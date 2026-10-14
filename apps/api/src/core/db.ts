import { PrismaClient, Prisma } from '@prisma/client';
import { Redis } from 'ioredis';
import { env } from '../config.js';
export const db = new PrismaClient({ log: [] });
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});
export async function transaction<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(work, { isolationLevel: 'Serializable', timeout: 15000 });
    } catch (e) {
      const retryable =
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.code === 'P2034' ||
          e.code === 'P2002' ||
          (e.code === 'P2010' && ['40001', '40P01'].includes(String(e.meta?.code))));
      if (retryable && attempt < 4) {
        await new Promise((r) => setTimeout(r, 30 * 2 ** attempt + Math.random() * 30));
        continue;
      }
      throw e;
    }
  }
}
export async function audit(
  actorId: string,
  action: string,
  target: string,
  metadata: Prisma.InputJsonValue = {},
) {
  return db.auditLog.create({ data: { actorId, action, target, metadata } });
}
