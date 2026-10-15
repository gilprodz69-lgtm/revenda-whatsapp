import { Prisma } from '@prisma/client';
import { db, transaction } from '../core/db.js';
import { AppError } from '../core/errors.js';
import { hash } from '../core/crypto.js';
import { withLock } from '../core/lock.js';
import { smm, supportedSmmService, type SmmService } from '../integrations/smm.js';

export const smmSlug = (providerId: string, serviceId: string) => `smm-${providerId}-${serviceId}`;
export async function smmProvider(id: string, selling = true) {
  const provider = await db.smmProvider.findUniqueOrThrow({ where: { id } });
  if (selling && !provider.active)
    throw new AppError('SMM_DISABLED', 'Este provedor SMM está desativado.');
  return provider;
}
export async function browseSmmCatalog(
  id: string,
  query: { search: string; provider: string; page: number; limit: number },
) {
  const provider = await smmProvider(id);
  await smm.balance(provider);
  const services = await smm.services(provider);
  const imported = new Set(
    (
      await db.product.findMany({
        where: { smmProviderId: id, archivedAt: null },
        select: { smmServiceId: true },
      })
    ).map((p) => p.smmServiceId),
  );
  const search = query.search.toLocaleLowerCase('pt-BR');
  const filtered = services.filter(
    (s) =>
      (!query.provider || s.category === query.provider) &&
      `${s.service} ${s.name} ${s.category}`.toLocaleLowerCase('pt-BR').includes(search),
  );
  return {
    data: filtered.slice((query.page - 1) * query.limit, query.page * query.limit).map((s) => ({
      slug: s.service,
      code: s.service,
      name: s.name,
      provider: { key: s.category, name: s.category },
      cost: s.rate,
      currency: provider.currency,
      costUsd: provider.currency === 'USD' ? s.rate : null,
      canImport: supportedSmmService(s),
      unsupportedReason: `Tipo ${s.type} ainda não compatível com a compra avulsa.`,
      stock: s.type === 'Package' ? 1 : s.max,
      minQuantity: s.min,
      priceBasis: s.type === 'Package' ? 1 : 1000,
      available: true,
      imported: imported.has(s.service),
      type: s.type,
    })),
    providers: [...new Set(services.map((s) => s.category))].map((name) => ({ key: name, name })),
    total: filtered.length,
    page: query.page,
    limit: query.limit,
  };
}
async function storeService(
  tx: Prisma.TransactionClient,
  provider: { id: string; currency: string },
  service: SmmService,
  categoryId?: string | null,
) {
  const data = {
    name: service.name,
    supplierRate: service.rate,
    costCurrency: provider.currency,
    costUsd: provider.currency === 'USD' ? service.rate : '0',
    catalogPriceUsd: provider.currency === 'USD' ? service.rate : '0',
    smmType: service.type,
    minQuantity: service.type === 'Package' ? 1 : Math.max(1, service.min),
    maxQuantity: service.type === 'Package' ? 1 : service.max,
    stock: service.type === 'Package' ? 1 : service.max,
    available: supportedSmmService(service),
    priceBasis: service.type === 'Package' ? 1 : 1000,
    supportsRefill: service.refill,
    supportsCancel: service.cancel,
    syncedAt: new Date(),
  };
  if (categoryId === undefined) {
    const sourceKey = `smm:${provider.id}:${hash(service.category)}`;
    categoryId = (
      await tx.category.upsert({
        where: { sourceKey },
        create: { sourceKey, name: service.category || 'Serviços SMM' },
        update: {},
      })
    ).id;
  }
  const slug = smmSlug(provider.id, service.service);
  const existing = await tx.product.findUnique({ where: { slug } });
  await tx.product.upsert({
    where: { slug },
    create: {
      slug,
      source: 'SMM',
      smmProviderId: provider.id,
      smmServiceId: service.service,
      categoryId,
      deliveryType: 'SMM',
      bulkTiers: [],
      ...data,
    },
    update: {
      ...data,
      ...(existing?.archivedAt
        ? { archivedAt: null, active: true, visible: true, authorizedResale: false }
        : {}),
    },
  });
}
export async function importSmmServices(
  id: string,
  serviceIds: string[],
  categoryId: string | undefined,
  actorId: string,
) {
  return withLock(`smm-catalog:${id}`, async () => {
    const provider = await smmProvider(id);
    await smm.balance(provider);
    const all = await smm.services(provider, true);
    const selected = [...new Set(serviceIds)].map((id) => all.find((s) => s.service === id));
    if (selected.some((s) => !s || !supportedSmmService(s)))
      throw new AppError(
        'SMM_SERVICE_UNSUPPORTED',
        'A seleção contém um serviço ausente ou de tipo não compatível. Atualize a lista.',
        409,
      );
    if (categoryId) await db.category.findUniqueOrThrow({ where: { id: categoryId } });
    await transaction(async (tx) => {
      for (const service of selected) await storeService(tx, provider, service!, categoryId);
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'smm.import',
          target: id,
          metadata: { services: serviceIds, categoryId: categoryId ?? null },
        },
      });
    });
    return { imported: selected.length, syncedAt: new Date().toISOString() };
  });
}
export async function syncSmmProvider(id: string) {
  return withLock(`smm-catalog:${id}`, async () => {
    const provider = await smmProvider(id);
    await smm.balance(provider);
    const all = await smm.services(provider, true);
    const imported = await db.product.findMany({ where: { smmProviderId: id, archivedAt: null } });
    await transaction(async (tx) => {
      for (const product of imported) {
        const service = all.find((s) => s.service === product.smmServiceId);
        if (service) await storeService(tx, provider, service, product.categoryId);
        else
          await tx.product.update({
            where: { slug: product.slug },
            data: { available: false, syncedAt: new Date() },
          });
      }
    });
    return { products: imported.length };
  });
}
export async function syncAllSmm() {
  for (const provider of await db.smmProvider.findMany({
    where: { active: true },
    select: { id: true },
  }))
    await syncSmmProvider(provider.id).catch(() =>
      console.error(JSON.stringify({ event: 'smm.sync_failed', providerId: provider.id })),
    );
}
export async function ensurePartnerCategory(
  tx: Prisma.TransactionClient,
  provider: { key: string; name: string; sortOrder?: number },
) {
  return tx.category.upsert({
    where: { sourceKey: `partner:${provider.key}` },
    create: {
      id: `partner-${provider.key}`,
      sourceKey: `partner:${provider.key}`,
      name: provider.name,
      sortOrder: provider.sortOrder ?? 0,
    },
    update: {},
  });
}
