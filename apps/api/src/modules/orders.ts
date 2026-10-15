import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db, transaction } from '../core/db.js';
import { AppError, PartnerError, definitiveOrderFailures } from '../core/errors.js';
import { encrypt } from '../core/crypto.js';
import { partner } from '../integrations/partner.js';
import { deliveryLines, type PartnerOrder } from '../integrations/partner-contract.js';
import { mutateWallet } from './wallet.js';
import { currentRate } from './exchange.js';
import { priceQuote, type Tier } from './pricing.js';
import { messageTemplate } from './templates.js';

export async function quoteProduct(slug: string, quantity: number) {
  const local = await db.product.findUniqueOrThrow({ where: { slug } });
  if (local.archivedAt || !local.active || !local.visible || !local.authorizedResale)
    throw new AppError('PRODUCT_UNAVAILABLE', 'Este produto não está disponível para venda.');
  const live = await partner.product(slug);
  if (live.currency !== 'USD')
    throw new AppError(
      'PRODUCT_CURRENCY_UNSUPPORTED',
      `A venda deste serviço está indisponível para a moeda ${live.currency}.`,
    );
  if (!live.stock.inStock || quantity > live.stock.count || quantity > live.stock.maxQuantity)
    throw new AppError('OUT_OF_STOCK', 'Quantidade indisponível no estoque.');
  const rate = await currentRate();
  const rule = {
    markupPercent: local.markupPercent.toString(),
    fixedMargin: local.fixedMargin.toString(),
    manualPrice: local.manualPrice?.toString(),
    promoPrice: local.promoPrice?.toString(),
    promoUntil: local.promoUntil,
    roundingStep: local.roundingStep.toString(),
    volumeDiscountPercent: local.volumeDiscountPercent.toString(),
    volumeMinQuantity: local.volumeMinQuantity,
  };
  const quote = priceQuote(
    live.yourPrice,
    live.bulkDiscount?.enabled ? live.bulkDiscount.tiers : [],
    quantity,
    rate.usdBrl.toString(),
    rule,
  );
  return {
    product: { ...local, name: local.displayName ?? local.name },
    live,
    rate,
    quantity,
    ...quote,
  };
}
export async function placeOrder(input: {
  customerId: string;
  instanceName: string;
  slug: string;
  quantity: number;
  idempotencyKey: string;
  expectedTotalBrl: string;
}) {
  const prior = await db.order.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (prior) {
    const priorBody = prior.requestBody as { productSlug: string; quantity: number };
    if (
      prior.customerId !== input.customerId ||
      priorBody.productSlug !== input.slug ||
      priorBody.quantity !== input.quantity
    )
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        'Identificador já utilizado com outros dados.',
        409,
      );
    return prior;
  }
  const quote = await quoteProduct(input.slug, input.quantity);
  if (!new Prisma.Decimal(input.expectedTotalBrl).equals(quote.totalBrl))
    throw new AppError(
      'PRICE_CHANGED',
      'O preço mudou. Consulte o resumo novamente antes de confirmar.',
      409,
    );
  const id = randomUUID();
  return transaction(async (tx) => {
    const existing = await tx.order.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      const body = existing.requestBody as { productSlug: string; quantity: number };
      if (
        existing.customerId !== input.customerId ||
        body.productSlug !== input.slug ||
        body.quantity !== input.quantity
      )
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'Identificador já utilizado com outros dados.',
          409,
        );
      return existing;
    }
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: input.customerId } });
    if (customer.blocked) throw new AppError('CUSTOMER_BLOCKED', 'Conta bloqueada para compras.');
    const local = await tx.product.findUniqueOrThrow({ where: { slug: input.slug } });
    if (local.archivedAt || !local.active || !local.visible || !local.authorizedResale)
      throw new AppError('PRODUCT_UNAVAILABLE', 'Produto desativado.');
    const order = await tx.order.create({
      data: {
        id,
        idempotencyKey: input.idempotencyKey,
        externalOrderId: `wa-${id}`,
        customerId: input.customerId,
        instanceName: input.instanceName,
        totalBrl: quote.totalBrl,
        estimatedCostUsd: quote.estimatedCostUsd,
        usdBrl: quote.rate.usdBrl,
        exchangeRateId: quote.rate.id,
        requestBody: {
          productSlug: input.slug,
          quantity: input.quantity,
          externalOrderId: `wa-${id}`,
        },
        items: {
          create: {
            productSlug: input.slug,
            name: quote.product.name,
            quantity: input.quantity,
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
      reason: 'Reserva para compra',
    });
    return order;
  });
}

async function finalizeOrder(orderId: string, external: PartnerOrder) {
  const lines = deliveryLines(external);
  return transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.reservationSettled) return order;
    const body = order.requestBody as {
      productSlug: string;
      quantity: number;
      externalOrderId: string;
    };
    if (
      external.externalOrderId !== order.externalOrderId ||
      external.quantity !== body.quantity ||
      external.product.slug !== body.productSlug
    )
      throw new AppError('PARTNER_CONTRACT_MISMATCH', 'Resposta externa divergente.', 503);
    const profit = order.totalBrl.sub(new Prisma.Decimal(external.totalCharged).mul(order.usdBrl));
    await mutateWallet(tx, {
      customerId: order.customerId,
      key: `capture-${order.id}`,
      kind: 'CAPTURE',
      availableDelta: '0',
      reservedDelta: order.totalBrl.negated().toString(),
      reference: order.id,
      reason: 'Compra externa confirmada',
    });
    for (const line of lines)
      await tx.delivery.upsert({
        where: { orderId_lineCode: { orderId, lineCode: line.lineCode } },
        create: {
          orderId,
          lineCode: line.lineCode,
          type: line.type,
          encryptedContent: encrypt(line.text),
        },
        update: {},
      });
    return tx.order.update({
      where: { id: orderId },
      data: {
        status: 'COMPLETED',
        externalOrderCode: external.orderCode,
        actualCostUsd: external.totalCharged,
        grossProfitBrl: profit,
        reservationSettled: true,
        completedAt: new Date(),
        errorCode: null,
      },
    });
  });
}
async function failOrder(orderId: string, code: string) {
  return transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.reservationSettled) return;
    await mutateWallet(tx, {
      customerId: order.customerId,
      key: `release-${order.id}`,
      kind: 'RELEASE',
      availableDelta: order.totalBrl.toString(),
      reservedDelta: order.totalBrl.negated().toString(),
      reference: order.id,
      reason: code,
    });
    await tx.order.update({
      where: { id: orderId },
      data: { status: 'FAILED', errorCode: code, reservationSettled: true },
    });
    await tx.message.upsert({
      where: { key: `order-failed-${orderId}` },
      create: {
        key: `order-failed-${orderId}`,
        instanceName: order.instanceName,
        customerId: order.customerId,
        direction: 'OUT',
        encryptedText: encrypt(await messageTemplate('failed', { pedido: orderId.slice(0, 8) })),
      },
      update: {},
    });
  });
}
export async function processOrder(id: string) {
  const order = await db.order.findUniqueOrThrow({ where: { id }, include: { attempts: true } });
  if (order.reservationSettled || ['FAILED', 'REFUNDED', 'REVIEW'].includes(order.status)) return;
  const hadPurchase = order.attempts.some((a) => a.operation === 'PURCHASE');
  const body = order.requestBody as {
    productSlug: string;
    quantity: number;
    externalOrderId: string;
  };
  let posted = false;
  try {
    if (hadPurchase) {
      const found = await partner.orders({ externalOrderId: order.externalOrderId, limit: 100 });
      if (found.data.length) {
        const match = found.data.find((o) => o.externalOrderId === order.externalOrderId);
        if (!match) throw new AppError('PARTNER_CONTRACT_MISMATCH', 'Pedido externo divergente.');
        // Bulk detail has no lines[] in the documented GET shape. Idempotent POST recovers ALL lines.
        const result =
          body.quantity > 1
            ? await partner.createOrder(body)
            : await partner.order(match.orderCode);
        await finalizeOrder(id, result);
        return;
      }
    } else {
      const health = await partner.health();
      if (!health.ok) throw new PartnerError('MAINTENANCE', undefined, 503);
      const live = await partner.product(body.productSlug);
      if (live.currency !== 'USD') {
        await failOrder(id, 'PRODUCT_CURRENCY_UNSUPPORTED');
        return;
      }
      if (
        !live.stock.inStock ||
        live.stock.count < body.quantity ||
        live.stock.maxQuantity < body.quantity
      ) {
        await failOrder(id, 'OUT_OF_STOCK');
        return;
      }
      let cost = new Prisma.Decimal(live.yourPrice);
      for (const t of (live.bulkDiscount?.enabled ? live.bulkDiscount.tiers : []) as Tier[])
        if (
          body.quantity >= t.minQuantity &&
          (t.maxQuantity === null || body.quantity <= t.maxQuantity) &&
          cost.gt(t.unitPrice)
        )
          cost = new Prisma.Decimal(t.unitPrice);
      if (cost.mul(body.quantity).gt(order.estimatedCostUsd)) {
        await failOrder(id, 'COST_CHANGED');
        return;
      }
      const balance = await partner.balance();
      if (cost.mul(body.quantity).gt(balance.balance)) {
        await failOrder(id, 'INSUFFICIENT_BALANCE');
        return;
      }
    }
    await db.orderAttempt.create({
      data: { orderId: id, operation: 'PURCHASE', outcome: 'STARTED' },
    });
    await db.order.update({ where: { id }, data: { status: 'PROCESSING' } });
    posted = true;
    const external = await partner.createOrder(body);
    await finalizeOrder(id, external);
    await db.orderAttempt
      .create({ data: { orderId: id, operation: 'RESULT', outcome: 'COMPLETED' } })
      .catch(() => undefined);
  } catch (e) {
    const code = e instanceof AppError ? e.code : 'CONTRACT_OR_INTERNAL_ERROR';
    await db.orderAttempt.create({
      data: {
        orderId: id,
        operation: 'RESULT',
        outcome: 'ERROR',
        errorCode: code,
        requestId: e instanceof PartnerError ? e.requestId : undefined,
      },
    });
    if (
      !hadPurchase &&
      e instanceof PartnerError &&
      !e.uncertain &&
      definitiveOrderFailures.has(code)
    ) {
      await failOrder(id, code);
      return;
    }
    const count = order.attempts.filter(
      (a) => a.operation === 'RESULT' && a.outcome === 'ERROR',
    ).length;
    await db.order.updateMany({
      where: { id, reservationSettled: false },
      data: {
        status: count >= 5 ? 'REVIEW' : hadPurchase || posted ? 'UNKNOWN' : 'RESERVED',
        errorCode: code,
      },
    });
    throw e;
  }
}
export async function refundOrder(id: string, reason: string, actorId: string) {
  return transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${id} FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({ where: { id } });
    if (order.status === 'REFUNDED') return order;
    if (order.status !== 'COMPLETED')
      throw new AppError('INVALID_REFUND', 'Só é possível estornar pedidos concluídos.', 409);
    const deliveries = await tx.delivery.findMany({ where: { orderId: id } });
    if (deliveries.some((d) => d.status === 'SENDING' || d.status === 'UNKNOWN'))
      throw new AppError(
        'REFUND_DELIVERY_UNCERTAIN',
        'Confira o resultado do envio antes de estornar o pedido.',
        409,
      );
    const pendingIds = deliveries
      .filter((d) => d.status === 'PENDING' && d.messageId)
      .map((d) => d.messageId!);
    await tx.message.updateMany({
      where: { id: { in: pendingIds }, status: 'PENDING' },
      data: { status: 'FAILED' },
    });
    await tx.delivery.updateMany({
      where: { orderId: id, status: 'PENDING' },
      data: { status: 'FAILED' },
    });
    await mutateWallet(tx, {
      customerId: order.customerId,
      key: `refund-${id}`,
      kind: 'REFUND',
      availableDelta: order.totalBrl.toString(),
      reservedDelta: '0',
      reference: id,
      reason,
    });
    await tx.auditLog.create({
      data: { actorId, action: 'order.refund', target: id, metadata: { reason } },
    });
    return tx.order.update({
      where: { id },
      data: {
        status: 'REFUNDED',
        grossProfitBrl: order.actualCostUsd?.mul(order.usdBrl).negated(),
      },
    });
  });
}
