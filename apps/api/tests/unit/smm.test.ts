import { it, expect } from 'vitest';
import {
  publicSmmAddress,
  smmUrl,
  smmServiceSchema,
  supportedSmmService,
} from '../../src/integrations/smm.js';
import { smmPriceQuote } from '../../src/modules/pricing.js';
import { smmRequest } from '../../src/modules/smm-orders.js';
const rule = {
  markupPercent: '100',
  fixedMargin: '0',
  roundingStep: '0.01',
  volumeDiscountPercent: '0',
  volumeMinQuantity: 10000,
};
it('cobra por mil proporcionalmente, sem arredondar cada unidade para um centavo', () => {
  expect(smmPriceQuote('1', 100, 1000, '5', rule)).toMatchObject({
    unitSaleBrl: '10.00',
    totalBrl: '1.00',
    estimatedCostBrl: '0.5000',
    estimatedProfitBrl: '0.50',
  });
  expect(smmPriceQuote('1', 1500, 1000, '5', { ...rule, manualPrice: '15' }).totalBrl).toBe(
    '22.50',
  );
  expect(smmPriceQuote('0.001', 50, 1000, '1', { ...rule, manualPrice: '0.01' }).totalBrl).toBe(
    '0.01',
  );
});
it('trata custo BRL sem conversão cambial e pacote por pedido', () => {
  expect(smmPriceQuote('2', 1000, 1000, '1', rule).totalBrl).toBe('4.00');
  expect(smmPriceQuote('2', 1, 1, '5', rule).totalBrl).toBe('20.00');
  expect(
    smmPriceQuote('2', 1000, 1000, '1', {
      ...rule,
      volumeMinQuantity: 1000,
      volumeDiscountPercent: '10',
    }).totalBrl,
  ).toBe('3.60');
});
it.each([
  '127.0.0.1',
  '10.0.0.1',
  '172.16.0.1',
  '192.168.1.1',
  '169.254.169.254',
  '100.64.0.1',
  '::1',
  '::ffff:127.0.0.1',
  'fe80::1',
  'fc00::1',
  '2001:db8::1',
  '2002:7f00:1::',
])('bloqueia endereço privado/reservado %s', (ip) => expect(publicSmmAddress(ip)).toBe(false));
it('aceita IPs públicos e valida URL sem credenciais ou redirecionamento', () => {
  expect(publicSmmAddress('104.21.20.20')).toBe(true);
  expect(publicSmmAddress('2606:4700:4700::1111')).toBe(true);
  expect(smmUrl('https://machinesmm.com/api/v2')).toBe('https://machinesmm.com/api/v2');
  for (const url of [
    'http://example.com/api/v2',
    'https://127.0.0.1/api',
    'https://localhost/api',
    'https://api.internal/api',
    'https://user:key@example.com/api',
    'https://example.com/api?key=secret',
    'https://example.com:6379/api',
  ])
    expect(() => smmUrl(url)).toThrow();
});
it('lê flags e pacotes sem limite numérico; tipos contínuos não podem ser importados', () => {
  const service = smmServiceSchema.parse({
    service: 1,
    name: 'Pacote',
    type: 'Package',
    category: 'Instagram',
    rate: '2',
    min: '0',
    max: '0',
    refill: '1',
    cancel: 0,
  });
  expect(service.refill).toBe(true);
  expect(supportedSmmService(service)).toBe(true);
  expect(supportedSmmService({ ...service, type: 'Subscriptions' })).toBe(false);
  expect(supportedSmmService({ ...service, type: 'Default' })).toBe(false);
});
it('envia somente campos documentados por tipo, preservando comentários e protegendo key/action', () => {
  const link = 'https://example.com/post';
  expect(smmRequest('Package', '2', 1, { link })).toEqual({ service: '2', link });
  expect(smmRequest('Custom Comments', '2', 2, { link, comments: 'ótimo\nobrigado' })).toEqual({
    service: '2',
    link,
    comments: 'ótimo\nobrigado',
  });
  expect(smmRequest('Comment Likes', '2', 100, { link, username: 'autor' })).toMatchObject({
    quantity: '100',
    username: 'autor',
  });
  expect(smmRequest('Poll', '2', 100, { link, answer_number: '2' })).toMatchObject({
    answer_number: '2',
  });
  expect(() => smmRequest('Default', '2', 100, { link, key: 'overwrite' })).toThrow();
  expect(() => smmRequest('Default', '2', 100, { link: 'javascript:alert(1)' })).toThrow();
  expect(() => smmRequest('Custom Comments', '2', 2, { link, comments: 'uma linha' })).toThrow();
});
