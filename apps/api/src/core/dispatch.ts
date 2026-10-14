import { db } from './db.js';

// PostgreSQL is authoritative. Queue notifications accelerate processing after commit;
// the periodic recovery still handles Redis outages or a crash between commit and enqueue.
async function notify(work: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('QUEUE_HANDOFF_TIMEOUT')), 1000);
        timer.unref();
      }),
    ]);
  } catch {
    console.warn(JSON.stringify({ event: 'dispatch.deferred' }));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function notifyIncoming(event: {
  id: string;
  processedAt: Date | null;
  failedAt: Date | null;
}) {
  if (event.processedAt || event.failedAt) return;
  await notify(async () => {
    const { incomingQueue } = await import('./queues.js');
    await incomingQueue.add('process', { id: event.id }, { jobId: `event-${event.id}` });
  });
}
export async function notifyOutgoing(filter: { customerId?: string; instanceName?: string } = {}) {
  await notify(async () => {
    const rows = await db.message.findMany({
      where: { ...filter, direction: 'OUT', status: 'PENDING', instance: { state: 'open' } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    if (!rows.length) return;
    const { outgoingQueue } = await import('./queues.js');
    await outgoingQueue.addBulk(
      rows.map((row) => ({
        name: 'send',
        data: { id: row.id },
        opts: { jobId: `send-${row.id}` },
      })),
    );
  });
}
export async function notifyOrder(id: string) {
  await notify(async () => {
    const { orderQueue } = await import('./queues.js');
    await orderQueue.add('purchase', { id }, { jobId: `order-${id}` });
  });
}
