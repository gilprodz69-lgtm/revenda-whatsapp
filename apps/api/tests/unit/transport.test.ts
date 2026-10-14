import { it, expect, vi, beforeEach, afterEach } from 'vitest';
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
beforeEach(() => {
  vi.clearAllMocks();
  mocks.redis.eval.mockResolvedValue(1);
});
afterEach(() => vi.unstubAllGlobals());
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
