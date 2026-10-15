import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type { SmmProvider } from '@prisma/client';
import { db, redis } from '../core/db.js';
import { decrypt, hash } from '../core/crypto.js';
import { AppError } from '../core/errors.js';

export class SmmError extends AppError {
  constructor(
    public uncertain: boolean,
    code = 'SMM_UNAVAILABLE',
    message = 'Não foi possível consultar o provedor SMM. Confira a conexão e tente novamente.',
  ) {
    super(code, message, 502);
  }
}
export function smmUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== '443') ||
    isIP(url.hostname.replace(/[\[\]]/g, '')) ||
    !url.hostname.includes('.') ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)
  )
    throw new AppError(
      'SMM_URL_INVALID',
      'Use a URL HTTPS pública da API, sem chave, usuário ou parâmetros.',
    );
  return url.toString();
}
export function publicSmmAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a! >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Globally routed IPv6 unicast only. Reject mapped IPv4 and local/multicast/documentation ranges.
  return (
    isIP(address) === 6 &&
    /^[23]/i.test(address) &&
    !/^(?:2001:(?:0:|db8:|10:|20:)|2002:|3fff:)/i.test(address)
  );
}
export const smmTransport = {
  async post(endpoint: string, body: string): Promise<{ status: number; body: string }> {
    const url = new URL(smmUrl(endpoint));
    const addresses = await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some((a) => !publicSmmAddress(a.address)))
      throw new SmmError(
        false,
        'SMM_ADDRESS_INVALID',
        'O endereço da API SMM deve resolver somente para IPs públicos.',
      );
    const address = addresses[0]!;
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'POST',
          signal: AbortSignal.timeout(15000),
          family: address.family,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          },
          // Pin the validated IP for this request; TLS still verifies the original hostname.
          lookup: (_host, _options, callback) => callback(null, address.address, address.family),
        },
        (res) => {
          let text = '',
            bytes = 0;
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > 8 * 1024 * 1024) req.destroy(new Error('Response too large'));
            else text += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 502, body: text }));
          res.on('error', reject);
        },
      );
      req.setTimeout(15000, () => req.destroy(new Error('SMM timeout')));
      req.on('error', reject);
      req.end(body);
    });
  },
};
const decimal = z
  .union([z.string(), z.number()])
  .transform(String)
  .refine((v) => /^\d{1,10}(\.\d{1,8})?$/.test(v) && new Decimal(v).isFinite());
const count = z.coerce.number().int().min(0).max(2147483647);
const id = z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(String);
const flag = z
  .union([z.boolean(), z.literal(0), z.literal(1), z.literal('0'), z.literal('1')])
  .transform((v) => v === true || v === 1 || v === '1')
  .optional()
  .default(false);
export const smmServiceSchema = z.object({
  service: id,
  name: z.string().min(1),
  type: z.string(),
  category: z.string(),
  rate: decimal,
  min: count,
  max: count,
  refill: flag,
  cancel: flag,
  dripfeed: flag,
});
export type SmmService = z.infer<typeof smmServiceSchema>;
export const smmTypes = ['Default', 'Package', 'Custom Comments', 'Comment Likes', 'Poll'];
export const supportedSmmService = (service: SmmService) =>
  smmTypes.includes(service.type) &&
  new Decimal(service.rate).gt(0) &&
  (service.type === 'Package' || service.max >= Math.max(1, service.min));
export const smmStatusSchema = z.object({
  charge: decimal,
  start_count: z.union([z.string(), z.number()]).optional(),
  status: z.enum([
    'Pending',
    'Processing',
    'In progress',
    'Completed',
    'Partial',
    'Canceled',
    'Cancelled',
    'Refunded',
  ]),
  remains: count,
  currency: z.enum(['USD', 'BRL']),
});
export const smm = {
  async call(
    provider: SmmProvider,
    action: string,
    fields: Record<string, string> = {},
  ): Promise<unknown> {
    const bucket = `smm-limit:${provider.id}:${Math.floor(Date.now() / 60000)}`;
    const admitted = Number(
      await redis.eval(
        "local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],65) end;return n",
        1,
        bucket,
      ),
    );
    if (admitted > provider.requestsPerMinute)
      throw new SmmError(
        false,
        'SMM_RATE_LIMIT',
        'Limite de consultas do provedor SMM atingido. Aguarde um minuto.',
      );
    const started = Date.now();
    let status: number | undefined, code: string | undefined;
    try {
      const response = await smmTransport.post(
        provider.url,
        new URLSearchParams({
          ...fields,
          key: decrypt(provider.encryptedApiKey),
          action,
        }).toString(),
      );
      status = response.status;
      if (status < 200 || status >= 300) throw new SmmError(action === 'add');
      const body: unknown = JSON.parse(response.body);
      if (body && typeof body === 'object' && 'error' in body)
        throw new SmmError(
          false,
          'SMM_REJECTED',
          'O provedor SMM recusou a solicitação. Confira a chave, o serviço e os dados informados.',
        );
      return body;
    } catch (error) {
      code = error instanceof SmmError ? error.code : 'SMM_TRANSPORT_UNKNOWN';
      if (error instanceof SmmError) throw error;
      throw new SmmError(action === 'add', code);
    } finally {
      await db.apiRequestLog
        .create({
          data: {
            service: `smm:${provider.id}`,
            method: 'POST',
            route: action,
            status,
            code,
            durationMs: Date.now() - started,
          },
        })
        .catch(() => undefined);
    }
  },
  async services(provider: SmmProvider, fresh = false) {
    const cache = `smm-services:${provider.id}:${hash(provider.url + provider.encryptedApiKey)}`;
    const prior = fresh ? null : await redis.get(cache);
    if (prior) return z.array(smmServiceSchema).parse(JSON.parse(prior));
    const services = z
      .array(smmServiceSchema)
      .max(100000)
      .parse(await smm.call(provider, 'services'));
    await redis.set(cache, JSON.stringify(services), 'EX', 30);
    return services;
  },
  async balance(provider: SmmProvider) {
    const value = z
      .object({ balance: decimal, currency: z.enum(['USD', 'BRL']) })
      .parse(await smm.call(provider, 'balance'));
    if (value.currency !== provider.currency)
      throw new SmmError(
        false,
        'SMM_CURRENCY_CHANGED',
        'A moeda da conta SMM difere da configuração. Confira o provedor antes de vender.',
      );
    return value;
  },
  async add(provider: SmmProvider, fields: Record<string, string>) {
    const result = z.object({ order: id }).safeParse(await smm.call(provider, 'add', fields));
    if (!result.success)
      throw new SmmError(
        true,
        'SMM_ORDER_UNKNOWN',
        'O provedor não confirmou o número do pedido. É necessária revisão; o envio não será repetido.',
      );
    return result.data.order;
  },
  async status(provider: SmmProvider, order: string) {
    const value = smmStatusSchema.parse(await smm.call(provider, 'status', { order }));
    if (value.currency !== provider.currency) throw new SmmError(false, 'SMM_CURRENCY_CHANGED');
    return value;
  },
};
