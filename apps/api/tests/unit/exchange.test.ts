import { it, expect, vi, beforeEach, afterEach } from 'vitest';
const mocks = vi.hoisted(() => ({
  provider: 'bcb',
  create: vi.fn(async ({ data }) => ({ id: 'test-rate', ...data })),
  findFirst: vi.fn(async () => null),
}));
vi.mock('../../src/core/db.js', () => ({
  db: { exchangeRate: { create: mocks.create, findFirst: mocks.findFirst } },
}));
vi.mock('../../src/core/settings.js', () => ({ setting: async () => mocks.provider }));
import { refreshExchange, currentRate } from '../../src/modules/exchange.js';
const closing = { value: [{ cotacaoVenda: 5.25, dataHoraCotacao: '2026-10-14 13:05:17.833426' }] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.provider = 'bcb';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('consulta fechamento com espaços OData em %20 e grava valor/data/validade oficiais', async () => {
  const fetch = vi.fn(
    async (url: string) =>
      new Response(url.includes('+') ? 'invalid OData' : JSON.stringify(closing), {
        status: url.includes('+') ? 400 : 200,
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const rate = await refreshExchange();
  expect(rate).toMatchObject({
    usdBrl: '5.25',
    source: 'BCB-PTAX-venda',
    observedAt: new Date('2026-10-14T16:05:17.833Z'),
    expiresAt: new Date('2026-10-18T16:05:17.833Z'),
  });
  const url = fetch.mock.calls[0]![0];
  expect(url).toContain('tipoBoletim%20eq%20%27Fechamento%27');
  expect(url).toContain('dataHoraCotacao%20desc');
  expect(url).not.toContain('+');
});
it('mantém renovação manual sem consulta automática e permite consulta explícita ao BCB', async () => {
  mocks.provider = 'manual';
  const fetch = vi.fn(async () => new Response(JSON.stringify(closing)));
  vi.stubGlobal('fetch', fetch);
  expect(await refreshExchange()).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
  expect(await refreshExchange({ force: true })).toHaveProperty('usdBrl', '5.25');
  expect(mocks.provider).toBe('manual');
});
it.each([
  ['HTTP', () => new Response('error', { status: 400 }), 'RATE_UNAVAILABLE'],
  ['vazio', () => new Response(JSON.stringify({ value: [] })), 'RATE_UNAVAILABLE'],
  ['JSON inválido', () => new Response('<html>error</html>'), 'RATE_INVALID_RESPONSE'],
  [
    'taxa inválida',
    () =>
      new Response(
        JSON.stringify({ value: [{ cotacaoVenda: -1, dataHoraCotacao: '2026-10-14 13:00:00' }] }),
      ),
    'RATE_INVALID_RESPONSE',
  ],
  [
    'data inválida',
    () =>
      new Response(JSON.stringify({ value: [{ cotacaoVenda: 5.25, dataHoraCotacao: 'invalid' }] })),
    'RATE_INVALID_RESPONSE',
  ],
  [
    'vencido',
    () =>
      new Response(
        JSON.stringify({ value: [{ cotacaoVenda: 5.25, dataHoraCotacao: '2026-10-01 13:00:00' }] }),
      ),
    'RATE_STALE',
  ],
])('não grava cotação em resposta %s', async (_name, response, code) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response()),
  );
  await expect(refreshExchange()).rejects.toMatchObject({ code });
  expect(mocks.create).not.toHaveBeenCalled();
});
it('modo BCB selecionado sem registro válido continua bloqueando vendas', async () => {
  await expect(currentRate()).rejects.toMatchObject({ code: 'RATE_NOT_CONFIGURED' });
});
