import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { AppError } from '../core/errors.js';
import { equalSecret } from '../core/crypto.js';
import { credentials, setting } from '../core/settings.js';
import { env } from '../config.js';
export type PixPayer = { email?: string; cpf?: string; name?: string };
export type PixRequest = { reference: string; amount: string; payer: PixPayer; expiresAt: Date };
export type PixCharge = {
  id: string;
  reference: string;
  amount: string;
  currency: string;
  status: string;
  pixCode?: string;
  qrBase64?: string;
  expiresAt?: Date;
  method: string;
  liveMode: boolean | null;
};
export interface PixGateway {
  name: string;
  requiresPayerDetails: boolean;
  buildRequest(input: PixRequest): Promise<string>;
  create(body: string, idempotencyKey: string): Promise<PixCharge>;
  get(id: string): Promise<PixCharge>;
  validateWebhook(signature: string, requestId: string, dataId: string): Promise<boolean>;
}
const mpSchema = z.object({
  id: z.number().or(z.string()),
  external_reference: z.string(),
  transaction_amount: z
    .number()
    .refine(
      (v) => new Decimal(String(v)).decimalPlaces() <= 2,
      'Valor do gateway deve ter no máximo duas casas decimais.',
    ),
  currency_id: z.string(),
  status: z.string(),
  payment_method_id: z.string(),
  live_mode: z.boolean(),
  date_of_expiration: z.string().nullable().optional(),
  point_of_interaction: z
    .object({
      transaction_data: z
        .object({ qr_code: z.string().optional(), qr_code_base64: z.string().optional() })
        .optional(),
    })
    .optional(),
});
export function verifyMpSignature(
  secret: string,
  signature: string,
  requestId: string,
  dataId: string,
  now = Date.now(),
) {
  const fields = Object.fromEntries(signature.split(',').map((p) => p.trim().split('=')));
  if (
    !secret ||
    !fields.ts ||
    !fields.v1 ||
    !/^\d+$/.test(fields.ts) ||
    !/^[a-f\d]{64}$/i.test(fields.v1) ||
    !requestId ||
    !dataId
  )
    return false;
  const timestamp = Number(fields.ts),
    millis = timestamp > 1e12 ? timestamp : timestamp * 1000;
  if (Math.abs(now - millis) > 5 * 60 * 1000) return false;
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${fields.ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest('hex');
  return equalSecret(expected, fields.v1.toLowerCase());
}
export class MercadoPagoGateway implements PixGateway {
  name = 'mercadopago';
  requiresPayerDetails = true;
  async buildRequest(input: PixRequest) {
    if (
      !z.string().email().safeParse(input.payer.email).success ||
      !z
        .string()
        .regex(/^\d{11}$/)
        .safeParse(input.payer.cpf).success
    )
      throw new AppError('PIX_PAYER_REQUIRED', 'O Mercado Pago exige e-mail e CPF do pagador.');
    return `{"transaction_amount":${input.amount},"payment_method_id":"pix","external_reference":${JSON.stringify(input.reference)},"description":"Depósito na carteira","notification_url":${JSON.stringify(`${env.PUBLIC_API_URL}/webhooks/pix?source_news=webhooks`)},"date_of_expiration":${JSON.stringify(input.expiresAt.toISOString())},"payer":${JSON.stringify({ email: input.payer.email, identification: { type: 'CPF', number: input.payer.cpf } })}}`;
  }
  async call(path: string, method = 'GET', body?: string, key?: string): Promise<PixCharge> {
    const { mpToken } = await credentials();
    if (!mpToken)
      throw new AppError('PIX_NOT_CONFIGURED', 'Configure as credenciais do gateway Pix.', 503);
    const response = await fetch(`https://api.mercadopago.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${mpToken}`,
        'Content-Type': 'application/json',
        ...(key ? { 'X-Idempotency-Key': key } : {}),
      },
      body,
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new AppError('PIX_PROVIDER_ERROR', 'Não foi possível consultar a cobrança Pix.', 503);
    const charge = mpSchema.parse(await response.json());
    return {
      id: String(charge.id),
      reference: charge.external_reference,
      amount: new Decimal(String(charge.transaction_amount)).toFixed(2, Decimal.ROUND_HALF_UP),
      currency: charge.currency_id,
      status: charge.status,
      method: charge.payment_method_id,
      liveMode: charge.live_mode,
      pixCode: charge.point_of_interaction?.transaction_data?.qr_code,
      qrBase64: charge.point_of_interaction?.transaction_data?.qr_code_base64,
      expiresAt: charge.date_of_expiration ? new Date(charge.date_of_expiration) : undefined,
    };
  }
  create(body: string, key: string) {
    return this.call('/v1/payments', 'POST', body, key);
  }
  get(id: string) {
    return this.call(`/v1/payments/${encodeURIComponent(id)}`);
  }
  async validateWebhook(signature: string, requestId: string, dataId: string) {
    const { mpWebhookSecret } = await credentials();
    return verifyMpSignature(mpWebhookSecret, signature, requestId, dataId);
  }
}
const expayId = z.string().uuid();
const expaySchema = z
  .object({
    id: expayId.optional(),
    charge_id: expayId.optional(),
    reference: z.string().min(1),
    amount: z
      .union([z.number().finite(), z.string().regex(/^\d+(\.\d{1,2})?$/)])
      .refine((value) => {
        const amount = new Decimal(value);
        return amount.isPositive() && amount.decimalPlaces() <= 2;
      }),
    currency: z.string(),
    payment_method: z.string(),
    status: z.enum(['pending', 'paid', 'failed', 'refunded', 'expired', 'canceled']),
    expires_at: z.string().datetime({ offset: true }).nullish(),
    live_mode: z.boolean().optional(),
    pix_data: z
      .object({
        qr_code: z.string().optional(),
        copy_paste: z.string().optional(),
        qr_code_base64: z.string().optional(),
      })
      .nullish(),
  })
  .refine(
    (charge) =>
      !!(charge.id || charge.charge_id) &&
      (!charge.id || !charge.charge_id || charge.id === charge.charge_id),
    'Identificação da cobrança divergente.',
  );
export function parseExpayCharge(payload: unknown): PixCharge {
  const charge = expaySchema.parse(payload);
  const statuses: Record<typeof charge.status, string> = {
    pending: 'pending',
    paid: 'approved',
    failed: 'rejected',
    refunded: 'refunded',
    expired: 'expired',
    canceled: 'cancelled',
  };
  return {
    id: (charge.charge_id ?? charge.id)!,
    reference: charge.reference,
    amount: new Decimal(charge.amount).toFixed(2),
    currency: charge.currency,
    method: charge.payment_method,
    status: statuses[charge.status],
    pixCode: charge.pix_data?.copy_paste || charge.pix_data?.qr_code,
    qrBase64: charge.pix_data?.qr_code_base64?.replace(/^data:image\/png;base64,/, ''),
    expiresAt: charge.expires_at ? new Date(charge.expires_at) : undefined,
    // ExPay's current contract does not expose a sandbox/live flag. Do not invent one.
    liveMode: charge.live_mode ?? null,
  };
}
export class ExpayGateway implements PixGateway {
  name = 'expay';
  requiresPayerDetails = false;
  async buildRequest(input: PixRequest) {
    const storeId = await setting('pix.expayStoreId', env.EXPAY_STORE_ID);
    const fields = JSON.stringify({
      currency: 'BRL',
      payment_method: 'pix',
      reference: input.reference,
      customer: { name: input.payer.name, document: input.payer.cpf, email: input.payer.email },
      ...(storeId ? { store_id: storeId } : {}),
    });
    // Serialize Decimal directly as a JSON number, without binary floating point arithmetic.
    return `{"amount":${input.amount},${fields.slice(1)}`;
  }
  async call(path: string, method = 'GET', body?: string, key?: string) {
    const { expayApiKey } = await credentials();
    if (!expayApiKey)
      throw new AppError('PIX_NOT_CONFIGURED', 'Configure a chave de API da Expay Brasil.', 503);
    const response = await fetch(`https://expaybrasil.com/api/v1${path}`, {
      method,
      headers: {
        'X-API-Key': expayApiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body,
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new AppError(
        'PIX_PROVIDER_ERROR',
        'Não foi possível consultar a cobrança na Expay Brasil.',
        503,
      );
    return parseExpayCharge(await response.json());
  }
  create(body: string, key: string) {
    return this.call('/charges', 'POST', body, key);
  }
  async get(id: string) {
    return this.call(`/charges/${encodeURIComponent(expayId.parse(id))}`);
  }
  async validateWebhook() {
    return false;
  }
}
// Notification shapes may vary by store configuration. Only recognized UUIDs trigger an API lookup;
// unknown shapes are acknowledged and the independent polling keeps reconciliation working.
export function expayNotificationChargeId(body: unknown): string | null {
  const parsed = z
    .object({
      charge_id: z.unknown().optional(),
      id: z.unknown().optional(),
      data: z.unknown().optional(),
    })
    .passthrough()
    .safeParse(body);
  if (!parsed.success) return null;
  const data = z
    .object({ charge_id: z.unknown().optional(), id: z.unknown().optional() })
    .passthrough()
    .safeParse(parsed.data.data);
  for (const candidate of [
    parsed.data.charge_id,
    data.success ? data.data.charge_id : null,
    data.success ? data.data.id : null,
    parsed.data.id,
  ]) {
    const result = expayId.safeParse(candidate);
    if (result.success) return result.data;
  }
  return null;
}
export async function pixGateway(): Promise<PixGateway> {
  const name = await setting('pix.gateway', env.PIX_GATEWAY);
  if (name === 'expay') return new ExpayGateway();
  if (name === 'mercadopago') return new MercadoPagoGateway();
  throw new AppError(
    'PIX_DISABLED',
    'Depósitos Pix ainda não configurados. Solicite suporte.',
    503,
  );
}
