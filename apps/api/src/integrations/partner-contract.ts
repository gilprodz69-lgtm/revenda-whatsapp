import { z } from 'zod';
const money = z.string().regex(/^\d+(\.\d{1,8})?$/);
export const deliveryTypeSchema = z.enum(['LINK', 'COUPON', 'READY_ACCOUNT']);
export const providerSchema = z.object({
  id: z.number().int(),
  key: z.string(),
  name: z.string(),
  sortOrder: z.number().int().optional(),
  emoji: z
    .object({ normal: z.string().nullable().optional(), display: z.string().optional() })
    .optional(),
});
export const tierSchema = z.object({
  minQuantity: z.number().int().positive(),
  maxQuantity: z.number().int().nullable(),
  unitPrice: money,
});
export const productSchema = z.object({
  id: z.number().int(),
  slug: z.string().min(1),
  productCode: z.string().nullable().optional(),
  name: z.string(),
  provider: providerSchema,
  deliveryType: deliveryTypeSchema,
  catalogPrice: money,
  yourPrice: money,
  // Catalog metadata may contain USDT or another currency. Monetary operations
  // must check support explicitly; never reinterpret these amounts as USD.
  currency: z.string().regex(/^[A-Z][A-Z0-9]{2,9}$/),
  durationDays: z.number().int().nullable().optional(),
  warranty: z
    .object({ enabled: z.boolean(), days: z.number().int().nullable().optional() })
    .optional(),
  stock: z.object({
    inStock: z.boolean(),
    count: z.number().int().nonnegative(),
    maxQuantity: z.number().int().nonnegative(),
  }),
  bulkDiscount: z
    .object({
      enabled: z.boolean(),
      stackingPolicy: z.string().optional(),
      tiers: z.array(tierSchema),
    })
    .optional(),
  description: z.string().nullable().optional(),
  instructions: z.string().nullable().optional(),
  descriptionFormat: z.string().optional(),
});
export type PartnerProduct = z.infer<typeof productSchema>;
export const contentSchema = z.object({
  link: z.string().url().optional(),
  code: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  instructions: z.string().optional(),
  format: z.string().optional(),
});
export const orderResponseSchema = z.object({
  ok: z.literal(true),
  orderCode: z.string(),
  externalOrderId: z.string(),
  status: z.string(),
  deliveryType: deliveryTypeSchema,
  product: z.object({ slug: z.string(), name: z.string(), productCode: z.string().optional() }),
  quantity: z.number().int().positive(),
  unitPrice: money,
  totalCharged: money,
  currency: z.literal('USD'),
  delivery: contentSchema.optional(),
  lines: z.array(contentSchema.extend({ orderCode: z.string() })).optional(),
  createdAt: z.string().optional(),
  balanceAfter: money.optional(),
});
export type PartnerOrder = z.infer<typeof orderResponseSchema>;
export const orderSummarySchema = orderResponseSchema.omit({
  ok: true,
  delivery: true,
  lines: true,
});
export function deliveryLines(order: PartnerOrder) {
  if (order.status !== 'COMPLETED') throw new Error('Pedido externo ainda não concluído.');
  const lines =
    order.quantity > 1 ? order.lines : [{ ...order.delivery, orderCode: order.orderCode }];
  if (!lines || lines.length !== order.quantity)
    throw new Error('Quantidade de entregas divergente.');
  return lines.map((line) => {
    const content =
      order.deliveryType === 'LINK'
        ? line.link
        : order.deliveryType === 'COUPON'
          ? line.code
          : line.content;
    if (!content) throw new Error('Conteúdo de entrega ausente.');
    if (order.deliveryType === 'LINK' && !/^https?:\/\//.test(content))
      throw new Error('Link inválido.');
    return {
      lineCode: line.orderCode,
      type: order.deliveryType,
      text: `${content}${line.instructions ? `\n\nInstruções: ${line.instructions}` : ''}`,
    };
  });
}
