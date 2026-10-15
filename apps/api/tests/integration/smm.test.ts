import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, redis, transaction } from '../../src/core/db.js';
import { encrypt, decrypt, hash } from '../../src/core/crypto.js';
import { smmTransport, smm, type SmmService } from '../../src/integrations/smm.js';
import {
  importSmmServices,
  smmSlug,
  syncSmmProvider,
  browseSmmCatalog,
} from '../../src/modules/smm-catalog.js';
import { placeOrder, processOrder, quoteProduct, refundOrder } from '../../src/modules/orders.js';
import { processSmmOrder, linkSmmOrder } from '../../src/modules/smm-orders.js';
import { mutateWallet } from '../../src/modules/wallet.js';
import { prepareDeliveries } from '../../src/modules/messaging.js';
import { syncCatalog, archiveProduct } from '../../src/modules/catalog.js';
import { partner } from '../../src/integrations/partner.js';
import { buildApp } from '../../src/app.js';
import { processIncoming } from '../../src/modules/conversation.js';
import {
  incomingQueue,
  orderQueue,
  outgoingQueue,
  maintenanceQueue,
  paymentQueue,
} from '../../src/core/queues.js';

if (!process.env.DATABASE_URL?.includes('revenda_test'))
  throw new Error('SMM tests require isolated revenda_test.');
const clear =
  'TRUNCATE "AdminSession","Admin","AuditLog","ApiRequestLog","WebhookEvent","Delivery","OrderAttempt","OrderItem","Order","Payment","LedgerEntry","Wallet","Message","Conversation","Customer","Product","Provider","Category","SmmProvider","WhatsappInstance","ExchangeRate","Setting" CASCADE';
let providerId: string, customerId: string, slug: string, currency: string, rate: string;
let status: { charge: string; status: string; remains: string; currency: string };
let transport: ReturnType<typeof vi.spyOn<typeof smmTransport, 'post'>>;
let additions: URLSearchParams[];
const services = (): SmmService[] =>
  [
    ['1', 'Default', 100, 10000],
    ['2', 'Package', 0, 0],
    ['3', 'Custom Comments', 2, 100],
    ['4', 'Comment Likes', 50, 10000],
    ['5', 'Poll', 20, 10000],
    ['6', 'Subscriptions', 0, 0],
  ].map(([service, type, min, max]) => ({
    service: String(service),
    type: String(type),
    name: `Serviço ${type}`,
    category: 'Instagram',
    rate,
    min: Number(min),
    max: Number(max),
    refill: true,
    cancel: true,
    dripfeed: false,
  }));
beforeAll(() => db.$connect());
beforeEach(async () => {
  vi.restoreAllMocks();
  await db.$executeRawUnsafe(clear);
  await redis.flushdb();
  currency = 'USD';
  rate = '1';
  additions = [];
  status = { charge: '1', status: 'In progress', remains: '1000', currency };
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('No real external calls in tests'))),
  );
  transport = vi.spyOn(smmTransport, 'post').mockImplementation(async (_url, body) => {
    const fields = new URLSearchParams(body);
    let response: unknown;
    switch (fields.get('action')) {
      case 'services':
        response = services();
        break;
      case 'balance':
        response = { balance: '1000', currency };
        break;
      case 'add':
        additions.push(fields);
        response = { order: 12345 };
        break;
      case 'status':
        response = status;
        break;
      default:
        throw new Error('Unexpected SMM action');
    }
    return { status: 200, body: JSON.stringify(response) };
  });
  const provider = await db.smmProvider.create({
    data: {
      name: 'Machine SMM',
      url: 'https://machinesmm.com/api/v2',
      encryptedApiKey: encrypt('TEST-SMM-KEY-NEVER-REAL'),
      currency,
    },
  });
  providerId = provider.id;
  slug = smmSlug(providerId, '1');
  customerId = (
    await db.customer.create({
      data: { name: 'Cliente', phone: '5511999999999', wallet: { create: {} } },
    })
  ).id;
  await db.whatsappInstance.create({ data: { name: 'store', state: 'open' } });
  await db.exchangeRate.create({
    data: {
      usdBrl: '5',
      source: 'fixture',
      observedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  await transaction((tx) =>
    mutateWallet(tx, {
      customerId,
      key: 'fixture-credit',
      kind: 'TEST_DEPOSIT',
      availableDelta: '100',
      reservedDelta: '0',
      reason: 'Isolated fixture',
      reference: 'fixture',
    }),
  );
  await importSmmServices(providerId, ['1'], undefined, 'owner-fixture');
  await db.product.update({
    where: { slug },
    data: { authorizedResale: true, markupPercent: '100' },
  });
});
afterAll(async () => {
  await db.$executeRawUnsafe(clear);
  vi.unstubAllGlobals();
  await Promise.all([
    incomingQueue.close(),
    orderQueue.close(),
    outgoingQueue.close(),
    maintenanceQueue.close(),
    paymentQueue.close(),
  ]);
  await redis.quit();
  await db.$disconnect();
});
async function order(
  quantity = 1000,
  service = '1',
  details: Record<string, string> = { link: 'https://example.com/post' },
  key = randomUUID(),
) {
  const productSlug = smmSlug(providerId, service),
    quote = await quoteProduct(productSlug, quantity);
  return placeOrder({
    customerId,
    instanceName: 'store',
    slug: productSlug,
    quantity,
    expectedTotalBrl: quote.totalBrl,
    idempotencyKey: key,
    details,
  });
}
async function wallet() {
  const w = await db.wallet.findUniqueOrThrow({ where: { customerId } });
  return { available: w.available.toFixed(2), reserved: w.reserved.toFixed(2) };
}
async function session() {
  const owner = await db.admin.create({
    data: { email: 'smm-owner@example.com', role: 'OWNER', passwordHash: 'fixture' },
  });
  const token = randomUUID(),
    csrf = randomUUID();
  await db.adminSession.create({
    data: {
      id: hash(token),
      adminId: owner.id,
      csrfHash: hash(csrf),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  return {
    owner,
    headers: { cookie: `session=${token}`, origin: process.env.APP_ORIGIN!, 'x-csrf-token': csrf },
  };
}
async function receive(text: string) {
  const event = await db.webhookEvent.create({
    data: {
      key: randomUUID(),
      source: 'evolution',
      encryptedPayload: encrypt(
        JSON.stringify({
          instance: 'store',
          data: {
            key: { id: randomUUID(), remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
            message: { conversation: text },
          },
        }),
      ),
    },
  });
  await processIncoming(event.id);
  await processIncoming(event.id);
  return db.message.findUnique({ where: { key: `reply-${event.key}` } });
}
it('importa seletivamente, separa fornecedores com mesmo ID e bloqueia tipos contínuos sem gravação parcial', async () => {
  const preview = await browseSmmCatalog(providerId, {
    search: '',
    provider: '',
    page: 1,
    limit: 25,
  });
  expect(preview.data).toHaveLength(6);
  expect(preview.data.find((p) => p.slug === '6')?.canImport).toBe(false);
  expect(preview.data.find((p) => p.slug === '2')?.canImport).toBe(true);
  await expect(importSmmServices(providerId, ['2', '6'], undefined, 'owner')).rejects.toMatchObject(
    { code: 'SMM_SERVICE_UNSUPPORTED' },
  );
  expect(await db.product.count()).toBe(1);
  const second = await db.smmProvider.create({
    data: {
      name: 'Outro',
      url: 'https://example.com/api/v2',
      encryptedApiKey: encrypt('TEST-OTHER-KEY'),
      currency: 'USD',
    },
  });
  await importSmmServices(second.id, ['1'], undefined, 'owner');
  expect(await db.product.count()).toBe(2);
  expect(
    (await db.product.findUniqueOrThrow({ where: { slug: smmSlug(second.id, '1') } })).externalId,
  ).toBeNull();
  expect(await db.provider.count()).toBe(0);
});
it('não altera serviços SMM ao sincronizar Partner nem perde preços/categorias na sincronização SMM', async () => {
  const category = await db.category.create({ data: { name: 'Minha categoria' } });
  await db.product.update({
    where: { slug },
    data: {
      categoryId: category.id,
      displayName: 'Minha oferta',
      description: 'Descrição local',
      manualPrice: '15',
      visible: false,
    },
  });
  vi.spyOn(partner, 'products').mockResolvedValue({ data: [] });
  await syncCatalog();
  expect((await db.product.findUniqueOrThrow({ where: { slug } })).available).toBe(true);
  rate = '2';
  await syncSmmProvider(providerId);
  expect(await db.product.findUniqueOrThrow({ where: { slug } })).toMatchObject({
    categoryId: category.id,
    displayName: 'Minha oferta',
    description: 'Descrição local',
    visible: false,
  });
  expect((await db.product.findUniqueOrThrow({ where: { slug } })).manualPrice?.toFixed(2)).toBe(
    '15.00',
  );
  await archiveProduct(slug, 'owner');
  await syncSmmProvider(providerId);
  expect((await db.product.findUniqueOrThrow({ where: { slug } })).archivedAt).not.toBeNull();
  await importSmmServices(providerId, ['1'], undefined, 'owner');
  expect((await db.product.findUniqueOrThrow({ where: { slug } })).authorizedResale).toBe(false);
  const moved = await db.category.create({ data: { name: 'Categoria escolhida na importação' } });
  await importSmmServices(providerId, ['1'], moved.id, 'owner');
  expect((await db.product.findUniqueOrThrow({ where: { slug } })).categoryId).toBe(moved.id);
});
it('reserva, envia uma única vez sob concorrência, acompanha status e entrega sem duplicar o débito', async () => {
  const key = randomUUID(),
    first = await order(1000, '1', undefined, key);
  expect(first.totalBrl.toFixed(2)).toBe('10.00');
  expect(await wallet()).toEqual({ available: '90.00', reserved: '10.00' });
  expect((await order(1000, '1', undefined, key)).id).toBe(first.id);
  await expect(order(1000, '1', { link: 'https://example.com/other' }, key)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  await Promise.all([processOrder(first.id), processOrder(first.id)]);
  expect(additions).toHaveLength(1);
  expect(additions[0]!.get('quantity')).toBe('1000');
  expect(additions[0]!.get('key')).toBe('TEST-SMM-KEY-NEVER-REAL');
  expect((await db.order.findUniqueOrThrow({ where: { id: first.id } })).smmOrderId).toBe('12345');
  await processSmmOrder(first.id, true);
  expect(await wallet()).toEqual({ available: '90.00', reserved: '10.00' });
  status = { charge: '1', status: 'Completed', remains: '0', currency };
  await Promise.all([processSmmOrder(first.id, true), processSmmOrder(first.id, true)]);
  await prepareDeliveries();
  expect(await wallet()).toEqual({ available: '90.00', reserved: '0.00' });
  expect(await db.delivery.count()).toBe(1);
  expect(await db.ledgerEntry.count({ where: { kind: 'SMM_SETTLE' } })).toBe(1);
  expect(
    (await db.order.findUniqueOrThrow({ where: { id: first.id } })).grossProfitBrl?.toFixed(2),
  ).toBe('5.00');
  const logs = JSON.stringify(await db.apiRequestLog.findMany());
  expect(logs).not.toContain('TEST-SMM-KEY');
  expect(logs).not.toContain('example.com/post');
});
it.each(['Partial', 'Canceled', 'Refunded'])(
  'concilia %s sem duplicar a devolução e mantém relatórios corretos',
  async (state) => {
    const first = await order();
    await processOrder(first.id);
    const partial = state === 'Partial';
    status = {
      charge: partial ? '0.6' : '0',
      status: state,
      remains: partial ? '400' : '1000',
      currency,
    };
    await processSmmOrder(first.id, true);
    await processSmmOrder(first.id, true);
    expect(await wallet()).toEqual({ available: partial ? '94.00' : '100.00', reserved: '0.00' });
    const settled = await db.order.findUniqueOrThrow({ where: { id: first.id } });
    expect(settled.status).toBe(partial ? 'PARTIAL' : 'CANCELLED');
    expect(settled.refundedBrl.toFixed(2)).toBe(partial ? '4.00' : '10.00');
    if (partial) {
      const { headers } = await session(),
        app = await buildApp();
      vi.spyOn(partner, 'balance').mockResolvedValue({ ok: true, currency: 'USD', balance: '0' });
      try {
        const response = await app.inject({ method: 'GET', url: '/api/dashboard', headers });
        expect(response.statusCode).toBe(200);
        expect(response.json().revenue).toBe('6');
        expect(response.json().profit).toBe('3');
      } finally {
        await app.close();
      }
      await refundOrder(first.id, 'Estorno complementar em teste', 'owner');
      await refundOrder(first.id, 'Estorno complementar em teste', 'owner');
      expect(await wallet()).toEqual({ available: '100.00', reserved: '0.00' });
    }
  },
);
it('não repete add incerto, conserva a reserva e permite vincular o pedido real após conferência', async () => {
  const first = await order();
  transport.mockImplementationOnce(async () => {
    throw new Error('Timeout after add');
  }); // services(fresh) fails safely before add
  await expect(processOrder(first.id)).rejects.toThrow();
  expect(additions).toHaveLength(0);
  const base = transport.getMockImplementation()!;
  transport.mockImplementation(async (url, body) => {
    if (new URLSearchParams(body).get('action') === 'add') {
      additions.push(new URLSearchParams(body));
      throw new Error('Lost response after purchase');
    }
    return base(url, body);
  });
  await processOrder(first.id);
  await processOrder(first.id);
  expect(additions).toHaveLength(1);
  expect((await db.order.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('REVIEW');
  expect(await wallet()).toEqual({ available: '90.00', reserved: '10.00' });
  status = { charge: '1', status: 'Completed', remains: '0', currency };
  await linkSmmOrder(first.id, '12345', 'owner');
  expect(await wallet()).toEqual({ available: '90.00', reserved: '0.00' });
  expect(additions).toHaveLength(1);
});
it('exige conferência, permissão financeira e CSRF para liberar criação incerta sem repetir add', async () => {
  const first = await order();
  const base = transport.getMockImplementation()!;
  transport.mockImplementation(async (url, body) => {
    if (new URLSearchParams(body).get('action') === 'add') {
      additions.push(new URLSearchParams(body));
      throw new Error('Lost response');
    }
    return base(url, body);
  });
  await processOrder(first.id);
  const { owner, headers } = await session(),
    app = await buildApp();
  const url = `/api/orders/${first.id}/smm/release`;
  const payload = { reason: 'Conferido no painel: pedido não criado.', confirmed: true };
  try {
    expect(
      (await app.inject({ method: 'POST', url, headers: { cookie: headers.cookie }, payload }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...payload, confirmed: false },
        })
      ).statusCode,
    ).toBe(400);
    await db.admin.update({ where: { id: owner.id }, data: { role: 'OPERATOR' } });
    expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(403);
    expect(await wallet()).toEqual({ available: '90.00', reserved: '10.00' });
    await db.admin.update({ where: { id: owner.id }, data: { role: 'OWNER' } });
    for (let i = 0; i < 2; i++)
      expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(200);
    await processOrder(first.id);
    expect(additions).toHaveLength(1);
    expect(await wallet()).toEqual({ available: '100.00', reserved: '0.00' });
    expect(
      await db.auditLog.count({
        where: { action: 'smm.order.release', target: first.id, actorId: owner.id },
      }),
    ).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('FAILED');
  } finally {
    await app.close();
  }
});
it('libera reserva em recusa explícita e quando o custo muda antes do add', async () => {
  const first = await order();
  rate = '2';
  await processOrder(first.id);
  expect(additions).toHaveLength(0);
  expect(await wallet()).toEqual({ available: '100.00', reserved: '0.00' });
  rate = '1';
  await redis.flushdb();
  const second = await order();
  const base = transport.getMockImplementation()!;
  transport.mockImplementation(async (url, body) =>
    new URLSearchParams(body).get('action') === 'add'
      ? {
          status: 200,
          body: JSON.stringify({ error: 'Provider rejected TEST-SMM-KEY-NEVER-REAL' }),
        }
      : base(url, body),
  );
  await processOrder(second.id);
  expect((await db.order.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('FAILED');
  expect(await wallet()).toEqual({ available: '100.00', reserved: '0.00' });
  expect(JSON.stringify(await db.apiRequestLog.findMany())).not.toContain('TEST-SMM-KEY');
});
it('vende custo em BRL sem cotação USD e bloqueia divergência de moeda', async () => {
  currency = 'BRL';
  rate = '2';
  await db.smmProvider.update({ where: { id: providerId }, data: { currency } });
  await syncSmmProvider(providerId);
  await db.exchangeRate.deleteMany();
  const first = await order();
  expect(first.totalBrl.toFixed(2)).toBe('4.00');
  expect(first.usdBrl).toBeNull();
  await processOrder(first.id);
  status = { charge: '2', status: 'Completed', remains: '0', currency };
  await processSmmOrder(first.id, true);
  expect(
    (await db.order.findUniqueOrThrow({ where: { id: first.id } })).grossProfitBrl?.toFixed(2),
  ).toBe('2.00');
  currency = 'USD';
  await expect(importSmmServices(providerId, ['2'], undefined, 'owner')).rejects.toMatchObject({
    code: 'SMM_CURRENCY_CHANGED',
  });
});
it.each(['2', '3', '4', '5'])(
  'coleta os campos do serviço %s pelo WhatsApp e envia o formato correto',
  async (service) => {
    await importSmmServices(providerId, [service], undefined, 'owner');
    await db.product.updateMany({ data: { authorizedResale: false } });
    await db.product.update({
      where: { slug: smmSlug(providerId, service) },
      data: { authorizedResale: true, markupPercent: '100' },
    });
    await receive('menu');
    await receive('1');
    await receive('1');
    const preview = await receive('1');
    expect(decrypt(preview!.encryptedText)).toContain('Preço:');
    if (!['2', '3'].includes(service)) await receive(service === '4' ? '100' : '20');
    expect((await db.conversation.findFirstOrThrow()).state).toMatchObject({ step: 'SMM_DETAILS' });
    await receive('https://example.com/post');
    if (service === '3') await receive('Comentário um\nComentário dois');
    if (service === '4') await receive('autor');
    if (service === '5') await receive('2');
    expect((await db.conversation.findFirstOrThrow()).state).toMatchObject({ step: 'CONFIRM' });
    await receive('1');
    const first = await db.order.findFirstOrThrow();
    await processOrder(first.id);
    expect(additions).toHaveLength(1);
    expect(additions[0]!.get('service')).toBe(service);
    if (service === '2' || service === '3') expect(additions[0]!.has('quantity')).toBe(false);
    if (service === '3')
      expect(additions[0]!.get('comments')).toBe('Comentário um\nComentário dois');
    if (service === '4') expect(additions[0]!.get('username')).toBe('autor');
    if (service === '5') expect(additions[0]!.get('answer_number')).toBe('2');
  },
);
it('bloqueia destino inválido, mínimo/máximo, categoria oculta e provedor desativado antes de reservar', async () => {
  await expect(order(99)).rejects.toMatchObject({ code: 'INVALID_QUANTITY' });
  await expect(order(10001)).rejects.toMatchObject({ code: 'INVALID_QUANTITY' });
  await expect(order(1000, '1', { link: 'file:///secret' })).rejects.toMatchObject({
    code: 'SMM_LINK_INVALID',
  });
  const product = await db.product.findUniqueOrThrow({ where: { slug } });
  await db.category.update({ where: { id: product.categoryId! }, data: { active: false } });
  await expect(quoteProduct(slug, 1000)).rejects.toMatchObject({ code: 'PRODUCT_UNAVAILABLE' });
  await db.category.update({ where: { id: product.categoryId! }, data: { active: true } });
  await db.smmProvider.update({ where: { id: providerId }, data: { active: false } });
  await expect(quoteProduct(slug, 1000)).rejects.toMatchObject({ code: 'SMM_DISABLED' });
  expect(await db.order.count()).toBe(0);
  expect(await wallet()).toEqual({ available: '100.00', reserved: '0.00' });
});
it('protege cadastro/edição com sessão e CSRF, mantém a chave vazia e audita sem segredos', async () => {
  const { owner, headers } = await session(),
    app = await buildApp();
  const body = {
    name: 'Machine alterada',
    url: 'https://machinesmm.com/api/v2',
    currency: 'USD',
    apiKey: '',
    active: true,
    requestsPerMinute: 60,
  };
  try {
    expect((await app.inject({ method: 'GET', url: '/api/smm-providers' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/smm-providers/${providerId}`,
          headers: { cookie: headers.cookie },
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/smm-providers/${providerId}`,
      headers,
      payload: body,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).not.toContain('encryptedApiKey');
    expect(
      decrypt(
        (await db.smmProvider.findUniqueOrThrow({ where: { id: providerId } })).encryptedApiKey,
      ),
    ).toBe('TEST-SMM-KEY-NEVER-REAL');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/smm-providers',
          headers,
          payload: { ...body, name: 'Unsafe', url: 'http://localhost/api', apiKey: 'secret' },
        })
      ).statusCode,
    ).toBe(400);
    await db.admin.update({ where: { id: owner.id }, data: { role: 'OPERATOR' } });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/smm-providers/${providerId}`,
          headers,
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain('TEST-SMM-KEY');
  } finally {
    await app.close();
  }
});
it('cria/edita categorias e move serviços sem mudar o provedor; oculta no bot e impede exclusão em uso', async () => {
  const { headers } = await session(),
    app = await buildApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers,
      payload: { name: 'Redes sociais', sortOrder: 1, active: true },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/products/${slug}`,
      headers,
      payload: { categoryId: id },
    });
    expect(patch.statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/categories/${id}`, headers })).statusCode,
    ).toBe(409);
    await app.inject({
      method: 'PATCH',
      url: `/api/categories/${id}`,
      headers,
      payload: {
        name: 'Instagram da loja',
        description: 'Meus serviços',
        sortOrder: 1,
        active: true,
      },
    });
    await receive('menu');
    const categories = await receive('1');
    expect(decrypt(categories!.encryptedInteractive!)).toContain('Instagram da loja');
    await app.inject({
      method: 'PATCH',
      url: `/api/categories/${id}`,
      headers,
      payload: { name: 'Instagram da loja', active: false },
    });
    await receive('menu');
    expect(decrypt((await receive('1'))!.encryptedText)).not.toContain('Instagram da loja');
    expect((await db.product.findUniqueOrThrow({ where: { slug } })).smmProviderId).toBe(
      providerId,
    );
  } finally {
    await app.close();
  }
});
