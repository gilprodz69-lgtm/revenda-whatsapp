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
  let productDeleted = false;
  let productEdits: Record<string, unknown> = {};
  let smmProviders: Record<string, any>[] = [];
  let categories: Record<string, any>[] = [
    {
      id: 'cat-1',
      name: 'Instagram',
      description: '',
      sortOrder: 0,
      active: true,
      _count: { products: 0 },
    },
  ];
  const smmImported = new Set<string>();
  let rates: Record<string, unknown>[] = [];
  const refreshRate = () => {
    rates = [
      {
        id: 'bcb-test-rate',
        usdBrl: '5.25',
        source: 'BCB-PTAX-venda',
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    ];
    return rates[0];
  };
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
    } else if (url.pathname === '/api/categories') {
      if (req.method() === 'POST') {
        const row = {
          id: `cat-${categories.length + 1}`,
          ...req.postDataJSON(),
          _count: { products: 0 },
        };
        categories.push(row);
        body = row;
      } else body = { data: categories };
    } else if (url.pathname.startsWith('/api/categories/')) {
      const id = url.pathname.split('/').at(-1);
      if (req.method() === 'DELETE') categories = categories.filter((c) => c.id !== id);
      else categories = categories.map((c) => (c.id === id ? { ...c, ...req.postDataJSON() } : c));
      body = { ok: true };
    } else if (url.pathname === '/api/smm-providers') {
      if (req.method() === 'POST') {
        const { apiKey: _key, ...values } = req.postDataJSON();
        const row = {
          id: 'smm-1',
          ...values,
          keyConfigured: true,
          _count: { products: 0, orders: 0 },
        };
        smmProviders.push(row);
        body = row;
      } else body = { data: smmProviders };
    } else if (url.pathname === '/api/smm-providers/smm-1/test')
      body = { balance: '100.00', currency: 'USD' };
    else if (url.pathname === '/api/smm-providers/smm-1/catalog')
      body = {
        data: [
          {
            slug: '1',
            code: '1',
            name: 'Curtidas SMM',
            provider: { key: 'Instagram', name: 'Instagram' },
            cost: '1',
            currency: 'USD',
            priceBasis: 1000,
            minQuantity: 100,
            stock: 10000,
            canImport: true,
            available: true,
            imported: smmImported.has('1'),
          },
          {
            slug: '2',
            code: '2',
            name: 'Assinatura automática',
            provider: { key: 'Instagram', name: 'Instagram' },
            cost: '1',
            currency: 'USD',
            priceBasis: 1000,
            stock: 0,
            canImport: false,
            available: true,
            imported: false,
            unsupportedReason: 'Tipo Subscriptions ainda não compatível com a compra avulsa.',
          },
        ],
        total: 2,
        page: 1,
        limit: 25,
        providers: [{ key: 'Instagram', name: 'Instagram' }],
      };
    else if (url.pathname === '/api/smm-providers/smm-1/import') {
      req.postDataJSON().slugs.forEach((id: string) => smmImported.add(id));
      smmProviders = smmProviders.map((p) => ({
        ...p,
        _count: { products: smmImported.size, orders: 0 },
      }));
      body = { imported: req.postDataJSON().slugs.length };
    } else if (url.pathname === '/api/smm-providers/smm-1') {
      if (req.method() === 'DELETE') smmProviders = [];
      else {
        const { apiKey: _key, ...values } = req.postDataJSON();
        smmProviders = smmProviders.map((p) => ({ ...p, ...values }));
      }
      body = { ok: true };
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
    } else if (url.pathname === '/api/products/authorized-product' && req.method() === 'DELETE') {
      productDeleted = true;
      body = { slug: 'authorized-product', archived: true };
    } else if (url.pathname === '/api/products/authorized-product' && req.method() === 'PATCH') {
      productEdits = { ...productEdits, ...req.postDataJSON() };
      body = productEdits;
    } else if (url.pathname === '/api/products' && req.method() === 'GET')
      body = {
        data: productDeleted
          ? []
          : [
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
                ...productEdits,
                supplierName: 'Assinatura autorizada',
                name: productEdits.displayName ?? 'Assinatura autorizada',
              },
            ],
        total: productDeleted ? 0 : 1,
      };
    else if (url.pathname === '/api/settings') {
      if (req.method() === 'PUT') {
        for (const [key, value] of Object.entries(req.postDataJSON())) {
          if (key.startsWith('secret.')) secrets[key] = !!value;
          else settings[key] = value;
        }
        if (req.postDataJSON()['exchange.provider'] === 'bcb') refreshRate();
      }
      body = {
        values: settings,
        secrets,
        environment: {},
        rates,
        currentRate: rates[0] ?? null,
        templates: [{ key: 'summary', label: 'Resumo do pedido', text: 'Total: R$ {valor}' }],
      };
    } else if (url.pathname === '/api/exchange/refresh') body = refreshRate();
    else if (url.pathname === '/api/whatsapp/license') body = { status: 'active' };
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

test('cadastra provedor SMM, testa conexão, mantém chave salva e importa para uma categoria', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/');
  await navigate(page, 'Provedores SMM');
  await page.getByRole('button', { name: 'Novo provedor', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nome', { exact: true }).fill('Machine SMM');
  await dialog.getByLabel('URL da API SMM', { exact: true }).fill('https://machinesmm.com/api/v2');
  await dialog.getByLabel('Chave da API SMM', { exact: true }).fill('TEST-KEY-NEVER-REAL');
  const saved = page.waitForRequest(
    (req) => req.method() === 'POST' && req.url().endsWith('/smm-providers'),
  );
  await dialog.getByRole('button', { name: 'Salvar', exact: true }).click();
  expect((await saved).postDataJSON()).toMatchObject({
    currency: 'USD',
    active: true,
    url: 'https://machinesmm.com/api/v2',
  });
  await expect(page.getByText('Machine SMM', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Testar conexão', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Conexão válida · Saldo USD 100.00');
  await page.getByRole('button', { name: 'Editar Machine SMM', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Chave da API SMM', { exact: true })).toHaveValue('');
  await dialog.getByLabel('Nome', { exact: true }).fill('Machine SMM principal');
  await dialog.getByRole('button', { name: 'Salvar', exact: true }).click();
  await page.getByRole('button', { name: 'Importar serviços', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Importar serviços', exact: true });
  await expect(
    dialog.getByRole('checkbox', { name: 'Selecionar Assinatura automática', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Selecionar Curtidas SMM', exact: true }).check();
  await dialog
    .getByRole('combobox', { name: 'Categoria da loja', exact: true })
    .selectOption('cat-1');
  await page.screenshot({
    path: `test-results/smm-import-${test.info().project.name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
  const imported = page.waitForRequest(
    (req) => req.method() === 'POST' && req.url().endsWith('/smm-1/import'),
  );
  await dialog.getByRole('button', { name: 'Importar selecionados (1)', exact: true }).click();
  expect((await imported).postDataJSON()).toEqual({ slugs: ['1'], categoryId: 'cat-1' });
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('1 serviços · Chave configurada')).toBeVisible();
  await page.reload();
  await navigate(page, 'Provedores SMM');
  await expect(page.getByText('Machine SMM principal', { exact: true })).toBeVisible();
  await page.screenshot({
    path: `test-results/smm-providers-${test.info().project.name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
});

test('cria, edita e oculta categorias e atribui o produto sem mudar o fornecedor', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/');
  await navigate(page, 'Categorias');
  await page.getByRole('button', { name: 'Nova categoria', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nome', { exact: true }).fill('Serviços da loja');
  await dialog.getByLabel('Descrição da categoria', { exact: true }).fill('Meus serviços digitais');
  await dialog.getByLabel('Ordem de exibição', { exact: true }).fill('2');
  await dialog.getByRole('button', { name: 'Salvar', exact: true }).click();
  await page.getByRole('button', { name: 'Editar Serviços da loja', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nome', { exact: true }).fill('Minha categoria');
  await dialog.getByLabel('Exibir categoria no WhatsApp', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.getByText('Oculto / desativado', { exact: true })).toBeVisible();
  await page.screenshot({
    path: `test-results/categories-${test.info().project.name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await navigate(page, 'Produtos');
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await page.getByRole('tab', { name: 'Apresentação', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Categoria no WhatsApp', exact: true })
    .selectOption('cat-1');
  const changed = page.waitForRequest(
    (req) => req.method() === 'PATCH' && req.url().endsWith('/products/authorized-product'),
  );
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  expect((await changed).postDataJSON()).toMatchObject({
    categoryId: 'cat-1',
    authorizedResale: true,
  });
});

test('identifica preço SMM por mil e mantém o catálogo Partner junto dos serviços', async ({
  page,
}) => {
  await mockApi(page);
  await page.route('**/api/products?**', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            slug: 'smm-test-1',
            name: 'Curtidas da loja',
            source: 'SMM',
            smmProvider: { name: 'Machine SMM', active: true },
            category: { name: 'Instagram', active: true },
            categoryId: 'cat-1',
            costCurrency: 'USD',
            supplierRate: '1',
            priceBasis: 1000,
            minQuantity: 100,
            maxQuantity: 10000,
            active: true,
            visible: true,
            available: true,
            authorizedResale: true,
            markupPercent: '100',
            fixedMargin: '0',
            roundingStep: '0.01',
            volumeDiscountPercent: '0',
            volumeMinQuantity: 10000,
            quote: { unitSaleBrl: '10', estimatedProfitBrl: '5' },
          },
        ],
        total: 1,
      }),
    }),
  );
  await page.goto('/');
  await navigate(page, 'Produtos');
  await expect(page.getByText('Venda por 1.000 unidades', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await page.getByLabel('Preço manual por 1.000 (R$)', { exact: true }).fill('15');
  await page.screenshot({
    path: `test-results/smm-pricing-${test.info().project.name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page.getByRole('button', { name: 'Importar serviços', exact: true }).click();
  await expect(
    page
      .getByRole('dialog')
      .getByText('Escolha os produtos da Partner que deseja adicionar à sua loja.'),
  ).toBeVisible();
});

test('distingue modo salvo de cotação válida e consulta BCB em ambos os modos', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/');
  await navigate(page, 'Configurações');
  const card = page.locator('section.card').filter({ hasText: 'Cotação USD / BRL' });
  await expect(card.getByRole('status')).toContainText(
    'Nenhuma cotação válida. Vendas bloqueadas.',
  );
  await card.getByLabel('Modo da cotação').selectOption('bcb');
  await card.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(card.getByRole('status')).toContainText('Cotação válida: R$ 5,25 por USD');
  await page.reload();
  await navigate(page, 'Configurações');
  await expect(card.getByRole('status')).toContainText('Cotação válida: R$ 5,25 por USD');
  await card.getByLabel('Modo da cotação').selectOption('manual');
  await card.getByRole('button', { name: 'Salvar', exact: true }).click();
  const mutation = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/exchange/refresh' && request.method() === 'POST',
  );
  await card.getByRole('button', { name: 'Consultar BCB', exact: true }).click();
  await mutation;
  await expect(card.getByRole('status')).toContainText('Cotação válida: R$ 5,25 por USD');
  await expect(card.getByLabel('Modo da cotação')).toHaveValue('manual');
});

test('falha do BCB não mostra sucesso nem cotação válida e permite nova consulta', async ({
  page,
}) => {
  await mockApi(page);
  let fail = true;
  await page.route('**/api/exchange/refresh', async (route) => {
    if (!fail) return route.fallback();
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Cotação oficial indisponível.' }),
    });
  });
  await page.goto('/');
  await navigate(page, 'Configurações');
  const card = page.locator('section.card').filter({ hasText: 'Cotação USD / BRL' });
  await card.getByRole('button', { name: 'Consultar BCB', exact: true }).click();
  await expect(page.getByText('Cotação oficial indisponível.', { exact: true })).toBeVisible();
  await expect(card.getByRole('status')).toContainText(
    'Nenhuma cotação válida. Vendas bloqueadas.',
  );
  fail = false;
  await card.getByRole('button', { name: 'Consultar BCB', exact: true }).click();
  await expect(card.getByRole('status')).toContainText('Cotação válida: R$ 5,25 por USD');
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

test('edita nome e descrição, mantém entre abas e recarrega os textos salvos', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await navigate(page, 'Produtos');
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await page.getByRole('tab', { name: 'Apresentação', exact: true }).click();
  await page.getByLabel('Nome na loja', { exact: true }).fill('Gemini da NeverzShop');
  await page
    .getByLabel('Descrição no WhatsApp', { exact: true })
    .fill('Plano da loja.\nInstruções em português.');
  await page.getByRole('tab', { name: 'Preços', exact: true }).click();
  await page.getByRole('tab', { name: 'Apresentação', exact: true }).click();
  await expect(page.getByLabel('Nome na loja', { exact: true })).toHaveValue(
    'Gemini da NeverzShop',
  );
  await page.screenshot({
    path: `test-results/product-presentation-${test.info().project.name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
  const mutation = page.waitForRequest(
    (req) => req.method() === 'PATCH' && req.url().endsWith('/products/authorized-product'),
  );
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  expect((await mutation).postDataJSON()).toMatchObject({
    displayName: 'Gemini da NeverzShop',
    description: 'Plano da loja.\nInstruções em português.',
  });
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.reload();
  await navigate(page, 'Produtos');
  await expect(page.getByText('Gemini da NeverzShop', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await page.getByRole('tab', { name: 'Apresentação', exact: true }).click();
  await expect(page.getByLabel('Descrição no WhatsApp', { exact: true })).toHaveValue(
    'Plano da loja.\nInstruções em português.',
  );
  await page.getByLabel('Nome na loja', { exact: true }).fill('');
  await page.getByLabel('Descrição no WhatsApp', { exact: true }).fill('');
  const reset = page.waitForRequest(
    (req) => req.method() === 'PATCH' && req.url().endsWith('/products/authorized-product'),
  );
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  expect((await reset).postDataJSON()).toMatchObject({ displayName: null, description: null });
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByText('Assinatura autorizada', { exact: true })).toBeVisible();
});

test('exclui produto somente após confirmar e atualiza a lista', async ({ page }) => {
  await mockApi(page);
  const deletions: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'DELETE') deletions.push(req.url());
  });
  await page.goto('/');
  await navigate(page, 'Produtos');
  const button = page.getByRole('button', { name: 'Excluir Assinatura autorizada', exact: true });
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Excluir produto', exact: true });
  await expect(dialog.getByText('Assinatura autorizada', { exact: true })).toBeVisible();
  await expect(
    dialog.getByText(/Pedidos existentes, entregas e histórico serão preservados/),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  expect(deletions).toHaveLength(0);
  await expect(button).toBeVisible();
  await button.click();
  await page.screenshot({
    path: `test-results/product-delete-${test.info().project.name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
  const mutation = page.waitForRequest(
    (req) => req.method() === 'DELETE' && req.url().endsWith('/products/authorized-product'),
  );
  await dialog.getByRole('button', { name: 'Excluir produto', exact: true }).click();
  expect((await mutation).headers()['content-type']).toBeUndefined();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Nenhum registro encontrado')).toBeVisible();
  expect(deletions).toHaveLength(1);
});

test('erro ao excluir mantém produto e permite tentar novamente', async ({ page }) => {
  await mockApi(page);
  let failed = true;
  await page.route('**/api/products/authorized-product', async (route) => {
    if (!failed || route.request().method() !== 'DELETE') return route.fallback();
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Não foi possível excluir agora.' }),
    });
  });
  await page.goto('/');
  await navigate(page, 'Produtos');
  await page.getByRole('button', { name: 'Excluir Assinatura autorizada', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Excluir produto', exact: true });
  await dialog.getByRole('button', { name: 'Excluir produto', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Não foi possível excluir agora.');
  await expect(dialog.getByRole('button', { name: 'Excluir produto', exact: true })).toBeEnabled();
  failed = false;
  await dialog.getByRole('button', { name: 'Excluir produto', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Nenhum registro encontrado')).toBeVisible();
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
  const mainMenu = page.getByRole('combobox', { name: 'Menu principal', exact: true });
  await expect(mainMenu).toHaveValue('buttons');
  await mainMenu.selectOption('list');
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
  expect((await mutation).postDataJSON()['bot.mainMenuStyle']).toBe('list');
  await page.reload();
  await navigate(page, 'Configurações');
  await expect(field).toHaveValue('comprar, quero comprar, vendas');
  await expect(mainMenu).toHaveValue('list');
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
