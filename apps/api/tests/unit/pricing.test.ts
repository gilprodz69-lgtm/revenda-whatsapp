import { describe, it, expect } from 'vitest';
import { priceQuote, type PriceRule } from '../../src/modules/pricing.js';
const rule: PriceRule = {
  markupPercent: '30',
  fixedMargin: '0',
  roundingStep: '0.01',
  volumeDiscountPercent: '0',
  volumeMinQuantity: 10,
};
describe('Formação de preço com Decimal', () => {
  it('aplica o exemplo da especificação exatamente', () =>
    expect(priceQuote('5', [], 1, '5.3', rule)).toMatchObject({
      unitSaleBrl: '34.45',
      estimatedCostUsd: '5.0000',
      estimatedProfitBrl: '7.95',
    }));
  it('não acumula erro binário com centavos', () =>
    expect(priceQuote('0.1', [], 3, '1', { ...rule, markupPercent: '0' }).totalBrl).toBe('0.30'));
  it('seleciona o menor custo de volume BEST_PRICE', () =>
    expect(
      priceQuote(
        '12.50',
        [
          { minQuantity: 5, maxQuantity: 9, unitPrice: '11.50' },
          { minQuantity: 10, maxQuantity: null, unitPrice: '10' },
        ],
        10,
        '5',
        rule,
      ).estimatedCostUsd,
    ).toBe('100.0000'));
  it('não aplica faixa abaixo da quantidade mínima', () =>
    expect(
      priceQuote('12.50', [{ minQuantity: 5, maxQuantity: 9, unitPrice: '11.50' }], 4, '5', rule)
        .unitCostUsd,
    ).toBe('12.5000'));
  it('preserva preço manual e margem fixa nas suas respectivas regras', () => {
    expect(priceQuote('5', [], 1, '5', { ...rule, manualPrice: '40' }).unitSaleBrl).toBe('40.00');
    expect(priceQuote('5', [], 1, '5', { ...rule, fixedMargin: '2' }).unitSaleBrl).toBe('34.50');
  });
  it('aplica promoção válida e ignora promoção vencida', () => {
    expect(
      priceQuote(
        '5',
        [],
        1,
        '5',
        { ...rule, promoPrice: '20', promoUntil: new Date('2030-01-01') },
        new Date('2026-01-01'),
      ).unitSaleBrl,
    ).toBe('20.00');
    expect(
      priceQuote('5', [], 1, '5', { ...rule, promoPrice: '20', promoUntil: new Date('2020-01-01') })
        .unitSaleBrl,
    ).toBe('32.50');
  });
  it('arredonda para cima no passo explícito', () =>
    expect(priceQuote('5', [], 1, '5.3', { ...rule, roundingStep: '0.10' }).unitSaleBrl).toBe(
      '34.50',
    ));
  it('aplica desconto local por volume', () =>
    expect(priceQuote('5', [], 10, '5', { ...rule, volumeDiscountPercent: '10' }).totalBrl).toBe(
      '292.50',
    ));
  it.each([0, -1, 1.5, NaN])('recusa quantidade inválida %s', (q) =>
    expect(() => priceQuote('5', [], q, '5', rule)).toThrow(),
  );
  it.each(['0', '-1', 'NaN'])('recusa cotação inválida %s', (r) =>
    expect(() => priceQuote('5', [], 1, r, rule)).toThrow(),
  );
});
