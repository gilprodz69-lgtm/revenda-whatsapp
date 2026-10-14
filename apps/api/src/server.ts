import { buildApp } from './app.js';
import { env } from './config.js';
import { db, redis } from './core/db.js';
import {
  incomingQueue,
  orderQueue,
  outgoingQueue,
  maintenanceQueue,
  paymentQueue,
} from './core/queues.js';
const app = await buildApp();
await app.listen({ host: '0.0.0.0', port: env.PORT });
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    await app.close();
    await Promise.all([
      incomingQueue.close(),
      orderQueue.close(),
      outgoingQueue.close(),
      maintenanceQueue.close(),
      paymentQueue.close(),
    ]);
    await db.$disconnect();
    await redis.quit();
    process.exit(0);
  });
