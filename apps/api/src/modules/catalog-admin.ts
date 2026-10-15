import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, transaction } from '../core/db.js';
import { encrypt } from '../core/crypto.js';
import { AppError } from '../core/errors.js';
import { requirePermission } from './auth.js';
import { smm, smmUrl } from '../integrations/smm.js';
import {
  browseSmmCatalog,
  importSmmServices,
  smmProvider,
  syncSmmProvider,
} from './smm-catalog.js';

const idParams = z.object({ id: z.string().min(1).max(120) });
const providerBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    url: z.string().url().transform(smmUrl),
    apiKey: z.string().trim().max(2000).optional(),
    currency: z.enum(['USD', 'BRL']),
    active: z.boolean().default(true),
    requestsPerMinute: z.number().int().min(1).max(300).default(60),
  })
  .strict();
const providerSelect = {
  id: true,
  name: true,
  url: true,
  currency: true,
  active: true,
  requestsPerMinute: true,
  createdAt: true,
  _count: { select: { products: true, orders: true } },
} as const;
const categoryBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(300).default(''),
    sortOrder: z.number().int().min(0).max(100000).default(0),
    active: z.boolean().default(true),
  })
  .strict();
export async function registerCatalogAdmin(admin: FastifyInstance) {
  admin.get('/categories', async () => ({
    data: await db.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { products: true } } },
    }),
  }));
  admin.post('/categories', async (request) => {
    requirePermission(request, 'configure');
    const body = categoryBody.parse(request.body);
    return transaction(async (tx) => {
      const category = await tx.category.create({ data: body });
      await tx.auditLog.create({
        data: {
          actorId: request.admin.id,
          action: 'category.create',
          target: category.id,
          metadata: body,
        },
      });
      return category;
    });
  });
  admin.patch('/categories/:id', async (request) => {
    requirePermission(request, 'configure');
    const { id } = idParams.parse(request.params),
      body = categoryBody.parse(request.body);
    return transaction(async (tx) => {
      const result = await tx.category.update({ where: { id }, data: body });
      await tx.auditLog.create({
        data: { actorId: request.admin.id, action: 'category.update', target: id, metadata: body },
      });
      return result;
    });
  });
  admin.delete('/categories/:id', async (request) => {
    requirePermission(request, 'configure');
    const { id } = idParams.parse(request.params);
    return transaction(async (tx) => {
      if (await tx.product.count({ where: { categoryId: id } }))
        throw new AppError(
          'CATEGORY_IN_USE',
          'Mova os produtos para outra categoria antes de excluir, ou oculte esta categoria.',
          409,
        );
      await tx.category.delete({ where: { id } });
      await tx.auditLog.create({
        data: { actorId: request.admin.id, action: 'category.delete', target: id, metadata: {} },
      });
      return { ok: true };
    });
  });
  admin.get('/smm-providers', async (request) => {
    requirePermission(request, 'configure');
    return {
      data: (
        await db.smmProvider.findMany({ select: providerSelect, orderBy: { name: 'asc' } })
      ).map((p) => ({ ...p, keyConfigured: true })),
    };
  });
  admin.post('/smm-providers', async (request) => {
    requirePermission(request, 'configure');
    const { apiKey, ...body } = providerBody.parse(request.body);
    if (!apiKey) throw new AppError('SMM_KEY_REQUIRED', 'Informe a chave da API SMM.');
    return transaction(async (tx) => {
      const result = await tx.smmProvider.create({
        data: { ...body, encryptedApiKey: encrypt(apiKey) },
        select: providerSelect,
      });
      await tx.auditLog.create({
        data: {
          actorId: request.admin.id,
          action: 'smm.provider.create',
          target: result.id,
          metadata: body,
        },
      });
      return result;
    });
  });
  admin.patch('/smm-providers/:id', async (request) => {
    requirePermission(request, 'configure');
    const { id } = idParams.parse(request.params),
      { apiKey, ...body } = providerBody.parse(request.body);
    return transaction(async (tx) => {
      const prior = await tx.smmProvider.findUniqueOrThrow({ where: { id } });
      if (
        (body.url !== prior.url || body.currency !== prior.currency) &&
        (await tx.order.count({ where: { smmProviderId: id } }))
      )
        throw new AppError(
          'SMM_PROVIDER_IN_USE',
          'Este provedor tem pedidos. Para mudar endpoint ou moeda, cadastre outro provedor.',
          409,
        );
      const result = await tx.smmProvider.update({
        where: { id },
        data: { ...body, ...(apiKey ? { encryptedApiKey: encrypt(apiKey) } : {}) },
        select: providerSelect,
      });
      await tx.auditLog.create({
        data: {
          actorId: request.admin.id,
          action: 'smm.provider.update',
          target: id,
          metadata: { ...body, keyChanged: !!apiKey },
        },
      });
      return result;
    });
  });
  admin.delete('/smm-providers/:id', async (request) => {
    requirePermission(request, 'configure');
    const { id } = idParams.parse(request.params);
    return transaction(async (tx) => {
      if (
        (await tx.product.count({ where: { smmProviderId: id } })) ||
        (await tx.order.count({ where: { smmProviderId: id } }))
      )
        throw new AppError(
          'SMM_PROVIDER_IN_USE',
          'Este provedor tem serviços ou pedidos. Desative-o para preservar o histórico.',
          409,
        );
      await tx.smmProvider.delete({ where: { id } });
      await tx.auditLog.create({
        data: {
          actorId: request.admin.id,
          action: 'smm.provider.delete',
          target: id,
          metadata: {},
        },
      });
      return { ok: true };
    });
  });
  admin.post('/smm-providers/:id/test', async (request) => {
    requirePermission(request, 'configure');
    const { id } = idParams.parse(request.params);
    return smm.balance(await smmProvider(id, false));
  });
  admin.post('/smm-providers/:id/sync', async (request) => {
    requirePermission(request, 'operate');
    const { id } = idParams.parse(request.params);
    return syncSmmProvider(id);
  });
  admin.get('/smm-providers/:id/catalog', async (request) => {
    requirePermission(request, 'operate');
    const { id } = idParams.parse(request.params);
    const query = z
      .object({
        search: z.string().max(100).default(''),
        provider: z.string().max(300).default(''),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(request.query);
    return browseSmmCatalog(id, query);
  });
  admin.post('/smm-providers/:id/import', async (request) => {
    requirePermission(request, 'operate');
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        slugs: z.array(z.string().regex(/^\d+$/)).min(1).max(100),
        categoryId: z.string().min(1).optional(),
      })
      .parse(request.body);
    return importSmmServices(id, body.slugs, body.categoryId, request.admin.id);
  });
}
