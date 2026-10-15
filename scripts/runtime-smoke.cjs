// Explicitly mocked external services. Production runtime never imports this file.
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');
const { Queue } = require('bullmq');
const root = path.resolve(__dirname, '..');
const url = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (
  !url ||
  new URL(url).pathname !== '/revenda_test' ||
  !redisUrl ||
  new URL(redisUrl).pathname !== '/15'
)
  throw new Error('Smoke exige DATABASE_URL revenda_test e REDIS_URL com DB 15.');
const db = new PrismaClient({ datasources: { db: { url } } });
const redis = new Redis(redisUrl);
const maintenance = new Queue('maintenance', { connection: { url: redisUrl } });
let workerOutput = '',
  sends = 0,
  interactiveSends = 0;
const fixture = (handler, port) =>
  new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
const send = (res, data) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};
const children = [],
  servers = [];
const instance = 'runtime-smoke';
const env = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: '15300',
  DATABASE_URL: url,
  REDIS_URL: redisUrl,
  APP_ORIGIN: 'http://localhost:5173',
  PUBLIC_API_URL: 'http://localhost:15300',
  ENCRYPTION_KEY: 'a'.repeat(64),
  WEBHOOK_SECRET: 'b'.repeat(64),
  EVOLUTION_API_KEY: 'c'.repeat(64),
  EVOLUTION_URL: 'http://127.0.0.1:16600',
  PARTNER_URL: 'http://127.0.0.1:16500',
  PARTNER_API_KEY: 'TEST_ONLY',
  PIX_GATEWAY: 'disabled',
  MP_ACCESS_TOKEN: '',
  MP_WEBHOOK_SECRET: '',
  TRUST_PROXY: '0',
};
(async () => {
  console.log(
    'TESTE ISOLADO: Partner API e Evolution serão mocks HTTP locais. Nenhuma compra ou pagamento real.',
  );
  await db.whatsappInstance.upsert({
    where: { name: instance },
    create: { name: instance, state: 'open' },
    update: { state: 'open' },
  });
  servers.push(
    await fixture((req, res) => {
      send(
        res,
        req.url.startsWith('/health')
          ? { ok: true, service: 'partner-api', version: 1 }
          : req.url.startsWith('/balance')
            ? { ok: true, balance: '0.00', currency: 'USD' }
            : { data: [] },
      );
    }, 16500),
  );
  servers.push(
    await fixture((req, res) => {
      if (/\/message\/send(?:Text|Buttons|List)\//.test(req.url)) sends++;
      if (req.url.includes('/message/sendButtons/')) interactiveSends++;
      send(
        res,
        req.url.includes('connectionState')
          ? { instance: { state: 'open' } }
          : { key: { id: randomUUID() } },
      );
    }, 16600),
  );
  for (const file of ['server', 'worker']) {
    const child = spawn(process.execPath, [`dist/${file}.js`], {
      cwd: path.join(root, 'apps/api'),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', (e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
    child.stdout.on('data', (data) => {
      if (file === 'worker') workerOutput += data.toString();
    });
    child.stderr.on('data', (data) => process.stderr.write(data));
    children.push(child);
  }
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch('http://127.0.0.1:15300/health/ready');
      if (r.ok) break;
    } catch {}
    if (i === 99) throw Error('API não ficou pronta.');
    await new Promise((r) => setTimeout(r, 200));
  }
  for (let i = 0; !workerOutput.includes('"event":"worker.ready"'); i++) {
    if (i === 100) throw Error('Worker startup timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
  // Prove normal replies do not depend on the 15-second recovery scan.
  await maintenance.removeJobScheduler('pump');
  for (let i = 0; ; i++) {
    const jobs = await maintenance.getJobs(['active', 'waiting']);
    if (!jobs.some((job) => job.name === 'pump')) break;
    if (i === 100) throw Error('Recovery scan did not finish');
    await new Promise((r) => setTimeout(r, 50));
  }
  const timings = [];
  for (const text of ['oi', 'menu']) {
    const id = `smoke-${randomUUID()}`;
    const started = Date.now();
    const request = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': env.WEBHOOK_SECRET },
      body: JSON.stringify({
        event: 'messages.upsert',
        instance,
        data: {
          key: { id, remoteJid: '5511888888888@s.whatsapp.net', fromMe: false },
          message: { conversation: text },
        },
      }),
    };
    for (let duplicate = 0; duplicate < 2; duplicate++) {
      const response = await fetch('http://127.0.0.1:15300/webhooks/evolution', request);
      if (response.status !== 202) throw Error('Webhook recusado: ' + response.status);
    }
    let sent = false;
    for (let i = 0; i < 100; i++) {
      const row = await db.message.findUnique({
        where: { key: `reply-evolution-${instance}-${id}` },
      });
      if (row?.status === 'SENT') {
        sent = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!sent) throw Error('Worker não enviou a resposta persistida.');
    const elapsed = Date.now() - started;
    if (elapsed >= 5000) throw Error('Reply exceeded 5 seconds without recovery scan');
    timings.push(elapsed);
  }
  if (sends !== 2) throw Error('Duplicate or missing WhatsApp reply: ' + sends);
  if (interactiveSends !== 2) throw Error('Default menus did not use native reply buttons');
  if (!(await redis.get('worker:heartbeat'))) throw Error('Heartbeat do worker ausente.');
  console.log(
    'SMOKE PASS: API + worker, recovery scan disabled, replies (ms): ' +
      timings.join(', ') +
      '; no duplicate sends.',
  );
})()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const child of children) {
      child.kill();
      await Promise.race([
        new Promise((r) => child.once('exit', r)),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    for (const server of servers) await new Promise((r) => server.close(r));
    await db.$disconnect();
    await maintenance.close();
    await redis.quit();
  });
