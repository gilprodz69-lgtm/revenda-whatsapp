# Homologação e limites da entrega

Esta versão não apresenta integrações reais sem credenciais como concluídas. O código não contém mocks ativáveis em produção. As contas externas e domínio ainda devem ser configurados pelo operador.

## Verificação local

- TypeScript: `npm run typecheck`.
- Build backend/painel: `npm run build`.
- Testes unitários: `npm test`.
- Auditoria de dependências: `npm audit --audit-level=moderate`.
- Integração: PostgreSQL/Redis isolados, migrations completas, transações reais com externos mockados.
- UI: Playwright, respostas de API explicitamente mockadas; sem transações externas.

O relatório da execução local é registrado em [VALIDACAO.md](VALIDACAO.md). Os resultados no Ubuntu estão nas [execuções do workflow GitHub](https://github.com/gilprodz69-lgtm/revenda-whatsapp/actions/workflows/ci.yaml). A CI também constrói as imagens e inicia PostgreSQL, Redis, migrations, administrador, API, worker, painel e Evolution em ambiente descartável. A validação da configuração Caddy não substitui emissão de certificado com domínio real.

## Critérios antes de abrir vendas

1. Em VPS Ubuntu 24.04 limpa, execute install; confira migrations das duas aplicações, usuários distintos, ausência de portas 5432/6379/8080 públicas e HTTPS válido.
2. Execute install novamente: confirme preservação das carteiras, contas, catálogo e sessões.
3. Configure credenciais de homologação e catálogo autorizado. Teste saudação, fornecedores, produtos, quantidade, volta/menu/cancelamento e timeout de conversa.
4. Teste a cobrança Pix com cenário permitido pelo provedor: pendente, expirada, aprovada e notificações repetidas. Produção recusa pagamentos `live_mode=false`. Não autorize compra real sem acordo explícito de teste financeiro.
5. Com autorização do proprietário, faça uma compra simples e uma em lote; confira custos, cotação, captura, linhas e destinatário. Não simule aprovação em runtime.
6. Reinicie worker durante pedido, indisponibilize API/WhatsApp temporariamente e confira reconciliação/outbox. Interrompa envio após resposta incerta e confirme ausência de retry automático.
7. Teste backup/restore em VPS secundária. Confira descriptografia, ledger, logins, sessões, QR, entrega pendente e conciliação do snapshot.
8. Teste atualização e rollback com release compatível. Consulte limitações de downgrade no documento de operação.

## Recursos com escopo explícito

- Gateway: Expay Brasil conforme a API atual `/api/v1/charges`; Mercado Pago mantido como adaptador de compatibilidade. EfíBank não está implementado.
- Pagamento: depósito Pix na carteira e compra com saldo. Não há cobrança Pix direta vinculada a um pedido.
- Atendimento: takeover por cliente, mensagens humanas pelo painel e retomada; horários são texto configurável. Não há escalonamento automático por calendário de plantão.
- Templates: mensagens de cada etapa editáveis pelo painel, com placeholders validados. Dados financeiros/entrega e opções de navegação são acrescentados pelo sistema.
- Backups: automação host/timer e scripts, sem download remoto ou restauração pelo navegador.
- Câmbio: manual e BCB/PTAX; outros provedores exigem adaptador.
- Segurança: RBAC em código com três papéis; não há editor arbitrário de permissões ou MFA.
- QR, reconexão e pareamento precisam de conta WhatsApp e teste contra a versão fixada. O código respeita as rotas do upstream; compatibilidade futura do WhatsApp/Baileys não pode ser garantida por teste offline.
- Instalador e imagens: arquivos prontos para teste, sem alegação de execução numa VPS limpa até sua homologação.

Considere estes pontos no aceite. O sistema tem componentes funcionais e testes; os itens acima não devem ser anunciados como recursos implementados além do seu escopo descrito.
