import { Prisma, type Product } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { db, transaction } from '../core/db.js';
import { decrypt, encrypt, hash } from '../core/crypto.js';
import { AppError } from '../core/errors.js';
import { smm, SmmError, smmTypes, supportedSmmService } from '../integrations/smm.js';
import { smmProvider } from './smm-catalog.js';
import { currentRate } from './exchange.js';
import { smmPriceQuote } from './pricing.js';
import { mutateWallet } from './wallet.js';
import { failOrder } from './orders.js';

export const smmDetailFields = (type: string) => [
  { key: 'link', label: 'Envie o link completo da página, perfil ou publicação (https://...).' },
  ...(type === 'Custom Comments'
    ? [
        {
          key: 'comments',
          label:
            'Envie os comentários desejados, um por linha. A quantidade será o número de linhas.',
        },
      ]
    : []),
  ...(type === 'Comment Likes'
    ? [{ key: 'username', label: 'Informe o usuário do autor do comentário, sem @.' }]
    : []),
  ...(type === 'Poll'
    ? [
        {
          key: 'answer_number',
          label: 'Informe o número da resposta da enquete (1 para a primeira opção).',
        },
      ]
    : []),
];
export function validateSmmField(key: string, text: string) {
  const value = text.trim();
  if (key === 'link') {
    const url = z.string().url().max(2000).safeParse(value);
    if (
      !url.success ||
      !/^https?:\/\//i.test(value) ||
      new URL(value).username ||
      new URL(value).password
    )
      throw new AppError(
        'SMM_LINK_INVALID',
        'Envie um link completo válido, começando com https://.',
      );
  } else if (key === 'comments') {
    if (!value || value.length > 10000 || value.split(/\r?\n/).some((line) => !line.trim()))
      throw new AppError(
        'SMM_COMMENTS_INVALID',
        'Envie um comentário por linha, sem linhas vazias (até 10.000 caracteres).',
      );
  } else if (key === 'username' && !/^[\w.\-]{1,100}$/.test(value))
    throw new AppError(
      'SMM_USERNAME_INVALID',
      'Informe somente o nome do usuário, sem @ ou espaços.',
    );
  else if (key === 'answer_number' && !/^[1-9]\d{0,3}$/.test(value))
    throw new AppError('SMM_ANSWER_INVALID', 'Informe um número de resposta entre 1 e 9999.');
  return value;
}
export function smmRequest(
  type: string,
  service: string,
  quantity: number,
  details: Record<string, string>,
) {
  const expected = smmDetailFields(type);
  if (
    !smmTypes.includes(type) ||
    Object.keys(details).some((k) => !expected.some((f) => f.key === k))
  )
    throw new AppError('SMM_INPUT_INVALID', 'Dados incompatíveis com o tipo do serviço.');
  const values = Object.fromEntries(
    expected.map((f) => [f.key, validateSmmField(f.key, details[f.key] ?? '')]),
  );
  if (type === 'Custom Comments' && values.comments!.split(/\r?\n/).length !== quantity)
    throw new AppError(
      'SMM_QUANTITY_CHANGED',
      'A quantidade deve corresponder ao número de comentários.',
    );
  if (type === 'Package' && quantity !== 1)
    throw new AppError('INVALID_QUANTITY', 'Este serviço vende um pacote por pedido.');
  return {
    service,
    ...values,
    ...(['Package', 'Custom Comments'].includes(type) ? {} : { quantity: String(quantity) }),
  };
}
export async function quoteSmmProduct(product: Product, quantity: number) {
  const provider = await smmProvider(product.smmProviderId!);
  const service = (await smm.services(provider)).find((s) => s.service === product.smmServiceId);
  if (!service || !supportedSmmService(service))
    throw new AppError('PRODUCT_UNAVAILABLE', 'Este serviço SMM não está disponível.');
  if (service.type !== product.smmType)
    throw new AppError(
      'SMM_SERVICE_CHANGED',
      'O tipo deste serviço foi alterado pelo provedor. Sincronize o catálogo antes de vender.',
    );
  const min = service.type === 'Package' ? 1 : Math.max(1, service.min),
    max = service.type === 'Package' ? 1 : service.max;
  if (!Number.isInteger(quantity) || quantity < min || quantity > max)
    throw new AppError('INVALID_QUANTITY', `Informe uma quantidade entre ${min} e ${max}.`);
  const rate = provider.currency === 'USD' ? await currentRate() : null;
  const conversion = rate?.usdBrl.toString() ?? '1'; // BRL costs are already in the customer's currency.
  const basis = service.type === 'Package' ? 1 : 1000;
  const price = smmPriceQuote(service.rate, quantity, basis, conversion, {
    markupPercent: product.markupPercent.toString(),
    fixedMargin: product.fixedMargin.toString(),
    manualPrice: product.manualPrice?.toString(),
    promoPrice: product.promoPrice?.toString(),
    promoUntil: product.promoUntil,
    roundingStep: product.roundingStep.toString(),
    volumeMinQuantity: product.volumeMinQuantity,
    volumeDiscountPercent: product.volumeDiscountPercent.toString(),
  });
  const nativeCost = new Decimal(service.rate).mul(quantity).div(basis);
  return {
    product: { ...product, name: product.displayName ?? product.name },
    rate,
    quantity,
    live: {
      name: service.name,
      currency: provider.currency,
      yourPrice: service.rate,
      stock: { inStock: true, count: max, maxQuantity: max },
      durationDays: null,
      warranty: undefined,
      bulkDiscount: undefined,
      minQuantity: min,
      smmType: service.type,
    },
    unitCostUsd: provider.currency === 'USD' ? service.rate : '0',
    estimatedCostUsd: provider.currency === 'USD' ? nativeCost.toFixed(4) : '0',
    ...price,
    priceBasis: basis,
    service,
    provider,
  };
}
export async function placeSmmOrder(
  input: {
    customerId: string;
    instanceName: string;
    slug: string;
    quantity: number;
    idempotencyKey: string;
    expectedTotalBrl: string;
    details?: Record<string, string>;
  },
  product: Product,
) {
  const existing = await db.order.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) {
    if (existing.source !== 'SMM' || !existing.encryptedSmmRequest)
      throw new AppError('IDEMPOTENCY_CONFLICT', 'A confirmação já pertence a outro pedido.', 409);
    const priorBody = existing.requestBody as {
      fingerprint?: string;
      serviceType: string;
      productSlug: string;
      quantity: number;
    };
    const priorFields = JSON.parse(decrypt(existing.encryptedSmmRequest!)) as Record<
      string,
      string
    >;
    const fingerprint = hash(
      JSON.stringify(
        smmRequest(
          priorBody.serviceType,
          priorFields.service!,
          input.quantity,
          input.details ?? {},
        ),
      ),
    );
    if (
      existing.customerId !== input.customerId ||
      priorBody.productSlug !== input.slug ||
      priorBody.quantity !== input.quantity ||
      priorBody.fingerprint !== fingerprint
    )
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        'A confirmação já foi usada com outros dados.',
        409,
      );
    return existing;
  }
  if (product.archivedAt || !product.active || !product.visible || !product.authorizedResale)
    throw new AppError('PRODUCT_UNAVAILABLE', 'Este serviço não está disponível.');
  const quote = await quoteSmmProduct(product, input.quantity);
  const fields = smmRequest(
    quote.service.type,
    quote.service.service,
    input.quantity,
    input.details ?? {},
  );
  const fingerprint = hash(JSON.stringify(fields));
  if (!new Decimal(input.expectedTotalBrl).equals(quote.totalBrl))
    throw new AppError('PRICE_CHANGED', 'O preço mudou. Consulte o resumo novamente.', 409);
  const id = randomUUID();
  return transaction(async (tx) => {
    const prior = await tx.order.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (prior) {
      if (
        prior.customerId !== input.customerId ||
        (prior.requestBody as { fingerprint?: string }).fingerprint !== fingerprint
      )
        throw new AppError('IDEMPOTENCY_CONFLICT', 'Confirmação divergente.', 409);
      return prior;
    }
    const local = await tx.product.findUniqueOrThrow({
      where: { slug: input.slug },
      include: { category: true, smmProvider: true },
    });
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: input.customerId } });
    if (
      customer.blocked ||
      local.archivedAt ||
      !local.active ||
      !local.visible ||
      !local.authorizedResale ||
      local.category?.active === false ||
      !local.smmProvider?.active ||
      local.smmProviderId !== quote.provider.id
    )
      throw new AppError('PRODUCT_UNAVAILABLE', 'Este serviço não está disponível para compra.');
    const order = await tx.order.create({
      data: {
        id,
        idempotencyKey: input.idempotencyKey,
        externalOrderId: `wa-${id}`,
        source: 'SMM',
        customerId: input.customerId,
        instanceName: input.instanceName,
        totalBrl: quote.totalBrl,
        estimatedCostUsd: quote.estimatedCostUsd,
        estimatedCostBrl: quote.estimatedCostBrl,
        exchangeRateId: quote.rate?.id,
        usdBrl: quote.rate?.usdBrl,
        smmProviderId: quote.provider.id,
        encryptedSmmRequest: encrypt(JSON.stringify(fields)),
        requestBody: {
          productSlug: input.slug,
          quantity: input.quantity,
          fingerprint,
          currency: quote.provider.currency,
          serviceType: quote.service.type,
        },
        items: {
          create: {
            productSlug: input.slug,
            name: quote.product.name,
            quantity: input.quantity,
            priceBasis: quote.priceBasis,
            unitSaleBrl: quote.unitSaleBrl,
            unitCostUsd: quote.unitCostUsd,
          },
        },
      },
    });
    await mutateWallet(tx, {
      customerId: input.customerId,
      key: `reserve-${id}`,
      kind: 'RESERVE',
      availableDelta: `-${quote.totalBrl}`,
      reservedDelta: quote.totalBrl,
      reference: id,
      reason: 'Reserva para serviço SMM',
    });
    return order;
  });
}
async function smmNotice(
  tx: Prisma.TransactionClient,
  order: { id: string; customerId: string; instanceName: string },
  kind: string,
  text: string,
) {
  await tx.message.upsert({
    where: { key: `smm-${kind}-${order.id}` },
    create: {
      key: `smm-${kind}-${order.id}`,
      customerId: order.customerId,
      instanceName: order.instanceName,
      direction: 'OUT',
      encryptedText: encrypt(text),
    },
    update: {},
  });
}
export async function processSmmOrder(id: string, force = false) {
  const order = await db.order.findUniqueOrThrow({
    where: { id },
    include: { items: { include: { product: true } }, attempts: true },
  });
  if (order.source !== 'SMM' || order.reservationSettled || (order.status === 'REVIEW' && !force))
    return;
  const body = order.requestBody as { quantity: number; currency: string; serviceType: string };
  const provider = await smmProvider(order.smmProviderId!, false);
  if (provider.currency !== body.currency)
    throw new AppError('SMM_CURRENCY_CHANGED', 'A moeda do pedido SMM diverge da conta.', 409);
  if (!order.smmOrderId) {
    const sent = order.attempts.find((a) => a.operation === 'PURCHASE');
    if (sent) {
      if (sent.createdAt.getTime() > Date.now() - 30000 && order.status !== 'REVIEW') return;
      await db.order.update({
        where: { id },
        data: { status: 'REVIEW', errorCode: 'SMM_ADD_UNKNOWN' },
      });
      return;
    }
    if (!provider.active) {
      await failOrder(id, 'SMM_DISABLED');
      return;
    }
    const item = order.items[0]!,
      fields = JSON.parse(decrypt(order.encryptedSmmRequest!)) as Record<string, string>;
    const live = (await smm.services(provider, true)).find((s) => s.service === fields.service);
    if (
      !live ||
      live.type !== body.serviceType ||
      !supportedSmmService(live) ||
      body.quantity < (live.type === 'Package' ? 1 : live.min) ||
      body.quantity > (live.type === 'Package' ? 1 : live.max)
    ) {
      await failOrder(id, 'SMM_SERVICE_CHANGED');
      return;
    }
    const cost = new Decimal(live.rate).mul(body.quantity).div(item.priceBasis);
    const costBrl = cost.mul(body.currency === 'USD' ? order.usdBrl!.toString() : '1');
    if (costBrl.gt(order.estimatedCostBrl!.toString())) {
      await failOrder(id, 'COST_CHANGED');
      return;
    }
    if (cost.gt((await smm.balance(provider)).balance)) {
      await failOrder(id, 'INSUFFICIENT_BALANCE');
      return;
    }
    const claimed = await transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${id} FOR UPDATE`;
      const current = await tx.order.findUniqueOrThrow({ where: { id } });
      if (
        current.reservationSettled ||
        current.status === 'REVIEW' ||
        current.smmOrderId ||
        (await tx.orderAttempt.count({ where: { orderId: id, operation: 'PURCHASE' } }))
      )
        return false;
      await tx.orderAttempt.create({
        data: { orderId: id, operation: 'PURCHASE', outcome: 'STARTED' },
      });
      await tx.order.update({ where: { id }, data: { status: 'PROCESSING' } });
      return true;
    });
    if (!claimed) return;
    let externalId: string;
    try {
      externalId = await smm.add(provider, fields);
    } catch (error) {
      if (error instanceof SmmError && !error.uncertain) {
        await failOrder(id, error.code);
        return;
      }
      await transaction(async (tx) => {
        await tx.order.update({
          where: { id },
          data: { status: 'REVIEW', errorCode: 'SMM_ADD_UNKNOWN' },
        });
        await smmNotice(
          tx,
          order,
          'review',
          `Pedido ${id.slice(0, 8)} em revisão. O provedor não confirmou o recebimento. Sua reserva continua protegida; nossa equipe deve conferir o pedido antes de qualquer novo envio.`,
        );
      });
      return;
    }
    await transaction(async (tx) => {
      await tx.order.update({
        where: { id },
        data: {
          smmOrderId: externalId,
          externalOrderCode: `smm:${provider.id}:${externalId}`,
          smmState: 'Pending',
          lastSmmPollAt: new Date(),
        },
      });
      await smmNotice(
        tx,
        order,
        'accepted',
        `Serviço enviado ao provedor. Pedido ${id.slice(0, 8)} · número ${externalId}. Você receberá uma atualização ao concluir. Consulte Meus pedidos para acompanhar.`,
      );
    });
    return;
  }
  if (!force && order.lastSmmPollAt && order.lastSmmPollAt.getTime() > Date.now() - 60000) return;
  await db.order.update({ where: { id }, data: { lastSmmPollAt: new Date() } });
  const status = await smm.status(provider, order.smmOrderId);
  const terminal = ['Completed', 'Partial', 'Canceled', 'Cancelled', 'Refunded'].includes(
    status.status,
  );
  if (!terminal) {
    await db.order.update({
      where: { id },
      data: { status: 'PROCESSING', smmState: status.status, smmRemains: status.remains },
    });
    return;
  }
  const cancelled = ['Canceled', 'Cancelled', 'Refunded'].includes(status.status);
  if (
    status.remains > body.quantity ||
    (status.status === 'Completed' && status.remains !== 0) ||
    (status.status === 'Partial' && (status.remains <= 0 || status.remains >= body.quantity)) ||
    (cancelled &&
      (!new Decimal(status.charge).isZero() ||
        (status.remains !== body.quantity && status.remains !== 0)))
  ) {
    await db.order.update({
      where: { id },
      data: { status: 'REVIEW', errorCode: 'SMM_STATUS_INVALID' },
    });
    return;
  }
  const remains = cancelled ? body.quantity : status.remains;
  const refund = new Decimal(order.totalBrl.toString())
    .mul(remains)
    .div(body.quantity)
    .toDecimalPlaces(2, Decimal.ROUND_DOWN);
  const actualCostBrl = new Decimal(status.charge).mul(
    body.currency === 'USD' ? order.usdBrl!.toString() : '1',
  );
  await transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${id} FOR UPDATE`;
    const current = await tx.order.findUniqueOrThrow({ where: { id } });
    if (current.reservationSettled) return;
    await mutateWallet(tx, {
      customerId: order.customerId,
      key: `smm-settle-${id}`,
      kind: 'SMM_SETTLE',
      availableDelta: refund.toFixed(2),
      reservedDelta: order.totalBrl.negated().toString(),
      reference: id,
      reason: `SMM ${status.status}`,
    });
    await tx.order.update({
      where: { id },
      data: {
        status: cancelled ? 'CANCELLED' : remains > 0 ? 'PARTIAL' : 'COMPLETED',
        smmState: status.status,
        smmRemains: remains,
        reservationSettled: true,
        refundedBrl: refund.toFixed(2),
        actualCostBrl: actualCostBrl.toFixed(4),
        actualCostUsd: body.currency === 'USD' ? status.charge : null,
        grossProfitBrl: new Decimal(order.totalBrl.toString())
          .sub(refund)
          .sub(actualCostBrl)
          .toFixed(2),
        completedAt: new Date(),
      },
    });
    if (!remains)
      await tx.delivery.upsert({
        where: { orderId_lineCode: { orderId: id, lineCode: 'smm-result' } },
        create: {
          orderId: id,
          lineCode: 'smm-result',
          type: 'SMM',
          encryptedContent: encrypt(
            `Serviço concluído pelo provedor. Pedido ${order.smmOrderId}. Quantidade: ${body.quantity}.`,
          ),
        },
        update: {},
      });
    else
      await smmNotice(
        tx,
        order,
        'settled',
        `Pedido ${id.slice(0, 8)} ${cancelled ? 'cancelado' : 'concluído parcialmente'}. Entregues: ${body.quantity - remains} de ${body.quantity}. R$ ${refund.toFixed(2)} devolvidos à carteira.`,
      );
  });
}
export async function linkSmmOrder(id: string, externalId: string, actorId: string) {
  const order = await db.order.findUniqueOrThrow({ where: { id } });
  if (
    order.source !== 'SMM' ||
    order.smmOrderId ||
    order.reservationSettled ||
    !['REVIEW', 'UNKNOWN', 'PROCESSING'].includes(order.status)
  )
    throw new AppError(
      'SMM_LINK_NOT_ALLOWED',
      'Este pedido não está aguardando identificação no provedor.',
      409,
    );
  await smm.status(await smmProvider(order.smmProviderId!, false), externalId);
  await transaction(async (tx) => {
    await tx.order.update({
      where: { id },
      data: {
        smmOrderId: externalId,
        externalOrderCode: `smm:${order.smmProviderId}:${externalId}`,
        status: 'PROCESSING',
        errorCode: null,
        lastSmmPollAt: null,
      },
    });
    await tx.auditLog.create({
      data: { actorId, action: 'smm.order.link', target: id, metadata: { externalId } },
    });
  });
  await processSmmOrder(id, true);
  return { ok: true };
}
export async function releaseUnsentSmmOrder(id: string, actorId: string, reason: string) {
  const order = await db.order.findUniqueOrThrow({ where: { id } });
  if (
    order.status === 'FAILED' &&
    order.reservationSettled &&
    order.errorCode === 'SMM_ADMIN_CONFIRMED_NOT_CREATED'
  )
    return { ok: true };
  if (
    order.source !== 'SMM' ||
    order.smmOrderId ||
    order.reservationSettled ||
    !['REVIEW', 'UNKNOWN'].includes(order.status)
  )
    throw new AppError(
      'SMM_RELEASE_NOT_ALLOWED',
      'Apenas um pedido SMM sem identificação e em revisão pode ter a reserva liberada após conferência.',
      409,
    );
  await failOrder(id, 'SMM_ADMIN_CONFIRMED_NOT_CREATED', actorId, reason);
  return { ok: true };
}
