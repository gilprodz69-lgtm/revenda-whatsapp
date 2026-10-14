import { Decimal } from 'decimal.js';
import { AppError } from '../core/errors.js';
export type Tier = { minQuantity: number; maxQuantity: number | null; unitPrice: string };
export type PriceRule = {
  markupPercent: string;
  fixedMargin: string;
  manualPrice?: string | null;
  promoPrice?: string | null;
  promoUntil?: Date | null;
  roundingStep: string;
  volumeDiscountPercent: string;
  volumeMinQuantity: number;
};
export function priceQuote(
  costUsd: string,
  tiers: Tier[],
  quantity: number,
  usdBrl: string,
  rule: PriceRule,
  now = new Date(),
) {
  if (!Number.isInteger(quantity) || quantity < 1)
    throw new AppError('INVALID_QUANTITY', 'Quantidade inválida.');
  const rate = new Decimal(usdBrl);
  if (!rate.isFinite() || rate.lte(0))
    throw new AppError('INVALID_RATE', 'Configure uma cotação USD/BRL válida.');
  let cost = new Decimal(costUsd);
  for (const tier of tiers) {
    if (quantity >= tier.minQuantity && (tier.maxQuantity === null || quantity <= tier.maxQuantity))
      cost = Decimal.min(cost, tier.unitPrice);
  }
  const converted = cost.mul(rate);
  let sale = rule.manualPrice
    ? new Decimal(rule.manualPrice)
    : converted.mul(new Decimal(rule.markupPercent).div(100).add(1)).add(rule.fixedMargin);
  if (rule.promoPrice && rule.promoUntil && rule.promoUntil > now)
    sale = Decimal.min(sale, rule.promoPrice);
  if (quantity >= rule.volumeMinQuantity)
    sale = sale.mul(new Decimal(1).sub(new Decimal(rule.volumeDiscountPercent).div(100)));
  const step = new Decimal(rule.roundingStep);
  if (step.lt('0.01') || step.decimalPlaces() > 2 || sale.lte(0))
    throw new AppError('INVALID_PRICE', 'Regra de preço inválida.');
  sale = sale
    .div(step)
    .toDecimalPlaces(0, Decimal.ROUND_CEIL)
    .mul(step)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return {
    unitCostUsd: cost.toFixed(4),
    unitSaleBrl: sale.toFixed(2),
    totalBrl: sale.mul(quantity).toFixed(2),
    estimatedCostUsd: cost.mul(quantity).toFixed(4),
    estimatedProfitBrl: sale.sub(converted).mul(quantity).toFixed(2),
  };
}
