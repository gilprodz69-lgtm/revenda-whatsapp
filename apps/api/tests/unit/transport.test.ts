import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({
  redis: { get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), eval: vi.fn(async () => 1) },
  log: vi.fn(async () => ({})),
  setting: vi.fn(async (_key: string, fallback: unknown) => fallback),
}));
vi.mock('../../src/core/db.js', () => ({
  db: { apiRequestLog: { create: mocks.log } },
  redis: mocks.redis,
}));
vi.mock('../../src/core/settings.js', () => ({
  credentials: async () => ({ partnerKey: 'TEST-KEY' }),
  setting: mocks.setting,
}));
import { PartnerApiService } from '../../src/integrations/partner.js';
import { PartnerError } from '../../src/core/errors.js';
function documentedExample(heading: string) {
  const docs = readFileSync(
    new URL('../../../../docs/references/partner-api-docs.html', import.meta.url),
    'utf8',
  );
  const start = docs.indexOf(`<h3>${heading}</h3>`);
  const json = docs.slice(start).match(/<pre>([\s\S]*?)<\/pre>/)?.[1];
  if (start < 0 || !json) throw new Error('Exemplo de contrato não encontrado.');
  return JSON.parse(json);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.redis.eval.mockResolvedValue(1);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('identifica 502 HTML sem expor corpo e mantém GET limitado a três tentativas', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(
    async () => new Response('<html>PRIVATE-UPSTREAM-BODY</html>', { status: 502 }),
  );
  vi.stubGlobal('fetch', fetch);
  const pending = expect(
    new PartnerApiService().product('gemini-link-pro-18months'),
  ).rejects.toMatchObject({
    code: 'UPSTREAM_UNAVAILABLE',
    status: 502,
    uncertain: false,
    message: expect.stringContaining('temporariamente indisponível'),
  });
  await vi.runAllTimersAsync();
  await pending;
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('PRIVATE-UPSTREAM-BODY');
  expect(mocks.log).toHaveBeenCalledWith({
    data: expect.objectContaining({ code: 'UPSTREAM_UNAVAILABLE', status: 502 }),
  });
});
it('502 na compra permanece incerto e não repete o POST automaticamente', async () => {
  const fetch = vi.fn(async () => new Response('Bad Gateway', { status: 502 }));
  vi.stubGlobal('fetch', fetch);
  await expect(
    new PartnerApiService().createOrder({
      productSlug: 'product',
      quantity: 1,
      externalOrderId: 'same-reference',
    }),
  ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', uncertain: true });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('aceita os exemplos completos de fornecedores e produtos da documentação Partner', async () => {
  const providers = documentedExample('GET /catalog/providers');
  const products = documentedExample('GET /catalog/products?provider=gemini');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(JSON.stringify(url.endsWith('/providers') ? providers : products), {
          status: 200,
        }),
    ),
  );
  const service = new PartnerApiService();
  expect((await service.providers()).data[0]?.key).toBe('gemini');
  expect((await service.products()).data[0]).toMatchObject({
    slug: 'gemini-pro-monthly',
    yourPrice: '12.50',
  });
});
it('lê catálogo misto com os 20 índices USDT do diagnóstico sem converter a moeda', async () => {
  const sample = documentedExample('GET /catalog/products?provider=gemini').data[0];
  const usdt = new Set([
    2, 5, 17, 29, 31, 32, 35, 37, 62, 65, 66, 70, 74, 75, 76, 77, 83, 84, 85, 86,
  ]);
  const data = Array.from({ length: 90 }, (_, index) => ({
    ...sample,
    id: index + 1,
    slug: `service-${index}`,
    currency: usdt.has(index) ? 'USDT' : 'USD',
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 })),
  );
  const result = await new PartnerApiService().products();
  expect(result.data).toHaveLength(90);
  expect(result.data.filter((p) => p.currency === 'USDT')).toHaveLength(20);
  expect(result.data[2]).toMatchObject({ currency: 'USDT', yourPrice: '12.50' });
  expect(result.data[0]).toMatchObject({ currency: 'USD', yourPrice: '12.50' });
});
it('usa envelope data para catálogo e Bearer no servidor', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  expect(await new PartnerApiService().providers()).toEqual({ data: [] });
  expect(fetch.mock.calls[0]?.[0]).toBe('http://partner.test/api/partner/v1/catalog/providers');
  expect((fetch.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
    Authorization: 'Bearer TEST-KEY',
  });
});
it('não envia autenticação no health público', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, service: 'partner-api', version: 1 }), {
        status: 200,
      }),
  );
  vi.stubGlobal('fetch', fetch);
  await new PartnerApiService().health();
  expect((fetch.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty('Authorization');
});
it('respeita o bloqueio compartilhado sem chamar o fornecedor', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  mocks.redis.eval.mockResolvedValue(0);
  await expect(new PartnerApiService().request('/orders', 'POST', {})).rejects.toMatchObject({
    code: 'RATE_LIMIT_EXCEEDED',
  });
  expect(fetch).not.toHaveBeenCalled();
});
it('timeout de POST é resultado desconhecido e não gera retry de transporte', async () => {
  const fetch = vi.fn(async () => {
    throw new Error('timeout');
  });
  vi.stubGlobal('fetch', fetch);
  await expect(
    new PartnerApiService().request('/orders', 'POST', { externalOrderId: 'same' }),
  ).rejects.toMatchObject({ uncertain: true });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(mocks.log.mock.calls[0]?.[0]).not.toHaveProperty('data.body');
});
it('429 aplica cooldown do Retry-After e registra só metadados seguros', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: 'RATE_LIMIT_EXCEEDED', requestId: 'req-1', message: 'secret data' },
          }),
          { status: 429, headers: { 'Retry-After': '120' } },
        ),
    ),
  );
  await expect(new PartnerApiService().request('/orders', 'POST', {})).rejects.toBeInstanceOf(
    PartnerError,
  );
  expect(mocks.redis.set).toHaveBeenCalledWith(
    expect.stringContaining(':cooldown'),
    '1',
    'EX',
    120,
  );
  expect(mocks.log).toHaveBeenCalledWith({
    data: expect.objectContaining({ code: 'RATE_LIMIT_EXCEEDED', requestId: 'req-1' }),
  });
  expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('secret data');
});
