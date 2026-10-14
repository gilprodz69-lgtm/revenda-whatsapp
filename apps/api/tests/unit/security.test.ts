import { it, expect, vi, describe } from 'vitest';
import { createHmac } from 'node:crypto';
vi.mock('../../src/core/db.js', () => ({ db: {}, redis: {}, transaction: vi.fn() }));
import { encrypt, decrypt, equalSecret } from '../../src/core/crypto.js';
import { verifyMpSignature } from '../../src/integrations/pix.js';
import { normalizePhone, incomingSchema } from '../../src/integrations/evolution.js';
import { permissions } from '../../src/modules/auth.js';
import {
  validateTemplate,
  renderTemplate,
  validCpf,
  normalizedInput,
  stateSchema,
} from '../../src/modules/conversation.js';
describe('Segurança e conversa', () => {
  it('protege segredos com AES-GCM e nonce novo', () => {
    const a = encrypt('senha'),
      b = encrypt('senha');
    expect(a).not.toBe(b);
    expect(a).not.toContain('senha');
    expect(decrypt(a)).toBe('senha');
  });
  it('recusa criptograma adulterado', () => {
    const parts = encrypt('senha').split('.');
    parts[2] = Buffer.alloc(16).toString('base64');
    expect(() => decrypt(parts.join('.'))).toThrow();
  });
  it('compara segredos de comprimentos diferentes de forma segura', () => {
    expect(equalSecret('abc', 'a')).toBe(false);
    expect(equalSecret('abc', 'abc')).toBe(true);
  });
  it('valida a assinatura oficial MP e janela de repetição', () => {
    const now = Date.now(),
      ts = String(Math.floor(now / 1000)),
      secret = 'test-secret';
    const v = createHmac('sha256', secret).update(`id:123;request-id:r1;ts:${ts};`).digest('hex');
    expect(verifyMpSignature(secret, `ts=${ts},v1=${v}`, 'r1', '123', now)).toBe(true);
    expect(verifyMpSignature(secret, `ts=${ts},v1=${v}`, 'r1', '124', now)).toBe(false);
    expect(verifyMpSignature(secret, `ts=${ts},v1=${v}`, 'r1', '123', now + 600000)).toBe(false);
  });
  it('recusa assinatura ausente ou malformada', () => {
    expect(verifyMpSignature('secret', '', '', '')).toBe(false);
    expect(verifyMpSignature('secret', 'ts=abc,v1=x', 'request', '123')).toBe(false);
  });
  it('aceita somente números privados reais', () => {
    expect(normalizePhone('5511999999999@s.whatsapp.net')).toBe('5511999999999');
    expect(normalizePhone('123@g.us')).toBeNull();
    expect(normalizePhone('123@lid')).toBeNull();
    expect(normalizePhone('status@broadcast')).toBeNull();
  });
  it('reconhece resposta interativa sem depender de botões na saída', () =>
    expect(
      incomingSchema.parse({
        key: { id: 'a', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
        message: { buttonsResponseMessage: { selectedButtonId: '1' } },
      }).message?.buttonsResponseMessage?.selectedButtonId,
    ).toBe('1'));
  it('aplica permissões de operação e finanças separadamente', () => {
    expect(permissions.VIEWER.has('operate')).toBe(false);
    expect(permissions.OPERATOR.has('finance')).toBe(false);
    expect(permissions.OWNER.has('finance')).toBe(true);
  });
  it('valida placeholders e renderiza sem interpretar HTML', () => {
    expect(renderTemplate('Olá {nome}! {loja}', { nome: 'João', loja: 'Loja' })).toBe(
      'Olá João! Loja',
    );
    expect(() => validateTemplate('{senha}')).toThrow();
  });
  it('normaliza saudações em português', () => expect(normalizedInput(' OlÁ ')).toBe('ola'));
  it('valida CPF antes de cobrar', () => {
    expect(validCpf('52998224725')).toBe(true);
    expect(validCpf('11111111111')).toBe(false);
    expect(validCpf('52998224724')).toBe(false);
  });
  it('reconstrói confirmação persistida com resumo e timeout', () => {
    const state = {
      step: 'CONFIRM',
      slug: 'p',
      quantity: 2,
      total: '30.00',
      quoteExpires: Date.now() + 30000,
    };
    expect(stateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
});
