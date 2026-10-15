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
  const imported = new Set(['service-1']);
  const catalog = Array.from({ length: 28 }, (_, index) => ({
    slug: `service-${index + 1}`,
    name: `Serviço ${String(index + 1).padStart(2, '0')}`,
    code: `SVC-${index + 1}`,
    provider: index % 2 ? { key: 'openai', name: 'OpenAI' } : { key: 'gemini', name: 'Gemini' },
    cost: '5.00',
    currency: index === 2 ? 'USDT' : 'USD',
    canImport: index !== 2,
    stock: 10,
    available: true,
  }));
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
    else if (url.pathname === '/api/products/catalog') {
      const search = (url.searchParams.get('search') ?? '').toLowerCase();
      const provider = url.searchParams.get('provider') ?? '';
      const current = Number(url.searchParams.get('page') ?? '1');
      const filtered = catalog.filter(
        (service) =>
          (!provider || service.provider.key === provider) &&
          `${service.name} ${service.code}`.toLowerCase().includes(search),
      );
      body = {
        data: filtered
          .slice((current - 1) * 25, current * 25)
          .map((service) => ({ ...service, imported: imported.has(service.slug) })),
        total: filtered.length,
        page: current,
        limit: 25,
        providers: [
          { key: 'gemini', name: 'Gemini' },
          { key: 'openai', name: 'OpenAI' },
        ],
      };
    } else if (url.pathname === '/api/products/import' && req.method() === 'POST') {
      const slugs = req.postDataJSON().slugs as string[];
      slugs.forEach((slug) => imported.add(slug));
      body = { imported: slugs.length, syncedAt: new Date().toISOString() };
    } else if (url.pathname === '/api/products' && req.method() === 'GET')
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

test('escolhe serviços da Partner com busca, paginação e seleção preservada', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await navigate(page, 'Produtos');
  await page.getByRole('button', { name: 'Importar serviços', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Importar serviços', exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('checkbox', { name: 'Selecionar Serviço 01', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Selecionar Serviço 02', exact: true }).check();
  await dialog.getByRole('button', { name: 'Próxima', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Selecionar Serviço 27', exact: true }).check();
  await dialog.getByRole('button', { name: 'Anterior', exact: true }).click();
  await expect(
    dialog.getByRole('checkbox', { name: 'Selecionar Serviço 02', exact: true }),
  ).toBeChecked();
  await dialog.getByLabel('Buscar serviços', { exact: true }).fill('SVC-2');
  await dialog.getByRole('combobox', { name: 'Fornecedor', exact: true }).selectOption('openai');
  await expect(
    dialog.getByText('2 selecionado(s) · 6 serviço(s) encontrado(s)', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('checkbox', { name: 'Selecionar Serviço 02', exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('checkbox', { name: 'Selecionar Serviço 27', exact: true }),
  ).not.toBeVisible();
  await dialog.getByText('Revisar seleção (2)', { exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Remover Serviço 27 da seleção', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `test-results/catalog-import-${test.info().project.name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
  const mutation = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/products/import',
  );
  await dialog.getByRole('button', { name: 'Importar selecionados (2)', exact: true }).click();
  expect((await mutation).postDataJSON()).toEqual({ slugs: ['service-2', 'service-27'] });
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText('2 serviço(s) importado(s). Revise o preço e autorize a revenda em Editar.', {
      exact: true,
    }),
  ).toBeVisible();
});

test('mostra erro da Partner na janela de importação e permite tentar novamente', async ({
  page,
}) => {
  await mockApi(page);
  let fail = true;
  await page.route('**/api/products/catalog?**', async (route) => {
    if (!fail) return route.fallback();
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Configure a chave da Partner API.' }),
    });
  });
  await page.goto('/');
  await navigate(page, 'Produtos');
  await page.getByRole('button', { name: 'Importar serviços', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Importar serviços', exact: true });
  await expect(dialog.getByRole('alert')).toHaveText('Configure a chave da Partner API.');
  fail = false;
  await dialog.getByRole('button', { name: 'Tentar novamente', exact: true }).click();
  await expect(
    dialog.getByRole('checkbox', { name: 'Selecionar Serviço 02', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('alert')).not.toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('mostra a moeda USDT e mantém seleção individual e em lote somente em USD', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/');
  await navigate(page, 'Produtos');
  await page.getByRole('button', { name: 'Importar serviços', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Importar serviços', exact: true });
  const checkbox = dialog.getByRole('checkbox', { name: 'Selecionar Serviço 03', exact: true });
  await expect(checkbox).toBeDisabled();
  const row = dialog.locator('.import-service').filter({ hasText: 'Serviço 03' });
  await expect(row).toContainText('USDT 5,00');
  await expect(row).toContainText('Moeda sem suporte para importação');
  await dialog.getByRole('button', { name: 'Selecionar página', exact: true }).click();
  const mutation = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/products/import',
  );
  await dialog.getByRole('button', { name: 'Importar selecionados (23)', exact: true }).click();
  const slugs = (await mutation).postDataJSON().slugs;
  expect(slugs).toHaveLength(23);
  expect(slugs).not.toContain('service-3');
  expect(slugs).not.toContain('service-1');
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
