import { readFile } from 'node:fs/promises';
import argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import './config.js';
import { encrypt } from './core/crypto.js';
// This one-shot process needs only PostgreSQL; do not open the application's Redis connection.
const db = new PrismaClient({ log: [] });
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const passwordFile = process.env.ADMIN_PASSWORD_FILE;
if (!email || !passwordFile) throw new Error('Informe ADMIN_EMAIL e ADMIN_PASSWORD_FILE.');
const password = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '');
if (password.length < 14) throw new Error('A senha inicial deve ter pelo menos 14 caracteres.');
await db.admin.upsert({
  where: { email },
  create: {
    email,
    role: 'OWNER',
    passwordHash: await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    }),
  },
  update: {},
});
for (const [variable, key] of [
  ['PARTNER_API_KEY_FILE', 'secret.partnerKey'],
  ['EXPAY_API_KEY_FILE', 'secret.expayApiKey'],
] as const) {
  const file = process.env[variable];
  const value = file ? (await readFile(file, 'utf8')).trim() : '';
  if (value) {
    if (value.length < 16 || value.length > 500)
      throw new Error('Chave de integração com tamanho inválido.');
    await db.setting.upsert({
      where: { key },
      create: { key, value: encrypt(JSON.stringify(value)), encrypted: true },
      update: {},
    });
    if (key === 'secret.expayApiKey')
      await db.setting.upsert({
        where: { key: 'pix.gateway' },
        create: { key: 'pix.gateway', value: 'expay' },
        update: {},
      });
  }
}
console.log(
  'Administrador e integrações iniciais disponíveis. Nenhuma senha ou chave foi exibida.',
);
await db.$disconnect();
