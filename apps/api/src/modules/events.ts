import { db } from '../core/db.js';
import { incomingQueue } from '../core/queues.js';
import { AppError } from '../core/errors.js';
export async function recordEventFailure(id: string, code: string, exhausted: boolean) {
  await db.webhookEvent.updateMany({
    where: { id, processedAt: null },
    data: {
      attempts: { increment: 1 },
      errorCode: code,
      ...(exhausted ? { failedAt: new Date() } : {}),
    },
  });
}
export async function retryEvent(id: string, actorId: string) {
  const event = await db.webhookEvent.findUniqueOrThrow({ where: { id } });
  if (event.processedAt) return { processed: true };
  if (!event.failedAt)
    throw new AppError('EVENT_NOT_FAILED', 'O evento já está em processamento.', 409);
  const prior = await incomingQueue.getJob(`event-${id}`);
  if (prior) {
    const state = await prior.getState();
    if (!['failed', 'completed'].includes(state))
      throw new AppError('EVENT_BUSY', 'O evento já está na fila.', 409);
    await prior.remove();
  }
  await db.$transaction([
    db.webhookEvent.update({
      where: { id },
      data: { failedAt: null, attempts: 0, errorCode: null },
    }),
    db.auditLog.create({ data: { actorId, action: 'event.retry', target: id, metadata: {} } }),
  ]);
  await incomingQueue.add('process', { id }, { jobId: `event-${id}` });
  return { queued: true };
}
