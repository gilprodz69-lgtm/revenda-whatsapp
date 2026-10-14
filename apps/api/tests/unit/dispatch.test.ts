import { beforeEach, it, expect, vi } from 'vitest';
vi.mock('../../src/core/db.js', () => ({ db: { message: { findMany: vi.fn() } } }));
vi.mock('../../src/core/queues.js', () => ({
  incomingQueue: { add: vi.fn() },
  outgoingQueue: { addBulk: vi.fn() },
  orderQueue: { add: vi.fn() },
}));
import { db } from '../../src/core/db.js';
import { incomingQueue, outgoingQueue } from '../../src/core/queues.js';
import { notifyIncoming, notifyOutgoing } from '../../src/core/dispatch.js';
beforeEach(() => vi.resetAllMocks());
it('não reativa eventos já processados ou separados para revisão', async () => {
  await notifyIncoming({ id: 'done', processedAt: new Date(), failedAt: null });
  await notifyIncoming({ id: 'review', processedAt: null, failedAt: new Date() });
  expect(incomingQueue.add).not.toHaveBeenCalled();
  await notifyIncoming({ id: 'new', processedAt: null, failedAt: null });
  expect(incomingQueue.add).toHaveBeenCalledWith('process', { id: 'new' }, { jobId: 'event-new' });
});
it('tolera falha no Redis para permitir recuperação pelo registro persistido', async () => {
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(incomingQueue.add).mockRejectedValueOnce(new Error('Redis unavailable'));
  await expect(
    notifyIncoming({ id: 'saved', processedAt: null, failedAt: null }),
  ).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'dispatch.deferred' }));
  log.mockRestore();
});
it('encaminha respostas persistidas com identificação estável para deduplicar', async () => {
  vi.mocked(db.message.findMany).mockResolvedValue([{ id: 'reply' }] as never);
  await notifyOutgoing({ customerId: 'customer', instanceName: 'store' });
  expect(outgoingQueue.addBulk).toHaveBeenCalledWith([
    { name: 'send', data: { id: 'reply' }, opts: { jobId: 'send-reply' } },
  ]);
  expect(db.message.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        customerId: 'customer',
        instanceName: 'store',
        direction: 'OUT',
        status: 'PENDING',
        instance: { state: 'open' },
      },
    }),
  );
});
