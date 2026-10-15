import { beforeAll, beforeEach, afterAll, it, expect, vi, describe } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, redis, transaction } from '../../src/core/db.js';
import { mutateWallet } from '../../src/modules/wallet.js';
import { placeOrder, processOrder, refundOrder, quoteProduct } from '../../src/modules/orders.js';
import { createDeposit, reconcilePayment } from '../../src/modules/payments.js';
import { prepareDeliveries, dispatchMessage } from '../../src/modules/messaging.js';
import { processIncoming } from '../../src/modules/conversation.js';
import {
  syncCatalog,
  browseCatalog,
  importCatalog,
  archiveProduct,
} from '../../src/modules/catalog.js';
import { partner } from '../../src/integrations/partner.js';
import { evolution, InteractiveRejected } from '../../src/integrations/evolution.js';
import { PartnerError, AppError } from '../../src/core/errors.js';
import { encrypt, decrypt, hash } from '../../src/core/crypto.js';
import type { Interactive } from '../../src/modules/interactive.js';
import { saveSetting, credentials } from '../../src/core/settings.js';
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
    await saveSetting('bot.mainMenuStyle', 'list');
    await credit();
    async function receive(text: string, native = false, list = false) {
      const event = await db.webhookEvent.create({
        data: {
          key: randomUUID(),
          source: 'evolution',
          encryptedPayload: encrypt(
            JSON.stringify({
              instance: 'store',
              data: {
                key: { id: randomUUID(), remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
                message: list
                  ? { listResponseMessage: { singleSelectReply: { selectedRowId: text } } }
                  : native
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
    expect(menu.type).toBe('list');
    if (menu.type !== 'list') throw Error('Expected native list menu');
    expect(menu.buttonText).toBe('Menu');
    const options = (m: Interactive) => (m.type === 'buttons' ? m.buttons : m.rows);
    expect(options(menu).map((o) => o.title)).toEqual([
      '🛍️ Comprar serviços',
      '💰 Meu saldo',
      '💳 Adicionar saldo',
      '📦 Meus pedidos',
      '🎧 Suporte',
      '👤 Minha conta',
    ]);
    expect(menu.description).not.toContain('1 - Ver produtos');
    const categories = JSON.parse(
      decrypt((await receive(options(menu)[0]!.id, false, true))!.encryptedInteractive!),
    ) as Interactive;
    expect(categories.type).toBe('list');
    const products = JSON.parse(
      decrypt((await receive(options(categories)[0]!.id, false, true))!.encryptedInteractive!),
    ) as Interactive;
    expect(products.type).toBe('list');
    const quantity = JSON.parse(
      decrypt((await receive(options(products)[0]!.id, false, true))!.encryptedInteractive!),
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
  it('preserva a outbox enquanto a ativação da Evolution está pendente e envia após liberar', async () => {
    const row = await db.message.create({
      data: {
        key: 'activation-pending',
        instanceName: 'store',
        customerId,
        direction: 'OUT',
        encryptedText: encrypt('Mensagem pendente'),
      },
    });
    const send = vi
      .spyOn(evolution, 'sendText')
      .mockRejectedValueOnce(
        new AppError('EVOLUTION_ACTIVATION_REQUIRED', 'Ativação pendente', 503),
      );
    await dispatchMessage(row.id);
    expect((await db.message.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('PENDING');
    send.mockResolvedValueOnce({ key: { id: 'after-activation' } });
    await dispatchMessage(row.id);
    expect((await db.message.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('SENT');
    expect(send).toHaveBeenCalledTimes(2);
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
              syncedAt: new Date(),
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
describe('Cotação BCB e estado de configuração', () => {
  async function session() {
    const admin = await db.admin.create({
      data: { email: 'exchange@example.com', passwordHash: 'test-session-fixture', role: 'OWNER' },
    });
    const token = randomUUID(),
      csrf = randomUUID();
    await db.adminSession.create({
      data: {
        id: hash(token),
        adminId: admin.id,
        csrfHash: hash(csrf),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    return { cookie: `session=${token}`, origin: process.env.APP_ORIGIN!, 'x-csrf-token': csrf };
  }
  it('salvar BCB obtém taxa válida e Consultar BCB funciona também em modo manual', async () => {
    await db.exchangeRate.deleteMany();
    const headers = await session();
    const fetch = vi.fn(
      async (url: string) =>
        new Response(
          url.includes('+')
            ? 'invalid OData filter'
            : JSON.stringify({
                value: [
                  {
                    cotacaoVenda: 5.25,
                    dataHoraCotacao: new Date(Date.now() - 3 * 3600000)
                      .toISOString()
                      .slice(0, 19)
                      .replace('T', ' '),
                  },
                ],
              }),
          { status: url.includes('+') ? 400 : 200 },
        ),
    );
    vi.stubGlobal('fetch', fetch);
    const app = await buildApp();
    try {
      expect(
        (await app.inject({ method: 'GET', url: '/api/settings', headers })).json().currentRate,
      ).toBeNull();
      expect(
        (await app.inject({ method: 'GET', url: '/api/products', headers })).json().data[0].quote,
      ).toBeNull();
      const save = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers,
        payload: { 'exchange.provider': 'bcb' },
      });
      expect(save.statusCode).toBe(200);
      expect(
        (await app.inject({ method: 'GET', url: '/api/settings', headers })).json().currentRate
          .usdBrl,
      ).toBe('5.25');
      expect(
        (await app.inject({ method: 'GET', url: '/api/products', headers })).json().data[0].quote
          .unitSaleBrl,
      ).toBe('10.50');
      await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers,
        payload: { 'exchange.provider': 'manual' },
      });
      await db.exchangeRate.deleteMany();
      const query = await app.inject({ method: 'POST', url: '/api/exchange/refresh', headers });
      expect(query.statusCode).toBe(200);
      expect(query.json().usdBrl).toBe('5.25');
      expect(await db.exchangeRate.count()).toBe(1);
      expect(
        (await app.inject({ method: 'GET', url: '/api/settings', headers })).json().values[
          'exchange.provider'
        ],
      ).toBe('manual');
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
  it('não confirma sucesso nem cria cotação se a consulta falhar ao ativar BCB', async () => {
    await db.exchangeRate.deleteMany();
    const headers = await session();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 503 })),
    );
    const app = await buildApp();
    try {
      const save = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers,
        payload: { 'exchange.provider': 'bcb' },
      });
      expect(save.statusCode).toBe(503);
      expect(save.json()).toMatchObject({
        code: 'RATE_REFRESH_FAILED',
        message: expect.stringContaining('Modo BCB salvo, mas'),
      });
      expect(await db.exchangeRate.count()).toBe(0);
      expect(
        (await app.inject({ method: 'GET', url: '/api/settings', headers })).json().currentRate,
      ).toBeNull();
    } finally {
      await app.close();
    }
  });
});
describe('Importação seletiva do catálogo', () => {
  const remote = {
    ...live,
    id: 43,
    slug: 'new-service',
    name: 'Novo serviço',
    productCode: 'NEW-43',
  };
  it('mostra catálogo USD/USDT, importa USD e recusa conversão implícita em seleção mista', async () => {
    const usdt = { ...remote, id: 44, slug: 'usdt-service', currency: 'USDT' };
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ data: [live, remote, usdt] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetch);
    const preview = await browseCatalog({ search: '', provider: '', page: 1, limit: 25 });
    expect(preview.total).toBe(3);
    expect(preview.data.find((p) => p.slug === usdt.slug)).toMatchObject({
      cost: '1.00',
      currency: 'USDT',
      costUsd: null,
      canImport: false,
    });
    expect(preview.data.find((p) => p.slug === remote.slug)).toMatchObject({
      currency: 'USD',
      canImport: true,
    });
    await expect(importCatalog([remote.slug, usdt.slug], 'test-owner')).rejects.toMatchObject({
      code: 'CATALOG_CURRENCY_UNSUPPORTED',
    });
    expect(await db.product.count()).toBe(1);
    await importCatalog([remote.slug], 'test-owner');
    expect(
      (await db.product.findUniqueOrThrow({ where: { slug: remote.slug } })).costUsd.toFixed(2),
    ).toBe('1.00');
    expect(await db.product.findUnique({ where: { slug: usdt.slug } })).toBeNull();
  });
  it('desativa produto que mudou para USDT sem sobrescrever seu custo USD anterior', async () => {
    vi.spyOn(partner, 'products').mockResolvedValue({
      data: [{ ...live, currency: 'USDT', yourPrice: '8.00' }],
    });
    await syncCatalog();
    const product = await db.product.findUniqueOrThrow({ where: { slug: live.slug } });
    expect(product.available).toBe(false);
    expect(product.stock).toBe(0);
    expect(product.costUsd.toFixed(2)).toBe('1.00');
    expect(product.authorizedResale).toBe(true);
  });
  it('não reserva saldo nem cria pedido para custo em moeda não suportada', async () => {
    await credit();
    vi.mocked(partner.product).mockResolvedValue({ ...live, currency: 'USDT' });
    await expect(purchase()).rejects.toMatchObject({ code: 'PRODUCT_CURRENCY_UNSUPPORTED' });
    expect(await db.order.count()).toBe(0);
    expect(await db.ledgerEntry.count({ where: { kind: 'RESERVE' } })).toBe(0);
  });
  it('libera a reserva sem comprar se o fornecedor muda a moeda antes do envio', async () => {
    await credit();
    const order = await purchase();
    vi.mocked(partner.product).mockResolvedValue({ ...live, currency: 'USDT' });
    const post = vi.spyOn(partner, 'createOrder');
    await processOrder(order.id);
    expect(post).not.toHaveBeenCalled();
    const wallet = await db.wallet.findUniqueOrThrow({ where: { customerId } });
    expect(wallet.available.toFixed(2)).toBe('100.00');
    expect(wallet.reserved.toFixed(2)).toBe('0.00');
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('FAILED');
  });
  it('consulta e filtra a prévia sem importar produtos', async () => {
    vi.spyOn(partner, 'products').mockResolvedValue({ data: [live, remote] });
    const preview = await browseCatalog({
      search: 'NEW-43',
      provider: 'gemini',
      page: 1,
      limit: 25,
    });
    expect(preview.data).toMatchObject([{ slug: 'new-service', imported: false, costUsd: '1.00' }]);
    expect(preview.total).toBe(1);
    const current = await browseCatalog({ search: 'product', provider: '', page: 1, limit: 25 });
    expect(current.data[0]?.imported).toBe(true);
    expect(await db.product.count()).toBe(1);
  });
  it('importa somente a seleção, preserva regras e não adiciona outros serviços na sincronização', async () => {
    const other = { ...remote, id: 44, slug: 'other-service', name: 'Outro serviço' };
    vi.spyOn(partner, 'products').mockResolvedValue({ data: [live, remote, other] });
    const result = await importCatalog(['new-service', 'new-service'], 'test-owner');
    expect(result.imported).toBe(1);
    expect(await db.product.count()).toBe(2);
    expect(await db.product.findUnique({ where: { slug: other.slug } })).toBeNull();
    const imported = await db.product.findUniqueOrThrow({ where: { slug: remote.slug } });
    expect(imported.authorizedResale).toBe(false);
    await db.product.update({
      where: { slug: remote.slug },
      data: { manualPrice: '35.90', authorizedResale: true },
    });
    vi.mocked(partner.products).mockResolvedValue({
      data: [live, { ...remote, yourPrice: '2.00' }, other],
    });
    await importCatalog(['new-service'], 'test-owner');
    await syncCatalog();
    const updated = await db.product.findUniqueOrThrow({ where: { slug: remote.slug } });
    expect(updated.manualPrice?.toFixed(2)).toBe('35.90');
    expect(updated.authorizedResale).toBe(true);
    expect(updated.costUsd.toFixed(2)).toBe('2.00');
    expect(await db.product.count()).toBe(2);
    expect(await db.auditLog.count({ where: { action: 'catalog.import' } })).toBe(2);
  });
  it('rejeita uma seleção que saiu do catálogo sem importar parcialmente', async () => {
    vi.spyOn(partner, 'products').mockResolvedValue({ data: [live, remote] });
    await expect(importCatalog(['new-service', 'missing'], 'test-owner')).rejects.toMatchObject({
      code: 'CATALOG_CHANGED',
    });
    expect(await db.product.count()).toBe(1);
    expect(await db.auditLog.count()).toBe(0);
    // Lock is released even on failure.
    expect((await importCatalog(['new-service'], 'test-owner')).imported).toBe(1);
  });
  it('protege importação com sessão, CSRF e permissão; erro Partner não encerra a sessão admin', async () => {
    const owner = await db.admin.create({
      data: {
        email: 'import@example.com',
        passwordHash: 'not-used-session-fixture',
        role: 'OWNER',
      },
    });
    const token = randomUUID(),
      csrf = randomUUID();
    await db.adminSession.create({
      data: {
        id: hash(token),
        adminId: owner.id,
        csrfHash: hash(csrf),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const headers = {
      cookie: `session=${token}`,
      origin: process.env.APP_ORIGIN!,
      'x-csrf-token': csrf,
    };
    const products = vi.spyOn(partner, 'products').mockResolvedValue({ data: [live, remote] });
    const app = await buildApp();
    try {
      expect((await app.inject({ method: 'GET', url: '/api/products/catalog' })).statusCode).toBe(
        401,
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/products/import',
            headers: { cookie: headers.cookie },
            payload: { slugs: [remote.slug] },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/products/import',
            headers,
            payload: { slugs: [] },
          })
        ).statusCode,
      ).toBe(400);
      const preview = await app.inject({
        method: 'GET',
        url: '/api/products/catalog?search=NEW-43',
        headers,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().data[0].slug).toBe(remote.slug);
      const imported = await app.inject({
        method: 'POST',
        url: '/api/products/import',
        headers,
        payload: { slugs: [remote.slug] },
      });
      expect(imported.statusCode).toBe(200);
      expect(imported.json().imported).toBe(1);
      const synced = await app.inject({ method: 'POST', url: '/api/products/sync', headers });
      expect(synced.statusCode).toBe(200);
      products.mockRejectedValueOnce(new PartnerError('INVALID_API_KEY', 'req-test', 401));
      const failed = await app.inject({ method: 'GET', url: '/api/products/catalog', headers });
      expect(failed.statusCode).toBe(502);
      expect(failed.json()).toMatchObject({
        code: 'CATALOG_INVALID_API_KEY',
        message: expect.stringContaining('Configurações'),
      });
      await db.admin.update({ where: { id: owner.id }, data: { role: 'VIEWER' } });
      expect(
        (await app.inject({ method: 'GET', url: '/api/products/catalog', headers })).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/products/import',
            headers,
            payload: { slugs: [remote.slug] },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
});
describe('Produtos da loja e acesso rápido ao Pix', () => {
  async function ownerSession() {
    const owner = await db.admin.create({
      data: {
        email: 'products@example.com',
        passwordHash: 'session-fixture',
        role: 'OWNER',
      },
    });
    const token = randomUUID(),
      csrf = randomUUID();
    await db.adminSession.create({
      data: {
        id: hash(token),
        adminId: owner.id,
        csrfHash: hash(csrf),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    return {
      owner,
      headers: {
        cookie: `session=${token}`,
        origin: process.env.APP_ORIGIN!,
        'x-csrf-token': csrf,
      },
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
  it('ignora conversa comum no menu antigo sem renovar a sessão nem invalidar botões', async () => {
    const expiresAt = new Date(Date.now() + 60000);
    await db.conversation.create({
      data: {
        customerId,
        instanceName: 'store',
        expiresAt,
        state: { step: 'MENU', interaction: { token: 'legacy-menu', values: ['0', '3', '5'] } },
      },
    });
    for (const text of ['Top, já usei um bot parecido', 'paguei', 'vou ver depois'])
      expect(await receive(text)).toBeNull();
    const conversation = await db.conversation.findFirstOrThrow();
    expect(conversation.expiresAt).toEqual(expiresAt);
    expect(conversation.state).toMatchObject({ interaction: { token: 'legacy-menu' } });
    expect(await db.message.count()).toBe(0);
    expect(await db.webhookEvent.count({ where: { processedAt: null } })).toBe(0);
    expect(decrypt((await receive('wa:legacy-menu:3'))!.encryptedText)).toContain(
      'Quanto deseja adicionar',
    );
    expect((await db.conversation.findFirstOrThrow()).state).toMatchObject({
      step: 'DEPOSIT_AMOUNT',
    });
  });
  it.each([
    'PROVIDERS',
    'PRODUCTS',
    'QUANTITY',
    'CONFIRM',
    'DEPOSIT_AMOUNT',
    'DEPOSIT_EMAIL',
    'DEPOSIT_CPF',
  ])('ignora texto alheio à etapa %s e aceita a palavra-chave configurada', async (step) => {
    await saveSetting('bot.activationKeywords', ['comprar agora']);
    const expiresAt = new Date(Date.now() + 60000);
    await db.conversation.create({
      data: {
        customerId,
        instanceName: 'store',
        expiresAt,
        state: {
          step,
          provider: 'gemini',
          options: ['product'],
          slug: 'product',
          quantity: 1,
          total: '10',
          amount: '10',
          depositKey: 'pending-test',
        },
      },
    });
    expect(await receive('Top, já usei um bot parecido')).toBeNull();
    expect(await db.message.count()).toBe(0);
    expect((await db.conversation.findFirstOrThrow()).expiresAt).toEqual(expiresAt);
    expect(await db.payment.count()).toBe(0);
    expect(await db.order.count()).toBe(0);
    expect(await db.webhookEvent.count({ where: { processedAt: null } })).toBe(0);
    expect(await receive('COMPRAR   AGORA!')).not.toBeNull();
    expect((await db.conversation.findFirstOrThrow()).state).toMatchObject({ step: 'MENU' });
  });
  it('não usa saudações antigas fora da configuração mesmo com o menu ativo', async () => {
    await saveSetting('bot.activationKeywords', ['vendas']);
    expect(await receive('vendas')).not.toBeNull();
    const conversation = await db.conversation.findFirstOrThrow();
    for (const text of ['oi', 'olá', 'início', 'menu', 'obrigado'])
      expect(await receive(text)).toBeNull();
    expect(await db.message.count({ where: { direction: 'OUT' } })).toBe(1);
    expect((await db.conversation.findFirstOrThrow()).expiresAt).toEqual(conversation.expiresAt);
    expect(await receive('1')).not.toBeNull();
    expect((await db.conversation.findFirstOrThrow()).state).toMatchObject({ step: 'PROVIDERS' });
  });
  it('envia menu com três botões visíveis e mantém acesso à carteira e listas de categorias', async () => {
    const options = (message: NonNullable<Awaited<ReturnType<typeof receive>>>) =>
      JSON.parse(decrypt(message.encryptedInteractive!));
    const first = options((await receive('menu'))!);
    expect(first.type).toBe('buttons');
    expect(first.buttons.map((b: { title: string }) => b.title)).toEqual([
      '🛒 Comprar serviços',
      '💰 Meu saldo',
      '🎧 Suporte',
    ]);
    expect(first.description).not.toContain('1 - Ver produtos');
    const wallet = options((await receive(first.buttons[1].id))!);
    expect(wallet.type).toBe('list');
    expect(wallet.rows.map((r: { title: string }) => r.title)).toEqual([
      '💳 Adicionar saldo',
      '📦 Meus pedidos',
      '👤 Minha conta',
      'Menu principal',
    ]);
    const second = options((await receive('menu'))!);
    expect(second.type).toBe('buttons');
    expect(second.buttons[0].id).not.toBe(first.buttons[0].id);
    expect(await receive(first.buttons[0].id)).toBeNull();
    expect(options((await receive(second.buttons[0].id))!).type).toBe('list');
  });
  it('edita nome/descrição com permissão, validação e persistência após sincronizar', async () => {
    const { owner, headers } = await ownerSession();
    const app = await buildApp();
    const payload = {
      displayName: 'Gemini da loja',
      description: 'Descrição escrita pelo lojista.\nAtivação no seu e-mail.',
    };
    try {
      expect(
        (await app.inject({ method: 'PATCH', url: '/api/products/product', payload })).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/products/product',
            headers: { cookie: headers.cookie },
            payload,
          })
        ).statusCode,
      ).toBe(403);
      await db.admin.update({ where: { id: owner.id }, data: { role: 'OPERATOR' } });
      expect(
        (await app.inject({ method: 'PATCH', url: '/api/products/product', headers, payload }))
          .statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'DELETE', url: '/api/products/product', headers })).statusCode,
      ).toBe(403);
      await db.admin.update({ where: { id: owner.id }, data: { role: 'OWNER' } });
      for (const invalid of [
        { displayName: '' },
        { displayName: 'x'.repeat(151) },
        { description: 'x'.repeat(2501) },
      ])
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: '/api/products/product',
              headers,
              payload: invalid,
            })
          ).statusCode,
        ).toBe(400);
      expect(
        (await app.inject({ method: 'PATCH', url: '/api/products/product', headers, payload }))
          .statusCode,
      ).toBe(200);
      vi.spyOn(partner, 'products').mockResolvedValue({
        data: [{ ...live, name: 'Novo nome do fornecedor', description: 'Texto externo' }],
      });
      await syncCatalog();
      const listed = await app.inject({
        method: 'GET',
        url: '/api/products?search=Gemini%20da%20loja',
        headers,
      });
      expect(listed.json()).toMatchObject({
        total: 1,
        data: [{ ...payload, name: payload.displayName, supplierName: 'Novo nome do fornecedor' }],
      });
      expect((await quoteProduct('product', 1)).product.name).toBe(payload.displayName);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/products/product',
            headers,
            payload: { displayName: null, description: null },
          })
        ).statusCode,
      ).toBe(200);
      expect((await quoteProduct('product', 1)).product).toMatchObject({
        name: 'Novo nome do fornecedor',
        description: null,
      });
    } finally {
      await app.close();
    }
  });
  it('exclui com confirmação HTTP protegida, oculta novas compras e mantém pedido e entrega existentes', async () => {
    await credit();
    const order = await purchase();
    const { headers } = await ownerSession();
    const app = await buildApp();
    vi.spyOn(partner, 'products').mockResolvedValue({ data: [live] });
    try {
      expect(
        (await app.inject({ method: 'DELETE', url: '/api/products/product' })).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: '/api/products/product',
            headers: { cookie: headers.cookie },
          })
        ).statusCode,
      ).toBe(403);
      for (let attempt = 0; attempt < 2; attempt++)
        expect(
          (await app.inject({ method: 'DELETE', url: '/api/products/product', headers }))
            .statusCode,
        ).toBe(200);
      expect(
        (await app.inject({ method: 'GET', url: '/api/products', headers })).json().total,
      ).toBe(0);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/products/product',
            headers,
            payload: { active: true },
          })
        ).statusCode,
      ).toBe(404);
      await syncCatalog();
      expect(
        (await db.product.findUniqueOrThrow({ where: { slug: 'product' } })).archivedAt,
      ).not.toBeNull();
      expect(
        (await browseCatalog({ search: '', provider: '', page: 1, limit: 25 })).data[0]!.imported,
      ).toBe(false);
      await expect(quoteProduct('product', 1)).rejects.toMatchObject({
        code: 'PRODUCT_UNAVAILABLE',
      });
      await receive('oi');
      expect(decrypt((await receive('1'))!.encryptedText)).not.toContain('1 - Gemini');
      vi.spyOn(partner, 'createOrder').mockResolvedValue(external(order.id));
      await processOrder(order.id);
      await prepareDeliveries();
      expect(
        (
          await db.order.findUniqueOrThrow({
            where: { id: order.id },
            include: { items: { include: { product: true } } },
          })
        ).items[0]!.product.slug,
      ).toBe('product');
      expect(await db.delivery.count({ where: { orderId: order.id } })).toBe(1);
      expect(await db.auditLog.count({ where: { action: 'product.delete' } })).toBe(1);
      expect(
        (await db.wallet.findUniqueOrThrow({ where: { customerId } })).available.toFixed(2),
      ).toBe('90.00');
    } finally {
      await app.close();
    }
  });
  it('reimporta produto excluído como rascunho mantendo textos e preço local', async () => {
    await db.product.update({
      where: { slug: 'product' },
      data: { displayName: 'Minha oferta', description: 'Meu texto', manualPrice: '15' },
    });
    await archiveProduct('product', 'test-owner');
    vi.spyOn(partner, 'products').mockResolvedValue({ data: [live] });
    await importCatalog(['product'], 'test-owner');
    const product = await db.product.findUniqueOrThrow({ where: { slug: 'product' } });
    expect(product).toMatchObject({
      archivedAt: null,
      active: true,
      visible: true,
      authorizedResale: false,
      displayName: 'Minha oferta',
      description: 'Meu texto',
    });
    expect(product.manualPrice?.toFixed(2)).toBe('15.00');
    await expect(quoteProduct('product', 1)).rejects.toMatchObject({ code: 'PRODUCT_UNAVAILABLE' });
  });
  it('usa apresentação local nos detalhes, resumo e histórico, sem publicar descrição externa', async () => {
    await credit();
    await saveSetting('bot.messageStyle', 'text');
    vi.spyOn(partner, 'product').mockResolvedValue({
      ...live,
      name: 'Nome externo',
      description: 'Descrição externa que não deve aparecer',
    });
    await db.product.update({
      where: { slug: 'product' },
      data: { displayName: 'Oferta personalizada', description: 'Minha descrição\nSegunda linha' },
    });
    await receive('oi');
    await receive('1');
    expect(decrypt((await receive('1'))!.encryptedText)).toContain('1 - Oferta personalizada');
    const details = decrypt((await receive('1'))!.encryptedText);
    expect(details).toContain('Oferta personalizada\nMinha descrição\nSegunda linha');
    expect(details).not.toContain('Descrição externa');
    expect(decrypt((await receive('1'))!.encryptedText)).toContain('Oferta personalizada');
    await receive('1');
    expect((await db.orderItem.findFirstOrThrow()).name).toBe('Oferta personalizada');
    await db.product.update({ where: { slug: 'product' }, data: { description: null } });
    await receive('menu');
    await receive('1');
    await receive('1');
    expect(decrypt((await receive('1'))!.encryptedText)).not.toContain('Descrição externa');
  });
  it.each(['interactive', 'text'])(
    'oferece adicionar saldo após saldo insuficiente em modo %s sem criar pedido ou débito',
    async (style) => {
      await saveSetting('bot.messageStyle', style);
      await saveSetting('pix.gateway', 'expay');
      await saveSetting('secret.expayApiKey', 'TEST-NOT-REAL', true);
      const gatewayId = randomUUID();
      let reference = '',
        amount = 0;
      const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
        if (options?.method === 'POST') {
          const body = JSON.parse(String(options.body));
          reference = body.reference;
          amount = body.amount;
        }
        return new Response(
          JSON.stringify({
            charge_id: gatewayId,
            reference,
            amount,
            currency: 'BRL',
            payment_method: 'pix',
            status: 'pending',
            pix_data: { copy_paste: 'PIX-ONLY-TEST' },
          }),
          { status: 200 },
        );
      });
      vi.stubGlobal('fetch', fetch);
      await receive('oi');
      await receive('1');
      await receive('1');
      await receive('1');
      const summary = await receive('1');
      const error = await receive('1');
      expect(decrypt(error!.encryptedText)).toContain('3 - Adicionar saldo');
      expect(await db.order.count()).toBe(0);
      expect(await db.ledgerEntry.count()).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
      let action = '3';
      if (style === 'interactive') {
        const previous = JSON.parse(decrypt(summary!.encryptedInteractive!));
        expect(await receive(previous.buttons[0].id)).toBeNull();
        const buttons = JSON.parse(decrypt(error!.encryptedInteractive!));
        expect(buttons.buttons[0].title).toBe('💳 Adicionar saldo');
        action = buttons.buttons[0].id;
      } else expect(error!.encryptedInteractive).toBeNull();
      expect(decrypt((await receive(action))!.encryptedText)).toContain('Quanto deseja adicionar');
      await receive('25');
      expect(await db.payment.count()).toBe(1);
      expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
      expect(fetch.mock.calls.filter(([, options]) => options?.method !== 'POST')).toHaveLength(1);
      expect((await db.payment.findFirstOrThrow()).amountBrl.toFixed(2)).toBe('25.00');
      expect(await db.order.count()).toBe(0);
      expect(
        (await db.wallet.findUniqueOrThrow({ where: { customerId } })).available.toFixed(2),
      ).toBe('0.00');
    },
  );
});

describe('Expay Brasil', () => {
  async function configured() {
    await saveSetting('pix.gateway', 'expay');
    await saveSetting('secret.expayApiKey', 'TEST-EXPAY-KEY-NEVER-REAL', true);
  }
  async function receivePix(text: string) {
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
    return event;
  }
  function mockPixCharge() {
    const gatewayId = randomUUID();
    let reference = '',
      amount = 0;
    const fetch = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      if (options?.method === 'POST') {
        const body = JSON.parse(String(options.body));
        reference = body.reference;
        amount = body.amount;
      }
      return new Response(
        JSON.stringify({
          charge_id: gatewayId,
          reference,
          amount,
          currency: 'BRL',
          payment_method: 'pix',
          status: 'pending',
          pix_data: { copy_paste: '000201-PIX-TEST-ONLY', qr_code_base64: 'aW1hZ2U=' },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }
  it.each(['interactive', 'text'])(
    'após gerar Pix em modo %s só reabre por palavra configurada e continua conciliando o pagamento',
    async (style) => {
      await configured();
      await saveSetting('bot.activationKeywords', ['Abrir loja']);
      await saveSetting('bot.messageStyle', style);
      const fetch = mockPixCharge();
      await receivePix('ABRIR LOJA!');
      await receivePix('3');
      const beforePix = (await db.conversation.findFirstOrThrow()).state as {
        interaction?: { token: string; values: string[] };
      };
      await receivePix('10');
      const payment = await db.payment.findFirstOrThrow();
      const conversation = await db.conversation.findFirstOrThrow();
      expect(conversation.state).toEqual({ step: 'IDLE' });
      expect(payment.status).toBe('PENDING');
      const replies = await db.message.count({ where: { direction: 'OUT' } });
      const texts = [
        'Top, já usei um bot bem parecido quando rodava no x1',
        'paguei',
        'vou pagar depois',
        'oi',
        'menu',
        'suporte',
        'pix',
        '1',
        '3',
        '0',
        'voltar',
        'cancelar',
      ];
      if (beforePix.interaction)
        texts.push(`wa:${beforePix.interaction.token}:${beforePix.interaction.values[0]}`);
      for (const text of texts) {
        const event = await receivePix(text);
        await processIncoming(event.id);
        expect(await db.message.findUnique({ where: { key: `reply-${event.key}` } })).toBeNull();
      }
      expect(await db.message.count({ where: { direction: 'OUT' } })).toBe(replies);
      expect((await db.conversation.findFirstOrThrow()).expiresAt).toEqual(conversation.expiresAt);
      expect(await db.webhookEvent.count({ where: { processedAt: null } })).toBe(0);
      expect(await db.payment.count()).toBe(1);
      expect(await db.order.count()).toBe(0);
      expect(await db.ledgerEntry.count()).toBe(0);
      expect(fetch).toHaveBeenCalledTimes(2); // One creation and one authenticated lookup.
      fetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            charge_id: payment.gatewayId,
            reference: payment.id,
            amount: 10,
            currency: 'BRL',
            payment_method: 'pix',
            status: 'paid',
          }),
          { status: 200 },
        ),
      );
      await reconcilePayment(payment.gatewayId!);
      expect(
        (await db.wallet.findUniqueOrThrow({ where: { customerId } })).available.toFixed(2),
      ).toBe('10.00');
      expect((await db.conversation.findFirstOrThrow()).state).toEqual({ step: 'IDLE' });
      const afterPaid = await db.message.count({ where: { direction: 'OUT' } });
      await receivePix('obrigado');
      expect(await db.message.count({ where: { direction: 'OUT' } })).toBe(afterPaid);
      await receivePix('  ABRIR   LOJA!! ');
      expect(await db.message.count({ where: { direction: 'OUT' } })).toBe(afterPaid + 1);
      expect((await db.conversation.findFirstOrThrow()).state).toMatchObject({ step: 'MENU' });
      await receivePix('1');
      expect((await db.conversation.findFirstOrThrow()).state).toMatchObject({ step: 'PROVIDERS' });
    },
  );
  it('protege Pix de versões anteriores sem apagar a sessão e permite navegar após reativação', async () => {
    await configured();
    await saveSetting('bot.activationKeywords', ['abrir']);
    const fetch = mockPixCharge();
    await receivePix('abrir');
    await receivePix('3');
    await receivePix('10');
    const legacyState = {
      step: 'MENU',
      interaction: { token: 'old-pix', values: ['0', '3', '5'] },
    };
    await db.conversation.updateMany({ data: { state: legacyState } });
    const conversation = await db.conversation.findFirstOrThrow();
    const count = await db.message.count();
    for (const text of [
      'Top, já usei um bot parecido',
      'paguei',
      '1',
      '3',
      '0',
      'saldo',
      'pix',
      'wa:old-pix:3',
    ])
      await receivePix(text);
    expect(await db.message.count()).toBe(count);
    expect((await db.conversation.findFirstOrThrow()).state).toEqual(legacyState);
    expect((await db.conversation.findFirstOrThrow()).expiresAt).toEqual(conversation.expiresAt);
    expect(await db.payment.count()).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await receivePix('ABRIR!');
    await receivePix('3');
    expect((await db.conversation.findFirstOrThrow()).state).toMatchObject({
      step: 'DEPOSIT_AMOUNT',
    });
    expect(await db.payment.count()).toBe(1);
  });
  it.each(['interactive', 'text'])(
    'gera após o valor e envia copia e cola sozinho em modo %s',
    async (style) => {
      await configured();
      await saveSetting('bot.messageStyle', style);
      const fetch = mockPixCharge();
      await receivePix('oi');
      await receivePix('3');
      const event = await receivePix('10,25');
      // Duplicate webhook processing must not create another charge or another code message.
      await processIncoming(event.id);
      expect(await db.payment.count()).toBe(1);
      expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
      const request = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
      expect(request.amount).toBe(10.25);
      expect(request.customer).toEqual({ name: 'Cliente' });
      const messages = await db.message.findMany({
        where: {
          key: { in: [`reply-${event.key}`, `pix-qr-${event.key}`, `pix-code-${event.key}`] },
        },
        orderBy: { createdAt: 'asc' },
      });
      expect(messages.map((message) => message.key)).toEqual([
        `reply-${event.key}`,
        `pix-qr-${event.key}`,
        `pix-code-${event.key}`,
      ]);
      expect(decrypt(messages[0]!.encryptedText)).toContain('mensagem separada');
      expect(decrypt(messages[0]!.encryptedText)).not.toContain('000201-PIX-TEST-ONLY');
      if (messages[0]!.encryptedInteractive)
        expect(decrypt(messages[0]!.encryptedInteractive)).not.toContain('000201-PIX-TEST-ONLY');
      const code = messages[2]!;
      expect(decrypt(code.encryptedText)).toBe('000201-PIX-TEST-ONLY');
      expect(code.encryptedInteractive).toBeNull();
      expect(code.encryptedMedia).toBeNull();
      expect((await db.conversation.findFirstOrThrow()).state).toMatchObject({ step: 'IDLE' });
      const send = vi
        .spyOn(evolution, 'sendText')
        .mockResolvedValue({ key: { id: 'pix-code-sent' } });
      const interactive = vi.spyOn(evolution, 'sendInteractive');
      await dispatchMessage(code.id);
      expect(send).toHaveBeenCalledWith('store', '5511999999999', '000201-PIX-TEST-ONLY');
      expect(interactive).not.toHaveBeenCalled();
    },
  );
  it.each(['DEPOSIT_EMAIL', 'DEPOSIT_CPF'])(
    'continua sessões antigas em %s sem pedir dados opcionais',
    async (step) => {
      await configured();
      const fetch = mockPixCharge();
      await db.conversation.create({
        data: {
          customerId,
          instanceName: 'store',
          expiresAt: new Date(Date.now() + 60000),
          state: { step, amount: '20.00', depositKey: 'legacy-deposit' },
        },
      });
      await receivePix('continuar');
      expect((await db.payment.findFirstOrThrow()).idempotencyKey).toBe('legacy-deposit');
      expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).customer).toEqual({
        name: 'Cliente',
      });
      expect((await db.conversation.findFirstOrThrow()).state).toMatchObject({ step: 'IDLE' });
    },
  );
  it('mantém coleta e validação reais quando o gateway é Mercado Pago', async () => {
    await saveSetting('pix.gateway', 'mercadopago');
    await receivePix('oi');
    await receivePix('3');
    await receivePix('20');
    expect((await db.conversation.findFirstOrThrow()).state).toMatchObject({
      step: 'DEPOSIT_EMAIL',
    });
    await receivePix('sem-email');
    expect((await db.conversation.findFirstOrThrow()).state).toMatchObject({
      step: 'DEPOSIT_EMAIL',
    });
    await receivePix('test@example.com');
    await receivePix('12345678901');
    expect((await db.conversation.findFirstOrThrow()).state).toMatchObject({ step: 'DEPOSIT_CPF' });
    expect(await db.payment.count()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
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
    const licenseStatus = vi
      .spyOn(evolution, 'licenseStatus')
      .mockResolvedValue({ status: 'inactive', instanceId: 'test-instance' });
    const register = vi.spyOn(evolution, 'licenseRegister').mockResolvedValue({
      status: 'pending',
      registerUrl: 'https://license.evolutionfoundation.com.br/register',
    });
    const activate = vi.spyOn(evolution, 'licenseActivate').mockResolvedValue({ status: 'active' });
    expect(
      (await app.inject({ method: 'GET', url: '/api/whatsapp/license', headers })).json().status,
    ).toBe('inactive');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/whatsapp/license/register',
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/whatsapp/license/activate',
          headers,
          payload: { code: 'TEST_ONLY_CODE' },
        })
      ).statusCode,
    ).toBe(200);
    expect(licenseStatus).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith('TEST_ONLY_CODE');
    expect(
      JSON.stringify(
        await db.auditLog.findMany({ where: { action: { startsWith: 'evolution.activation' } } }),
      ),
    ).not.toContain('TEST_ONLY_CODE');
    const initial = await app.inject({ method: 'GET', url: '/api/settings', headers });
    const partnerKey = 'TEST-PARTNER-KEY-PERSISTED-12345',
      expayKey = 'TEST-EXPAY-KEY-PERSISTED-12345';
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/settings',
          headers,
          payload: {
            'secret.partnerKey': partnerKey,
            'secret.expayApiKey': expayKey,
            'pix.gateway': 'expay',
            'pix.expayStoreId': 'my-existing-store',
          },
        })
      ).statusCode,
    ).toBe(200);
    const saved = await app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(saved.json().secrets).toMatchObject({
      'secret.partnerKey': true,
      'secret.expayApiKey': true,
    });
    expect(saved.json().values).toMatchObject({
      'pix.gateway': 'expay',
      'pix.expayStoreId': 'my-existing-store',
    });
    expect(saved.body).not.toContain(partnerKey);
    expect(saved.body).not.toContain(expayKey);
    const encrypted = await db.setting.findUniqueOrThrow({ where: { key: 'secret.expayApiKey' } });
    expect(encrypted.encrypted).toBe(true);
    expect(String(encrypted.value)).not.toContain(expayKey);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/settings',
          headers,
          payload: { 'pix.gateway': 'expay', 'pix.expayStoreId': 'my-existing-store' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await db.setting.findUniqueOrThrow({ where: { key: 'secret.expayApiKey' } })).value,
    ).toEqual(encrypted.value);
    expect(await credentials()).toMatchObject({ partnerKey, expayApiKey: expayKey });
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
    expect(
      (await app.inject({ method: 'GET', url: '/api/whatsapp/license', headers: { cookie } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/whatsapp/license/activate',
          headers: { cookie, origin: 'http://localhost:5173', 'x-csrf-token': csrf },
          payload: { code: 'TEST_ONLY_CODE' },
        })
      ).statusCode,
    ).toBe(403);
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
