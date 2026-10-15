# Configuração

Provedores SMM, categorias da loja, tipos avulsos e preços por 1.000/pacote: [guia SMM](SMM.md). As configurações da Partner abaixo continuam independentes.

## Segredos

`ENCRYPTION_KEY` deve conter 64 caracteres hexadecimais (32 bytes). `WEBHOOK_SECRET` e `EVOLUTION_API_KEY` são gerados com 32 bytes. Mantenha `.env` em modo 0600; `secrets` em 0700. A senha inicial fica em `secrets/admin-password`, root:1000, modo 0640, para o container da migração ler sem executar como root. Execuções repetidas não redefinem senhas existentes.

Não troque a chave de criptografia sem um processo de recifrar os dados. Backup do banco sem essa chave não permite recuperar entregas, histórico ou credenciais. O backup criptografado inclui `.env`; guarde a passphrase fora da VPS também.

Chaves Partner/Expay configuradas no painel substituem os valores de ambiente e ficam cifradas no banco. GET de configurações informa somente presença. O instalador pode provisioná-las por arquivos protegidos em `secrets`, montados somente no processo de configuração inicial, sem sobrescrever configurações existentes. Credenciais da Evolution são fornecidas por ambiente para manter o webhook e o container coerentes. Para rotação da chave Evolution/webhook, altere `.env`, recrie os serviços e reconfigure a instância usando a configuração oficial de webhook; não publique o manager Evolution.

## Partner API

Base: `https://ggsoma.store/api/partner/v1`, header Bearer somente nas rotas protegidas. `/health` é público. O serviço implementa balance, providers, products, detalhe por slug/id, create order, list/detail orders e usage. Produtos são identificados por slug. **Produtos → Importar serviços** consulta uma prévia sem gravar produtos: permite buscar por nome/código/slug, filtrar fornecedor, paginar e selecionar até 100 serviços por importação. A seleção permanece ao trocar página ou filtro. Produtos já importados são identificados na janela.

**Sincronizar importados** e a rotina periódica atualizam somente os serviços existentes, preservando regras locais. Novos serviços do fornecedor aguardam seleção manual. Ausentes ficam indisponíveis sem remover histórico. A importação selecionada não desativa produtos fora da seleção, nem redefine preço, margem, visibilidade ou autorização existentes. Importação e auditoria são gravadas na mesma transação. Consultas ao catálogo não fazem compras nem consomem saldo no fornecedor.

O catálogo real pode misturar **USD e USDT**, embora o exemplo do HTML informe USD. A leitura preserva a moeda original e exibe todos os serviços; um item USDT não bloqueia os demais. Esta versão importa e vende somente produtos **USD**, compatíveis com a cotação e a contabilização existentes. Itens USDT aparecem identificados e indisponíveis para seleção; não existe conversão automática USDT=USD. Seleções enviadas diretamente à API com moeda não suportada são recusadas sem importação parcial. Caso um produto já cadastrado mude de moeda no fornecedor, a sincronização o deixa indisponível sem sobrescrever seu custo USD anterior; a compra também confere a moeda antes de reservar saldo e antes do primeiro envio ao fornecedor.

Limites em `.env`: `PARTNER_REQUESTS_PER_MINUTE` e `PARTNER_ORDERS_PER_MINUTE`. Planos documentados: limited 10/2, standard 60/10, premium 300/50. As contagens são compartilhadas somente entre os processos desta instalação; outras aplicações com a mesma chave também consomem o limite do fornecedor. Prefira uma chave própria para esta instalação.

Produtos entram com `authorizedResale=false`. O proprietário precisa conferir origem e autorização, além de definir preço/margem e visibilidade. Em **Editar → Apresentação**, `displayName` define o nome na loja (vazio usa o nome do fornecedor) e `description` define a descrição enviada no WhatsApp (vazia não exibe descrição). Ambos são locais e sobrevivem à sincronização. O bot não envia automaticamente a descrição externa e remove tags da descrição local; o painel não renderiza HTML como markup.

Excluir um produto preenche `archivedAt` e desativa a listagem, sem remover os registros associados a pedidos. Apenas uma importação explícita restaura o serviço, como rascunho não autorizado. A migração 202610150005 adiciona as colunas opcionais `archivedAt` e `displayName`; não remove dados existentes.

O modo `bot.messageStyle=interactive` usa `bot.mainMenuStyle=buttons` por padrão: três ações visíveis no menu inicial e listas para categorias/produtos/carteira. `bot.mainMenuStyle=list` mantém as seis ações na lista inicial. `text` mantém a navegação por números. O aplicativo do WhatsApp controla a rolagem e a abertura de listas.

Depois de gerar um Pix, a conversa entra em `IDLE` e exige uma das palavras de `bot.activationKeywords` para voltar ao atendimento. A conciliação financeira funciona independentemente desse estado. Durante etapas ativas, o bot aceita botões e entradas da etapa, ignorando conversas comuns sem renovar a sessão. Saudações não configuradas não são tratadas como comandos implícitos de reinício.

## Pix

O gateway escolhido para esta operação é **Expay Brasil**. Use a chave da API atual documentada em [expaybrasil.com/docs](https://expaybrasil.com/docs): `X-API-Key`, base `https://expaybrasil.com/api/v1`, criação `POST /charges` com `Idempotency-Key` e consulta `GET /charges/{UUID}`. O contrato consultado está em [references/expay-openapi.json](references/expay-openapi.json), obtido em 14/10/2026. A documentação antiga em Readme.io usa outro contrato (`merchant_key`/purchase/link) e não é usada por este adaptador.

Na Expay, o cliente informa somente o valor: e-mail e CPF não são solicitados nem inventados. O contrato oficial de `POST /charges` torna `customer` e seus campos opcionais para Pix; o nome enviado vem do cadastro do cliente. O Mercado Pago mantém sua coleta de e-mail e CPF válido, conforme os requisitos desse adaptador. Sessões Expay antigas que aguardavam e-mail/CPF continuam com o valor já informado na próxima resposta.

O bot envia o resumo da cobrança, o QR Code (se fornecido pelo gateway) e, por último, uma mensagem contendo **somente o código Pix copia e cola**. Toque e segure essa mensagem no WhatsApp e selecione **Copiar**. O código não é misturado com menus, legendas ou instruções. A outbox grava as mensagens na mesma transação e com chaves únicas para evitar duplicação ao processar novamente o webhook.

A referência local e o corpo são congelados antes da criação, e reenvios usam a mesma chave idempotente. `amount` é em reais, com duas casas, não centavos. O vencimento é o `expires_at` retornado pela Expay; se ausente, o bot não inventa uma data de expiração.

Informe a chave no instalador ou selecione `expay` em Configurações → Gateway Pix e salve a chave. `EXPAY_API_KEY`/`EXPAY_STORE_ID` também são aceitos por ambiente. ID da loja é opcional e só é enviado se configurado. Sem credenciais, cobranças são recusadas.

Configure na loja Expay `https://SEU_DOMINIO/webhooks/pix/expay`. O OpenAPI atual não especifica uma assinatura HMAC de saída; o aplicativo não inventa uma. O callback apenas agenda consulta de uma cobrança conhecida. Valor, referência e status recebidos no callback nunca aprovam pagamentos. O worker consulta a API autenticada, confere UUID, referência local, BRL, Pix e valor exato e só credita em `paid`. Formatos de notificação não reconhecidos são ignorados e a consulta periódica independente mantém a confirmação. A rotina consulta cobranças recentes a cada minuto durante sete dias; mantenha o webhook configurado para eventos posteriores.

O contrato atual não expõe um indicador de ambiente de teste. A API é fixada no endpoint HTTPS oficial; um eventual `live_mode=false` é recusado em produção. Credenciais e comportamento reais da sua conta precisam ser homologados. O adaptador Mercado Pago anterior continua disponível por compatibilidade, com validação HMAC própria, sem participar da configuração Expay.

Aprovação depende da consulta ao provedor. Prints e mensagens de clientes não creditam saldo. Reembolso de depósito no provedor é enviado à revisão administrativa; devolução em dinheiro não é feita pelo endpoint de estorno de pedido, que devolve **saldo local**.

## Cotação

Em **Configurações → Cotação USD / BRL**, salvar **BCB · PTAX venda** consulta e grava um fechamento imediatamente. Se a consulta falhar, a preferência BCB permanece salva, mas a operação retorna erro explícito de consulta. O painel indica separadamente a existência de **cotação válida**, seu valor e vencimento. **Consultar BCB** faz uma consulta real mesmo quando o modo de renovação selecionado é manual, sem alterar esse modo. Uma preferência salva não substitui um registro de cotação válido.

A consulta OData codifica espaços com `%20`. O serviço Olinda responde HTTP 400 ao filtro com espaços codificados como `+`. Respostas HTTP inválidas, formato inesperado, data inválida e fechamento vencido não geram cotação. Falha de transporte não inventa valor nem estende validade.

Sem taxa válida, vendas são bloqueadas. Manual: informe valor real, justificativa/fonte e validade de 1 a 168 horas. BCB: busca último boletim PTAX de fechamento de venda USD publicado nos últimos sete dias; a taxa vence quatro dias depois do boletim. Falhas não inventam taxa nem estendem automaticamente uma taxa vencida. PTAX é referência comercial escolhida pelo operador; a operação pode configurar taxa manual que reflita seu financiamento real.

## Domínio e rede

Caddy publica HTTPS automático para o domínio. DNS A/AAAA precisa apontar para a mesma VPS e 80/443 devem estar acessíveis no firewall externo. Não crie portas públicas para PostgreSQL, Redis ou Evolution. A rede interna é criada pelo Compose; não há redes externas pressupostas.

Docker pode contornar regras UFW para portas publicadas; esta composição publica somente HTTP/HTTPS. Em VPS com outros projetos Docker, revise seus mapeamentos e as regras DOCKER-USER. O instalador preserva a porta SSH ativa antes de habilitar UFW.

Referências primárias usadas:

- [Código oficial Evolution 2.4.0-rc2](https://github.com/evolution-foundation/evolution-api/tree/2.4.0-rc2), especialmente rotas `instance.router.ts`, `sendMessage.router.ts`, DTOs, migrations e ativação em `src/licensing`.
- [Expay Brasil — documentação atual](https://expaybrasil.com/docs) e [OpenAPI](https://expaybrasil.com/docs/openapi.json).
- [Mercado Pago Pix via Payments](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/integration-configuration/integrate-pix).
- [Mercado Pago — autenticação de webhooks](https://www.mercadopago.com.br/developers/en/docs/links-and-debts/additional-content/your-integrations/notifications/webhooks).
- [BCB — documentação PTAX](https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/documentacao).
- [Docker — Ubuntu](https://docs.docker.com/engine/install/ubuntu/).
- [Caddy — HTTPS automático](https://caddyserver.com/docs/automatic-https).
