import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { FastifyRequest, FastifyReply } from 'fastify';
import { Role } from '@prisma/client';
import { db } from '../core/db.js';
import { hash, equalSecret } from '../core/crypto.js';
import { AppError } from '../core/errors.js';
import { env } from '../config.js';
declare module 'fastify' {
  interface FastifyRequest {
    admin: { id: string; email: string; role: Role };
    sessionCsrfHash: string;
  }
}
export const permissions: Record<Role, Set<string>> = {
  OWNER: new Set(['read', 'operate', 'finance', 'configure', 'admins']),
  OPERATOR: new Set(['read', 'operate']),
  VIEWER: new Set(['read']),
};
export function requirePermission(request: FastifyRequest, permission: string) {
  if (!permissions[request.admin.role].has(permission))
    throw new AppError('FORBIDDEN', 'Você não tem permissão para esta ação.', 403);
}
export async function authenticate(request: FastifyRequest) {
  const token = request.cookies.session;
  if (!token) throw new AppError('UNAUTHORIZED', 'Faça login para continuar.', 401);
  const session = await db.adminSession.findUnique({
    where: { id: hash(token) },
    include: { admin: true },
  });
  if (!session || session.expiresAt < new Date() || session.admin.disabled)
    throw new AppError('UNAUTHORIZED', 'Sua sessão expirou.', 401);
  request.admin = { id: session.admin.id, email: session.admin.email, role: session.admin.role };
  request.sessionCsrfHash = session.csrfHash;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    if (
      request.headers.origin !== env.APP_ORIGIN ||
      typeof request.headers['x-csrf-token'] !== 'string' ||
      !equalSecret(hash(request.headers['x-csrf-token']), session.csrfHash)
    )
      throw new AppError('CSRF_REJECTED', 'Requisição recusada. Atualize a página.', 403);
  }
}
export async function login(email: string, password: string, reply: FastifyReply) {
  const admin = await db.admin.findUnique({ where: { email } });
  // Equal-work verification for unknown accounts reduces the login enumeration signal.
  const dummy =
    '$argon2id$v=19$m=65536,t=3,p=1$MTIzNDU2Nzg5MGFiY2RlZg$BNLfQcBRBWXf/S9cgcBRNF7TT6TBWYytKwBFkmcnwv0';
  const valid = await argon2.verify(admin?.passwordHash ?? dummy, password).catch(() => false);
  if (!admin || admin.disabled || !valid)
    throw new AppError('LOGIN_FAILED', 'E-mail ou senha inválidos.', 401);
  const token = randomBytes(32).toString('hex'),
    csrf = randomBytes(32).toString('hex');
  await db.adminSession.create({
    data: {
      id: hash(token),
      adminId: admin.id,
      csrfHash: hash(csrf),
      expiresAt: new Date(Date.now() + 8 * 3600000),
    },
  });
  reply.setCookie('session', token, {
    path: '/',
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 8 * 3600,
  });
  reply.setCookie('csrf', csrf, {
    path: '/',
    httpOnly: false,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 8 * 3600,
  });
  return { admin: { id: admin.id, email: admin.email, role: admin.role }, csrf };
}
