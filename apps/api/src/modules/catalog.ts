import { db, redis, transaction } from '../core/db.js';
import { partner } from '../integrations/partner.js';
import { randomUUID } from 'node:crypto';
import { AppError } from '../core/errors.js';
export async function syncCatalog() {
  const token = randomUUID();
  if (!(await redis.set('catalog-sync-lock', token, 'EX', 180, 'NX')))
    throw new AppError('SYNC_BUSY', 'Sincronização já em andamento.', 409);
  try {
    const providers = await partner.providers(),
      products = await partner.products();
    const now = new Date();
    await transaction(async (tx) => {
      for (const provider of providers.data)
        await tx.provider.upsert({
          where: { key: provider.key },
          create: {
            key: provider.key,
            externalId: provider.id,
            name: provider.name,
            emoji: provider.emoji?.normal,
            sortOrder: provider.sortOrder ?? 0,
          },
          update: {
            externalId: provider.id,
            name: provider.name,
            emoji: provider.emoji?.normal,
            sortOrder: provider.sortOrder ?? 0,
          },
        });
      for (const p of products.data) {
        const data = {
          externalId: p.id,
          code: p.productCode,
          name: p.name,
          providerKey: p.provider.key,
          catalogPriceUsd: p.catalogPrice,
          costUsd: p.yourPrice,
          deliveryType: p.deliveryType,
          stock: p.stock.count,
          maxQuantity: p.stock.maxQuantity,
          available: p.stock.inStock,
          durationDays: p.durationDays,
          warrantyDays: p.warranty?.enabled ? p.warranty.days : null,
          bulkTiers: p.bulkDiscount?.enabled ? p.bulkDiscount.tiers : [],
          syncedAt: now,
        };
        await tx.provider.upsert({
          where: { key: p.provider.key },
          create: { key: p.provider.key, externalId: p.provider.id, name: p.provider.name },
          update: { name: p.provider.name },
        });
        await tx.product.upsert({
          where: { slug: p.slug },
          create: { slug: p.slug, ...data },
          update: data,
        });
      }
      // Retain local rules/history while excluding products absent from the complete upstream list.
      await tx.product.updateMany({
        where: { slug: { notIn: products.data.map((p) => p.slug) } },
        data: { available: false, stock: 0, syncedAt: now },
      });
    });
    return { providers: providers.data.length, products: products.data.length, syncedAt: now };
  } finally {
    await redis.eval(
      "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
      1,
      'catalog-sync-lock',
      token,
    );
  }
}
