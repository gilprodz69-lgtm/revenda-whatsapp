import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db, transaction } from '../core/db.js';
import { encrypt, decrypt } from '../core/crypto.js';
import { AppError } from '../core/errors.js';
import { setting } from '../core/settings.js';
import { withLock } from '../core/lock.js';
import { incomingSchema, privateSenderPhone } from '../integrations/evolution.js';
import { notifyOutgoing, notifyOrder } from '../core/dispatch.js';
import { activationKeywords, matchesActivation } from './bot-activation.js';
import { quoteProduct, placeOrder } from './orders.js';
import { createDeposit } from './payments.js';
import { templates, messageTemplate } from './templates.js';
export { validateTemplate, renderTemplate, allowedPlaceholders } from './templates.js';

export const menuText = templates.welcome!.text;
export function normalizedInput(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}
export const stateSchema = z.object({
  step: z.enum([
    'MENU',
    'PROVIDERS',
    'PRODUCTS',
    'QUANTITY',
    'CONFIRM',
    'DEPOSIT_AMOUNT',
    'DEPOSIT_EMAIL',
    'DEPOSIT_CPF',
  ]),
  provider: z.string().optional(),
  options: z.array(z.string()).optional(),
  slug: z.string().optional(),
  quantity: z.number().optional(),
  total: z.string().optional(),
  amount: z.string().optional(),
  email: z.string().optional(),
  depositKey: z.string().optional(),
  offset: z.number().optional(),
  quoteExpires: z.number().optional(),
});
type State = z.infer<typeof stateSchema>;
export function validCpf(cpf: string) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  for (let n = 9; n <= 10; n++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(cpf[i]) * (n + 1 - i);
    const digit = (sum * 10) % 11;
    if ((digit === 10 ? 0 : digit) !== Number(cpf[n])) return false;
  }
  return true;
}

export async function processIncoming(eventId: string) {
  const event = await db.webhookEvent.findUniqueOrThrow({ where: { id: eventId } });
  if (event.processedAt) return;
  const payload = JSON.parse(decrypt(event.encryptedPayload)) as {
    instance: string;
    data: unknown;
  };
  const message = incomingSchema.parse(payload.data);
  const phone = privateSenderPhone(message.key);
  if (!phone) {
    await db.webhookEvent.update({ where: { id: eventId }, data: { processedAt: new Date() } });
    return;
  }
  await withLock(`conversation:${payload.instance}:${phone}`, async () => {
    const instance = await db.whatsappInstance.findUnique({ where: { name: payload.instance } });
    if (!instance) {
      await db.webhookEvent.update({ where: { id: eventId }, data: { processedAt: new Date() } });
      return;
    }
    const raw =
      message.message?.conversation ??
      message.message?.extendedTextMessage?.text ??
      message.message?.buttonsResponseMessage?.selectedButtonId ??
      message.message?.listResponseMessage?.singleSelectReply?.selectedRowId ??
      '';
    const existingCustomer = await db.customer.findUnique({ where: { phone } });
    const current = existingCustomer
      ? await db.conversation.findUnique({
          where: {
            customerId_instanceName: {
              customerId: existingCustomer.id,
              instanceName: instance.name,
            },
          },
        })
      : null;
    const active = !!current && current.expiresAt > new Date();
    const trigger = matchesActivation(raw, await activationKeywords());
    if (
      !active &&
      !trigger &&
      !(existingCustomer?.humanUntil && existingCustomer.humanUntil > new Date())
    ) {
      await db.webhookEvent.update({ where: { id: eventId }, data: { processedAt: new Date() } });
      return;
    }
    const customer = await db.customer.upsert({
      where: { phone },
      create: {
        phone,
        name: message.pushName?.slice(0, 100) ?? phone,
        wallet: { create: {} },
        optedInAt: new Date(),
      },
      update: {},
    });
    let state: State =
      current && current.expiresAt > new Date()
        ? stateSchema.parse(current.state)
        : { step: 'MENU' };
    let response = '';
    let qr: string | undefined;
    let humanUntil: Date | undefined;
    let createdOrderId: string | undefined;
    const input = normalizedInput(raw),
      store = await setting('store.name', 'Nossa loja');
    const mainMenu = async () => messageTemplate('welcome', { nome: customer.name, loja: store });
    const startHuman = async () => {
      humanUntil = new Date(Date.now() + 24 * 3600000);
      state = { step: 'MENU' };
      return `${await messageTemplate('human')}\n${await setting('human.hours', 'Atendimento conforme disponibilidade da equipe.')}`;
    };
    const showProviders = async () => {
      const providers = await db.provider.findMany({
        where: {
          products: {
            some: {
              available: true,
              active: true,
              visible: true,
              authorizedResale: true,
              stock: { gt: 0 },
            },
          },
        },
        orderBy: { sortOrder: 'asc' },
      });
      state = { step: 'PROVIDERS', options: providers.map((p) => p.key) };
      if (!providers.length) state = { step: 'MENU' };
      return providers.length
        ? `${await messageTemplate('categories')}\n${providers.map((p, i) => `${i + 1} - ${p.name}`).join('\n')}\n\n0 - Menu`
        : messageTemplate('unavailable');
    };
    const showProducts = async (provider: string, offset = 0) => {
      const products = await db.product.findMany({
        where: {
          providerKey: provider,
          active: true,
          available: true,
          visible: true,
          authorizedResale: true,
          stock: { gt: 0 },
        },
        orderBy: { name: 'asc' },
        skip: offset,
        take: 9,
      });
      state = {
        step: 'PRODUCTS',
        provider,
        options: products.slice(0, 8).map((p) => p.slug),
        offset,
      };
      return `${await messageTemplate('products')}\n${products
        .slice(0, 8)
        .map((p, i) => `${i + 1} - ${p.name}`)
        .join(
          '\n',
        )}\n${products.length > 8 ? '9 - Mais produtos\n' : ''}\nVoltar - Categorias\n0 - Menu`;
    };
    try {
      if (
        !raw ||
        customer.blocked ||
        !instance.botEnabled ||
        (customer.humanUntil && customer.humanUntil > new Date())
      )
        response = '';
      else if (['suporte', 'atendente', 'humano'].includes(input)) response = await startHuman();
      else if (
        (!active && trigger) ||
        (state.step === 'MENU' && trigger) ||
        ['menu', 'oi', 'ola', 'inicio', '0', 'cancelar'].includes(input)
      ) {
        state = { step: 'MENU' };
        response = await mainMenu();
      } else if (input === 'voltar') {
        if (state.step === 'PRODUCTS') response = await showProviders();
        else if (state.provider) response = await showProducts(state.provider);
        else {
          state = { step: 'MENU' };
          response = await mainMenu();
        }
      } else if (state.step === 'MENU') {
        if (['1', 'produtos', 'catalogo'].includes(input)) response = await showProviders();
        else if (['2', 'saldo', 'extrato'].includes(input)) {
          const wallet = await db.wallet.findUniqueOrThrow({
            where: { customerId: customer.id },
            include: { entries: { orderBy: { createdAt: 'desc' }, take: 5 } },
          });
          response = `Saldo disponível: R$ ${wallet.available.toFixed(2)}\nSaldo reservado: R$ ${wallet.reserved.toFixed(2)}\n\nÚltimas movimentações:\n${wallet.entries.map((e) => `${e.kind}: R$ ${e.availableDelta.toFixed(2)}`).join('\n')}\n\n3 - Adicionar saldo\n0 - Menu`;
        } else if (['3', 'pix', 'deposito', 'adicionar saldo'].includes(input)) {
          state = { step: 'DEPOSIT_AMOUNT' };
          response =
            'Quanto deseja adicionar à carteira? Informe o valor em reais (ex.: 50,00). O pagamento confirmado vira saldo; depois você confirma sua compra.\n0 - Cancelar';
        } else if (['4', 'pedidos', 'meus pedidos'].includes(input)) {
          const orders = await db.order.findMany({
            where: { customerId: customer.id },
            orderBy: { createdAt: 'desc' },
            take: 10,
          });
          response = orders.length
            ? orders
                .map((o) => `${o.id.slice(0, 8)} • ${o.status} • R$ ${o.totalBrl.toFixed(2)}`)
                .join('\n')
            : 'Você ainda não fez pedidos.';
          response += '\n\n0 - Menu';
        } else if (['5', 'suporte', 'atendente'].includes(input)) {
          response = await startHuman();
        } else if (['6', 'conta', 'minha conta'].includes(input))
          response = `Nome: ${customer.name}\nWhatsApp: +${customer.phone}\nConta: ${customer.id.slice(0, 8)}\n\n0 - Menu`;
        else response = await mainMenu();
      } else if (state.step === 'PROVIDERS') {
        const provider = state.options?.[Number(input) - 1];
        response = provider
          ? await showProducts(provider)
          : 'Escolha uma categoria da lista ou digite 0.';
      } else if (state.step === 'PRODUCTS') {
        if (input === '9' && state.provider)
          response = await showProducts(state.provider, (state.offset ?? 0) + 8);
        else {
          const slug = state.options?.[Number(input) - 1];
          if (!slug) response = 'Escolha um produto da lista.';
          else {
            const quote = await quoteProduct(slug, 1);
            state = { step: 'QUANTITY', slug, provider: state.provider };
            response = `${quote.live.name}\n${(quote.live.description ?? '').replace(/<[^>]*>/g, '')}\nPreço unitário: R$ ${quote.unitSaleBrl}\nDuração: ${quote.live.durationDays ?? 'Não informada'} dias\nGarantia: ${quote.live.warranty?.enabled ? (quote.live.warranty.days ?? 'Consultar suporte') : 0} dias\nMáximo: ${quote.live.stock.maxQuantity}\n\n${await messageTemplate('quantity')}\nVoltar - Produtos\n0 - Cancelar`;
          }
        }
      } else if (state.step === 'QUANTITY' && state.slug) {
        const quantity = Number(input);
        const quote = await quoteProduct(state.slug, quantity);
        state = {
          ...state,
          step: 'CONFIRM',
          quantity,
          total: quote.totalBrl,
          quoteExpires: Date.now() + 5 * 60000,
        };
        response = `${await messageTemplate('summary', { produto: quote.live.name, valor: quote.totalBrl })}\nQuantidade: ${quantity}\n\n1 - Confirmar usando saldo da carteira\n0 - Cancelar\nO preço será conferido novamente ao confirmar.`;
      } else if (state.step === 'CONFIRM' && state.slug && state.quantity && state.total) {
        if (!['1', 'sim', 'confirmar'].includes(input))
          response = 'Digite 1 para confirmar ou 0 para cancelar.';
        else if (!state.quoteExpires || state.quoteExpires < Date.now()) {
          state = { ...state, step: 'QUANTITY' };
          response = 'O resumo venceu. Informe novamente a quantidade para atualizar o preço.';
        } else {
          const order = await placeOrder({
            customerId: customer.id,
            instanceName: instance.name,
            slug: state.slug,
            quantity: state.quantity,
            expectedTotalBrl: state.total,
            idempotencyKey: `message-${event.key}`,
          });
          state = { step: 'MENU' };
          response = await messageTemplate('processing', { pedido: order.id.slice(0, 8) });
          createdOrderId = order.id;
        }
      } else if (state.step === 'DEPOSIT_AMOUNT') {
        if (
          !/^\d{1,5}([.,]\d{1,2})?$/.test(input) ||
          new Prisma.Decimal(input.replace(',', '.')).lt(1) ||
          new Prisma.Decimal(input.replace(',', '.')).gt(10000)
        )
          response = 'Informe um valor entre R$ 1,00 e R$ 10.000,00.';
        else {
          state = {
            step: 'DEPOSIT_EMAIL',
            amount: new Prisma.Decimal(input.replace(',', '.')).toFixed(2),
            depositKey: `deposit-${event.key}`,
          };
          response =
            'Informe seu e-mail para a cobrança Pix. Ele será usado somente no processamento do pagamento.';
        }
      } else if (state.step === 'DEPOSIT_EMAIL') {
        if (!z.string().email().safeParse(raw.trim()).success)
          response = 'Informe um e-mail válido.';
        else {
          state = { ...state, step: 'DEPOSIT_CPF', email: raw.trim() };
          response =
            'Informe seu CPF para a cobrança (11 dígitos). Os dados ficam protegidos e não aparecem nos logs.';
        }
      } else if (state.step === 'DEPOSIT_CPF' && state.amount && state.email) {
        const cpf = input.replace(/[.\-\s]/g, '');
        if (!validCpf(cpf)) response = 'Informe um CPF válido.';
        else {
          const payment = await createDeposit(
            customer.id,
            instance.name,
            state.amount,
            { email: state.email, cpf },
            state.depositKey ?? `deposit-${event.key}`,
          );
          response = `${await messageTemplate('awaitingPayment', { valor: payment.amountBrl.toFixed(2) })}\nVencimento: ${payment.expiresAt?.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) ?? 'consulte o prazo no aplicativo do banco'}\n\n${payment.encryptedPixCode ? decrypt(payment.encryptedPixCode) : 'Cobrança em processamento. Aguarde ou solicite suporte.'}`;
          qr = payment.encryptedQrImage ? decrypt(payment.encryptedQrImage) : undefined;
          state = { step: 'MENU' };
        }
      }
    } catch (e) {
      if (e instanceof AppError) response = e.message + '\nDigite menu para voltar ao início.';
      else throw e;
      if (e instanceof AppError && ['PRICE_CHANGED', 'OUT_OF_STOCK'].includes(e.code))
        state = { step: 'MENU' };
    }
    await transaction(async (tx) => {
      if ((await tx.webhookEvent.findUniqueOrThrow({ where: { id: eventId } })).processedAt) return;
      if (humanUntil)
        await tx.customer.update({ where: { id: customer.id }, data: { humanUntil } });
      await tx.message.upsert({
        where: { key: `in-${event.key}` },
        create: {
          key: `in-${event.key}`,
          instanceName: instance.name,
          customerId: customer.id,
          direction: 'IN',
          status: 'SENT',
          externalMessageId: message.key.id,
          encryptedText: encrypt(raw),
        },
        update: {},
      });
      await tx.conversation.upsert({
        where: {
          customerId_instanceName: { customerId: customer.id, instanceName: instance.name },
        },
        create: {
          customerId: customer.id,
          instanceName: instance.name,
          state: state as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + 30 * 60000),
        },
        update: {
          state: state as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + 30 * 60000),
        },
      });
      if (response)
        await tx.message.upsert({
          where: { key: `reply-${event.key}` },
          create: {
            key: `reply-${event.key}`,
            customerId: customer.id,
            instanceName: instance.name,
            direction: 'OUT',
            encryptedText: encrypt(response),
          },
          update: {},
        });
      if (qr)
        await tx.message.upsert({
          where: { key: `pix-qr-${event.key}` },
          create: {
            key: `pix-qr-${event.key}`,
            customerId: customer.id,
            instanceName: instance.name,
            direction: 'OUT',
            encryptedText: encrypt('Escaneie o QR Code para pagar o Pix.'),
            encryptedMedia: encrypt(qr),
            mediaType: 'image',
          },
          update: {},
        });
      await tx.webhookEvent.update({ where: { id: eventId }, data: { processedAt: new Date() } });
    });
    await notifyOutgoing({ customerId: customer.id, instanceName: instance.name });
    if (createdOrderId) await notifyOrder(createdOrderId);
  });
}
