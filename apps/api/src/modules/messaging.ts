import { db, transaction } from '../core/db.js';
import { decrypt, encrypt } from '../core/crypto.js';
import { evolution, InteractiveRejected } from '../integrations/evolution.js';
import { AppError } from '../core/errors.js';
import { messageTemplate } from './templates.js';
import { interactiveSchema } from './interactive.js';
import { setting } from '../core/settings.js';

export async function prepareDeliveries() {
  const rows = await db.delivery.findMany({
    where: { messageId: null, status: 'PENDING', order: { status: 'COMPLETED' } },
    include: { order: true },
    take: 100,
  });
  for (const row of rows)
    await transaction(async (tx) => {
      const current = await tx.delivery.findUniqueOrThrow({ where: { id: row.id } });
      if (current.messageId) return;
      const item = await tx.orderItem.findFirstOrThrow({ where: { orderId: row.orderId } });
      const message = await tx.message.upsert({
        where: { key: `delivery-${row.id}` },
        create: {
          key: `delivery-${row.id}`,
          instanceName: row.order.instanceName,
          customerId: row.order.customerId,
          direction: 'OUT',
          encryptedText: encrypt(
            `${await messageTemplate('completed', { pedido: row.order.id.slice(0, 8), produto: item.name })}\n\n${decrypt(row.encryptedContent)}`,
          ),
        },
        update: {},
      });
      await tx.delivery.update({ where: { id: row.id }, data: { messageId: message.id } });
    });
}
export async function dispatchMessage(id: string) {
  const row = await db.message.findUniqueOrThrow({
    where: { id },
    include: { customer: true, instance: true },
  });
  if (row.status !== 'PENDING' || row.direction !== 'OUT' || row.instance.state !== 'open') return;
  const claimed = await db.message.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'SENDING' },
  });
  if (!claimed.count) return;
  await db.delivery.updateMany({
    where: { messageId: id },
    data: { status: 'SENDING', attempts: { increment: 1 } },
  });
  try {
    const sendText = () =>
      evolution.sendText(row.instanceName, row.customer.phone, decrypt(row.encryptedText));
    const sendMenu = async () => {
      if (
        !row.encryptedInteractive ||
        (await setting('bot.messageStyle', 'interactive')) === 'text'
      )
        return sendText();
      try {
        return await evolution.sendInteractive(
          row.instanceName,
          row.customer.phone,
          interactiveSchema.parse(JSON.parse(decrypt(row.encryptedInteractive))),
        );
      } catch (e) {
        if (!(e instanceof InteractiveRejected)) throw e;
        console.warn(JSON.stringify({ event: 'interactive.rejected', instance: row.instanceName }));
        return sendText();
      }
    };
    const result = row.encryptedMedia
      ? await evolution.sendMedia(
          row.instanceName,
          row.customer.phone,
          decrypt(row.encryptedMedia),
          row.mediaType === 'document' ? 'document' : 'image',
          row.fileName ?? undefined,
          decrypt(row.encryptedText),
        )
      : await sendMenu();
    const externalMessageId = (result.key as { id?: string } | undefined)?.id;
    if (!externalMessageId)
      throw new AppError('SEND_UNKNOWN', 'Confirmação técnica de envio ausente.');
    await transaction(async (tx) => {
      await tx.message.update({ where: { id }, data: { status: 'SENT', externalMessageId } });
      await tx.delivery.updateMany({
        where: { messageId: id },
        data: { status: 'SENT', sentAt: new Date() },
      });
    });
  } catch (e) {
    await db.message.update({ where: { id }, data: { status: 'UNKNOWN' } });
    await db.delivery.updateMany({ where: { messageId: id }, data: { status: 'UNKNOWN' } });
    // Evolution has no documented send idempotency. Automatic retries would risk duplicate credentials.
    throw e;
  }
}
export async function controlledResend(deliveryId: string, actorId: string, reason: string) {
  return transaction(async (tx) => {
    const delivery = await tx.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
      include: { order: true },
    });
    if (delivery.order.status !== 'COMPLETED')
      throw new AppError('RESEND_NOT_ALLOWED', 'Pedido não concluído.', 409);
    const message = await tx.message.create({
      data: {
        key: `resend-${deliveryId}-${crypto.randomUUID()}`,
        instanceName: delivery.order.instanceName,
        customerId: delivery.order.customerId,
        direction: 'OUT',
        encryptedText: encrypt(
          `Reenvio solicitado do pedido ${delivery.order.id.slice(0, 8)}\n\n${decrypt(delivery.encryptedContent)}`,
        ),
      },
    });
    await tx.delivery.update({
      where: { id: deliveryId },
      data: { messageId: message.id, status: 'PENDING' },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'delivery.resend',
        target: deliveryId,
        metadata: { reason, recipient: delivery.order.customerId },
      },
    });
    return { messageId: message.id };
  });
}
