import { Worker } from 'bullmq';
import { db, redis } from './core/db.js';
import {
  queueConnection,
  incomingQueue,
  orderQueue,
  outgoingQueue,
  maintenanceQueue,
  paymentQueue,
} from './core/queues.js';
import { processIncoming } from './modules/conversation.js';
import { processOrder } from './modules/orders.js';
import { prepareDeliveries, dispatchMessage } from './modules/messaging.js';
import { syncCatalog } from './modules/catalog.js';
import { refreshExchange } from './modules/exchange.js';
import { recoverPaymentCreation, reconcilePayment } from './modules/payments.js';
import { decrypt } from './core/crypto.js';
import { saveSetting } from './core/settings.js';
import { AppError } from './core/errors.js';
import { withLock } from './core/lock.js';
import { evolution } from './integrations/evolution.js';
import { recordEventFailure } from './modules/events.js';
import { notifyOutgoing } from './core/dispatch.js';
import { syncAllSmm } from './modules/smm-catalog.js';

async function processEvent(id: string) {
  const event = await db.webhookEvent.findUniqueOrThrow({ where: { id } });
  if (event.processedAt) return;
  if (event.source === 'pix') {
    const body = JSON.parse(decrypt(event.encryptedPayload)) as { paymentId: string };
    await reconcilePayment(body.paymentId);
  } else {
    const payload = JSON.parse(decrypt(event.encryptedPayload)) as {
      event: string;
      instance: string;
      data: Record<string, unknown>;
    };
    const kind = payload.event.toLowerCase().replaceAll('_', '.');
    if (kind === 'messages.upsert') {
      await processIncoming(id);
      return;
    }
    if (kind === 'connection.update') {
      const live = await evolution.state(payload.instance);
      const state = (live.instance as { state?: string } | undefined)?.state ?? 'error';
      await db.whatsappInstance.updateMany({ where: { name: payload.instance }, data: { state } });
    }
    if (kind === 'qrcode.updated')
      await saveSetting(`qr.${payload.instance}`, payload.data as never, true);
  }
  await db.webhookEvent.update({ where: { id }, data: { processedAt: new Date() } });
}
async function pump() {
  await redis.set('worker:heartbeat', new Date().toISOString(), 'EX', 60);
  await prepareDeliveries();
  const events = await db.webhookEvent.findMany({
    where: { processedAt: null, failedAt: null },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  for (const event of events) {
    const prior = await incomingQueue.getJob(`event-${event.id}`);
    if (prior && (await prior.getState()) === 'failed') {
      await recordEventFailure(event.id, 'EVENT_RETRY_EXHAUSTED', true);
      continue;
    }
    await incomingQueue.add('process', { id: event.id }, { jobId: `event-${event.id}` });
  }
  const orders = await db.order.findMany({
    where: {
      status: { in: ['RESERVED', 'PROCESSING', 'UNKNOWN'] },
      updatedAt: { lt: new Date(Date.now() - 15000) },
      OR: [
        { source: 'PARTNER' },
        {
          source: 'SMM',
          OR: [{ lastSmmPollAt: null }, { lastSmmPollAt: { lt: new Date(Date.now() - 60000) } }],
        },
      ],
    },
    take: 50,
  });
  for (const order of orders)
    await orderQueue.add(
      'purchase',
      { id: order.id },
      { jobId: `order-${order.id}-${Math.floor(Date.now() / 300000)}` },
    );
  await notifyOutgoing();
  const stale = await db.message.findMany({
    where: { status: 'SENDING', updatedAt: { lt: new Date(Date.now() - 180000) } },
    select: { id: true },
  });
  for (const message of stale)
    await db.$transaction([
      db.message.update({ where: { id: message.id }, data: { status: 'UNKNOWN' } }),
      db.delivery.updateMany({ where: { messageId: message.id }, data: { status: 'UNKNOWN' } }),
    ]);
}
async function pollPayments() {
  const rows = await db.payment.findMany({
    where: {
      status: { in: ['CREATING', 'PENDING', 'EXPIRED', 'APPROVED'] },
      createdAt: { gt: new Date(Date.now() - 7 * 86400000) },
      updatedAt: { lt: new Date(Date.now() - 60000) },
    },
    take: 100,
    orderBy: { updatedAt: 'asc' },
  });
  for (const row of rows)
    await paymentQueue.add(
      'reconcile',
      { id: row.id },
      { jobId: `payment-${row.id}-${Math.floor(Date.now() / 60000)}` },
    );
}
const workers = [
  new Worker(
    'payments',
    (job) =>
      withLock(`payment:${job.data.id}`, async () => {
        const row = await db.payment.findUniqueOrThrow({ where: { id: job.data.id } });
        try {
          if (row.gatewayId) await reconcilePayment(row.gatewayId);
          else await recoverPaymentCreation(row.id);
        } catch (e) {
          await db.payment.update({
            where: { id: row.id },
            data: {
              updatedAt: new Date(),
              ...(row.status === 'CREATING' && row.expiresAt && row.expiresAt < new Date()
                ? { status: 'REVIEW' as const }
                : {}),
            },
          });
          throw e;
        }
      }),
    { connection: queueConnection, concurrency: 2, limiter: { max: 60, duration: 60000 } },
  ),
  new Worker('incoming', (job) => processEvent(job.data.id), {
    connection: queueConnection,
    concurrency: 1,
  }),
  new Worker(
    'orders',
    (job) =>
      withLock(`order:${job.data.id}`, async () => {
        await processOrder(job.data.id);
        await prepareDeliveries();
        await notifyOutgoing();
      }),
    {
      connection: queueConnection,
      concurrency: 2,
    },
  ),
  new Worker('outgoing', (job) => dispatchMessage(job.data.id), {
    connection: queueConnection,
    concurrency: 1,
    limiter: { max: 20, duration: 60000 },
  }),
  new Worker(
    'maintenance',
    async (job) => {
      if (job.name === 'pump') await pump();
      else if (job.name === 'catalog') await syncCatalog();
      else if (job.name === 'smm-catalog') await syncAllSmm();
      else if (job.name === 'exchange') await refreshExchange();
      else if (job.name === 'payments') await pollPayments();
      else if (job.name === 'retention') {
        await db.adminSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
        await db.apiRequestLog.deleteMany({
          where: { createdAt: { lt: new Date(Date.now() - 30 * 86400000) } },
        });
        await db.webhookEvent.deleteMany({
          where: {
            processedAt: { not: null },
            createdAt: { lt: new Date(Date.now() - 30 * 86400000) },
          },
        });
      }
    },
    { connection: queueConnection, concurrency: 2 },
  ),
];
for (const worker of workers) {
  worker.on('failed', (job, error) => {
    if (worker.name === 'incoming' && job)
      void recordEventFailure(
        job.data.id,
        error instanceof AppError ? error.code : 'INTERNAL',
        job.attemptsMade >= (job.opts.attempts ?? 1),
      ).catch(() => undefined);
  });
  worker.on('failed', (job, error) =>
    console.error(
      JSON.stringify({
        event: 'job.failed',
        queue: worker.name,
        id: job?.id,
        code: error instanceof AppError ? error.code : 'INTERNAL',
      }),
    ),
  );
  worker.on('error', () =>
    console.error(JSON.stringify({ event: 'worker.error', queue: worker.name })),
  );
}
await maintenanceQueue.upsertJobScheduler('pump', { every: 15000 }, { name: 'pump', data: {} });
await maintenanceQueue.upsertJobScheduler(
  'catalog',
  { every: 120000 },
  { name: 'catalog', data: {} },
);
await maintenanceQueue.upsertJobScheduler(
  'smm-catalog',
  { every: 120000 },
  { name: 'smm-catalog', data: {} },
);
await maintenanceQueue.upsertJobScheduler(
  'exchange',
  { every: 3600000 },
  { name: 'exchange', data: {} },
);
await maintenanceQueue.upsertJobScheduler(
  'payments',
  { every: 60000 },
  { name: 'payments', data: {} },
);
await maintenanceQueue.upsertJobScheduler(
  'retention',
  { every: 86400000 },
  { name: 'retention', data: {} },
);
await pump();
console.log(JSON.stringify({ event: 'worker.ready' }));
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all([
      incomingQueue.close(),
      orderQueue.close(),
      outgoingQueue.close(),
      maintenanceQueue.close(),
      paymentQueue.close(),
    ]);
    await redis.quit();
    await db.$disconnect();
    process.exit(0);
  });
