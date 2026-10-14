import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { db, redis } from '../core/db.js';
import { env } from '../config.js';
import { credentials } from '../core/settings.js';
import { hash } from '../core/crypto.js';
import { AppError, PartnerError } from '../core/errors.js';
import {
  providerSchema,
  productSchema,
  orderResponseSchema,
  orderSummarySchema,
} from './partner-contract.js';

const rateScript = `
local now=tonumber(ARGV[1]); local cutoff=now-60000
for i=1,2 do redis.call('ZREMRANGEBYSCORE',KEYS[i],'-inf',cutoff) end
if redis.call('EXISTS',KEYS[3])==1 then return 0 end
if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[2]) then return 0 end
if ARGV[4]=='1' and redis.call('ZCARD',KEYS[2])>=tonumber(ARGV[3]) then return 0 end
redis.call('ZADD',KEYS[1],now,ARGV[5]); redis.call('PEXPIRE',KEYS[1],61000)
if ARGV[4]=='1' then redis.call('ZADD',KEYS[2],now,ARGV[5]); redis.call('PEXPIRE',KEYS[2],61000) end
return 1`;

export class PartnerApiService {
  async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const { partnerKey } = await credentials();
    if (path !== '/health' && !partnerKey)
      throw new AppError('PARTNER_NOT_CONFIGURED', 'Configure a chave da Partner API.', 503);
    const prefix = `partner:${hash(partnerKey).slice(0, 20)}`;
    const totalLimit =
      Number(await redis.get(`${prefix}:totalLimit`)) || env.PARTNER_REQUESTS_PER_MINUTE;
    const orderLimit =
      Number(await redis.get(`${prefix}:orderLimit`)) || env.PARTNER_ORDERS_PER_MINUTE;
    const admitted = await redis.eval(
      rateScript,
      3,
      `${prefix}:total`,
      `${prefix}:orders`,
      `${prefix}:cooldown`,
      Date.now(),
      totalLimit,
      orderLimit,
      method === 'POST' ? 1 : 0,
      randomUUID(),
    );
    if (!admitted) throw new PartnerError('RATE_LIMIT_EXCEEDED', undefined, 429);
    const started = Date.now();
    let status: number | undefined, code: string | undefined, requestId: string | undefined;
    try {
      const response = await fetch(`${env.PARTNER_URL}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(path === '/health' ? {} : { Authorization: `Bearer ${partnerKey}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      status = response.status;
      // Lower advertised caps are honored conservatively. Unknown headers never increase our configured caps.
      const cap = Number(response.headers.get('x-ratelimit-limit'));
      if (cap > 0 && cap < totalLimit) await redis.set(`${prefix}:totalLimit`, cap, 'EX', 3600);
      const orderCap = Number(response.headers.get('x-ratelimit-orders-limit'));
      if (orderCap > 0 && orderCap < orderLimit)
        await redis.set(`${prefix}:orderLimit`, orderCap, 'EX', 3600);
      if (status === 429) {
        const retry = response.headers.get('retry-after');
        const seconds =
          retry && /^\d+$/.test(retry)
            ? Number(retry)
            : retry
              ? Math.ceil((Date.parse(retry) - Date.now()) / 1000)
              : 60;
        await redis.set(
          `${prefix}:cooldown`,
          '1',
          'EX',
          Math.max(60, Math.min(seconds || 60, 86400)),
        );
      }
      const json = (await response.json()) as {
        ok?: boolean;
        error?: { code?: string; requestId?: string };
      };
      if (!response.ok || (path !== '/health' && json.ok === false)) {
        code = typeof json.error === 'object' ? json.error?.code : undefined;
        requestId = typeof json.error === 'object' ? json.error?.requestId : undefined;
        throw new PartnerError(
          code ?? 'FAILED',
          requestId,
          response.status,
          method === 'POST' && (response.status >= 500 || !code || code === 'FAILED'),
        );
      }
      return json;
    } catch (error) {
      if (error instanceof PartnerError) throw error;
      code = 'TRANSPORT_UNKNOWN';
      throw new PartnerError(code, requestId, 503, method === 'POST');
    } finally {
      await db.apiRequestLog
        .create({
          data: {
            service: 'partner',
            method,
            route: path.split('?')[0]!,
            status,
            code,
            requestId,
            durationMs: Date.now() - started,
          },
        })
        .catch(() => undefined);
    }
  }
  async read<T>(path: string, schema: z.ZodType<T>, cacheSeconds = 0): Promise<T> {
    const { partnerKey } = await credentials();
    const key = `partner-cache:${hash(partnerKey)}:${path}`;
    if (cacheSeconds) {
      const cached = await redis.get(key);
      if (cached) return schema.parse(JSON.parse(cached));
    }
    for (let i = 0; ; i++) {
      try {
        const data = schema.parse(await this.request(path));
        if (cacheSeconds) await redis.set(key, JSON.stringify(data), 'EX', cacheSeconds);
        return data;
      } catch (e) {
        if (
          i >= 2 ||
          !(e instanceof PartnerError) ||
          !['MAINTENANCE', 'TRANSPORT_UNKNOWN'].includes(e.code)
        )
          throw e;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** i));
      }
    }
  }
  health() {
    return this.read(
      '/health',
      z.object({
        ok: z.boolean(),
        service: z.string(),
        version: z.number(),
        error: z.string().optional(),
      }),
    );
  }
  balance() {
    return this.read(
      '/balance',
      z.object({ ok: z.literal(true), balance: z.string(), currency: z.literal('USD') }),
      30,
    );
  }
  providers() {
    return this.read('/catalog/providers', z.object({ data: z.array(providerSchema) }), 60);
  }
  products(provider?: string) {
    return this.read(
      `/catalog/products${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`,
      z.object({ data: z.array(productSchema) }),
      60,
    );
  }
  product(ref: string) {
    return this.read(`/catalog/products/${encodeURIComponent(ref)}`, productSchema);
  }
  createOrder(body: { productSlug: string; quantity: number; externalOrderId: string }) {
    return this.request('/orders', 'POST', body).then((data) => orderResponseSchema.parse(data));
  }
  orders(
    query: {
      page?: number;
      limit?: number;
      externalOrderId?: string;
      status?: string;
      productSlug?: string;
    } = {},
  ) {
    const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
    return this.read(
      `/orders?${params}`,
      z.object({
        data: z.array(orderSummarySchema),
        meta: z.object({
          page: z.number(),
          limit: z.number(),
          total: z.number(),
          totalPages: z.number(),
        }),
      }),
    );
  }
  order(code: string) {
    return this.read(`/orders/${encodeURIComponent(code)}`, orderResponseSchema);
  }
  usage() {
    return this.read(
      '/usage',
      z.object({
        balance: z.string(),
        currency: z.literal('USD'),
        apiOrdersTotal: z.number(),
        apiSpendTotal: z.string(),
        apiOrders24h: z.number(),
        apiSpend24h: z.string(),
        requestCountToday: z.number(),
        errorCountToday: z.number(),
      }),
      60,
    );
  }
}
export const partner = new PartnerApiService();
