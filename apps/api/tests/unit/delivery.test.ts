import { it, expect, describe } from 'vitest';
import {
  orderResponseSchema,
  productSchema,
  deliveryLines,
  type PartnerOrder,
} from '../../src/integrations/partner-contract.js';
const base: PartnerOrder = {
  ok: true,
  orderCode: 'SO-A',
  externalOrderId: 'wa-1',
  status: 'COMPLETED',
  deliveryType: 'LINK',
  product: { slug: 'p', name: 'Produto' },
  quantity: 1,
  unitPrice: '5.00',
  totalCharged: '5.00',
  currency: 'USD',
  delivery: { link: 'https://example.com/activate', instructions: 'Ative sua assinatura.' },
};
describe('Contratos documentados de entrega', () => {
  it('valida a resposta de criação e aceita retry sem balanceAfter', () =>
    expect(orderResponseSchema.parse(base).orderCode).toBe('SO-A'));
  it('formata LINK e instruções', () =>
    expect(deliveryLines(base)[0]?.text).toContain('https://example.com/activate\n\nInstruções:'));
  it('formata COUPON', () =>
    expect(
      deliveryLines({ ...base, deliveryType: 'COUPON', delivery: { code: 'ABC' } })[0]?.text,
    ).toBe('ABC'));
  it('formata READY_ACCOUNT sem logar o conteúdo', () =>
    expect(
      deliveryLines({
        ...base,
        deliveryType: 'READY_ACCOUNT',
        delivery: { content: 'test@example.com\nsecret' },
      })[0]?.type,
    ).toBe('READY_ACCOUNT'));
  it('usa todos os elementos de lines em lote', () =>
    expect(
      deliveryLines({
        ...base,
        quantity: 2,
        delivery: undefined,
        deliveryType: 'COUPON',
        lines: [
          { orderCode: 'SO-A-L1', code: 'A' },
          { orderCode: 'SO-A-L2', code: 'B' },
        ],
      }).map((l) => l.text),
    ).toEqual(['A', 'B']));
  it('recusa lote incompleto mesmo com delivery top-level', () =>
    expect(() => deliveryLines({ ...base, quantity: 2 })).toThrow('Quantidade'));
  it('recusa conteúdo ausente', () =>
    expect(() => deliveryLines({ ...base, delivery: {} })).toThrow('ausente'));
  it('recusa estado externo pendente', () =>
    expect(() => deliveryLines({ ...base, status: 'PENDING' })).toThrow('ainda'));
  it('recusa moeda divergente', () =>
    expect(() => orderResponseSchema.parse({ ...base, currency: 'BRL' })).toThrow());
  it('recusa cartão de catálogo com campos monetários ausentes', () =>
    expect(() => productSchema.parse({ id: 42, slug: 'p', name: 'Produto' })).toThrow());
});
