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
  const settings: Record<string, unknown> = {};
  const secrets: Record<string, boolean> = {};
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    let body: unknown = {},
      status = 200;
    if (url.pathname === '/api/auth/me') {
      body = loggedIn ? { admin, csrf: 'test' } : { message: 'Faça login.' };
      status = loggedIn ? 200 : 401;
    } else if (url.pathname === '/api/auth/login') {
      loggedIn = true;
      body = { admin, csrf: 'test' };
    } else if (url.pathname === '/api/dashboard') body = dashboard;
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
    else if (url.pathname === '/api/settings') {
      if (req.method() === 'PUT')
        for (const [key, value] of Object.entries(req.postDataJSON())) {
          if (key.startsWith('secret.')) secrets[key] = !!value;
          else settings[key] = value;
        }
      body = {
        values: settings,
        secrets,
        environment: {},
        rates: [],
        templates: [{ key: 'summary', label: 'Resumo do pedido', text: 'Total: R$ {valor}' }],
      };
    } else if (url.pathname === '/api/whatsapp/license') body = { status: 'active' };
    else if (url.pathname === '/api/whatsapp') body = [];
    else body = { data: [], total: 0 };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
}
async function navigate(page: Page, label: string) {
  await expect(page.getByRole('button', { name: 'Alternar tema' })).toBeVisible();
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
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Alternar tema' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.screenshot({
    path: `test-results/dashboard-light-${test.info().project.name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Alternar tema' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({
    path: `test-results/dashboard-${test.info().project.name}.png`,
    fullPage: true,
    animations: 'disabled',
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
  await page.getByRole('tab', { name: 'Promoções', exact: true }).click();
  await page.getByLabel('Preço promocional (R$)').fill('35.00');
  await page.getByRole('tab', { name: 'Disponibilidade', exact: true }).click();
  await page.getByLabel('Visível no WhatsApp', { exact: true }).uncheck();
  await page.getByRole('tab', { name: 'Preços', exact: true }).click();
  await expect(page.getByLabel('Preço manual (R$)')).toHaveValue('39.90');
  await page.screenshot({
    path: `test-results/product-editor-${test.info().project.name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
  const mutation = page.waitForRequest(
    (req) => req.method() === 'PATCH' && req.url().includes('/products/authorized-product'),
  );
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  expect((await mutation).postDataJSON()).toMatchObject({
    manualPrice: '39.90',
    promoPrice: '35.00',
    visible: false,
    authorizedResale: true,
  });
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('modal contém o foco, permite navegar nas abas por teclado e fecha com Escape', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/');
  await navigate(page, 'Produtos');
  const edit = page.getByRole('button', { name: 'Editar', exact: true });
  await edit.click();
  const dialog = page.getByRole('dialog', { name: 'Regras de venda' });
  await expect(dialog).toBeVisible();
  await page.getByRole('tab', { name: 'Preços', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Promoções', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('Preço promocional (R$)')).toBeVisible();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(edit).toBeFocused();
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

test('salva palavras de ativação no admin e mantém após recarregar', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await navigate(page, 'Configurações');
  const field = page.getByLabel('Palavras-chave para iniciar o bot');
  await field.fill('comprar, quero comprar, vendas');
  const mutation = page.waitForRequest(
    (req) => req.method() === 'PUT' && req.url().endsWith('/settings'),
  );
  await page.getByRole('button', { name: 'Salvar atendimento', exact: true }).click();
  expect((await mutation).postDataJSON()['bot.activationKeywords']).toEqual([
    'comprar',
    'quero comprar',
    'vendas',
  ]);
  expect((await mutation).postDataJSON()['bot.messageStyle']).toBe('interactive');
  await page.reload();
  await navigate(page, 'Configurações');
  await expect(field).toHaveValue('comprar, quero comprar, vendas');
});

test('abre a seção que contém um campo obrigatório inválido antes de salvar', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await navigate(page, 'Produtos');
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await page.getByLabel('Margem sobre custo (%)').fill('');
  await page.getByRole('tab', { name: 'Promoções', exact: true }).click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Preços', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('Margem sobre custo (%)')).toBeFocused();
  await expect(page.getByRole('dialog')).toBeVisible();
});
test('configura Expay e mantém a chave fora dos valores retornados', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await navigate(page, 'Configurações');
  await page.getByLabel(/Partner API key/).fill('TEST-PARTNER-KEY-NEVER-REAL');
  await page.getByLabel('Gateway Pix').selectOption('expay');
  await page.getByLabel(/Chave de API Expay/).fill('TEST-EXPAY-KEY-NEVER-REAL');
  await page.getByLabel('ID da loja Expay (opcional)').fill('loja-teste');
  const mutation = page.waitForRequest(
    (req) => req.method() === 'PUT' && req.url().endsWith('/settings'),
  );
  await page.getByRole('button', { name: 'Salvar integrações' }).click();
  expect((await mutation).postDataJSON()).toEqual({
    'pix.gateway': 'expay',
    'pix.expayStoreId': 'loja-teste',
    'secret.expayApiKey': 'TEST-EXPAY-KEY-NEVER-REAL',
    'secret.partnerKey': 'TEST-PARTNER-KEY-NEVER-REAL',
  });
  await expect(page.getByLabel(/Chave de API Expay/)).toHaveValue('');
  await expect(page.getByLabel(/Chave de API Expay/)).toHaveAttribute(
    'placeholder',
    'Chave salva — preencha apenas para substituir',
  );
  await expect(page.getByLabel('ID da loja Expay (opcional)')).toHaveValue('loja-teste');
  await expect(page.getByLabel('Gateway Pix')).toHaveValue('expay');
  await expect(page.getByLabel(/Access Token/)).not.toBeVisible();
  await page.reload();
  await navigate(page, 'Configurações');
  await expect(page.getByLabel(/Partner API key/)).toHaveAttribute(
    'placeholder',
    'Chave salva — preencha apenas para substituir',
  );
  await expect(page.getByLabel(/Chave de API Expay/)).toHaveAttribute(
    'placeholder',
    'Chave salva — preencha apenas para substituir',
  );
  await expect(page.getByLabel('ID da loja Expay (opcional)')).toHaveValue('loja-teste');
  const resave = page.waitForRequest(
    (req) => req.method() === 'PUT' && req.url().endsWith('/settings'),
  );
  await page.getByRole('button', { name: 'Salvar integrações', exact: true }).click();
  expect((await resave).postDataJSON()).toEqual({
    'pix.gateway': 'expay',
    'pix.expayStoreId': 'loja-teste',
  });
  await expect(page.getByLabel(/Partner API key/)).toHaveAttribute(
    'placeholder',
    'Chave salva — preencha apenas para substituir',
  );
  await page.screenshot({
    path: `test-results/integrations-${test.info().project.name}.png`,
    fullPage: true,
    animations: 'disabled',
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

test('ativa Evolution pelo painel sem expor a chave e limpa o código do retorno', async ({
  page,
}) => {
  await mockApi(page);
  let active = false;
  await page.route('**/api/whatsapp/license', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: active ? 'active' : 'inactive' }),
    }),
  );
  await page.route('**/api/whatsapp/license/register', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'pending',
        registerUrl: 'https://license.evolutionfoundation.com.br/register?token=TEST_ONLY',
      }),
    }),
  );
  await page.route('**/api/whatsapp/license/activate', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ code: 'TEST_ONLY_CODE' });
    active = true;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: 'active' }),
    });
  });
  await page.goto('/evolution/activate?code=TEST_ONLY_CODE');
  await expect(page).toHaveURL('http://127.0.0.1:5173/');
  await expect(page.getByLabel('Código de ativação da Evolution')).toHaveValue('TEST_ONLY_CODE');
  await page.getByRole('button', { name: 'Iniciar ativação', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Abrir cadastro oficial' })).toHaveAttribute(
    'href',
    /license.evolutionfoundation.com.br/,
  );
  await page.getByRole('button', { name: 'Confirmar ativação', exact: true }).click();
  await expect(
    page.getByText('Evolution ativada. Você já pode conectar o WhatsApp.'),
  ).toBeVisible();
});
