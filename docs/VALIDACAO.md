# Registro de validação

## Versão 1.0.2

A [execução no Ubuntu 24.04](https://github.com/gilprodz69-lgtm/revenda-whatsapp/actions/runs/38653318295), commit de código `fbb950e`, foi aprovada em 14/10/2026: 78 testes unitários, 36 de integração e 18 de interface desktop/celular (132 no total), TypeScript, build, auditoria npm, scripts, updater, imagens Docker e inicialização dos serviços. O teste de processos reais enviou duas respostas interativas em 80 ms e 67 ms, sem varredura periódica nem duplicação; a Evolution de envio foi um servidor HTTP simulado.

O teste Docker iniciou a imagem oficial 2.3.7, gravou um registro no banco `evolution` e um arquivo no volume das instâncias, trocou para a imagem oficial **2.4.0-rc2** fixada por digest e confirmou ambos após as migrations e a inicialização com saúde. Também verificou `/license/status` e o bloqueio `LICENSE_REQUIRED` antes da ativação. São dados de teste que comprovam reutilização do banco/volume; o cenário não pareou uma conta WhatsApp real nem realizou cadastro/ativação real.

Os testes novos cobrem botões/listas/native flow, paginação, rejeição de menus antigos, confirmação única da compra, alternativa em texto, timeout sem repetição e preservação da outbox durante ativação pendente. O fluxo de ativação do painel foi verificado com endpoints simulados, autorização de proprietário, CSRF, auditoria sem código secreto e remoção do código da URL. No admin, os testes verificaram persistência do tema, seções dos modais, conservação dos valores, validação de campos em seções ocultas, foco contido e Escape. As capturas de desktop/celular em tema claro/escuro foram inspecionadas localmente.

Pendente na instalação do operador: aplicar a release, concluir o cadastro oficial da Evolution e testar a renderização dos botões/listas em outro aparelho/número. A rc2 é uma versão candidata escolhida explicitamente pelo operador. Nenhuma VPS, conta real de cliente ou pagamento real foi acessado nessa atualização.

## Versão 1.0.1

A [execução de 14/10/2026 no Ubuntu 24.04](https://github.com/gilprodz69-lgtm/revenda-whatsapp/actions/runs/38649960736), commit de código `6418ac5`, passou: 63 testes unitários, 32 de integração e 12 de interface desktop/celular (107 no total), TypeScript, build, auditoria npm, scripts Linux, imagens Docker e inicialização com saúde de PostgreSQL, Redis, migrations, administrador, API, worker, painel e Evolution. A configuração Caddy também foi validada.

O smoke iniciou API e worker reais com PostgreSQL/Redis e desativou a varredura de recuperação. Duas respostas foram enviadas em 82 ms e 67 ms, sem duplicar os envios quando o webhook foi repetido. Evolution e Partner foram servidores HTTP simulados; esses números não medem a latência do WhatsApp real.

Os cenários novos verificam grupos com remetente alternativo privado, rejeição no webhook e no worker, palavras-chave/frases, continuidade numérica e expiração de sessão, preservação de saudações antigas e edição autenticada no admin. O teste do updater usa um repositório Git descartável e serviços simulados: verifica backup antes da troca de versão, conservação de arquivos que representam configuração/dados/sessão/segredos, repetição da versão instalada e rejeição de alterações locais. Não substitui um teste de restauração do backup real na VPS. Nenhuma VPS foi acessada nesta atualização.

## Validação inicial da versão 1.0.0

Ambiente de desenvolvimento: Windows, Node 22.22.0. Docker Engine/WSL não estão instalados no host; localmente foi usado o CLI Compose para validar a configuração. Builds e inicialização de containers também são verificados pelo workflow no Ubuntu 24.04 do GitHub. Instalação numa VPS limpa e integrações com contas reais continuam pendentes.

Verificações executadas em 14/10/2026:

| Verificação | Resultado |
| --- | --- |
| TypeScript backend e painel | Aprovado |
| Build de produção Fastify/React | Aprovado |
| Testes unitários | 52 aprovados localmente e no GitHub |
| Testes de integração | 29 aprovados no Ubuntu/GitHub; 23 cenários iniciais também executados localmente |
| Interface desktop e celular | 10 aprovados com Playwright: Chrome local e Chromium no GitHub |
| API/worker em processos separados | Smoke aprovado: webhook → Redis/BullMQ → conversa → outbox → envio |
| Migrations | 3 aplicadas com sucesso em PostgreSQL 16.10 isolado |
| Dependências npm | `npm audit`: zero vulnerabilidades reportadas na execução |
| Docker Compose | Configuração local aprovada e boot efetivo dos serviços aprovado no Ubuntu/GitHub |
| Scripts Linux | Parser shfmt local, Bash real e testes de domínio/portas/SSH aprovados no GitHub |
| Imagens de terceiros | Tags/digests conferidos no registry Docker Hub |

Integração local usou PostgreSQL 16.10 e um port Windows Redis 7.4.6/MSYS2 em processos temporários, portas de loopback 15432/16379 e banco `revenda_test`/Redis DB 15. O workflow usa as imagens oficiais Linux. Compras Partner, gateway e envio Evolution foram mocks explícitos; nenhum pagamento ou pedido externo real foi executado.

Os testes verificaram concorrência/idempotência do ledger, saldo insuficiente, estoque, sincronização sem perder regras, timeout externo, reconciliação com mesmo corpo/ID, entrega em lote, falha de envio, desconexão, estorno, conversa persistente, navegação, takeover humano, CSRF/RBAC, HMAC Pix e fila BullMQ real. O smoke iniciou API e worker reais; os serviços externos foram servidores HTTP de teste locais.

Total: 91 testes automatizados aprovados (52 unitários + 29 de integração + 10 de interface), além do smoke de processos separados. A solicitação de conexão/pareamento no painel também foi verificada como POST protegido por CSRF; a chamada interna segue o GET oficial da Evolution.

A [execução aprovada no Ubuntu 24.04](https://github.com/gilprodz69-lgtm/revenda-whatsapp/actions/runs/38645260302), commit de código `4bf1cb4`, também construiu as imagens e iniciou PostgreSQL, Redis, migrations, administrador, API, worker, painel e Evolution. A configuração Caddy passou em `caddy validate`; emissão de HTTPS real depende do domínio da VPS. Os testes Expay verificaram criação/idempotência, confirmação concorrente, valores/referências/moeda/método divergentes, callbacks falsos e estorno. Nenhuma cobrança real foi criada.

O código foi publicado no repositório público [gilprodz69-lgtm/revenda-whatsapp](https://github.com/gilprodz69-lgtm/revenda-whatsapp). O [workflow](https://github.com/gilprodz69-lgtm/revenda-whatsapp/actions/workflows/ci.yaml) executa os testes no Ubuntu, builds Docker, inicialização dos serviços e validação da configuração Caddy. Consulte a execução correspondente ao commit/release para seu resultado.

O assistente de instalação também passou em testes isolados de validação de domínio, portas e preservação do SSH. O comando foi simulado nos quatro fluxos root/sudo com curl existente/ausente, preservando SSH, com operações externas mockadas. A versão do bootstrap foi conferida; entradas interativas são lidas de `/dev/tty` para funcionar com download por pipe.

Pendente na VPS: instalação limpa Ubuntu 24.04, emissão de HTTPS com domínio real, backup/restore e testes com credenciais reais Partner/Expay/WhatsApp. Os testes de CI não substituem essas etapas. Nenhuma VPS do usuário foi acessada ou alterada nesta entrega.
