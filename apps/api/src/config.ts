import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url(),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/i),
  WEBHOOK_SECRET: z.string().min(32),
  EVOLUTION_URL: z.string().url().default('http://evolution:8080'),
  EVOLUTION_API_KEY: z.string().min(16),
  PARTNER_URL: z.string().url().default('https://ggsoma.store/api/partner/v1'),
  PARTNER_API_KEY: z.string().default(''),
  PARTNER_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(60),
  PARTNER_ORDERS_PER_MINUTE: z.coerce.number().int().positive().default(10),
  PIX_GATEWAY: z.enum(['disabled', 'expay', 'mercadopago']).default('disabled'),
  EXPAY_API_KEY: z.string().default(''),
  EXPAY_STORE_ID: z.string().default(''),
  MP_ACCESS_TOKEN: z.string().default(''),
  MP_WEBHOOK_SECRET: z.string().default(''),
  MP_PAYER_EMAIL: z.string().email().optional(),
  PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
});
export const env = schema.parse(process.env);
if (env.NODE_ENV === 'production' && !env.APP_ORIGIN.startsWith('https://'))
  throw new Error('APP_ORIGIN deve usar HTTPS em produção.');
