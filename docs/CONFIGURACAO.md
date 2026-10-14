# Configuração

## Segredos

`ENCRYPTION_KEY` deve conter 64 caracteres hexadecimais (32 bytes). `WEBHOOK_SECRET` e `EVOLUTION_API_KEY` são gerados com 32 bytes. Mantenha `.env` em modo 0600; `secrets` em 0700. A senha inicial fica em `secrets/admin-password`, root:1000, modo 0640, para o container da migração ler sem executar como root. Execuções repetidas não redefinem senhas existentes.

Não troque a chave de criptografia sem um processo de recifrar os dados. Backup do banco sem essa chave não permite recuperar entregas, histórico ou credenciais. O backup criptografado inclui `.env`; guarde a passphrase fora da VPS também.

Chaves Partner/Expay configuradas no painel substituem os valores de ambiente e ficam cifradas no banco. GET de configurações informa somente presença. O instalador pode provisioná-las por arquivos protegidos em `secrets`, montados somente no processo de configuração inicial, sem sobrescrever configurações existentes. Credenciais da Evolution são fornecidas por ambiente para manter o webhook e o container coerentes. Para rotação da chave Evolution/webhook, altere `.env`, recrie os serviços e reconfigure a instância usando a configuração oficial de webhook; não publique o manager Evolution.

## Partner API

Base: `https://ggsoma.store/api/partner/v1`, header Bearer somente nas rotas protegidas. `/health` é público. O serviço implementa balance, providers, products, detalhe por slug/id, create order, list/detail orders e usage. Produtos são identificados por slug; sincronização faz upsert e preserva regras locais. Ausentes ficam indisponíveis sem remover histórico.

Limites em `.env`: `PARTNER_REQUESTS_PER_MINUTE` e `PARTNER_ORDERS_PER_MINUTE`. Planos documentados: limited 10/2, standard 60/10, premium 300/50. As contagens são compartilhadas somente entre os processos desta instalação; outras aplicações com a mesma chave também consomem o limite do fornecedor. Prefira uma chave própria para esta instalação.

Produtos entram com `authorizedResale=false`. O proprietário precisa conferir origem e autorização, além de definir preço/margem e visibilidade. Isso evita oferecer credenciais não autorizadas por padrão. O catálogo pode conter descrição HTML: o bot remove tags, e o painel não renderiza HTML recebido como markup.

## Pix

O gateway escolhido para esta operação é **Expay Brasil**. Use a chave da API atual documentada em [expaybrasil.com/docs](https://expaybrasil.com/docs): `X-API-Key`, base `https://expaybrasil.com/api/v1`, criação `POST /charges` com `Idempotency-Key` e consulta `GET /charges/{UUID}`. O contrato consultado está em [references/expay-openapi.json](references/expay-openapi.json), obtido em 14/10/2026. A documentação antiga em Readme.io usa outro contrato (`merchant_key`/purchase/link) e não é usada por este adaptador.

O cliente fornece e-mail e CPF válido. O nome vem do cadastro do cliente. A referência local e o corpo são congelados antes da criação, e reenvios usam a mesma chave idempotente. `amount` é em reais, com duas casas, não centavos. O vencimento é o `expires_at` retornado pela Expay; se ausente, o bot não inventa uma data de expiração.

Informe a chave no instalador ou selecione `expay` em Configurações → Gateway Pix e salve a chave. `EXPAY_API_KEY`/`EXPAY_STORE_ID` também são aceitos por ambiente. ID da loja é opcional e só é enviado se configurado. Sem credenciais, cobranças são recusadas.

Configure na loja Expay `https://SEU_DOMINIO/webhooks/pix/expay`. O OpenAPI atual não especifica uma assinatura HMAC de saída; o aplicativo não inventa uma. O callback apenas agenda consulta de uma cobrança conhecida. Valor, referência e status recebidos no callback nunca aprovam pagamentos. O worker consulta a API autenticada, confere UUID, referência local, BRL, Pix e valor exato e só credita em `paid`. Formatos de notificação não reconhecidos são ignorados e a consulta periódica independente mantém a confirmação. A rotina consulta cobranças recentes a cada minuto durante sete dias; mantenha o webhook configurado para eventos posteriores.

O contrato atual não expõe um indicador de ambiente de teste. A API é fixada no endpoint HTTPS oficial; um eventual `live_mode=false` é recusado em produção. Credenciais e comportamento reais da sua conta precisam ser homologados. O adaptador Mercado Pago anterior continua disponível por compatibilidade, com validação HMAC própria, sem participar da configuração Expay.

Aprovação depende da consulta ao provedor. Prints e mensagens de clientes não creditam saldo. Reembolso de depósito no provedor é enviado à revisão administrativa; devolução em dinheiro não é feita pelo endpoint de estorno de pedido, que devolve **saldo local**.

## Cotação

Sem taxa válida, vendas são bloqueadas. Manual: informe valor real, justificativa/fonte e validade de 1 a 168 horas. BCB: busca último boletim PTAX de fechamento de venda USD publicado nos últimos sete dias; a taxa vence quatro dias depois do boletim. Falhas não inventam taxa nem estendem automaticamente uma taxa vencida. PTAX é referência comercial escolhida pelo operador; a operação pode configurar taxa manual que reflita seu financiamento real.

## Domínio e rede

Caddy publica HTTPS automático para o domínio. DNS A/AAAA precisa apontar para a mesma VPS e 80/443 devem estar acessíveis no firewall externo. Não crie portas públicas para PostgreSQL, Redis ou Evolution. A rede interna é criada pelo Compose; não há redes externas pressupostas.

Docker pode contornar regras UFW para portas publicadas; esta composição publica somente HTTP/HTTPS. Em VPS com outros projetos Docker, revise seus mapeamentos e as regras DOCKER-USER. O instalador preserva a porta SSH ativa antes de habilitar UFW.

Referências primárias usadas:

- [Código oficial Evolution 2.3.7](https://github.com/evolution-foundation/evolution-api/tree/2.3.7), especialmente rotas `instance.router.ts`, `sendMessage.router.ts`, DTOs e migrations.
- [Expay Brasil — documentação atual](https://expaybrasil.com/docs) e [OpenAPI](https://expaybrasil.com/docs/openapi.json).
- [Mercado Pago Pix via Payments](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/integration-configuration/integrate-pix).
- [Mercado Pago — autenticação de webhooks](https://www.mercadopago.com.br/developers/en/docs/links-and-debts/additional-content/your-integrations/notifications/webhooks).
- [BCB — documentação PTAX](https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/documentacao).
- [Docker — Ubuntu](https://docs.docker.com/engine/install/ubuntu/).
- [Caddy — HTTPS automático](https://caddyserver.com/docs/automatic-https).
