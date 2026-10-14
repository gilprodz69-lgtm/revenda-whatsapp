import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db, transaction } from '../core/db.js';
import { encrypt, decrypt } from '../core/crypto.js';
import { AppError } from '../core/errors.js';
import { env } from '../config.js';
import { pixGateway, type PixPayer, type PixCharge } from '../integrations/pix.js';
import { mutateWallet } from './wallet.js';
import { messageTemplate } from './templates.js';

export async function createDeposit(
  customerId: string,
  instanceName: string,
  amount: string,
  payer: PixPayer,
  key: string,
) {
  const gateway = await pixGateway();
  const value = new Prisma.Decimal(amount);
  if (value.lt(1) || value.gt(10000) || value.decimalPlaces() > 2)
    throw new AppError('INVALID_AMOUNT', 'Valor entre R$ 1,00 e R$ 10.000,00.');
  const id = randomUUID(),
    expires = new Date(Date.now() + 3600000);
  // Monetary JSON token is serialized from Decimal, without a floating point calculation.
  const customer = await db.customer.findUniqueOrThrow({ where: { id: customerId } });
  const request = await gateway.buildRequest({
    reference: id,
    amount: value.toFixed(2),
    payer: { ...payer, name: customer.name.slice(0, 255) },
    expiresAt: expires,
  });
  const payment = await db.payment.upsert({
    where: { idempotencyKey: key },
    create: {
      id,
      idempotencyKey: key,
      customerId,
      instanceName,
      gateway: gateway.name,
      amountBrl: value,
      expiresAt: expires,
      encryptedRequestBody: encrypt(request),
    },
    update: {},
  });
  if (payment.customerId !== customerId || !payment.amountBrl.equals(value))
    throw new AppError('IDEMPOTENCY_CONFLICT', 'Cobrança já existente com outros dados.', 409);
  await recoverPaymentCreation(payment.id);
  return db.payment.findUniqueOrThrow({ where: { id: payment.id } });
}
export async function recoverPaymentCreation(id: string) {
  const payment = await db.payment.findUniqueOrThrow({ where: { id } });
  if (payment.status !== 'CREATING') return;
  const gateway = await pixGateway();
  if (gateway.name !== payment.gateway)
    throw new AppError('GATEWAY_CHANGED', 'Reative o gateway original para reconciliar.', 409);
  const charge = await gateway.create(
    decrypt(payment.encryptedRequestBody),
    payment.idempotencyKey,
  );
  validateCharge(payment, charge);
  await db.payment.updateMany({
    where: { id, status: 'CREATING' },
    data: {
      gatewayId: charge.id,
      status: 'PENDING',
      encryptedPixCode: charge.pixCode ? encrypt(charge.pixCode) : null,
      encryptedQrImage: charge.qrBase64 ? encrypt(charge.qrBase64) : null,
      expiresAt: charge.expiresAt ?? (gateway.name === 'expay' ? null : payment.expiresAt),
    },
  });
  await reconcilePayment(charge.id);
}
function validateCharge(
  payment: { id: string; amountBrl: Prisma.Decimal; gatewayId: string | null },
  charge: PixCharge,
) {
  if (
    charge.reference !== payment.id ||
    !payment.amountBrl.equals(charge.amount) ||
    charge.currency !== 'BRL' ||
    charge.method !== 'pix' ||
    (payment.gatewayId && payment.gatewayId !== charge.id)
  )
    throw new AppError('PAYMENT_MISMATCH', 'Cobrança divergente. Revisão necessária.', 409);
  if (env.NODE_ENV === 'production' && charge.liveMode === false)
    throw new AppError(
      'TEST_PAYMENT_REJECTED',
      'Pagamento de teste não pode creditar produção.',
      409,
    );
}
export async function reconcilePayment(gatewayId: string) {
  const gateway = await pixGateway(),
    charge = await gateway.get(gatewayId);
  // Bind the response to the ID we actually requested, then validate its local reference.
  // Unknown IDs are recovered through the original idempotent creation, never by reference alone.
  const payment = await db.payment.findUnique({ where: { gatewayId } });
  if (!payment || payment.gateway !== gateway.name) return;
  validateCharge(payment, charge);
  await transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${payment.id} FOR UPDATE`;
    const current = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    if (charge.status === 'approved') {
      if (current.creditedAt) {
        await tx.payment.update({ where: { id: current.id }, data: { updatedAt: new Date() } });
        return;
      }
      await mutateWallet(tx, {
        customerId: current.customerId,
        key: `payment-${current.id}`,
        kind: 'DEPOSIT',
        availableDelta: current.amountBrl.toString(),
        reservedDelta: '0',
        reference: current.id,
        reason: 'Pix confirmado pelo gateway',
      });
      await tx.payment.update({
        where: { id: current.id },
        data: { status: 'APPROVED', gatewayId, creditedAt: new Date() },
      });
      await tx.message.upsert({
        where: { key: `payment-approved-${current.id}` },
        create: {
          key: `payment-approved-${current.id}`,
          customerId: current.customerId,
          instanceName: current.instanceName,
          direction: 'OUT',
          encryptedText: encrypt(
            await messageTemplate('paymentConfirmed', { valor: current.amountBrl.toFixed(2) }),
          ),
        },
        update: {},
      });
    } else if (
      current.creditedAt &&
      ['refunded', 'charged_back', 'cancelled'].includes(charge.status)
    ) {
      await tx.payment.update({ where: { id: current.id }, data: { status: 'REVIEW' } });
      await tx.customer.update({ where: { id: current.customerId }, data: { blocked: true } });
    } else if (!current.creditedAt && ['cancelled', 'rejected', 'refunded'].includes(charge.status))
      await tx.payment.update({ where: { id: current.id }, data: { status: 'CANCELLED' } });
    else if (
      !current.creditedAt &&
      (charge.status === 'expired' || (current.expiresAt && current.expiresAt < new Date()))
    ) {
      await tx.payment.update({ where: { id: current.id }, data: { status: 'EXPIRED' } });
      await tx.message.upsert({
        where: { key: `payment-expired-${current.id}` },
        create: {
          key: `payment-expired-${current.id}`,
          customerId: current.customerId,
          instanceName: current.instanceName,
          direction: 'OUT',
          encryptedText: encrypt(
            await messageTemplate('paymentExpired', { valor: current.amountBrl.toFixed(2) }),
          ),
        },
        update: {},
      });
    } else await tx.payment.update({ where: { id: current.id }, data: { updatedAt: new Date() } });
  });
}
