import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { AppError } from '../core/errors.js';
import { equalSecret } from '../core/crypto.js';
import { credentials, setting } from '../core/settings.js';
import { env } from '../config.js';
export type PixPayer = { email: string; cpf: string };
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
  liveMode: boolean;
};
export interface PixGateway {
  name: string;
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
export async function pixGateway(): Promise<PixGateway> {
  const name = await setting('pix.gateway', env.PIX_GATEWAY);
  if (name === 'mercadopago') return new MercadoPagoGateway();
  throw new AppError(
    'PIX_DISABLED',
    'Depósitos Pix ainda não configurados. Solicite suporte.',
    503,
  );
}
