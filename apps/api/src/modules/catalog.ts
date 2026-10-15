import { db, redis, transaction } from '../core/db.js';
import { partner } from '../integrations/partner.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { PartnerProduct } from '../integrations/partner-contract.js';
import { AppError, PartnerError } from '../core/errors.js';

async function upstreamCatalog() {
  try {
    // Each product includes its provider. A second providers request is unnecessary.
    return (await partner.products()).data;
  } catch (error) {
    if (error instanceof PartnerError)
      throw new AppError(
        `CATALOG_${error.code}`,
        `${error.message} Confira a integração Partner nas Configurações.`,
        502,
      );
    if (error instanceof z.ZodError)
      throw new AppError(
        'CATALOG_INVALID_RESPONSE',
        'A Partner retornou um catálogo em formato incompatível. Confira a versão da API com o fornecedor.',
        502,
      );
    throw error;
  }
}

export async function browseCatalog(query: {
  search: string;
  provider: string;
  page: number;
  limit: number;
}) {
  const products = await upstreamCatalog();
  const imported = new Set(
    (await db.product.findMany({ select: { slug: true } })).map((p) => p.slug),
  );
  const search = query.search.toLocaleLowerCase('pt-BR');
  const filtered = products
    .filter(
      (p) =>
        (!query.provider || p.provider.key === query.provider) &&
        [p.name, p.slug, p.productCode ?? ''].some((v) =>
          v.toLocaleLowerCase('pt-BR').includes(search),
        ),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return {
    data: filtered.slice((query.page - 1) * query.limit, query.page * query.limit).map((p) => ({
      slug: p.slug,
      name: p.name,
      code: p.productCode,
      provider: p.provider,
      costUsd: p.yourPrice,
      stock: p.stock.count,
      available: p.stock.inStock,
      imported: imported.has(p.slug),
    })),
    providers: [
      ...new Map(
        products.map((p) => [p.provider.key, { key: p.provider.key, name: p.provider.name }]),
      ).values(),
    ],
    total: filtered.length,
    page: query.page,
    limit: query.limit,
  };
}

async function catalogWrite<T>(work: () => Promise<T>) {
  const token = randomUUID();
  if (!(await redis.set('catalog-sync-lock', token, 'EX', 180, 'NX')))
    throw new AppError('SYNC_BUSY', 'Sincronização já em andamento.', 409);
  try {
    return await work();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      console.error(JSON.stringify({ event: 'catalog.save_failed', code: error.code }));
      throw new AppError(
        'CATALOG_SAVE_FAILED',
        'Não foi possível gravar o catálogo. Nenhuma alteração desta operação foi aplicada. Tente novamente ou confira os logs do serviço.',
        503,
      );
    }
    throw error;
  } finally {
    await redis.eval(
      "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
      1,
      'catalog-sync-lock',
      token,
    );
  }
}

async function storeProducts(tx: Prisma.TransactionClient, products: PartnerProduct[], now: Date) {
  for (const provider of new Map(products.map((p) => [p.provider.key, p.provider])).values())
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
  for (const p of products) {
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
    await tx.product.upsert({
      where: { slug: p.slug },
      create: { slug: p.slug, ...data },
      update: data,
    });
  }
}

export async function importCatalog(slugs: string[], actorId: string) {
  return catalogWrite(async () => {
    const products = await upstreamCatalog();
    const bySlug = new Map(products.map((p) => [p.slug, p]));
    const selected = [...new Set(slugs)].map((slug) => {
      const product = bySlug.get(slug);
      if (!product)
        throw new AppError(
          'CATALOG_CHANGED',
          'Um serviço selecionado não está mais no catálogo. Atualize a lista e escolha novamente.',
          409,
        );
      return product;
    });
    const now = new Date();
    const result = { imported: selected.length, syncedAt: now.toISOString() };
    await transaction(async (tx) => {
      await storeProducts(tx, selected, now);
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'catalog.import',
          target: 'catalog',
          metadata: { ...result, slugs: [...new Set(slugs)] },
        },
      });
    });
    return result;
  });
}

export async function syncCatalog() {
  return catalogWrite(async () => {
    const products = await upstreamCatalog();
    const imported = new Set(
      (await db.product.findMany({ select: { slug: true } })).map((p) => p.slug),
    );
    const selected = products.filter((p) => imported.has(p.slug));
    const now = new Date();
    await transaction(async (tx) => {
      await storeProducts(tx, selected, now);
      // Retain local rules/history while excluding products absent from the complete upstream list.
      await tx.product.updateMany({
        where: { slug: { notIn: products.map((p) => p.slug) } },
        data: { available: false, stock: 0, syncedAt: now },
      });
    });
    return {
      providers: new Set(selected.map((p) => p.provider.key)).size,
      products: selected.length,
      syncedAt: now.toISOString(),
    };
  });
}
