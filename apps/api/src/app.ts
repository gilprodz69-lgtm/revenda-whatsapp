import Fastify, { LogController } from 'fastify';
import { readFileSync } from 'node:fs';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { env } from './config.js';
import { db, redis, audit, transaction } from './core/db.js';
import { hash, equalSecret, encrypt, decrypt } from './core/crypto.js';
import { AppError } from './core/errors.js';
import { authenticate, requirePermission, login } from './modules/auth.js';
import { setting, saveSetting } from './core/settings.js';
import { syncCatalog, browseCatalog, importCatalog, archiveProduct } from './modules/catalog.js';
import { adjustBalance } from './modules/wallet.js';
import { refundOrder } from './modules/orders.js';
import { refreshExchange } from './modules/exchange.js';
import { controlledResend, prepareDeliveries } from './modules/messaging.js';
import { validateTemplate } from './modules/conversation.js';
import {
  evolution,
  evolutionEventSchema,
  incomingSchema,
  normalizePhone,
  privateSenderPhone,
} from './integrations/evolution.js';
import { notifyIncoming, notifyOutgoing } from './core/dispatch.js';
import { activationKeywords, normalizeKeyword } from './modules/bot-activation.js';
import { pixGateway, expayNotificationChargeId } from './integrations/pix.js';
import { partner } from './integrations/partner.js';
import { orderQueue } from './core/queues.js';
import { templates, messageTemplate } from './modules/templates.js';
import { priceQuote, smmPriceQuote, type Tier } from './modules/pricing.js';
import { registerCatalogAdmin } from './modules/catalog-admin.js';
import { linkSmmOrder, processSmmOrder, releaseUnsentSmmOrder } from './modules/smm-orders.js';
import { withLock } from './core/lock.js';
import { retryEvent } from './modules/events.js';

const money = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/);
const positiveMoney = money.refine(
  (x) => new Prisma.Decimal(x).gt(0),
  'Informe um valor positivo.',
);
const idSchema = z.object({ id: z.string().uuid() });
const nameSchema = z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/) });
const paging = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().max(100).default(''),
});
const pagingOptions = (q: z.infer<typeof paging>) => ({
  skip: (q.page - 1) * q.limit,
  take: q.limit,
});

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: 'info',
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers.apikey',
        'req.headers.x-webhook-secret',
        'req.body',
        'res.headers.set-cookie',
      ],
    },
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: (_address: string, hop: number) => hop < env.TRUST_PROXY,
    bodyLimit: 512 * 1024,
  });
  await app.register(cookie);
  await app.register(helmet);
  await app.register(rateLimit, { max: 120, timeWindow: 60000, redis, skipOnError: false });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Verifique os campos informados.',
        fields: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    if (error instanceof AppError)
      return reply.code(error.status).send({ code: error.code, message: error.message });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025')
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'Registro não encontrado.' });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      return reply.code(409).send({ code: 'CONFLICT', message: 'Registro já existente.' });
    const candidate =
      error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const status =
      typeof candidate === 'number' && candidate >= 400 && candidate < 500 ? candidate : 500;
    request.log.error(
      { code: status === 500 ? 'INTERNAL' : 'HTTP_ERROR', requestId: request.id },
      'Requisição não concluída',
    );
    return reply.code(status).send({
      code: status === 429 ? 'RATE_LIMITED' : 'INTERNAL',
      message:
        status === 429
          ? 'Aguarde antes de tentar novamente.'
          : 'Não foi possível concluir a operação.',
    });
  });
  const version = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ).version as string;
  app.get('/health/live', async () => ({ ok: true, version }));
  app.get('/health/ready', async (_, reply) => {
    try {
      await db.$queryRaw`SELECT 1`;
      await redis.ping();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: 60000 } } },
    async (request, reply) => {
      if (request.headers.origin !== env.APP_ORIGIN)
        throw new AppError('ORIGIN_REJECTED', 'Origem inválida.', 403);
      const body = z
        .object({
          email: z
            .string()
            .email()
            .transform((v) => v.toLowerCase()),
          password: z.string().min(1).max(128),
        })
        .parse(request.body);
      return login(body.email, body.password, reply);
    },
  );
  app.post(
    '/webhooks/evolution',
    { config: { rateLimit: { max: 600, timeWindow: 60000 } } },
    async (request, reply) => {
      const secret = request.headers['x-webhook-secret'];
      if (typeof secret !== 'string' || !equalSecret(secret, env.WEBHOOK_SECRET))
        throw new AppError('UNAUTHORIZED', 'Webhook não autenticado.', 401);
      const payload = evolutionEventSchema.parse(request.body);
      if (!(await db.whatsappInstance.findUnique({ where: { name: payload.instance } })))
        return reply.code(202).send({ accepted: true });
      const event = payload.event.toLowerCase().replaceAll('_', '.');
      if (
        !['messages.upsert', 'connection.update', 'qrcode.updated', 'messages.update'].includes(
          event,
        )
      )
        return reply.code(202).send({ accepted: true });
      if (event === 'messages.upsert') {
        const parsed = incomingSchema.parse(payload.data);
        if (!privateSenderPhone(parsed.key)) return reply.code(202).send({ accepted: true });
        const key = `evolution-${payload.instance}-${parsed.key.id}`;
        const stored = await db.webhookEvent.upsert({
          where: { key },
          create: {
            key,
            source: 'evolution',
            encryptedPayload: encrypt(
              JSON.stringify({ event: payload.event, instance: payload.instance, data: parsed }),
            ),
          },
          update: {},
        });
        await notifyIncoming(stored);
      } else {
        const key = `evolution-${payload.instance}-${event}-${hash(JSON.stringify(payload.data))}-${Math.floor(Date.now() / 10000)}`;
        const stored = await db.webhookEvent.upsert({
          where: { key },
          create: { key, source: 'evolution', encryptedPayload: encrypt(JSON.stringify(payload)) },
          update: {},
        });
        await notifyIncoming(stored);
      }
      return reply.code(202).send({ accepted: true });
    },
  );
  app.post('/webhooks/pix', async (request, reply) => {
    const query = z
      .object({ 'data.id': z.string().regex(/^\d+$/) })
      .passthrough()
      .parse(request.query);
    const signature = request.headers['x-signature'],
      requestId = request.headers['x-request-id'];
    const gateway = await pixGateway();
    if (
      typeof signature !== 'string' ||
      typeof requestId !== 'string' ||
      !(await gateway.validateWebhook(signature, requestId, query['data.id']))
    )
      throw new AppError('INVALID_SIGNATURE', 'Assinatura inválida.', 401);
    const body = z
      .object({ type: z.literal('payment'), data: z.object({ id: z.string().or(z.number()) }) })
      .passthrough()
      .parse(request.body);
    if (String(body.data.id) !== query['data.id'])
      throw new AppError('INVALID_NOTIFICATION', 'Notificação divergente.', 400);
    const key = `pix-${hash(`${query['data.id']}-${requestId}-${signature}`)}`;
    const stored = await db.webhookEvent.upsert({
      where: { key },
      create: {
        key,
        source: 'pix',
        encryptedPayload: encrypt(JSON.stringify({ paymentId: query['data.id'] })),
      },
      update: {},
    });
    await notifyIncoming(stored);
    return reply.code(202).send({ accepted: true });
  });
  app.post(
    '/webhooks/pix/expay',
    { config: { rateLimit: { max: 30, timeWindow: 60000 } } },
    async (request, reply) => {
      const gatewayId = expayNotificationChargeId(request.body);
      if (gatewayId && (await pixGateway()).name === 'expay') {
        const payment = await db.payment.findUnique({ where: { gatewayId } });
        if (payment?.gateway === 'expay') {
          // Callbacks only trigger an authenticated API lookup; their status and amount are never trusted.
          const key = `expay-${gatewayId}-${Math.floor(Date.now() / 15000)}`;
          const stored = await db.webhookEvent.upsert({
            where: { key },
            create: {
              key,
              source: 'pix',
              encryptedPayload: encrypt(JSON.stringify({ paymentId: gatewayId })),
            },
            update: {},
          });
          await notifyIncoming(stored);
        }
      }
      return reply.code(202).send({ accepted: true });
    },
  );
  await app.register(
    async (admin) => {
      admin.addHook('preHandler', authenticate);
      await registerCatalogAdmin(admin);
      admin.get('/auth/me', async (request) => ({
        admin: request.admin,
        csrf: request.cookies.csrf,
      }));
      admin.post('/auth/logout', async (request, reply) => {
        if (request.cookies.session)
          await db.adminSession.deleteMany({ where: { id: hash(request.cookies.session) } });
        reply.clearCookie('session', { path: '/' }).clearCookie('csrf', { path: '/' });
        return { ok: true };
      });
      admin.get('/dashboard', async (request) => {
        const { days } = z
          .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
          .parse(request.query);
        const [
          customers,
          orders,
          pending,
          completed,
          revenue,
          profit,
          estimated,
          deposits,
          instances,
          partnerBalance,
          worker,
        ] = await Promise.all([
          db.customer.count(),
          db.order.count(),
          db.order.count({
            where: { status: { in: ['RESERVED', 'PROCESSING', 'UNKNOWN', 'REVIEW'] } },
          }),
          db.order.count({ where: { status: { in: ['COMPLETED', 'PARTIAL'] } } }),
          db.$queryRaw<
            Array<{ value: Prisma.Decimal }>
          >`SELECT COALESCE(SUM("totalBrl" - "refundedBrl"),0) AS value FROM "Order" WHERE status IN ('COMPLETED','PARTIAL')`,
          db.order.aggregate({
            where: { status: { in: ['COMPLETED', 'PARTIAL', 'REFUNDED'] } },
            _sum: { grossProfitBrl: true },
          }),
          db.$queryRaw<
            Array<{ value: Prisma.Decimal }>
          >`SELECT COALESCE(SUM("totalBrl" - "refundedBrl" - CASE WHEN source='SMM' THEN COALESCE("actualCostBrl","estimatedCostBrl",0) ELSE "estimatedCostUsd" * "usdBrl" END),0) AS value FROM "Order" WHERE status IN ('COMPLETED','PARTIAL')`,
          db.payment.aggregate({ where: { creditedAt: { not: null } }, _sum: { amountBrl: true } }),
          db.whatsappInstance.findMany(),
          partner.balance().catch(() => null),
          redis.get('worker:heartbeat'),
        ]);
        const chart = await db.$queryRaw<
          Array<{ day: string; revenue: Prisma.Decimal; orders: bigint }>
        >`SELECT to_char(("completedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS day, SUM("totalBrl" - "refundedBrl") AS revenue, COUNT(*) AS orders FROM "Order" WHERE status IN ('COMPLETED','PARTIAL') AND "completedAt">NOW()-make_interval(days=>${days}::int) GROUP BY day ORDER BY day`;
        const review = await db.order.count({ where: { status: 'REVIEW' } });
        const failedEvents = await db.webhookEvent.count({
          where: { failedAt: { not: null }, processedAt: null },
        });
        return {
          customers,
          orders,
          pending,
          completed,
          review,
          failedEvents,
          days,
          revenue: revenue[0]?.value ?? '0',
          profit: profit._sum.grossProfitBrl ?? '0',
          estimatedProfit: estimated[0]?.value ?? '0',
          deposits: deposits._sum.amountBrl ?? '0',
          instances,
          partnerBalance,
          services: { database: true, redis: true, worker: !!worker },
          chart: chart.map((r) => ({ ...r, orders: String(r.orders) })),
        };
      });
      admin.get('/products', async (request) => {
        const q = paging
          .extend({ filter: z.enum(['available', 'unavailable', 'unauthorized', '']).default('') })
          .parse(request.query);
        const where = {
          archivedAt: null,
          OR: [
            { name: { contains: q.search, mode: 'insensitive' as const } },
            { displayName: { contains: q.search, mode: 'insensitive' as const } },
            { slug: { contains: q.search, mode: 'insensitive' as const } },
          ],
          ...(q.filter === 'available'
            ? { available: true, active: true, visible: true, authorizedResale: true }
            : q.filter === 'unavailable'
              ? { available: false }
              : q.filter === 'unauthorized'
                ? { authorizedResale: false }
                : {}),
        };
        const [data, total, rate] = await Promise.all([
          db.product.findMany({
            where,
            ...pagingOptions(q),
            include: {
              provider: true,
              category: true,
              smmProvider: { select: { id: true, name: true, active: true } },
            },
            orderBy: { name: 'asc' },
          }),
          db.product.count({ where }),
          db.exchangeRate.findFirst({
            where: { expiresAt: { gt: new Date() } },
            orderBy: { createdAt: 'desc' },
          }),
        ]);
        return {
          data: data.map((p) => ({
            ...p,
            supplierName: p.name,
            name: p.displayName ?? p.name,
            quote:
              p.source === 'SMM'
                ? p.costCurrency === 'BRL' || rate
                  ? smmPriceQuote(
                      p.supplierRate!.toString(),
                      p.priceBasis,
                      p.priceBasis,
                      p.costCurrency === 'BRL' ? '1' : rate!.usdBrl.toString(),
                      {
                        markupPercent: p.markupPercent.toString(),
                        fixedMargin: p.fixedMargin.toString(),
                        manualPrice: p.manualPrice?.toString(),
                        promoPrice: p.promoPrice?.toString(),
                        promoUntil: p.promoUntil,
                        roundingStep: p.roundingStep.toString(),
                        volumeDiscountPercent: '0',
                        volumeMinQuantity: p.volumeMinQuantity,
                      },
                    )
                  : null
                : rate
                  ? priceQuote(
                      p.costUsd.toString(),
                      p.bulkTiers as Tier[],
                      1,
                      rate.usdBrl.toString(),
                      {
                        markupPercent: p.markupPercent.toString(),
                        fixedMargin: p.fixedMargin.toString(),
                        manualPrice: p.manualPrice?.toString(),
                        promoPrice: p.promoPrice?.toString(),
                        promoUntil: p.promoUntil,
                        roundingStep: p.roundingStep.toString(),
                        volumeDiscountPercent: p.volumeDiscountPercent.toString(),
                        volumeMinQuantity: p.volumeMinQuantity,
                      },
                    )
                  : null,
          })),
          total,
          page: q.page,
          rate,
        };
      });
      admin.post('/products/sync', async (request) => {
        requirePermission(request, 'operate');
        const result = await syncCatalog();
        await audit(request.admin.id, 'catalog.sync', 'catalog', result);
        return result;
      });
      admin.get('/products/catalog', async (request) => {
        requirePermission(request, 'operate');
        const query = paging
          .extend({ provider: z.string().max(100).default('') })
          .parse(request.query);
        return browseCatalog(query);
      });
      admin.post('/products/import', async (request) => {
        requirePermission(request, 'operate');
        const { slugs } = z
          .object({ slugs: z.array(z.string().min(1).max(255)).min(1).max(100) })
          .strict()
          .parse(request.body);
        return importCatalog(slugs, request.admin.id);
      });
      admin.delete('/products/:slug', async (request) => {
        requirePermission(request, 'configure');
        const { slug } = z.object({ slug: z.string().min(1).max(255) }).parse(request.params);
        return archiveProduct(slug, request.admin.id);
      });
      admin.patch('/products/:slug', async (request) => {
        requirePermission(request, 'configure');
        const { slug } = z.object({ slug: z.string() }).parse(request.params);
        const data = z
          .object({
            active: z.boolean().optional(),
            visible: z.boolean().optional(),
            displayName: z.string().trim().min(1).max(150).nullable().optional(),
            description: z.string().trim().max(2500).nullable().optional(),
            categoryId: z.string().min(1).nullable().optional(),
            authorizedResale: z.boolean().optional(),
            markupPercent: money.refine((v) => new Prisma.Decimal(v).lte(1000)).optional(),
            fixedMargin: money.optional(),
            manualPrice: positiveMoney.nullable().optional(),
            promoPrice: positiveMoney.nullable().optional(),
            promoUntil: z.string().datetime().nullable().optional(),
            roundingStep: positiveMoney.refine((v) => new Prisma.Decimal(v).gte('0.01')).optional(),
            volumeDiscountPercent: money.refine((v) => new Prisma.Decimal(v).lt(100)).optional(),
            volumeMinQuantity: z.number().int().min(2).optional(),
          })
          .strict()
          .parse(request.body);
        return transaction(async (tx) => {
          const product = await tx.product.update({
            where: { slug, archivedAt: null },
            data: {
              ...data,
              promoUntil:
                data.promoUntil === undefined
                  ? undefined
                  : data.promoUntil
                    ? new Date(data.promoUntil)
                    : null,
            },
          });
          await tx.auditLog.create({
            data: {
              actorId: request.admin.id,
              action: 'product.update',
              target: slug,
              metadata: data,
            },
          });
          return product;
        });
      });
      admin.get('/customers', async (request) => {
        const q = paging.parse(request.query);
        const where = {
          OR: [
            { name: { contains: q.search, mode: 'insensitive' as const } },
            { phone: { contains: q.search } },
          ],
        };
        const [data, total] = await Promise.all([
          db.customer.findMany({
            where,
            ...pagingOptions(q),
            include: { wallet: true, _count: { select: { orders: true } } },
            orderBy: { createdAt: 'desc' },
          }),
          db.customer.count({ where }),
        ]);
        return { data, total, page: q.page };
      });
      admin.get('/customers/:id', async (request) => {
        const { id } = idSchema.parse(request.params);
        return db.customer.findUniqueOrThrow({
          where: { id },
          include: {
            wallet: { include: { entries: { orderBy: { createdAt: 'desc' }, take: 100 } } },
            orders: { orderBy: { createdAt: 'desc' }, take: 50 },
            payments: {
              select: { id: true, amountBrl: true, status: true, createdAt: true },
              take: 50,
            },
          },
        });
      });
      admin.patch('/customers/:id', async (request) => {
        requirePermission(request, 'operate');
        const { id } = idSchema.parse(request.params);
        const data = z
          .object({
            blocked: z.boolean().optional(),
            humanUntil: z.string().datetime().nullable().optional(),
          })
          .strict()
          .parse(request.body);
        return transaction(async (tx) => {
          const result = await tx.customer.update({
            where: { id },
            data: {
              ...data,
              humanUntil:
                data.humanUntil === undefined
                  ? undefined
                  : data.humanUntil
                    ? new Date(data.humanUntil)
                    : null,
            },
          });
          await tx.auditLog.create({
            data: {
              actorId: request.admin.id,
              action: 'customer.update',
              target: id,
              metadata: data,
            },
          });
          return result;
        });
      });
      admin.post('/customers/:id/balance', async (request) => {
        requirePermission(request, 'finance');
        const { id } = idSchema.parse(request.params);
        const body = z
          .object({
            amount: z
              .string()
              .regex(/^-?\d{1,12}(\.\d{1,2})?$/)
              .refine((v) => !new Prisma.Decimal(v).isZero()),
            reason: z.string().min(10).max(300),
            key: z.string().uuid(),
          })
          .parse(request.body);
        return adjustBalance(id, body.amount, body.reason, body.key, request.admin.id);
      });
      admin.get('/orders', async (request) => {
        const q = paging
          .extend({
            status: z
              .enum([
                'RESERVED',
                'PROCESSING',
                'UNKNOWN',
                'COMPLETED',
                'FAILED',
                'REVIEW',
                'REFUNDED',
                'PARTIAL',
                'CANCELLED',
              ])
              .optional(),
          })
          .parse(request.query);
        const where = {
          status: q.status,
          OR: [{ id: { contains: q.search } }, { customer: { phone: { contains: q.search } } }],
        };
        const [data, total] = await Promise.all([
          db.order.findMany({
            where,
            ...pagingOptions(q),
            include: { customer: true, items: true },
            orderBy: { createdAt: 'desc' },
          }),
          db.order.count({ where }),
        ]);
        return {
          data: data.map(({ encryptedSmmRequest: _secret, ...row }) => row),
          total,
          page: q.page,
        };
      });
      admin.get('/orders/:id', async (request) => {
        const { id } = idSchema.parse(request.params);
        const order = await db.order.findUniqueOrThrow({
          where: { id },
          include: {
            customer: true,
            items: true,
            exchangeRate: true,
            attempts: { orderBy: { createdAt: 'desc' } },
            deliveries: {
              select: {
                id: true,
                lineCode: true,
                type: true,
                status: true,
                sentAt: true,
                attempts: true,
              },
            },
          },
        });
        const { encryptedSmmRequest, ...publicOrder } = order;
        return {
          ...publicOrder,
          ...(encryptedSmmRequest
            ? { targetLink: (JSON.parse(decrypt(encryptedSmmRequest)) as { link?: string }).link }
            : {}),
        };
      });
      admin.post('/orders/:id/reconcile', async (request) => {
        requirePermission(request, 'operate');
        const { id } = idSchema.parse(request.params);
        const order = await db.order.findUniqueOrThrow({ where: { id } });
        if (!order.reservationSettled)
          await db.order.update({ where: { id }, data: { status: 'UNKNOWN' } });
        await orderQueue.add('purchase', { id }, { jobId: `manual-${id}-${crypto.randomUUID()}` });
        await audit(request.admin.id, 'order.reconcile', id);
        return { queued: true };
      });
      admin.post('/orders/:id/review', async (request) => {
        requirePermission(request, 'operate');
        const { id } = idSchema.parse(request.params);
        await db.order.updateMany({
          where: { id, reservationSettled: false },
          data: { status: 'REVIEW' },
        });
        await audit(request.admin.id, 'order.review', id);
        return { ok: true };
      });
      admin.post('/orders/:id/smm/link', async (request) => {
        requirePermission(request, 'finance');
        const { id } = idSchema.parse(request.params);
        const { externalId } = z
          .object({ externalId: z.string().regex(/^\d{1,30}$/), confirmed: z.literal(true) })
          .parse(request.body);
        const result = await withLock(`order:${id}`, () =>
          linkSmmOrder(id, externalId, request.admin.id),
        );
        await prepareDeliveries();
        await notifyOutgoing();
        return result;
      });
      admin.post('/orders/:id/smm/status', async (request) => {
        requirePermission(request, 'operate');
        const { id } = idSchema.parse(request.params);
        await withLock(`order:${id}`, () => processSmmOrder(id, true));
        await prepareDeliveries();
        await notifyOutgoing();
        return { ok: true };
      });
      admin.post('/orders/:id/smm/release', async (request) => {
        requirePermission(request, 'finance');
        const { id } = idSchema.parse(request.params);
        const { reason } = z
          .object({ reason: z.string().trim().min(10).max(300), confirmed: z.literal(true) })
          .parse(request.body);
        const result = await withLock(`order:${id}`, () =>
          releaseUnsentSmmOrder(id, request.admin.id, reason),
        );
        await notifyOutgoing();
        return result;
      });
      admin.post('/orders/:id/refund', async (request) => {
        requirePermission(request, 'finance');
        const { id } = idSchema.parse(request.params);
        const { reason } = z.object({ reason: z.string().min(10).max(300) }).parse(request.body);
        return refundOrder(id, reason, request.admin.id);
      });
      admin.post('/deliveries/:id/resend', async (request) => {
        requirePermission(request, 'operate');
        const { id } = idSchema.parse(request.params);
        const { reason } = z.object({ reason: z.string().min(10).max(300) }).parse(request.body);
        const result = await controlledResend(id, request.admin.id, reason);
        await notifyOutgoing();
        return result;
      });
      admin.get('/payments', async (request) => {
        const q = paging.parse(request.query);
        const [data, total] = await Promise.all([
          db.payment.findMany({
            ...pagingOptions(q),
            select: {
              id: true,
              customer: { select: { name: true, phone: true } },
              amountBrl: true,
              status: true,
              gateway: true,
              gatewayId: true,
              expiresAt: true,
              creditedAt: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
          }),
          db.payment.count(),
        ]);
        return { data, total, page: q.page };
      });
      admin.get('/whatsapp', async () => db.whatsappInstance.findMany());
      admin.get('/whatsapp/license', async (request) => {
        requirePermission(request, 'configure');
        return evolution.licenseStatus();
      });
      admin.post('/whatsapp/license/register', async (request) => {
        requirePermission(request, 'configure');
        const result = await evolution.licenseRegister();
        await audit(request.admin.id, 'evolution.activation.register', 'evolution');
        return result;
      });
      admin.post('/whatsapp/license/activate', async (request) => {
        requirePermission(request, 'configure');
        const { code } = z.object({ code: z.string().trim().min(6).max(2000) }).parse(request.body);
        const result = await evolution.licenseActivate(code);
        await audit(request.admin.id, 'evolution.activation.complete', 'evolution');
        await notifyOutgoing();
        return result;
      });
      admin.post('/whatsapp', async (request) => {
        requirePermission(request, 'configure');
        const body = nameSchema
          .extend({
            number: z
              .string()
              .regex(/^\d{8,15}$/)
              .optional(),
          })
          .parse(request.body);
        await db.whatsappInstance.upsert({
          where: { name: body.name },
          create: { name: body.name },
          update: {},
        });
        try {
          await evolution.create(body.name, body.number);
        } catch (e) {
          await db.whatsappInstance.update({
            where: { name: body.name },
            data: { state: 'error' },
          });
          throw e;
        }
        await audit(request.admin.id, 'whatsapp.create', body.name);
        return { name: body.name };
      });
      admin.post('/whatsapp/:name/connect', async (request) => {
        requirePermission(request, 'operate');
        const { name } = nameSchema.parse(request.params);
        const { number } = z
          .object({
            number: z
              .string()
              .regex(/^\d{8,15}$/)
              .optional(),
          })
          .parse(request.body);
        const result = await evolution.connect(name, number);
        return {
          base64: result.base64,
          code: result.code,
          pairingCode: result.pairingCode,
          count: result.count,
        };
      });
      admin.get('/whatsapp/:name/state', async (request) => {
        const { name } = nameSchema.parse(request.params);
        const result = await evolution.state(name);
        const state = (result.instance as { state?: string } | undefined)?.state ?? 'error';
        const rows = await evolution.instances();
        const instances = Array.isArray(rows) ? rows : [];
        const match = instances.find((r: { name?: string }) => r.name === name);
        const phone = typeof match?.ownerJid === 'string' ? normalizePhone(match.ownerJid) : null;
        await db.whatsappInstance.update({ where: { name }, data: { state, phone } });
        return { state, phone };
      });
      admin.post('/whatsapp/:name/restart', async (request) => {
        requirePermission(request, 'operate');
        const { name } = nameSchema.parse(request.params);
        await evolution.restart(name);
        await audit(request.admin.id, 'whatsapp.restart', name);
        return { ok: true };
      });
      admin.patch('/whatsapp/:name', async (request) => {
        requirePermission(request, 'operate');
        const { name } = nameSchema.parse(request.params);
        const { botEnabled } = z.object({ botEnabled: z.boolean() }).parse(request.body);
        const result = await db.whatsappInstance.update({ where: { name }, data: { botEnabled } });
        await audit(request.admin.id, 'whatsapp.bot', name, { botEnabled });
        return result;
      });
      admin.get('/messages/:id', async (request) => {
        requirePermission(request, 'operate');
        const { id } = idSchema.parse(request.params);
        const rows = await db.message.findMany({
          where: { customerId: id },
          orderBy: { createdAt: 'desc' },
          take: 100,
        });
        await audit(request.admin.id, 'messages.read', id);
        return rows.map(({ encryptedText, encryptedMedia, encryptedInteractive, ...row }) => ({
          ...row,
          text:
            row.key.startsWith('delivery-') || row.key.startsWith('resend-')
              ? '[Entrega protegida: use o reenvio auditado]'
              : decrypt(encryptedText),
          hasMedia: !!encryptedMedia,
          hasInteractive: !!encryptedInteractive,
        }));
      });
      admin.post('/messages/:id', async (request) => {
        requirePermission(request, 'operate');
        const { id } = idSchema.parse(request.params);
        const body = z
          .object({ instanceName: z.string(), text: z.string().min(1).max(5000) })
          .parse(request.body);
        const sent = await transaction(async (tx) => {
          const result = await tx.message.create({
            data: {
              key: `human-${crypto.randomUUID()}`,
              customerId: id,
              instanceName: body.instanceName,
              direction: 'OUT',
              encryptedText: encrypt(body.text),
            },
          });
          await tx.auditLog.create({
            data: {
              actorId: request.admin.id,
              action: 'message.send',
              target: id,
              metadata: { messageId: result.id },
            },
          });
          return { id: result.id };
        });
        await notifyOutgoing({ customerId: id, instanceName: body.instanceName });
        return sent;
      });
      const publicKeys = [
        'store.name',
        'exchange.provider',
        'human.hours',
        'messages.welcome',
        'bot.greetings',
        'bot.activationKeywords',
        'bot.messageStyle',
        'bot.mainMenuStyle',
        'pix.gateway',
        'pix.expayStoreId',
      ];
      admin.get('/settings', async (request) => {
        requirePermission(request, 'configure');
        const values = Object.fromEntries(
          await Promise.all(
            publicKeys.map(async (key) => [
              key,
              key === 'bot.activationKeywords'
                ? await activationKeywords()
                : await setting(
                    key,
                    key === 'bot.messageStyle'
                      ? 'interactive'
                      : key === 'bot.mainMenuStyle'
                        ? 'buttons'
                        : key === 'pix.gateway'
                          ? env.PIX_GATEWAY
                          : key === 'pix.expayStoreId'
                            ? env.EXPAY_STORE_ID
                            : null,
                  ),
            ]),
          ),
        );
        const secrets = Object.fromEntries(
          await Promise.all(
            [
              'secret.partnerKey',
              'secret.expayApiKey',
              'secret.mpToken',
              'secret.mpWebhookSecret',
            ].map(async (key) => [key, !!(await setting(key, ''))]),
          ),
        );
        return {
          values,
          secrets,
          environment: {
            partnerKey: !!env.PARTNER_API_KEY,
            expayApiKey: !!env.EXPAY_API_KEY,
            expayStoreId: env.EXPAY_STORE_ID,
            mpToken: !!env.MP_ACCESS_TOKEN,
            mpWebhookSecret: !!env.MP_WEBHOOK_SECRET,
          },
          rates: await db.exchangeRate.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
          currentRate: await db.exchangeRate.findFirst({
            where: { expiresAt: { gt: new Date() } },
            orderBy: { createdAt: 'desc' },
          }),
          templates: await Promise.all(
            Object.entries(templates).map(async ([key, t]) => ({
              key,
              label: t.label,
              text: await setting(`messages.${key}`, t.text),
            })),
          ),
        };
      });
      admin.put('/settings', async (request) => {
        requirePermission(request, 'configure');
        const schemas: Record<string, z.ZodTypeAny> = {
          'store.name': z.string().min(1).max(100),
          'exchange.provider': z.enum(['manual', 'bcb']),
          'human.hours': z.string().max(300),
          'messages.welcome': z.string().min(1).max(3000).transform(validateTemplate),
          'bot.greetings': z.array(z.string().min(1).max(30)).max(20),
          'bot.messageStyle': z.enum(['interactive', 'text']),
          'bot.mainMenuStyle': z.enum(['buttons', 'list']),
          'bot.activationKeywords': z
            .array(
              z
                .string()
                .trim()
                .min(1)
                .max(80)
                .refine((v) => !!normalizeKeyword(v)),
            )
            .max(50)
            .transform((values) => [
              ...new Map(values.map((value) => [normalizeKeyword(value), value])).values(),
            ]),
          'pix.gateway': z.enum(['disabled', 'expay', 'mercadopago']),
          'pix.expayStoreId': z.string().max(255),
          'secret.expayApiKey': z.string().min(16).max(500),
          'secret.partnerKey': z.string().min(20).max(300),
          'secret.mpToken': z.string().min(20).max(500),
          'secret.mpWebhookSecret': z.string().min(16).max(300),
        };
        for (const key of Object.keys(templates))
          schemas[`messages.${key}`] = z.string().min(1).max(3000).transform(validateTemplate);
        const body = z.record(z.unknown()).parse(request.body);
        for (const [key, value] of Object.entries(body)) {
          const schema = schemas[key];
          if (!schema) throw new AppError('INVALID_SETTING', 'Configuração não permitida.');
          schema.parse(value);
        }
        for (const [key, value] of Object.entries(body))
          await saveSetting(
            key,
            schemas[key]!.parse(value) as Prisma.InputJsonValue,
            key.startsWith('secret.'),
          );
        await audit(request.admin.id, 'settings.update', 'settings', { keys: Object.keys(body) });
        if (body['exchange.provider'] === 'bcb') {
          try {
            await refreshExchange();
          } catch (error) {
            throw new AppError(
              'RATE_REFRESH_FAILED',
              `Modo BCB salvo, mas não foi possível obter uma cotação válida. ${error instanceof AppError ? error.message : 'Tente Consultar BCB novamente.'}`,
              503,
            );
          }
        }
        return { ok: true };
      });
      admin.post('/exchange/manual', async (request) => {
        requirePermission(request, 'finance');
        const body = z
          .object({
            usdBrl: z
              .string()
              .regex(/^\d{1,4}(\.\d{1,8})?$/)
              .refine((v) => new Prisma.Decimal(v).gt(0)),
            validHours: z.number().int().min(1).max(168),
            reason: z.string().min(10).max(300),
          })
          .parse(request.body);
        const rate = await db.exchangeRate.create({
          data: {
            usdBrl: body.usdBrl,
            source: `manual:${request.admin.id}`,
            observedAt: new Date(),
            expiresAt: new Date(Date.now() + body.validHours * 3600000),
          },
        });
        await audit(request.admin.id, 'exchange.manual', rate.id, {
          reason: body.reason,
          usdBrl: body.usdBrl,
        });
        return rate;
      });
      admin.post('/exchange/refresh', async (request) => {
        requirePermission(request, 'configure');
        return refreshExchange({ force: true });
      });
      admin.get('/partner/health', async () => partner.health());
      admin.get('/partner/usage', async () => partner.usage());
      admin.get('/events', async (request) => {
        requirePermission(request, 'configure');
        return db.webhookEvent.findMany({
          where: { failedAt: { not: null }, processedAt: null },
          ...pagingOptions(paging.parse(request.query)),
          select: {
            id: true,
            source: true,
            attempts: true,
            errorCode: true,
            createdAt: true,
            failedAt: true,
          },
          orderBy: { createdAt: 'desc' },
        });
      });
      admin.post('/events/:id/retry', async (request) => {
        requirePermission(request, 'operate');
        const { id } = idSchema.parse(request.params);
        return retryEvent(id, request.admin.id);
      });
      admin.get('/logs', async (request) => {
        requirePermission(request, 'configure');
        return db.apiRequestLog.findMany({
          ...pagingOptions(paging.parse(request.query)),
          orderBy: { createdAt: 'desc' },
        });
      });
      admin.get('/audit', async (request) => {
        requirePermission(request, 'configure');
        return db.auditLog.findMany({
          ...pagingOptions(paging.parse(request.query)),
          orderBy: { createdAt: 'desc' },
        });
      });
      admin.get('/admins', async (request) => {
        requirePermission(request, 'admins');
        return db.admin.findMany({
          select: { id: true, email: true, role: true, disabled: true, createdAt: true },
        });
      });
      admin.post('/admins', async (request) => {
        requirePermission(request, 'admins');
        const body = z
          .object({
            email: z
              .string()
              .email()
              .transform((v) => v.toLowerCase()),
            password: z.string().min(14).max(128),
            role: z.enum(['OWNER', 'OPERATOR', 'VIEWER']),
          })
          .parse(request.body);
        const result = await db.admin.create({
          data: {
            email: body.email,
            role: body.role,
            passwordHash: await argon2.hash(body.password, {
              type: argon2.argon2id,
              memoryCost: 65536,
              timeCost: 3,
              parallelism: 1,
            }),
          },
          select: { id: true, email: true, role: true },
        });
        await audit(request.admin.id, 'admin.create', result.id, { role: body.role });
        return result;
      });
      admin.patch('/admins/:id', async (request) => {
        requirePermission(request, 'admins');
        const { id } = idSchema.parse(request.params);
        const body = z
          .object({
            disabled: z.boolean().optional(),
            role: z.enum(['OWNER', 'OPERATOR', 'VIEWER']).optional(),
            password: z.string().min(14).max(128).optional(),
          })
          .strict()
          .parse(request.body);
        if (id === request.admin.id)
          throw new AppError('SELF_CHANGE', 'Use outro proprietário para alterar sua conta.', 409);
        return transaction(async (tx) => {
          const target = await tx.admin.findUniqueOrThrow({ where: { id } });
          if (target.role === 'OWNER' && (body.disabled || (body.role && body.role !== 'OWNER'))) {
            const count = await tx.admin.count({ where: { role: 'OWNER', disabled: false } });
            if (count <= 1)
              throw new AppError('LAST_OWNER', 'Mantenha um proprietário ativo.', 409);
          }
          await tx.admin.update({
            where: { id },
            data: {
              disabled: body.disabled,
              role: body.role,
              passwordHash: body.password
                ? await argon2.hash(body.password, { type: argon2.argon2id })
                : undefined,
            },
          });
          await tx.adminSession.deleteMany({ where: { adminId: id } });
          await tx.auditLog.create({
            data: {
              actorId: request.admin.id,
              action: 'admin.update',
              target: id,
              metadata: {
                disabled: body.disabled ?? false,
                role: body.role ?? target.role,
                passwordChanged: !!body.password,
              },
            },
          });
          return { ok: true };
        });
      });
    },
    { prefix: '/api' },
  );
  return app;
}
