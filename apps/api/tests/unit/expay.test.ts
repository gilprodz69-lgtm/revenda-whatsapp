import { it, expect, vi, beforeEach, afterEach } from 'vitest';
const mocks = vi.hoisted(() => ({
  setting: vi.fn(async (_key: string, fallback: unknown) => fallback),
}));
vi.mock('../../src/core/settings.js', () => ({
  setting: mocks.setting,
  credentials: async () => ({ expayApiKey: 'TEST-EXPAY-KEY-NOT-REAL' }),
}));
import {
  ExpayGateway,
  MercadoPagoGateway,
  parseExpayCharge,
  expayNotificationChargeId,
} from '../../src/integrations/pix.js';
const id = '019e1f6e-3a7f-70b9-bc21-646dc1c965d1';
const valid = {
  charge_id: id,
  reference: 'local-reference',
  amount: 20,
  currency: 'BRL',
  payment_method: 'pix',
  status: 'pending',
  pix_data: { copy_paste: 'PIX-TEST', qr_code_base64: 'data:image/png;base64,aW1hZ2U=' },
};
it.each([{}, { name: 'Cliente' }])(
  'gera Pix Expay sem exigir ou inventar CPF/e-mail: %j',
  async (payer) => {
    const gateway = new ExpayGateway();
    expect(gateway.requiresPayerDetails).toBe(false);
    const body = JSON.parse(
      await gateway.buildRequest({
        reference: 'local-reference',
        amount: '20.00',
        payer,
        expiresAt: new Date(),
      }),
    );
    expect(body).toMatchObject({ amount: 20, currency: 'BRL', payment_method: 'pix' });
    expect(body.customer).not.toHaveProperty('email');
    expect(body.customer).not.toHaveProperty('document');
  },
);
it('mantém a exigência de dados do pagador no Mercado Pago', async () => {
  const gateway = new MercadoPagoGateway();
  expect(gateway.requiresPayerDetails).toBe(true);
  await expect(
    gateway.buildRequest({
      reference: 'local-reference',
      amount: '20.00',
      payer: {},
      expiresAt: new Date(),
    }),
  ).rejects.toMatchObject({ code: 'PIX_PAYER_REQUIRED' });
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.setting.mockImplementation(async (_key, fallback) => fallback);
});
afterEach(() => vi.unstubAllGlobals());
it('interpreta QR e não inventa um indicador live inexistente no contrato Expay', () => {
  expect(parseExpayCharge(valid)).toMatchObject({
    id,
    amount: '20.00',
    status: 'pending',
    pixCode: 'PIX-TEST',
    qrBase64: 'aW1hZ2U=',
    liveMode: null,
  });
  expect(parseExpayCharge({ ...valid, live_mode: false }).liveMode).toBe(false);
});
it.each([
  ['paid', 'approved'],
  ['failed', 'rejected'],
  ['refunded', 'refunded'],
  ['expired', 'expired'],
  ['canceled', 'cancelled'],
])('mapeia estado Expay %s', (status, expected) =>
  expect(parseExpayCharge({ ...valid, status }).status).toBe(expected),
);
it('rejeita identificações divergentes e valores sem precisão monetária', () => {
  expect(() =>
    parseExpayCharge({ ...valid, id: '019e1f6e-3a7f-70b9-bc21-646dc1c965d2' }),
  ).toThrow();
  expect(() => parseExpayCharge({ ...valid, amount: 20.001 })).toThrow();
  expect(() => parseExpayCharge({ ...valid, amount: 'NaN' })).toThrow();
  expect(() => parseExpayCharge({ ...valid, charge_id: undefined })).toThrow();
});
it('usa endpoint atual, X-API-Key e a mesma chave idempotente em reenvio', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(valid), { status: 201 }));
  vi.stubGlobal('fetch', fetch);
  const gateway = new ExpayGateway();
  const body = await gateway.buildRequest({
    reference: 'local-reference',
    amount: '20.00',
    payer: { email: 'test@example.com', cpf: '52998224725', name: 'Cliente' },
    expiresAt: new Date(),
  });
  await gateway.create(body, 'same-key');
  await gateway.create(body, 'same-key');
  expect(JSON.parse(body)).toEqual({
    amount: 20,
    currency: 'BRL',
    payment_method: 'pix',
    reference: 'local-reference',
    customer: { email: 'test@example.com', document: '52998224725', name: 'Cliente' },
  });
  expect(body).toContain('"amount":20.00');
  for (const call of fetch.mock.calls as unknown as [string, RequestInit][]) {
    expect(call[0]).toBe('https://expaybrasil.com/api/v1/charges');
    expect(call[1].headers).toMatchObject({
      'X-API-Key': 'TEST-EXPAY-KEY-NOT-REAL',
      'Idempotency-Key': 'same-key',
    });
    expect(call[1].body).toBe(body);
    expect(call[1].redirect).toBe('error');
  }
  expect(body).not.toContain('TEST-EXPAY');
});
it('consulta somente UUID de cobrança e não envia outra criação ao consultar', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(valid), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await new ExpayGateway().get(id);
  expect((fetch.mock.calls as unknown as [string, RequestInit][])[0]).toMatchObject([
    `https://expaybrasil.com/api/v1/charges/${id}`,
    { method: 'GET' },
  ]);
  await expect(new ExpayGateway().get('../charges')).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('notificação só fornece um UUID para consulta, nunca prova de pagamento', () => {
  expect(
    expayNotificationChargeId({ data: { charge_id: id }, status: 'paid', amount: 99999 }),
  ).toBe(id);
  expect(expayNotificationChargeId({ charge_id: '../charges', status: 'paid' })).toBeNull();
  expect(expayNotificationChargeId({ status: 'paid', reference: 'qualquer' })).toBeNull();
});
