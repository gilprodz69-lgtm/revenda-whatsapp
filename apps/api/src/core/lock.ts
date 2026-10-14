import { randomUUID } from 'node:crypto';
import { redis } from './db.js';
import { AppError } from './errors.js';
export async function withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  if (!(await redis.set(key, token, 'PX', 120000, 'NX')))
    throw new AppError('BUSY', 'Processamento já em andamento.', 409);
  const heartbeat = setInterval(() => {
    void redis
      .eval(
        "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],120000) end return 0",
        1,
        key,
        token,
      )
      .catch(() => undefined);
  }, 30000);
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    await redis.eval(
      "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
      1,
      key,
      token,
    );
  }
}
