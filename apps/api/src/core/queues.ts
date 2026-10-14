import { Queue } from 'bullmq';
import { env } from '../config.js';
export const queueConnection = { url: env.REDIS_URL };
const defaults = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 15000 },
  removeOnComplete: 500,
  removeOnFail: 1000,
};
export const incomingQueue = new Queue('incoming', {
  connection: queueConnection,
  defaultJobOptions: defaults,
});
export const orderQueue = new Queue('orders', {
  connection: queueConnection,
  defaultJobOptions: { ...defaults, backoff: { type: 'exponential', delay: 60000 } },
});
export const outgoingQueue = new Queue('outgoing', {
  connection: queueConnection,
  defaultJobOptions: { ...defaults, attempts: 1, removeOnComplete: true },
});
export const maintenanceQueue = new Queue('maintenance', {
  connection: queueConnection,
  defaultJobOptions: { ...defaults, attempts: 3 },
});
export const paymentQueue = new Queue('payments', {
  connection: queueConnection,
  defaultJobOptions: { ...defaults, attempts: 3, backoff: { type: 'exponential', delay: 30000 } },
});
