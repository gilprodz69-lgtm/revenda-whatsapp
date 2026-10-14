import { beforeAll, beforeEach, afterAll, it, expect, vi, describe } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, redis, transaction } from '../../src/core/db.js';
import { mutateWallet } from '../../src/modules/wallet.js';
import { placeOrder, processOrder, refundOrder } from '../../src/modules/orders.js';
import { createDeposit, reconcilePayment } from '../../src/modules/payments.js';
import { prepareDeliveries, dispatchMessage } from '../../src/modules/messaging.js';
import { processIncoming } from '../../src/modules/conversation.js';
import { syncCatalog } from '../../src/modules/catalog.js';
import { partner } from '../../src/integrations/partner.js';
import { evolution, InteractiveRejected } from '../../src/integrations/evolution.js';
import { PartnerError, AppError } from '../../src/core/errors.js';
import { encrypt, decrypt } from '../../src/core/crypto.js';
import type { Interactive } from '../../src/modules/interactive.js';
import { saveSetting } from '../../src/core/settings.js';
import { buildApp } from '../../src/app.js';
import {
  incomingQueue,
  orderQueue,
  outgoingQueue,
  maintenanceQueue,
  paymentQueue,
} from '../../src/core/queues.js';
import type { PartnerProduct, PartnerOrder } from '../../src/integrations/partner-contract.js';
import argon2 from 'argon2';
import { createHmac } from 'node:crypto';
import { Worker, Queue, QueueEvents } from 'bullmq';
import { queueConnection } from '../../src/core/queues.js';
import { recordEventFailure, retryEvent } from '../../src/modules/events.js';

if (!process.env.DATABASE_URL?.includes('revenda_test'))
  throw new Error('Integração exige banco isolado revenda_test.');
const live: PartnerProduct = {
  id: 42,
  slug: 'product',
  name: 'Produto de teste',
  provider: { id: 3, key: 'gemini', name: 'Gemini' },
  deliveryType: 'COUPON',
  catalogPrice: '1.00',
  yourPrice: '1.00',
  currency: 'USD',
  stock: { inStock: true, count: 100, maxQuantity: 100 },
};
let customerId: string;
const external = (id: string, quantity = 1): PartnerOrder => ({
  ok: true,
  orderCode: `SO-${id}`,
  externalOrderId: `wa-${id}`,
  status: 'COMPLETED',
  deliveryType: 'COUPON',
  product: { slug: 'product', name: 'Produto' },
  quantity,
  unitPrice: '1.00',
  totalCharged: String(quantity),
  currency: 'USD',
  ...(quantity === 1
    ? { delivery: { code: 'TEST-COUPON' } }
    : {
        lines: Array.from({ length: quantity }, (_, i) => ({
          orderCode: `SO-${id}-L${i}`,
          code: `TEST-${i}`,
        })),
      }),
});
async function credit(amount = '100.00', key = randomUUID()) {
  return transaction((tx) =>
    mutateWallet(tx, {
      customerId,
      key,
      kind: 'TEST_DEPOSIT',
      availableDelta: amount,
      reservedDelta: '0',
      reference: 'test',
      reason: 'Teste isolado',
    }),
  );
}
async function purchase(quantity = 1, key = randomUUID()) {
  return placeOrder({
    customerId,
    instanceName: 'store',
    slug: 'product',
    quantity,
    expectedTotalBrl: String(quantity * 10),
    idempotencyKey: key,
  });
}
beforeAll(async () => {
  await db.$connect();
  await redis.ping();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await db.$executeRawUnsafe(
    'TRUNCATE "AdminSession","Admin","AuditLog","ApiRequestLog","WebhookEvent","Delivery","OrderAttempt","OrderItem","Order","Payment","LedgerEntry","Wallet","Message","Conversation","Customer","Product","Provider","WhatsappInstance","ExchangeRate","Setting" CASCADE',
  );
  await redis.flushdb();
  await db.whatsappInstance.create({ data: { name: 'store', state: 'open' } });
  const customer = await db.customer.create({
    data: { phone: '5511999999999', name: 'Cliente', wallet: { create: {} } },
  });
  customerId = customer.id;
  await db.provider.create({ data: { key: 'gemini', externalId: 3, name: 'Gemini' } });
  await db.product.create({
    data: {
      slug: 'product',
      externalId: 42,
      name: 'Produto',
      providerKey: 'gemini',
      catalogPriceUsd: '1',
      costUsd: '1',
      deliveryType: 'COUPON',
      stock: 100,
      maxQuantity: 100,
      available: true,
      authorizedResale: true,
      markupPercent: '100',
      bulkTiers: [],
      syncedAt: new Date(),
    },
  });
  await db.exchangeRate.create({
    data: {
      usdBrl: '5',
      source: 'test',
      observedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  vi.spyOn(partner, 'product').mockResolvedValue(live);
  vi.spyOn(partner, 'health').mockResolvedValue({ ok: true, service: 'partner-api', version: 1 });
  vi.spyOn(partner, 'balance').mockResolvedValue({ ok: true, balance: '1000', currency: 'USD' });
  // No fetch reaches a real purchase/payment endpoint during integration tests.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Acesso externo proibido nos testes'))),
  );
});
afterAll(async () => {
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
describe('Ledger transacional, pedidos e recuperação', () => {
  it('estorna uma única vez e impede envio pendente após o estorno', async () => {
    await credit();
    const order = await purchase();
    vi.spyOn(partner, 'createOrder').mockResolvedValue(external(order.id));
    await processOrder(order.id);
    await prepareDeliveries();
    await refundOrder(order.id, 'Devolução autorizada em teste', 'test-owner');
    await refundOrder(order.id, 'Devolução autorizada em teste', 'test-owner');
    expect(
      (await db.wallet.findUniqueOrThrow({ where: { customerId } })).available.toFixed(2),
    ).toBe('100.00');
    expect(await db.ledgerEntry.count({ where: { kind: 'REFUND' } })).toBe(1);
    const delivery = await db.delivery.findFirstOrThrow();
    const send = vi.spyOn(evolution, 'sendText');
    await dispatchMessage(delivery.messageId!);
    expect(send).not.toHaveBeenCalled();
  });
  it('credita o mesmo depósito uma única vez sob concorrência', async () => {
    const key = randomUUID();
    await Promise.all([credit('100', key), credit('100', key), credit('100', key)]);
    expect(
      (await db.wallet.findUniqueOrThrow({ where: { customerId } })).available.toFixed(2),
    ).toBe('100.00');
    expect(await db.ledgerEntry.count()).toBe(1);
  });
  it('recusa duas reservas concorrentes que excedem o saldo', async () => {
    await credit();
    const result = await Promise.allSettled([purchase(6), purchase(6)]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const wallet = await db.wallet.findUniqueOrThrow({ where: { customerId } });
    expect(wallet.available.toFixed(2)).toBe('40.00');
    expect(wallet.reserved.toFixed(2)).toBe('60.00');
  });
  it('repetir confirmação não cria novo pedido nem débito', async () => {
    await credit();
    const key = randomUUID();
    const a = await purchase(1, key),
      b = await purchase(1, key);
    expect(a.id).toBe(b.id);
    expect(await db.order.count()).toBe(1);
    expect(await db.ledgerEntry.count({ where: { kind: 'RESERVE' } })).toBe(1);
  });
  it('não altera ledger já lançado', async () => {
    await credit();
    const row = await db.ledgerEntry.findFirstOrThrow();
    await expect(
      db.ledgerEntry.update({ where: { id: row.id }, data: { reason: 'alterado' } }),
    ).rejects.toThrow();
  });
  it('conclui compra em lote e entrega todas as unidades uma vez', async () => {
    await credit();
    const order = await purchase(3);
    vi.spyOn(partner, 'createOrder').mockResolvedValue(external(order.id, 3));
    await processOrder(order.id);
    await processOrder(order.id);
    await prepareDeliveries();
    await prepareDeliveries();
    expect(await db.delivery.count()).toBe(3);
    expect(await db.message.count({ where: { direction: 'OUT' } })).toBe(3);
    expect((await db.wallet.findUniqueOrThrow({ where: { customerId } })).reserved.toFixed(2)).toBe(
      '0.00',
    );
    expect(await db.ledgerEntry.count({ where: { kind: 'CAPTURE' } })).toBe(1);
  });
  it('reconcilia timeout depois da compra externa sem comprar ou debitar de novo', async () => {
    await credit();
    const order = await purchase();
    const create = vi
      .spyOn(partner, 'createOrder')
      .mockRejectedValue(new PartnerError('TRANSPORT_UNKNOWN', undefined, 503, true));
    await expect(processOrder(order.id)).rejects.toThrow();
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('UNKNOWN');
    vi.spyOn(partner, 'orders').mockResolvedValue({
      data: [external(order.id)],
      meta: { page: 1, limit: 100, total: 1, totalPages: 1 },
    });
    vi.spyOn(partner, 'order').mockResolvedValue(external(order.id));
    await processOrder(order.id);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await db.ledgerEntry.count({ where: { kind: 'CAPTURE' } })).toBe(1);
  });
  it('reusa o mesmo ID e corpo quando busca não encontra pedido após timeout', async () => {
    await credit();
    const order = await purchase();
    const create = vi
      .spyOn(partner, 'createOrder')
      .mockRejectedValueOnce(new PartnerError('TRANSPORT_UNKNOWN', undefined, 503, true))
      .mockResolvedValue(external(order.id));
    await expect(processOrder(order.id)).rejects.toThrow();
    vi.spyOn(partner, 'orders').mockResolvedValue({
      data: [],
      meta: { page: 1, limit: 100, total: 0, totalPages: 0 },
    });
    await processOrder(order.id);
    expect(create.mock.calls[0]?.[0]).toEqual(create.mock.calls[1]?.[0]);
  });
  it('libera reserva em falta de estoque comprovada', async () => {
    await credit();
    const order = await purchase();
    vi.mocked(partner.product).mockResolvedValue({
      ...live,
      stock: { inStock: false, count: 0, maxQuantity: 0 },
    });
    await processOrder(order.id);
    const wallet = await db.wallet.findUniqueOrThrow({ where: { customerId } });
    expect(wallet.available.toFixed(2)).toBe('100.00');
    expect(wallet.reserved.toFixed(2)).toBe('0.00');
  });
  it('mantém a reserva quando fornecedor está indisponível', async () => {
    await credit();
    const order = await purchase();
    vi.mocked(partner.health).mockRejectedValue(new PartnerError('MAINTENANCE', 'req-1', 503));
    await expect(processOrder(order.id)).rejects.toThrow();
    expect((await db.wallet.findUniqueOrThrow({ where: { customerId } })).reserved.toFixed(2)).toBe(
      '10.00',
    );
  });
  it('não reenvia automaticamente uma entrega com resultado incerto', async () => {
    await credit();
    const order = await purchase();
    vi.spyOn(partner, 'createOrder').mockResolvedValue(external(order.id));
    await processOrder(order.id);
    await prepareDeliveries();
    const message = await db.message.findFirstOrThrow({ where: { direction: 'OUT' } });
    const send = vi.spyOn(evolution, 'sendText').mockRejectedValue(new Error('timeout'));
    await expect(dispatchMessage(message.id)).rejects.toThrow();
    await dispatchMessage(message.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await db.delivery.findFirstOrThrow()).status).toBe('UNKNOWN');
  });
  it('preserva a entrega pendente durante desconexão WhatsApp', async () => {
    const m = await db.message.create({
      data: {
        key: 'test',
        customerId,
        instanceName: 'store',
        direction: 'OUT',
        encryptedText: encrypt('teste'),
      },
    });
    await db.whatsappInstance.update({ where: { name: 'store' }, data: { state: 'close' } });
    const send = vi.spyOn(evolution, 'sendText');
    await dispatchMessage(m.id);
    expect(send).not.toHaveBeenCalled();
    expect((await db.message.findUniqueOrThrow({ where: { id: m.id } })).status).toBe('PENDING');
  });
});
describe('Catálogo, webhooks e fluxo completo', () => {
  it('navega por botões e listas, ignora menu antigo e confirma a compra uma vez', async () => {
    await credit();
    async function receive(text: string, native = false) {
      const event = await db.webhookEvent.create({
        data: {
          key: randomUUID(),
          source: 'evolution',
          encryptedPayload: encrypt(
            JSON.stringify({
              instance: 'store',
              data: {
                key: { id: randomUUID(), remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
                message: native
                  ? {
                      interactiveResponseMessage: {
                        nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: text }) },
                      },
                    }
                  : { conversation: text },
              },
            }),
          ),
        },
      });
      await processIncoming(event.id);
      await processIncoming(event.id);
      return db.message.findUnique({ where: { key: `reply-${event.key}` } });
    }
    const menu = JSON.parse(decrypt((await receive('oi'))!.encryptedInteractive!)) as Interactive;
    expect(menu.type).toBe('buttons');
    const options = (m: Interactive) => (m.type === 'buttons' ? m.buttons : m.rows);
    expect(options(menu).map((o) => o.title)).toEqual([
      '🛍️ Comprar serviços',
      '💰 Meu saldo',
      '🎧 Suporte',
    ]);
    expect(menu.description).not.toContain('1 - Ver produtos');
    const categories = JSON.parse(
      decrypt((await receive(options(menu)[0]!.id, true))!.encryptedInteractive!),
    ) as Interactive;
    expect(categories.type).toBe('list');
    const products = JSON.parse(
      decrypt((await receive(options(categories)[0]!.id, true))!.encryptedInteractive!),
    ) as Interactive;
    expect(products.type).toBe('list');
    const quantity = JSON.parse(
      decrypt((await receive(options(products)[0]!.id, true))!.encryptedInteractive!),
    ) as Interactive;
    const summary = JSON.parse(
      decrypt((await receive(options(quantity)[0]!.id, true))!.encryptedInteractive!),
    ) as Interactive;
    expect(options(summary)[0]!.title).toBe('✅ Confirmar compra');
    expect(await receive(options(quantity)[0]!.id, true)).toBeNull();
    expect(await db.order.count()).toBe(0);
    await receive(options(summary)[0]!.id, true);
    await receive(options(summary)[0]!.id, true);
    expect(await db.order.count()).toBe(1);
    expect((await db.wallet.findUniqueOrThrow({ where: { customerId } })).reserved.toFixed(2)).toBe(
      '10.00',
    );
  });
  it('volta ao texto só após rejeição explícita; timeout não duplica o envio', async () => {
    const message = {
      type: 'buttons',
      title: 'Loja',
      description: 'Olá',
      footer: 'Escolha',
      buttons: [{ id: 'wa:token:1', title: 'Comprar' }],
    };
    const create = () =>
      db.message.create({
        data: {
          key: randomUUID(),
          instanceName: 'store',
          customerId,
          direction: 'OUT',
          encryptedText: encrypt('1 - Comprar'),
          encryptedInteractive: encrypt(JSON.stringify(message)),
        },
      });
    const rich = vi
      .spyOn(evolution, 'sendInteractive')
      .mockRejectedValueOnce(new InteractiveRejected());
    const text = vi.spyOn(evolution, 'sendText').mockResolvedValue({ key: { id: 'fallback' } });
    const first = await create();
    await dispatchMessage(first.id);
    expect(text).toHaveBeenCalledTimes(1);
    expect((await db.message.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('SENT');
    rich.mockRejectedValueOnce(new AppError('EVOLUTION_TIMEOUT', 'Timeout', 503));
    const second = await create();
    await expect(dispatchMessage(second.id)).rejects.toMatchObject({ code: 'EVOLUTION_TIMEOUT' });
    expect(text).toHaveBeenCalledTimes(1);
    expect((await db.message.findUniqueOrThrow({ where: { id: second.id } })).status).toBe(
      'UNKNOWN',
    );
    await dispatchMessage(second.id);
    expect(rich).toHaveBeenCalledTimes(2);
    await saveSetting('bot.messageStyle', 'text');
    const third = await create();
    await dispatchMessage(third.id);
    expect(text).toHaveBeenCalledTimes(2);
    expect(rich).toHaveBeenCalledTimes(2);
  });
  it('pagina categorias sem ultrapassar dez opções na lista e mantém o modo texto disponível', async () => {
    for (let i = 0; i < 10; i++)
      await db.provider.create({
        data: {
          key: `extra-${i}`,
          externalId: 100 + i,
          name: `Categoria ${i}`,
          sortOrder: i + 1,
          products: {
            create: {
              slug: `extra-product-${i}`,
              externalId: 100 + i,
              name: `Produto ${i}`,
              costUsd: '1',
              catalogPriceUsd: '1',
              deliveryType: 'COUPON',
              stock: 10,
              maxQuantity: 10,
              available: true,
              authorizedResale: true,
              bulkTiers: [],
            },
          },
        },
      });
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
      return db.message.findUniqueOrThrow({ where: { key: `reply-${event.key}` } });
    }
    await receive('oi');
    const first = JSON.parse(decrypt((await receive('1')).encryptedInteractive!)) as Interactive;
    expect(first.type).toBe('list');
    if (first.type !== 'list') throw Error('Expected list');
    expect(first.rows).toHaveLength(10);
    const firstKeys = (await db.conversation.findFirstOrThrow()).state as { options: string[] };
    const next = first.rows.find((row) => row.title === 'Mais categorias')!;
    const second = JSON.parse(
      decrypt((await receive(next.id)).encryptedInteractive!),
    ) as Interactive;
    expect(second.type).toBe('list');
    if (second.type !== 'list') throw Error('Expected list');
    expect(second.rows).toHaveLength(4);
    const secondKeys = (await db.conversation.findFirstOrThrow()).state as { options: string[] };
    expect(firstKeys.options.filter((k) => secondKeys.options.includes(k))).toEqual([]);
    await saveSetting('bot.messageStyle', 'text');
    const plain = await receive('menu');
    expect(plain.encryptedInteractive).toBeNull();
    expect(decrypt(plain.encryptedText)).toContain('1 - Ver produtos');
  });
  it('ignora grupos na entrada HTTP e no processamento de eventos já persistidos', async () => {
    const app = await buildApp();
    const payload = {
      instance: 'store',
      event: 'messages.upsert',
      data: {
        key: {
          id: 'group',
          remoteJid: '12000@g.us',
          remoteJidAlt: '5511999999999@s.whatsapp.net',
          fromMe: false,
        },
        message: { conversation: 'oi' },
      },
    };
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/evolution',
      headers: { 'x-webhook-secret': process.env.WEBHOOK_SECRET },
      payload,
    });
    expect(response.statusCode).toBe(202);
    expect(await db.webhookEvent.count()).toBe(0);
    const event = await db.webhookEvent.create({
      data: {
        key: 'old-group',
        source: 'evolution',
        encryptedPayload: encrypt(JSON.stringify(payload)),
      },
    });
    await processIncoming(event.id);
    expect(await db.message.count()).toBe(0);
    expect(await db.conversation.count()).toBe(0);
    expect(
      (await db.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).processedAt,
    ).not.toBeNull();
    await app.close();
  });
  it('exige palavra configurada para iniciar e permite continuar pelo menu até a sessão expirar', async () => {
    await saveSetting('bot.activationKeywords', ['Quero comprar']);
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
    }
    await receive('oi');
    await receive('1');
    expect(await db.message.count()).toBe(0);
    await receive('QUERO   COMPRAR!');
    expect((await db.conversation.findFirstOrThrow()).state).toMatchObject({ step: 'MENU' });
    const reply = await db.message.findFirstOrThrow({ where: { direction: 'OUT' } });
    expect(await outgoingQueue.getJob(`send-${reply.id}`)).toBeDefined();
    await receive('1');
    expect((await db.conversation.findFirstOrThrow()).state).toMatchObject({ step: 'PROVIDERS' });
    await db.conversation.updateMany({ data: { expiresAt: new Date(0) } });
    await receive('1');
    expect(await db.message.count({ where: { direction: 'OUT' } })).toBe(2);
    await saveSetting('bot.activationKeywords', []);
    await receive('Quero comprar');
    expect(await db.message.count({ where: { direction: 'OUT' } })).toBe(2);
  });
  it('reconstrói a navegação voltar e permite solicitar suporte em qualquer etapa', async () => {
    for (const [i, text] of ['oi', '1', 'voltar', '1', '1', '1', 'suporte'].entries()) {
      const event = await db.webhookEvent.create({
        data: {
          key: `back-${i}`,
          source: 'evolution',
          encryptedPayload: encrypt(
            JSON.stringify({
              instance: 'store',
              data: {
                key: { id: `back-${i}`, remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
                message: { conversation: text },
              },
            }),
          ),
        },
      });
      await processIncoming(event.id);
      if (i === 2)
        expect((await db.conversation.findFirstOrThrow()).state).toMatchObject({ step: 'MENU' });
    }
    expect(
      (await db.customer.findUniqueOrThrow({ where: { id: customerId } })).humanUntil?.getTime(),
    ).toBeGreaterThan(Date.now());
  });
  it('encaminha evento esgotado para revisão e permite reprocessamento auditado', async () => {
    const event = await db.webhookEvent.create({
      data: { key: 'failed-event', source: 'evolution', encryptedPayload: encrypt('{}') },
    });
    await recordEventFailure(event.id, 'INTERNAL', true);
    expect(
      (await db.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).failedAt,
    ).not.toBeNull();
    await retryEvent(event.id, 'test-owner');
    expect(
      (await db.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).failedAt,
    ).toBeNull();
    expect(await incomingQueue.getJob(`event-${event.id}`)).not.toBeUndefined();
    expect(await db.auditLog.count({ where: { action: 'event.retry' } })).toBe(1);
  });
  it('sincroniza sem destruir regras locais e desativa ausentes', async () => {
    vi.spyOn(partner, 'providers').mockResolvedValue({ data: [live.provider] });
    vi.spyOn(partner, 'products').mockResolvedValue({ data: [{ ...live, yourPrice: '2' }] });
    await db.product.update({ where: { slug: 'product' }, data: { manualPrice: '25' } });
    await syncCatalog();
    const product = await db.product.findUniqueOrThrow({ where: { slug: 'product' } });
    expect(product.manualPrice?.toFixed(2)).toBe('25.00');
    expect(product.costUsd.toFixed(2)).toBe('2.00');
    vi.mocked(partner.products).mockResolvedValue({ data: [] });
    await syncCatalog();
    expect(await db.product.count()).toBe(1);
    expect((await db.product.findUniqueOrThrow({ where: { slug: 'product' } })).available).toBe(
      false,
    );
  });
  it('valida e deduplica webhook e ignora mensagens próprias', async () => {
    const app = await buildApp();
    const body = {
      event: 'messages.upsert',
      instance: 'store',
      data: {
        key: { id: 'w1', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
        message: { conversation: 'oi' },
      },
    };
    expect(
      (await app.inject({ method: 'POST', url: '/webhooks/evolution', payload: body })).statusCode,
    ).toBe(401);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/webhooks/evolution',
            headers: { 'x-webhook-secret': process.env.WEBHOOK_SECRET },
            payload: body,
          })
        ).statusCode,
      ).toBe(202);
    expect(await db.webhookEvent.count()).toBe(1);
    const stored = await db.webhookEvent.findFirstOrThrow();
    expect(await incomingQueue.getJob(`event-${stored.id}`)).toBeDefined();
    await app.inject({
      method: 'POST',
      url: '/webhooks/evolution',
      headers: { 'x-webhook-secret': process.env.WEBHOOK_SECRET },
      payload: {
        ...body,
        data: { ...body.data, key: { ...body.data.key, id: 'own', fromMe: true } },
      },
    });
    expect(await db.webhookEvent.count()).toBe(1);
    await app.close();
  });
  it('navega da saudação até compra e entrega usando estado persistente e recuperação', async () => {
    await credit();
    for (const [i, text] of ['oi', '1', '1', '1', '1', '1'].entries()) {
      const event = await db.webhookEvent.create({
        data: {
          key: `flow-${i}`,
          source: 'evolution',
          encryptedPayload: encrypt(
            JSON.stringify({
              instance: 'store',
              data: {
                key: { id: `flow-${i}`, remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
                message: { conversation: text },
              },
            }),
          ),
        },
      });
      await processIncoming(event.id);
      await processIncoming(event.id);
    }
    expect(await db.order.count()).toBe(1);
    expect(await db.message.count({ where: { direction: 'OUT' } })).toBe(6);
    expect((await db.conversation.findFirstOrThrow()).state).toMatchObject({ step: 'MENU' });
    const order = await db.order.findFirstOrThrow();
    vi.spyOn(partner, 'createOrder').mockResolvedValue(external(order.id));
    await processOrder(order.id);
    await prepareDeliveries();
    const delivery = await db.delivery.findFirstOrThrow();
    const send = vi.spyOn(evolution, 'sendText').mockResolvedValue({ key: { id: 'sent-test' } });
    await dispatchMessage(delivery.messageId!);
    expect(send.mock.calls[0]?.slice(0, 2)).toEqual(['store', '5511999999999']);
    expect((await db.delivery.findFirstOrThrow()).status).toBe('SENT');
  });
  it('não credita Pix com valor ou referência divergente', async () => {
    await saveSetting('pix.gateway', 'mercadopago');
    await saveSetting('secret.mpToken', 'TEST-token-never-real', true);
    const id = randomUUID();
    await db.payment.create({
      data: {
        id,
        customerId,
        instanceName: 'store',
        idempotencyKey: randomUUID(),
        gateway: 'mercadopago',
        gatewayId: '1',
        amountBrl: '20',
        encryptedRequestBody: encrypt('{}'),
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 1,
              external_reference: id,
              transaction_amount: 200,
              currency_id: 'BRL',
              status: 'approved',
              payment_method_id: 'pix',
              live_mode: false,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    await expect(reconcilePayment('1')).rejects.toThrow('divergente');
    expect(await db.ledgerEntry.count()).toBe(0);
  });
  it('confirma depósito Pix autenticado e protege contra crédito duplicado', async () => {
    await saveSetting('pix.gateway', 'mercadopago');
    await saveSetting('secret.mpToken', 'TEST-token-never-real', true);
    let reference = '';
    let approved = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, opts?: RequestInit) => {
        if (opts?.method === 'POST') reference = JSON.parse(String(opts.body)).external_reference;
        return new Response(
          JSON.stringify({
            id: 123,
            external_reference: reference,
            transaction_amount: 20,
            currency_id: 'BRL',
            status: approved ? 'approved' : 'pending',
            payment_method_id: 'pix',
            live_mode: false,
            date_of_expiration: new Date(Date.now() + 3600000).toISOString(),
            point_of_interaction: { transaction_data: { qr_code: 'PIX-CODE' } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    const payment = await createDeposit(
      customerId,
      'store',
      '20',
      { email: 'test@example.com', cpf: '52998224725' },
      randomUUID(),
    );
    approved = true;
    await Promise.all([reconcilePayment(payment.gatewayId!), reconcilePayment(payment.gatewayId!)]);
    expect(
      (await db.wallet.findUniqueOrThrow({ where: { customerId } })).available.toFixed(2),
    ).toBe('20.00');
    expect(await db.ledgerEntry.count({ where: { kind: 'DEPOSIT' } })).toBe(1);
  });
});
describe('Expay Brasil', () => {
  async function configured() {
    await saveSetting('pix.gateway', 'expay');
    await saveSetting('secret.expayApiKey', 'TEST-EXPAY-KEY-NEVER-REAL', true);
  }
  it('cria Pix pela API atual e credita uma única vez com reconciliações concorrentes', async () => {
    await configured();
    const gatewayId = randomUUID();
    let reference = '',
      status = 'pending';
    const fetch = vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') reference = JSON.parse(String(options.body)).reference;
      return new Response(
        JSON.stringify({
          charge_id: gatewayId,
          reference,
          amount: 20,
          currency: 'BRL',
          payment_method: 'pix',
          status,
          pix_data: { copy_paste: 'PIX-EXPAY-TEST' },
          expires_at: null,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetch);
    const key = randomUUID();
    const payment = await createDeposit(
      customerId,
      'store',
      '20',
      { email: 'test@example.com', cpf: '52998224725' },
      key,
    );
    expect(payment.gateway).toBe('expay');
    expect(payment.expiresAt).toBeNull();
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': key,
      'X-API-Key': 'TEST-EXPAY-KEY-NEVER-REAL',
    });
    status = 'paid';
    await Promise.all([reconcilePayment(gatewayId), reconcilePayment(gatewayId)]);
    expect(
      (await db.wallet.findUniqueOrThrow({ where: { customerId } })).available.toFixed(2),
    ).toBe('20.00');
    expect(await db.ledgerEntry.count({ where: { kind: 'DEPOSIT' } })).toBe(1);
    status = 'refunded';
    await reconcilePayment(gatewayId);
    expect((await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      'REVIEW',
    );
    expect((await db.customer.findUniqueOrThrow({ where: { id: customerId } })).blocked).toBe(true);
  });
  it.each(['amount', 'reference', 'currency', 'payment_method'])(
    'não credita cobrança Expay com %s divergente',
    async (field) => {
      await configured();
      const id = randomUUID(),
        gatewayId = randomUUID();
      await db.payment.create({
        data: {
          id,
          customerId,
          instanceName: 'store',
          idempotencyKey: randomUUID(),
          gateway: 'expay',
          gatewayId,
          amountBrl: '20',
          encryptedRequestBody: encrypt('{}'),
        },
      });
      const charge: Record<string, unknown> = {
        charge_id: gatewayId,
        reference: id,
        amount: 20,
        currency: 'BRL',
        payment_method: 'pix',
        status: 'paid',
      };
      charge[field] =
        field === 'amount'
          ? 200
          : field === 'reference'
            ? randomUUID()
            : field === 'currency'
              ? 'USD'
              : 'boleto';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(charge), { status: 200 })),
      );
      await expect(reconcilePayment(gatewayId)).rejects.toThrow('divergente');
      expect(await db.ledgerEntry.count()).toBe(0);
    },
  );
  it('webhook público não aprova pelo corpo e ignora cobranças desconhecidas', async () => {
    await configured();
    const id = randomUUID(),
      gatewayId = randomUUID();
    await db.payment.create({
      data: {
        id,
        customerId,
        instanceName: 'store',
        idempotencyKey: randomUUID(),
        gateway: 'expay',
        gatewayId,
        amountBrl: '20',
        status: 'PENDING',
        encryptedRequestBody: encrypt('{}'),
      },
    });
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: gatewayId,
            reference: id,
            amount: 20,
            currency: 'BRL',
            payment_method: 'pix',
            status: 'pending',
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetch);
    const app = await buildApp();
    try {
      for (let i = 0; i < 2; i++)
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/webhooks/pix/expay',
              payload: { charge_id: gatewayId, status: 'paid', amount: 10000 },
            })
          ).statusCode,
        ).toBe(202);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/webhooks/pix/expay',
            payload: { charge_id: randomUUID(), status: 'paid' },
          })
        ).statusCode,
      ).toBe(202);
      expect(await db.webhookEvent.count()).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
      await reconcilePayment(gatewayId);
      expect(await db.ledgerEntry.count()).toBe(0);
      expect((await db.payment.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
    } finally {
      await app.close();
    }
  });
});
describe('Autenticação, filas e proteção de webhooks financeiros', () => {
  it('permite ao proprietário salvar palavras-chave sem alterar credenciais ou configurações existentes', async () => {
    const owner = await db.admin.create({
      data: {
        email: 'owner@test.example',
        passwordHash: await argon2.hash('Test-password-12345'),
        role: 'OWNER',
      },
    });
    await saveSetting('store.name', 'Minha loja');
    await saveSetting('secret.expayApiKey', 'TEST-KEY', true);
    await saveSetting('bot.greetings', ['legado']);
    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://localhost:5173' },
      payload: { email: owner.email, password: 'Test-password-12345' },
    });
    const headers = {
      cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      origin: 'http://localhost:5173',
      'x-csrf-token': login.json().csrf,
    };
    const initial = await app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(initial.json().values['bot.activationKeywords']).toContain('legado');
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/settings',
          headers,
          payload: { 'bot.activationKeywords': [' Vendas ', 'vendas', 'Olá'] },
        })
      ).statusCode,
    ).toBe(200);
    const settings = (await app.inject({ method: 'GET', url: '/api/settings', headers })).json();
    expect(settings.values['bot.activationKeywords']).toEqual(['vendas', 'Olá']);
    expect(settings.values['store.name']).toBe('Minha loja');
    expect(settings.secrets['secret.expayApiKey']).toBe(true);
    expect((await db.admin.findUniqueOrThrow({ where: { id: owner.id } })).passwordHash).toBe(
      owner.passwordHash,
    );
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/settings',
          headers,
          payload: { 'bot.activationKeywords': [] },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/settings', headers })).json().values[
        'bot.activationKeywords'
      ],
    ).toEqual([]);
    await app.close();
  });
  it('retorna dashboard por período e filtros de catálogo com preços em Decimal', async () => {
    await db.admin.create({
      data: {
        email: 'owner@test.example',
        passwordHash: await argon2.hash('Test-password-12345'),
        role: 'OWNER',
      },
    });
    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://localhost:5173' },
      payload: { email: 'owner@test.example', password: 'Test-password-12345' },
    });
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const overview = await app.inject({
      method: 'GET',
      url: '/api/dashboard?days=7',
      headers: { cookie },
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({ days: 7, customers: 1, revenue: '0', chart: [] });
    const products = await app.inject({
      method: 'GET',
      url: '/api/products?filter=available',
      headers: { cookie },
    });
    expect(products.statusCode).toBe(200);
    expect(products.json().data[0].quote.unitSaleBrl).toBe('10.00');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/products?filter=unauthorized',
          headers: { cookie },
        })
      ).json().total,
    ).toBe(0);
    await app.close();
  });
  it('exige login, origem, CSRF e permissão financeira', async () => {
    await db.admin.create({
      data: {
        email: 'op@test.example',
        passwordHash: await argon2.hash('Test-password-12345'),
        role: 'OPERATOR',
      },
    });
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/api/customers' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: 'op@test.example', password: 'Test-password-12345' },
        })
      ).statusCode,
    ).toBe(403);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://localhost:5173' },
      payload: { email: 'op@test.example', password: 'Test-password-12345' },
    });
    expect(login.statusCode).toBe(200);
    const csrf = login.json().csrf;
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const connect = vi.spyOn(evolution, 'connect').mockResolvedValue({ pairingCode: '1234-5678' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/whatsapp/store/connect',
          headers: { cookie, origin: 'http://localhost:5173' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/whatsapp/store/connect',
          headers: { cookie, origin: 'http://localhost:5173', 'x-csrf-token': csrf },
          payload: {},
        })
      ).json(),
    ).toMatchObject({ pairingCode: '1234-5678' });
    expect(connect).toHaveBeenCalledWith('store', undefined);
    expect(login.cookies.find((c) => c.name === 'session')?.httpOnly).toBe(true);
    expect(
      (await app.inject({ method: 'GET', url: '/api/customers', headers: { cookie } })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/customers/${customerId}/balance`,
          headers: { cookie, origin: 'http://localhost:5173' },
          payload: { amount: '10', reason: 'Teste de permissão', key: randomUUID() },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/customers/${customerId}/balance`,
          headers: { cookie, origin: 'http://localhost:5173', 'x-csrf-token': csrf },
          payload: { amount: '10', reason: 'Teste de permissão', key: randomUUID() },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { cookie, origin: 'http://localhost:5173', 'x-csrf-token': csrf },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/customers', headers: { cookie } })).statusCode,
    ).toBe(401);
    await app.close();
  });
  it('valida HMAC Pix e rejeita ID adulterado sem confiar no status enviado', async () => {
    await saveSetting('pix.gateway', 'mercadopago');
    await saveSetting('secret.mpWebhookSecret', 'test-secret-long-enough', true);
    const app = await buildApp(),
      ts = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', 'test-secret-long-enough')
      .update(`id:123;request-id:r1;ts:${ts};`)
      .digest('hex');
    const headers = { 'x-signature': `ts=${ts},v1=${signature}`, 'x-request-id': 'r1' };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/webhooks/pix?data.id=123',
          headers,
          payload: { type: 'payment', data: { id: '124' }, status: 'approved' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/webhooks/pix?data.id=123',
          headers,
          payload: { type: 'payment', data: { id: '123' } },
        })
      ).statusCode,
    ).toBe(202);
    expect(await db.webhookEvent.count()).toBe(1);
    expect(await db.ledgerEntry.count()).toBe(0);
    await app.close();
  });
  it('executa job BullMQ real no Redis configurado', async () => {
    const name = `test-${randomUUID()}`,
      queue = new Queue(name, { connection: queueConnection }),
      events = new QueueEvents(name, { connection: queueConnection });
    const worker = new Worker(name, async (job) => job.data.value + 1, {
      connection: queueConnection,
    });
    try {
      await events.waitUntilReady();
      const job = await queue.add('check', { value: 41 });
      expect(await job.waitUntilFinished(events, 10000)).toBe(42);
    } finally {
      await worker.close();
      await events.close();
      await queue.close();
    }
  });
});
