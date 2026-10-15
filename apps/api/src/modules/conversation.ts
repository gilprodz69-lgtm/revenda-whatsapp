import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db, transaction } from '../core/db.js';
import { encrypt, decrypt } from '../core/crypto.js';
import { AppError } from '../core/errors.js';
import { setting } from '../core/settings.js';
import { withLock } from '../core/lock.js';
import { incomingSchema, incomingText, privateSenderPhone } from '../integrations/evolution.js';
import { pixGateway, type PixPayer } from '../integrations/pix.js';
import { notifyOutgoing, notifyOrder } from '../core/dispatch.js';
import { activationKeywords, matchesActivation } from './bot-activation.js';
import { quoteProduct, placeOrder } from './orders.js';
import { createDeposit } from './payments.js';
import { smmDetailFields, validateSmmField } from './smm-orders.js';
import { templates, messageTemplate } from './templates.js';
import {
  interactionStateSchema,
  resolveChoice,
  compactMenu,
  interactiveSchema,
  type Interactive,
} from './interactive.js';
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
    'IDLE',
    'MENU',
    'PROVIDERS',
    'PRODUCTS',
    'QUANTITY',
    'CONFIRM',
    'SMM_DETAILS',
    'DEPOSIT_AMOUNT',
    'DEPOSIT_EMAIL',
    'DEPOSIT_CPF',
  ]),
  provider: z.string().optional(),
  providerOffset: z.number().optional(),
  interaction: interactionStateSchema.optional(),
  options: z.array(z.string()).optional(),
  slug: z.string().optional(),
  quantity: z.number().optional(),
  total: z.string().optional(),
  amount: z.string().optional(),
  email: z.string().optional(),
  depositKey: z.string().optional(),
  offset: z.number().optional(),
  quoteExpires: z.number().optional(),
  smmType: z.string().optional(),
  details: z.record(z.string()).optional(),
  fieldIndex: z.number().int().min(0).optional(),
});
type State = z.infer<typeof stateSchema>;
function acceptsStepInput(state: State, input: string) {
  if (state.step === 'IDLE') return false;
  if (['0', 'cancelar', 'voltar', 'suporte', 'atendente', 'humano'].includes(input)) return true;
  switch (state.step) {
    case 'MENU':
      return [
        '1',
        'produtos',
        'catalogo',
        '2',
        'saldo',
        'extrato',
        '3',
        'pix',
        'deposito',
        'adicionar saldo',
        '4',
        'pedidos',
        'meus pedidos',
        '5',
        '6',
        'conta',
        'minha conta',
      ].includes(input);
    case 'PROVIDERS':
    case 'PRODUCTS':
    case 'QUANTITY':
      return /^\d+$/.test(input);
    case 'CONFIRM':
      return ['1', 'sim', 'confirmar'].includes(input);
    case 'DEPOSIT_AMOUNT':
      return /^\d+(?:[.,]\d+)?$/.test(input);
    case 'DEPOSIT_EMAIL':
      return input.includes('@') || input === 'continuar';
    case 'DEPOSIT_CPF':
      return /^[\d.\-\s]+$/.test(input) || input === 'continuar';
    case 'SMM_DETAILS': {
      const key = smmDetailFields(state.smmType ?? '')[state.fieldIndex ?? 0]?.key;
      return key === 'link'
        ? /^https?:\/\//i.test(input)
        : key === 'answer_number'
          ? /^\d+$/.test(input)
          : key === 'username'
            ? /^[\w.\-]{1,100}$/.test(input)
            : !!input;
    }
  }
}
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
    let raw = incomingText(message);
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
    let stateBefore =
      current && current.expiresAt > new Date() ? stateSchema.parse(current.state) : null;
    if (stateBefore?.step === 'MENU' && current) {
      // Previous versions left MENU after the final Pix batch. Treat that batch
      // as idle too, without clearing the existing payment or conversation.
      const lastReply = await db.message.findFirst({
        where: {
          customerId: current.customerId,
          instanceName: instance.name,
          direction: 'OUT',
          OR: [
            { key: { startsWith: 'reply-' } },
            { key: { startsWith: 'pix-code-' } },
            { key: { startsWith: 'pix-qr-' } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        select: { key: true },
      });
      if (lastReply?.key.startsWith('pix-')) stateBefore = { step: 'IDLE' };
    }
    const activeState = stateBefore?.step === 'IDLE' ? null : stateBefore;
    if (raw.startsWith('wa:')) {
      const selected = resolveChoice(raw, activeState?.interaction);
      // Old menus never become quantities or confirmations in a different conversation step.
      if (selected === null) {
        await db.webhookEvent.update({ where: { id: eventId }, data: { processedAt: new Date() } });
        return;
      }
      raw = selected;
    }
    const trigger = matchesActivation(raw, await activationKeywords());
    const input = normalizedInput(raw);
    const humanActive = !!existingCustomer?.humanUntil && existingCustomer.humanUntil > new Date();
    if (!trigger && !humanActive && (!activeState || !acceptsStepInput(activeState, input))) {
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
    let state: State = stateBefore ?? { step: 'MENU' };
    let response = '';
    let qr: string | undefined;
    let pixCode: string | undefined;
    let humanUntil: Date | undefined;
    let createdOrderId: string | undefined;
    let interactive: Interactive | undefined;
    const rich = (await setting('bot.messageStyle', 'interactive')) === 'interactive';
    const choices = (
      type: 'buttons' | 'list',
      text: string,
      items: { value: string; title: string; description?: string }[],
      buttonText = 'Ver opções',
    ) => {
      if (!rich || !items.length) return;
      const token = crypto.randomUUID();
      state.interaction = { token, values: items.map((item) => item.value) };
      const mapped = items.map((item) => ({
        id: `wa:${token}:${item.value}`,
        title: item.title.slice(0, 24),
        ...(item.description ? { description: item.description.slice(0, 72) } : {}),
      }));
      interactive = interactiveSchema.parse(
        type === 'buttons'
          ? {
              type,
              title: store.slice(0, 200),
              description: compactMenu(text),
              footer: 'Selecione uma opção abaixo',
              buttons: mapped,
            }
          : {
              type,
              title: store.slice(0, 200),
              description: compactMenu(text),
              footer: 'Selecione uma opção abaixo',
              buttonText,
              rows: mapped,
            },
      );
    };
    const store = await setting('store.name', 'Nossa loja');
    const finishDeposit = async (payer: PixPayer = {}) => {
      if (!state.amount) throw new AppError('INVALID_AMOUNT', 'Informe novamente o valor do Pix.');
      const payment = await createDeposit(
        customer.id,
        instance.name,
        state.amount,
        payer,
        state.depositKey ?? `deposit-${event.key}`,
      );
      const code = payment.encryptedPixCode ? decrypt(payment.encryptedPixCode) : undefined;
      response = `${await messageTemplate('awaitingPayment', { valor: payment.amountBrl.toFixed(2) })}\nVencimento: ${payment.expiresAt?.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) ?? 'consulte o prazo no aplicativo do banco'}\n\n${code ? 'O código Pix copia e cola será enviado em uma mensagem separada. Toque e segure a mensagem com o código e selecione Copiar para colar no aplicativo do seu banco.' : 'Cobrança em processamento. Aguarde ou solicite suporte.'}`;
      pixCode = code;
      qr = payment.encryptedQrImage ? decrypt(payment.encryptedQrImage) : undefined;
      // A pending Pix is not an invitation to keep replying to unrelated messages.
      // Only a configured activation keyword may start a new conversation from here.
      state = { step: 'IDLE' };
    };
    const mainMenu = async () => {
      const text = await messageTemplate('welcome', { nome: customer.name, loja: store });
      if (rich && (await setting('bot.mainMenuStyle', 'buttons')) === 'buttons') {
        choices('buttons', text, [
          { value: '1', title: '🛒 Comprar serviços' },
          { value: '2', title: '💰 Meu saldo' },
          { value: '5', title: '🎧 Suporte' },
        ]);
        return text;
      }
      choices(
        'list',
        text,
        [
          {
            value: '1',
            title: '🛍️ Comprar serviços',
            description: 'Explore categorias e produtos disponíveis',
          },
          {
            value: '2',
            title: '💰 Meu saldo',
            description: 'Consulte o saldo e suas movimentações',
          },
          {
            value: '3',
            title: '💳 Adicionar saldo',
            description: 'Adicione créditos à carteira por Pix',
          },
          {
            value: '4',
            title: '📦 Meus pedidos',
            description: 'Acompanhe suas compras e entregas',
          },
          { value: '5', title: '🎧 Suporte', description: 'Converse com a equipe de atendimento' },
          { value: '6', title: '👤 Minha conta', description: 'Consulte os dados da sua conta' },
        ],
        'Menu',
      );
      return text;
    };
    const startHuman = async () => {
      humanUntil = new Date(Date.now() + 24 * 3600000);
      state = { step: 'MENU' };
      return `${await messageTemplate('human')}\n${await setting('human.hours', 'Atendimento conforme disponibilidade da equipe.')}`;
    };
    const showProviders = async (offset = 0) => {
      const sellable = {
        archivedAt: null,
        available: true,
        active: true,
        visible: true,
        authorizedResale: true,
        stock: { gt: 0 },
        OR: [{ source: 'PARTNER' }, { source: 'SMM', smmProvider: { active: true } }],
      };
      const [categories, legacy] = await Promise.all([
        db.category.findMany({ where: { active: true, products: { some: sellable } } }),
        db.provider.findMany({
          where: {
            products: {
              some: {
                ...sellable,
                categoryId: null,
              },
            },
          },
        }),
      ]);
      const providers = [
        ...categories.map((c) => ({
          key: c.id,
          name: c.name,
          sortOrder: c.sortOrder,
          description: c.description,
        })),
        ...legacy.map((p) => ({
          key: p.key,
          name: p.name,
          sortOrder: p.sortOrder,
          description: '',
        })),
      ]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'pt-BR'))
        .slice(offset, offset + 9);
      state = {
        step: 'PROVIDERS',
        options: providers.slice(0, 8).map((p) => p.key),
        providerOffset: offset,
      };
      if (!providers.length) state = { step: 'MENU' };
      const text = providers.length
        ? `${await messageTemplate('categories')}\n${providers
            .slice(0, 8)
            .map((p, i) => `${i + 1} - ${p.name}`)
            .join('\n')}\n${providers.length > 8 ? '9 - Mais categorias\n' : ''}\n0 - Menu`
        : await messageTemplate('unavailable');
      if (providers.length)
        choices(
          'list',
          await messageTemplate('categories'),
          [
            ...providers
              .slice(0, 8)
              .map((p, i) => ({ value: String(i + 1), title: p.name, description: p.description })),
            ...(providers.length > 8 ? [{ value: '9', title: 'Mais categorias' }] : []),
            { value: '0', title: 'Menu principal' },
          ],
          'Ver categorias',
        );
      return text;
    };
    const showProducts = async (provider: string, offset = 0) => {
      const products = await db.product.findMany({
        where: {
          AND: [
            {
              OR: [
                { categoryId: provider },
                { category: { sourceKey: `partner:${provider}` } },
                { categoryId: null, providerKey: provider },
              ],
            },
            { OR: [{ categoryId: null }, { category: { active: true } }] },
            { OR: [{ source: 'PARTNER' }, { source: 'SMM', smmProvider: { active: true } }] },
          ],
          archivedAt: null,
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
      const text = `${await messageTemplate('products')}\n${products
        .slice(0, 8)
        .map((p, i) => `${i + 1} - ${p.displayName ?? p.name}`)
        .join(
          '\n',
        )}\n${products.length > 8 ? '9 - Mais produtos\n' : ''}\nVoltar - Categorias\n0 - Menu`;
      choices(
        'list',
        await messageTemplate('products'),
        [
          ...products.slice(0, 8).map((p, i) => ({
            value: String(i + 1),
            title: p.displayName ?? p.name,
            description:
              p.source === 'SMM'
                ? `Mínimo: ${p.minQuantity} · Máximo: ${p.maxQuantity}`
                : `Estoque: ${p.stock} · Máximo: ${p.maxQuantity}`,
          })),
          ...(products.length > 8
            ? [{ value: '9', title: 'Mais produtos' }]
            : [{ value: '0', title: 'Menu principal' }]),
          { value: 'voltar', title: 'Voltar às categorias' },
        ],
        'Ver produtos',
      );
      return text;
    };
    const startSmmDetails = (slug: string, quantity: number, type: string) => {
      state = {
        step: 'SMM_DETAILS',
        slug,
        quantity,
        provider: state.provider,
        smmType: type,
        details: {},
        fieldIndex: 0,
      };
      return `${smmDetailFields(type)[0]!.label}\n0 - Cancelar`;
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
      else if (trigger || ['0', 'cancelar'].includes(input)) {
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
          choices(
            'list',
            response,
            [
              { value: '3', title: '💳 Adicionar saldo' },
              { value: '4', title: '📦 Meus pedidos' },
              { value: '6', title: '👤 Minha conta' },
              { value: '0', title: 'Menu principal' },
            ],
            'Menu da carteira',
          );
        } else if (['3', 'pix', 'deposito', 'adicionar saldo'].includes(input)) {
          state = { step: 'DEPOSIT_AMOUNT' };
          response =
            'Quanto deseja adicionar à carteira? Informe o valor em reais (ex.: 50,00). O pagamento confirmado vira saldo; depois você confirma sua compra.\n0 - Cancelar';
          choices('buttons', response, [
            { value: '20', title: 'R$ 20,00' },
            { value: '50', title: 'R$ 50,00' },
            { value: '100', title: 'R$ 100,00' },
          ]);
        } else if (['4', 'pedidos', 'meus pedidos'].includes(input)) {
          const orders = await db.order.findMany({
            where: { customerId: customer.id },
            orderBy: { createdAt: 'desc' },
            take: 10,
          });
          response = orders.length
            ? orders
                .map(
                  (o) =>
                    `${o.id.slice(0, 8)} • ${o.source === 'SMM' ? (o.smmState ?? o.status) : o.status} • R$ ${o.totalBrl.toFixed(2)}${o.source === 'SMM' && o.smmRemains !== null ? ` • Restantes: ${o.smmRemains}` : ''}${o.refundedBrl.gt(0) ? ` • Devolvido: R$ ${o.refundedBrl.toFixed(2)}` : ''}`,
                )
                .join('\n')
            : 'Você ainda não fez pedidos.';
          response += '\n\n0 - Menu';
        } else if (['5', 'suporte', 'atendente'].includes(input)) {
          response = await startHuman();
        } else if (['6', 'conta', 'minha conta'].includes(input))
          response = `Nome: ${customer.name}\nWhatsApp: +${customer.phone}\nConta: ${customer.id.slice(0, 8)}\n\n0 - Menu`;
        else response = '';
      } else if (state.step === 'PROVIDERS') {
        if (input === '9') response = await showProviders((state.providerOffset ?? 0) + 8);
        else {
          const provider = state.options?.[Number(input) - 1];
          response = provider
            ? await showProducts(provider)
            : 'Escolha uma categoria da lista ou digite 0.';
        }
      } else if (state.step === 'PRODUCTS') {
        if (input === '9' && state.provider)
          response = await showProducts(state.provider, (state.offset ?? 0) + 8);
        else {
          const slug = state.options?.[Number(input) - 1];
          if (!slug) response = 'Escolha um produto da lista.';
          else {
            const listing = await db.product.findUniqueOrThrow({ where: { slug } });
            const quote = await quoteProduct(
              slug,
              listing.source === 'SMM' ? listing.minQuantity : 1,
            );
            state = { step: 'QUANTITY', slug, provider: state.provider };
            response =
              quote.product.source === 'SMM'
                ? `${quote.product.name}\n${(quote.product.description ?? '').replace(/<[^>]*>/g, '')}\nPreço: R$ ${quote.unitSaleBrl} por ${listing.priceBasis === 1 ? 'pacote' : '1.000 unidades'}\nMínimo: ${listing.minQuantity}\nMáximo: ${quote.live.stock.maxQuantity}\n\nInforme a quantidade desejada.\nVoltar - Produtos\n0 - Cancelar`
                : `${quote.product.name}\n${(quote.product.description ?? '').replace(/<[^>]*>/g, '')}\nPreço unitário: R$ ${quote.unitSaleBrl}\nDuração: ${quote.live.durationDays ?? 'Não informada'} dias\nGarantia: ${quote.live.warranty?.enabled ? (quote.live.warranty.days ?? 'Consultar suporte') : 0} dias\nMáximo: ${quote.live.stock.maxQuantity}\n\n${await messageTemplate('quantity')}\nVoltar - Produtos\n0 - Cancelar`;
            if (
              listing.source === 'SMM' &&
              ['Package', 'Custom Comments'].includes(listing.smmType!)
            ) {
              response =
                response.replace(/Informe a quantidade desejada\.[\s\S]*$/, '') +
                startSmmDetails(slug, listing.minQuantity, listing.smmType!);
            } else {
              choices(
                'buttons',
                response,
                (listing.source === 'SMM'
                  ? [listing.minQuantity, listing.minQuantity * 2, listing.minQuantity * 3]
                  : [1, 2, 3]
                )
                  .filter((n) => n <= quote.live.stock.maxQuantity)
                  .map((n) => ({
                    value: String(n),
                    title: n === 1 ? '1 unidade' : `${n} unidades`,
                  })),
              );
            }
          }
        }
      } else if (state.step === 'QUANTITY' && state.slug) {
        const quantity = Number(input);
        const quote = await quoteProduct(state.slug, quantity);
        if (quote.product.source === 'SMM') {
          response = startSmmDetails(state.slug, quantity, quote.product.smmType!);
        } else {
          state = {
            ...state,
            step: 'CONFIRM',
            quantity,
            total: quote.totalBrl,
            quoteExpires: Date.now() + 5 * 60000,
          };
          response = `${await messageTemplate('summary', { produto: quote.product.name, valor: quote.totalBrl })}\nQuantidade: ${quantity}\n\n1 - Confirmar usando saldo da carteira\n0 - Cancelar\nO preço será conferido novamente ao confirmar.`;
          choices('buttons', response, [
            { value: '1', title: '✅ Confirmar compra' },
            { value: '0', title: 'Cancelar' },
          ]);
        }
      } else if (state.step === 'SMM_DETAILS' && state.slug && state.smmType) {
        const fields = smmDetailFields(state.smmType),
          index = state.fieldIndex ?? 0,
          field = fields[index]!;
        const value = validateSmmField(field.key, raw);
        state.details = { ...state.details, [field.key]: value };
        if (index + 1 < fields.length) {
          state.fieldIndex = index + 1;
          response = `${fields[index + 1]!.label}\n0 - Cancelar`;
        } else {
          const quantity =
            state.smmType === 'Custom Comments'
              ? state.details.comments!.split(/\r?\n/).length
              : state.quantity!;
          const quote = await quoteProduct(state.slug, quantity);
          state = {
            ...state,
            step: 'CONFIRM',
            quantity,
            total: quote.totalBrl,
            quoteExpires: Date.now() + 5 * 60000,
          };
          response = `${await messageTemplate('summary', { produto: quote.product.name, valor: quote.totalBrl })}\nQuantidade: ${quantity}\nDestino: ${state.details!.link}\n${state.details!.username ? `Autor: ${state.details!.username}\n` : ''}${state.details!.answer_number ? `Resposta: ${state.details!.answer_number}\n` : ''}\n1 - Confirmar usando saldo da carteira\n0 - Cancelar\nO preço será conferido novamente ao confirmar.`;
          choices('buttons', response, [
            { value: '1', title: '✅ Confirmar compra' },
            { value: '0', title: 'Cancelar' },
          ]);
        }
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
            details: state.details,
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
          if (!(await pixGateway()).requiresPayerDetails) await finishDeposit();
          else
            response =
              'Informe seu e-mail para a cobrança Pix. Ele será usado somente no processamento do pagamento.';
        }
      } else if (state.step === 'DEPOSIT_EMAIL') {
        // Sessions started before the upgrade also skip optional payer questions.
        if (!(await pixGateway()).requiresPayerDetails) await finishDeposit();
        else if (!z.string().email().safeParse(raw.trim()).success)
          response = 'Informe um e-mail válido.';
        else {
          state = { ...state, step: 'DEPOSIT_CPF', email: raw.trim() };
          response =
            'Informe seu CPF para a cobrança (11 dígitos). Os dados ficam protegidos e não aparecem nos logs.';
        }
      } else if (state.step === 'DEPOSIT_CPF' && state.amount) {
        const cpf = input.replace(/[.\-\s]/g, '');
        if (!(await pixGateway()).requiresPayerDetails) await finishDeposit();
        else if (!validCpf(cpf)) response = 'Informe um CPF válido.';
        else await finishDeposit({ email: state.email, cpf });
      }
    } catch (e) {
      interactive = undefined;
      if (e instanceof AppError) response = e.message + '\nDigite menu para voltar ao início.';
      else throw e;
      if (e instanceof AppError && ['PRICE_CHANGED', 'OUT_OF_STOCK'].includes(e.code))
        state = { step: 'MENU' };
      if (e instanceof AppError && e.code === 'LOCAL_INSUFFICIENT_BALANCE') {
        state = { step: 'MENU' };
        response = `${e.message}\nAdicione saldo por Pix para continuar comprando.\n\n3 - Adicionar saldo\n0 - Menu`;
        choices('buttons', response, [
          { value: '3', title: '💳 Adicionar saldo' },
          { value: '0', title: 'Menu principal' },
        ]);
      }
    }
    if (
      response &&
      rich &&
      !interactive &&
      !customer.blocked &&
      instance.botEnabled &&
      !(customer.humanUntil && customer.humanUntil > new Date()) &&
      !humanUntil &&
      state.step === 'MENU'
    )
      choices(
        'list',
        response,
        [
          { value: '0', title: 'Menu principal' },
          { value: '3', title: 'Adicionar saldo' },
          { value: '5', title: 'Suporte' },
        ],
        'Menu',
      );
    if (!interactive) delete state.interaction;
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
      // PostgreSQL now() is identical throughout a transaction. Give this batch an
      // explicit order so recovery and immediate dispatch both leave the code last.
      const outgoingAt = Date.now();
      if (response)
        await tx.message.upsert({
          where: { key: `reply-${event.key}` },
          create: {
            key: `reply-${event.key}`,
            customerId: customer.id,
            instanceName: instance.name,
            direction: 'OUT',
            createdAt: new Date(outgoingAt),
            encryptedText: encrypt(response),
            ...(interactive ? { encryptedInteractive: encrypt(JSON.stringify(interactive)) } : {}),
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
            createdAt: new Date(outgoingAt + 1),
            encryptedText: encrypt('Escaneie o QR Code para pagar o Pix.'),
            encryptedMedia: encrypt(qr),
            mediaType: 'image',
          },
          update: {},
        });
      if (pixCode)
        await tx.message.upsert({
          where: { key: `pix-code-${event.key}` },
          create: {
            key: `pix-code-${event.key}`,
            customerId: customer.id,
            instanceName: instance.name,
            direction: 'OUT',
            createdAt: new Date(outgoingAt + 2),
            encryptedText: encrypt(pixCode),
          },
          update: {},
        });
      await tx.webhookEvent.update({ where: { id: eventId }, data: { processedAt: new Date() } });
    });
    await notifyOutgoing({ customerId: customer.id, instanceName: instance.name });
    if (createdOrderId) await notifyOrder(createdOrderId);
  });
}
