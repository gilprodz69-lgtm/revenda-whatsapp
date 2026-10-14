import { readFile } from 'node:fs/promises';
import argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import './config.js';
// This one-shot process needs only PostgreSQL; do not open the application's Redis connection.
const db = new PrismaClient({ log: [] });
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const passwordFile = process.env.ADMIN_PASSWORD_FILE;
if (!email || !passwordFile) throw new Error('Informe ADMIN_EMAIL e ADMIN_PASSWORD_FILE.');
const password = (await readFile(passwordFile, 'utf8')).trim();
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
console.log('Administrador inicial disponível. A senha não foi exibida.');
await db.$disconnect();
