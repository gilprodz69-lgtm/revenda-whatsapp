import { db } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { env } from '../config.js';
import { Prisma } from '@prisma/client';
export async function setting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.setting.findUnique({ where: { key } });
  if (!row) return fallback;
  return (row.encrypted ? JSON.parse(decrypt(row.value as string)) : row.value) as T;
}
export async function saveSetting(key: string, value: Prisma.InputJsonValue, encrypted = false) {
  const stored = encrypted ? encrypt(JSON.stringify(value)) : value;
  return db.setting.upsert({
    where: { key },
    create: { key, value: stored, encrypted },
    update: { value: stored, encrypted },
  });
}
export async function credentials() {
  return {
    partnerKey: await setting('secret.partnerKey', env.PARTNER_API_KEY),
    expayApiKey: await setting('secret.expayApiKey', env.EXPAY_API_KEY),
    mpToken: await setting('secret.mpToken', env.MP_ACCESS_TOKEN),
    mpWebhookSecret: await setting('secret.mpWebhookSecret', env.MP_WEBHOOK_SECRET),
  };
}
