# Revenda — loja WhatsApp

Monorepo de venda por WhatsApp com Fastify, React, PostgreSQL/Prisma, Redis/BullMQ, Evolution API **2.4.0-rc2** e Partner API v1. Interface e atendimento em português brasileiro. A Evolution usa uma versão candidata solicitada pelo operador e exige ativação oficial, disponível na aba WhatsApp do painel.

O contrato do fornecedor está em [docs/references/partner-api-docs.html](docs/references/partner-api-docs.html), fornecido pelo proprietário do projeto. Não há produtos fictícios, pagamento aprovado por comprovante ou gateway de demonstração no runtime.

## Instalação na VPS

Ubuntu Server **24.04 LTS x86_64**, 2 vCPUs, 4 GB de RAM e 15 GB livres. O repositório é **público**, e a instalação não pede login ou token GitHub. Na sessão SSH da VPS, copie e execute **um único comando**:

```bash
bash -o pipefail -ec 'privilege=(); if (( EUID != 0 )); then privilege=(sudo --preserve-env=SSH_CONNECTION); fi; if ! command -v curl >/dev/null; then "${privilege[@]}" apt-get update -qq; "${privilege[@]}" apt-get install -y -qq curl ca-certificates; fi; curl -fsSL --retry 3 --connect-timeout 15 https://raw.githubusercontent.com/gilprodz69-lgtm/revenda-whatsapp/main/scripts/bootstrap.sh | "${privilege[@]}" bash'
```

O comando funciona como root ou com um usuário que tenha sudo e instala curl se necessário. O bootstrap busca a release estável mais recente, e os arquivos ficam em `/opt/revenda-whatsapp`. Em uma instalação existente, o mesmo comando executa a atualização com backup, preservando domínio, senhas, chaves, banco, sessões do WhatsApp e configurações do painel. Se a versão já estiver instalada, apenas verifica a saúde dos serviços.

O instalador solicita domínio, e-mail para HTTPS, e-mail do administrador e senha inicial com confirmação. Também pede as chaves Partner/Expay sem exibi-las; Enter permite configurar depois. A chave Expay ativa o Pix no primeiro provisionamento. Mostra o IPv4 público e o registro DNS **A** a criar; você pode fazer o apontamento enquanto a instalação continua. Instala Docker pelo repositório oficial, constrói os serviços, aplica migrations, preserva a porta SSH no UFW e configura backup criptografado diário. HTTPS é emitido automaticamente quando o DNS e as portas 80/443 estiverem acessíveis. Execuções repetidas preservam `.env`, bancos, volumes e contas existentes.

O mesmo comando está em [INSTALL_VPS.txt](INSTALL_VPS.txt). Consulte o [guia de instalação](docs/INSTALACAO_VPS.md) para apontamentos e verificação após o DNS.

No painel:

1. Configure a chave da Partner API e os limites do seu plano. O saldo do fornecedor é em USD e precisa ser financiado na conta Telegram do fornecedor.
2. Escolha cotação manual real ou BCB/PTAX; sem cotação válida, vendas ficam bloqueadas.
3. Em **Produtos → Importar serviços**, escolha os produtos da Partner e clique em **Importar selecionados**. Em **Editar → Apresentação**, personalize nome e descrição; em **Preços**, defina o valor; em **Disponibilidade**, autorize a revenda. **Sincronizar importados** mantém textos e regras locais. **Excluir** retira o produto do catálogo, preservando pedidos e entregas.
4. Na aba WhatsApp, conclua **Iniciar ativação → Abrir cadastro oficial → Confirmar ativação** da Evolution. Depois crie/conecte a instância pelo QR Code ou pareamento. Instâncias existentes são preservadas. Em Configurações, escolha **Botões e listas**, defina as palavras-chave e selecione o menu principal com três botões visíveis ou uma lista completa. Categorias e produtos usam listas.
5. Para depósitos, confira **Expay Brasil** e a chave da API atual em Configurações. Se sua operação exigir, informe o ID da loja. Configure na loja Expay o webhook `https://SEU_DOMINIO/webhooks/pix/expay`. O sistema também consulta as cobranças automaticamente e só credita saldo após confirmação autenticada de valor, referência, moeda e método.
6. Execute os critérios de [homologação](docs/HOMOLOGACAO.md) antes de abrir vendas.

O cliente adiciona saldo por Pix, recebe crédito confirmado pelo gateway e então confirma a compra com a carteira. Compra direta por Pix atrelado a um pedido não é oferecida nesta versão: o depósito e o pedido possuem identidades separadas e auditáveis.

## Desenvolvimento

Node **22.22.0**, npm com lockfile versionado. A Evolution executa em seu próprio container com o runtime fornecido pelo upstream.

```bash
npm ci
npm run db:generate
npm run typecheck
npm test
npm run build
```

Para executar backend/worker, configure um `.env` na raiz com PostgreSQL, Redis e os segredos descritos em [.env.example](.env.example). Em desenvolvimento: `NODE_ENV=development`, `APP_ORIGIN=http://localhost:5173`, `TRUST_PROXY=0`. Use credenciais de teste para pagamentos. Migre o banco e crie o administrador com `ADMIN_EMAIL` e `ADMIN_PASSWORD_FILE` (arquivo legível somente pelo usuário do processo).

```bash
npm run db:migrate
npm run dev:api
npm run dev:admin
# Terminal adicional, com o backend já construído:
npm run worker -w apps/api
```

O Vite encaminha `/api` ao backend; o cookie de sessão permanece na mesma origem. Os testes unitários não exigem serviços. Testes de integração **exigem banco isolado chamado `revenda_test`** e Redis isolado (DB 15 por padrão):

```bash
DATABASE_URL=postgresql://postgres:test@localhost:5432/revenda_test \
REDIS_URL=redis://localhost:6379/15 npm run test:integration
```

Não execute os testes de integração em banco de produção: eles truncam somente o banco de teste após verificar seu nome. Na CI, migrations são aplicadas antes dos testes. Compras, gateway e WhatsApp externos são substituídos explicitamente por mocks nos testes, nunca no aplicativo em produção.

Após build, `npm run test:runtime` inicia API e worker reais com Partner/Evolution mockados por HTTP local e verifica webhook, fila e envio persistido. Exige `revenda_test` e Redis DB 15. O teste de interface é `npm run test:e2e` após `npx playwright install chromium`; para usar Chrome já instalado, defina `PLAYWRIGHT_CHANNEL=chrome`.

## Estrutura e operação

```text
apps/api/       API REST, bot, worker, integrações, schema e migrations
apps/admin/     Painel React/Vite/Tailwind
infra/          Proxy, nginx, inicialização dos bancos e Evolution
scripts/        Instalação, backup, restauração, atualização e health checks
docs/           Arquitetura, configuração, operação e homologação
.github/        Testes e builds automatizados
```

Consulte [arquitetura](docs/ARQUITETURA.md), [configuração](docs/CONFIGURACAO.md), [operação e troubleshooting](docs/OPERACAO.md) e [situação da validação](docs/HOMOLOGACAO.md).

O repositório contém implementação instalável e testes. A instalação numa VPS limpa, emissão real de certificado e integrações com contas reais precisam de homologação no ambiente de destino; o desenvolvimento local não constitui certificação de produção. A documentação de homologação registra exatamente os checks executados e os pendentes.

Licença MIT para o código desta aplicação. Evolution e demais componentes mantêm suas próprias licenças; a documentação Partner fornecida é material de referência do respectivo fornecedor.
