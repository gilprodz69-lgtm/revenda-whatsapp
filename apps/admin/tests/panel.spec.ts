import { test, expect, type Page } from '@playwright/test';
const admin = { id: 'test-owner', email: 'operacao@example.com', role: 'OWNER' };
const dashboard = {
  customers: 0,
  orders: 0,
  pending: 0,
  completed: 0,
  revenue: '0',
  profit: '0',
  estimatedProfit: '0',
  deposits: '0',
  instances: [],
  partnerBalance: null,
  services: { database: true, redis: true, worker: true },
  chart: [],
};
async function mockApi(page: Page, loggedIn = true) {
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    let body: unknown = {},
      status = 200;
    if (url.pathname === '/api/auth/me') {
      body = loggedIn ? { admin, csrf: 'test' } : { message: 'Faça login.' };
      status = loggedIn ? 200 : 401;
    } else if (url.pathname === '/api/auth/login') body = { admin, csrf: 'test' };
    else if (url.pathname === '/api/dashboard') body = dashboard;
    else if (url.pathname === '/api/products' && req.method() === 'GET')
      body = {
        data: [
          {
            slug: 'authorized-product',
            name: 'Assinatura autorizada',
            provider: { name: 'Fornecedor' },
            costUsd: '5.00',
            catalogPriceUsd: '6.00',
            stock: 10,
            maxQuantity: 10,
            available: true,
            active: true,
            visible: true,
            authorizedResale: true,
            markupPercent: '30',
            fixedMargin: '0',
            roundingStep: '0.01',
            volumeDiscountPercent: '0',
            volumeMinQuantity: 10,
            quote: { unitSaleBrl: '34.45', estimatedProfitBrl: '7.95' },
          },
        ],
        total: 1,
      };
    else if (url.pathname === '/api/settings')
      body = {
        values: {},
        secrets: {},
        environment: {},
        rates: [],
        templates: [{ key: 'summary', label: 'Resumo do pedido', text: 'Total: R$ {valor}' }],
      };
    else if (url.pathname === '/api/whatsapp') body = [];
    else body = { data: [], total: 0 };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
}
async function navigate(page: Page, label: string) {
  const menu = page.getByRole('button', { name: 'Abrir menu' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: label, exact: true }).click();
}
test('login, dashboard, tema e navegação responsiva', async ({ page }) => {
  await mockApi(page, false);
  await page.goto('/');
  await page.getByLabel('E-mail', { exact: true }).fill('operacao@example.com');
  await page.getByLabel('Senha', { exact: true }).fill('SenhaDeTeste123!');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Visão geral', exact: true })).toBeVisible();
  await expect(page.getByText('As primeiras vendas começam aqui')).toBeVisible();
  await page.getByRole('button', { name: 'Alternar tema' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({
    path: `test-results/dashboard-${test.info().project.name}.png`,
    fullPage: true,
  });
  await navigate(page, 'Pedidos');
  await expect(page.getByText('Nenhum registro encontrado')).toBeVisible();
});
test('edita regras de produto com valores financeiros em strings', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await navigate(page, 'Produtos');
  await expect(page.getByText('Assinatura autorizada')).toBeVisible();
  await page.getByRole('button', { name: 'Editar' }).click();
  await page.getByLabel('Preço manual (R$)').fill('39.90');
  const mutation = page.waitForRequest(
    (req) => req.method() === 'PATCH' && req.url().includes('/products/authorized-product'),
  );
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  expect((await mutation).postDataJSON()).toMatchObject({
    manualPrice: '39.90',
    authorizedResale: true,
  });
  await expect(page.getByRole('dialog')).not.toBeVisible();
});
test('não mostra segredos persistidos e permite editar template', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await navigate(page, 'Configurações');
  await expect(page.getByLabel(/Partner API key/)).toHaveValue('');
  await page.getByLabel('Resumo do pedido').fill('Compra: {produto} por {valor}');
  const mutation = page.waitForRequest(
    (req) => req.method() === 'PUT' && req.url().endsWith('/settings'),
  );
  await page.getByRole('button', { name: 'Salvar mensagens' }).click();
  expect((await mutation).postDataJSON()).toEqual({
    'messages.summary': 'Compra: {produto} por {valor}',
  });
});
test('conecta WhatsApp com uma mutação protegida e mostra o pareamento retornado', async ({
  page,
}) => {
  await mockApi(page);
  await page.route('**/api/whatsapp', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ name: 'store', state: 'close', botEnabled: true }]),
    }),
  );
  await page.route('**/api/whatsapp/store/connect', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ pairingCode: '1234-5678' }),
    }),
  );
  await page.goto('/');
  await navigate(page, 'WhatsApp');
  await page.getByRole('button', { name: 'Conectar WhatsApp', exact: true }).click();
  const request = page.waitForRequest((req) => req.url().endsWith('/whatsapp/store/connect'));
  await page.getByRole('button', { name: 'Gerar QR Code / pareamento' }).click();
  expect((await request).method()).toBe('POST');
  await expect(page.getByText('1234-5678')).toBeVisible();
});
