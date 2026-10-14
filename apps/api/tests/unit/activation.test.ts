import { it, expect, vi } from 'vitest';
vi.mock('../../src/core/settings.js', () => ({ setting: vi.fn() }));
import { setting } from '../../src/core/settings.js';
import { activationKeywords, matchesActivation } from '../../src/modules/bot-activation.js';
import { privateSenderPhone } from '../../src/integrations/evolution.js';

it('compara a mensagem inteira sem diferenciar acentos, caixa e pontuação final', () => {
  expect(matchesActivation('  OLÁ!! ', ['olá'])).toBe(true);
  expect(matchesActivation('quero   comprar', ['Quero comprar'])).toBe(true);
  expect(matchesActivation('foi enviado', ['oi'])).toBe(false);
  expect(matchesActivation('oi tudo bem', ['oi'])).toBe(false);
  expect(matchesActivation('oi', [])).toBe(false);
});
it('preserva saudações adicionais antigas até salvar a nova configuração', async () => {
  vi.mocked(setting).mockImplementation(async (key, fallback) =>
    key === 'bot.greetings' ? ['comprar'] : fallback,
  );
  expect(await activationKeywords()).toEqual(expect.arrayContaining(['oi', 'comprar']));
});
it('respeita uma lista nova vazia e palavras personalizadas sem reativar os padrões', async () => {
  vi.mocked(setting).mockResolvedValueOnce([]);
  expect(await activationKeywords()).toEqual([]);
  vi.mocked(setting).mockResolvedValueOnce(['vendas']);
  expect(await activationKeywords()).toEqual(['vendas']);
});
it.each(['12000@g.us', 'status@broadcast', '123@broadcast', '123@newsletter'])(
  'ignora %s mesmo com remetente alternativo privado',
  (remoteJid) => {
    expect(
      privateSenderPhone({
        remoteJid,
        remoteJidAlt: '5511999999999@s.whatsapp.net',
        fromMe: false,
      }),
    ).toBeNull();
  },
);
it('aceita privado e LID mapeado; ignora mensagens próprias e LID sem telefone', () => {
  const jid = '5511999999999@s.whatsapp.net';
  expect(privateSenderPhone({ remoteJid: jid, fromMe: false })).toBe('5511999999999');
  expect(privateSenderPhone({ remoteJid: '123@lid', remoteJidAlt: jid, fromMe: false })).toBe(
    '5511999999999',
  );
  expect(privateSenderPhone({ remoteJid: jid, fromMe: true })).toBeNull();
  expect(privateSenderPhone({ remoteJid: '123@lid', fromMe: false })).toBeNull();
});
