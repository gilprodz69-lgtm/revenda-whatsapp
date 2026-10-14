import { it, expect, vi, afterEach } from 'vitest';
import {
  incomingSchema,
  incomingText,
  EvolutionService,
  InteractiveRejected,
} from '../../src/integrations/evolution.js';
import { compactMenu, resolveChoice, interactiveSchema } from '../../src/modules/interactive.js';
const key = { id: 'x', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false };
const choice = { id: 'wa:token:1', title: 'Comprar' };
afterEach(() => vi.unstubAllGlobals());
it.each([
  { buttonsResponseMessage: { selectedButtonId: choice.id } },
  { templateButtonReplyMessage: { selectedId: choice.id } },
  { listResponseMessage: { singleSelectReply: { selectedRowId: choice.id } } },
  {
    interactiveResponseMessage: {
      nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: choice.id }) },
    },
  },
])('interpreta respostas de botões, listas, templates e native flow', (message) => {
  expect(incomingText(incomingSchema.parse({ key, message }))).toBe(choice.id);
});
it('ignora JSON interativo inválido e IDs que não pertencem à seleção atual', () => {
  expect(
    incomingText(
      incomingSchema.parse({
        key,
        message: {
          interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: 'invalid' } },
        },
      }),
    ),
  ).toBe('');
  const state = { token: 'token', values: ['1', '0'] };
  expect(resolveChoice(choice.id, state)).toBe('1');
  expect(resolveChoice('wa:old:1', state)).toBeNull();
  expect(resolveChoice('wa:token:5', state)).toBeNull();
  expect(resolveChoice('wa:token:1:extra', state)).toBeNull();
  expect(resolveChoice(choice.id, null)).toBeNull();
});
it('remove a lista numérica do corpo interativo preservando o texto personalizado', () => {
  expect(
    compactMenu(
      'Olá, Maria!\nMinha loja\n\n1 - Produtos\n2 - Saldo\n\nDigite menu para voltar ao início.',
    ),
  ).toBe('Olá, Maria!\nMinha loja');
});
it('usa contratos sendButtons/sendList da Evolution e IDs contextualizados', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ key: { id: 'sent' } })));
  vi.stubGlobal('fetch', fetch);
  const service = new EvolutionService();
  await service.sendInteractive('store', '5511999999999', {
    type: 'buttons',
    title: 'Loja',
    description: 'Como ajudar?',
    footer: 'Escolha',
    buttons: [choice],
  });
  let [url, options] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
  expect(url).toBe('http://evolution.test/message/sendButtons/store');
  expect(JSON.parse(String(options.body))).toMatchObject({
    number: '5511999999999',
    buttons: [{ type: 'reply', id: choice.id, displayText: 'Comprar' }],
  });
  await service.sendInteractive('store', '5511999999999', {
    type: 'list',
    title: 'Loja',
    description: 'Categorias',
    footer: 'Escolha',
    buttonText: 'Ver categorias',
    rows: [choice],
  });
  [url, options] = fetch.mock.calls[1]! as unknown as [string, RequestInit];
  expect(url).toBe('http://evolution.test/message/sendList/store');
  expect(JSON.parse(String(options.body))).toMatchObject({
    buttonText: 'Ver categorias',
    footerText: 'Escolha',
    sections: [{ rows: [{ rowId: choice.id, title: 'Comprar' }] }],
  });
});
it.each([400, 404, 405, 422])(
  'distingue rejeição explícita HTTP %i de resultado desconhecido',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status })),
    );
    await expect(
      new EvolutionService().sendInteractive('store', '5511999999999', {
        type: 'buttons',
        title: 'Loja',
        description: 'Menu',
        footer: 'Escolha',
        buttons: [choice],
      }),
    ).rejects.toBeInstanceOf(InteractiveRejected);
  },
);
it('não classifica timeout ou HTTP 500 como autorização para repetir envio', async () => {
  const service = new EvolutionService(),
    message = {
      type: 'buttons' as const,
      title: 'Loja',
      description: 'Menu',
      footer: 'Escolha',
      buttons: [choice],
    };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 500 })),
  );
  await expect(service.sendInteractive('store', '5511999999999', message)).rejects.toMatchObject({
    code: 'EVOLUTION_ERROR',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('timeout');
    }),
  );
  await expect(service.sendInteractive('store', '5511999999999', message)).rejects.toMatchObject({
    code: 'EVOLUTION_TIMEOUT',
  });
});
it('limita o número de opções conforme o formato', () => {
  expect(
    interactiveSchema.safeParse({
      type: 'buttons',
      title: 'Loja',
      description: 'Menu',
      footer: 'Escolha',
      buttons: Array(4).fill(choice),
    }).success,
  ).toBe(false);
  expect(
    interactiveSchema.safeParse({
      type: 'list',
      title: 'Loja',
      description: 'Menu',
      footer: 'Escolha',
      buttonText: 'Escolher',
      rows: Array(11).fill(choice),
    }).success,
  ).toBe(false);
});
