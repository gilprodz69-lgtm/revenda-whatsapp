import { Prisma } from '@prisma/client';
import { AppError } from '../core/errors.js';
import { transaction } from '../core/db.js';
export type WalletMutation = {
  customerId: string;
  key: string;
  kind: string;
  availableDelta: string;
  reservedDelta: string;
  reference: string;
  reason: string;
};
export async function mutateWallet(tx: Prisma.TransactionClient, m: WalletMutation) {
  const prior = await tx.ledgerEntry.findUnique({ where: { key: m.key } });
  if (prior) {
    const owner = await tx.wallet.findUniqueOrThrow({ where: { id: prior.walletId } });
    if (
      owner.customerId !== m.customerId ||
      prior.kind !== m.kind ||
      !prior.availableDelta.equals(m.availableDelta) ||
      !prior.reservedDelta.equals(m.reservedDelta) ||
      prior.reference !== m.reference
    )
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        'A chave financeira já foi usada com outros dados.',
        409,
      );
    return prior;
  }
  const wallet = await tx.wallet.upsert({
    where: { customerId: m.customerId },
    create: { customerId: m.customerId },
    update: {},
  });
  await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${wallet.id} FOR UPDATE`;
  const current = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
  const da = new Prisma.Decimal(m.availableDelta),
    dr = new Prisma.Decimal(m.reservedDelta);
  const available = current.available.add(da),
    reserved = current.reserved.add(dr);
  if (available.isNegative() || reserved.isNegative())
    throw new AppError('LOCAL_INSUFFICIENT_BALANCE', 'Saldo disponível insuficiente.');
  await tx.wallet.update({ where: { id: wallet.id }, data: { available, reserved } });
  return tx.ledgerEntry.create({
    data: {
      walletId: wallet.id,
      key: m.key,
      kind: m.kind,
      availableDelta: da,
      reservedDelta: dr,
      availableAfter: available,
      reservedAfter: reserved,
      reference: m.reference,
      reason: m.reason,
    },
  });
}
export async function adjustBalance(
  customerId: string,
  amount: string,
  reason: string,
  key: string,
  adminId: string,
) {
  return transaction(async (tx) => {
    const entry = await mutateWallet(tx, {
      customerId,
      key: `adjust-${key}`,
      kind: 'ADJUSTMENT',
      availableDelta: amount,
      reservedDelta: '0',
      reference: adminId,
      reason,
    });
    await tx.auditLog.create({
      data: {
        actorId: adminId,
        action: 'wallet.adjust',
        target: customerId,
        metadata: { amount, reason, key },
      },
    });
    return entry;
  });
}
