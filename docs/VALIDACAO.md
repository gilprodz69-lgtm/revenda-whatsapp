# Registro de validação

Ambiente de desenvolvimento: Windows, Node 22.22.0. Docker Engine/WSL não estão instalados no host; foi usado somente o CLI Compose para validar a configuração. Validação em Ubuntu/VPS e integrações reais ainda pendentes.

Verificações executadas em 14/10/2026:

| Verificação | Resultado |
| --- | --- |
| TypeScript backend e painel | Aprovado |
| Build de produção Fastify/React | Aprovado |
| Testes unitários | 42 aprovados |
| Testes de integração | 23 aprovados |
| Interface desktop e celular | 8 aprovados com Playwright e Chrome instalado |
| API/worker em processos separados | Smoke aprovado: webhook → Redis/BullMQ → conversa → outbox → envio |
| Migrations | 3 aplicadas com sucesso em PostgreSQL 16.10 isolado |
| Dependências npm | `npm audit`: zero vulnerabilidades reportadas na execução |
| Docker Compose | Configuração validada pelo CLI Compose 2.39.4, sem expor ambiente |
| Scripts Linux | Sintaxe Bash validada por parser shfmt 3.12.0 |
| Imagens de terceiros | Tags/digests conferidos no registry Docker Hub |

Integração local usou PostgreSQL 16.10 e um port Windows Redis 7.4.6/MSYS2 em processos temporários, portas de loopback 15432/16379 e banco `revenda_test`/Redis DB 15. O workflow usa as imagens oficiais Linux. Compras Partner, gateway e envio Evolution foram mocks explícitos; nenhum pagamento ou pedido externo real foi executado.

Os testes verificaram concorrência/idempotência do ledger, saldo insuficiente, estoque, sincronização sem perder regras, timeout externo, reconciliação com mesmo corpo/ID, entrega em lote, falha de envio, desconexão, estorno, conversa persistente, navegação, takeover humano, CSRF/RBAC, HMAC Pix e fila BullMQ real. O smoke iniciou API e worker reais; os serviços externos foram servidores HTTP de teste locais.

Total: 73 testes automatizados aprovados (42 unitários + 23 de integração + 8 de interface), além do smoke de processos separados. A solicitação de conexão/pareamento no painel também foi verificada como POST protegido por CSRF; a chamada interna segue o GET oficial da Evolution.

Pendente: build/boot efetivo dos containers, instalação limpa Ubuntu 24.04, emissão de HTTPS, backup/restore em VPS, execução do workflow GitHub e testes com credenciais reais Partner/Mercado Pago/WhatsApp. O CLI de configuração não substitui esses testes. Esta entrega não foi publicada nem implantada em uma conta externa.
