# Registro de validação

## Versão 1.0.8

A [execução no Ubuntu 24.04](https://github.com/gilprodz69-lgtm/revenda-whatsapp/actions/runs/38738145379), commit de código `e81cf5a`, foi aprovada: **94 testes unitários, 70 de integração e 34 de interface, 198 no total**, TypeScript, builds, smoke API/worker, auditoria npm sem vulnerabilidades reportadas, scripts Linux, updater e inicialização Docker. As cinco migrations existentes passaram; esta versão não adiciona migrations. O smoke da Evolution confirmou a preservação dos registros de teste de banco/sessão entre 2.3.7 e 2.4.0-rc2.

O cenário relatado foi reproduzido nos testes com a frase da captura após gerar uma cobrança Pix. Em modo interativo e texto, a conversa entra em espera: frases comuns, alegação de pagamento, números e botões antigos não geram resposta, nova cobrança, compra ou crédito e não renovam a sessão. Somente uma palavra-chave configurada reabre o menu; a navegação numérica segue funcionando depois da reativação. Uma confirmação autenticada simulada do gateway continua creditando a carteira e enviando a notificação sem reabrir o atendimento.

Os testes também cobrem as sete etapas de navegação/formulário ignorando texto alheio à etapa, preservação do prazo e botões de menus antigos, saudações removidas da configuração e Pix gerado antes desta versão. Neste último caso, a leitura da última resposta do atendimento reconhece o lote Pix antigo sem excluir ou regravar a cobrança/conversa; números e botões antigos são bloqueados até uma palavra-chave, e a navegação volta a funcionar após a reativação.

Partner, gateway e envio de WhatsApp são simulados nos testes; nenhum pagamento ou pedido externo real foi executado pelo assistente. A VPS do operador não foi acessada. Os testes de atualização e a inicialização Docker verificaram preservação e saúde no ambiente isolado; a aplicação da release na VPS é feita pelo operador.

## Versão 1.0.7

A [execução no Ubuntu 24.04](https://github.com/gilprodz69-lgtm/revenda-whatsapp/actions/runs/38730240498), commit de código `6c58913`, foi aprovada: **94 testes unitários, 58 de integração e 34 de interface, 186 no total**, TypeScript, builds, smoke API/worker, auditoria npm sem vulnerabilidades reportadas, scripts, updater e inicialização Docker. As cinco migrations foram aplicadas no banco isolado. A verificação da Evolution preservou os registros de teste de banco/sessão entre 2.3.7 e 2.4.0-rc2.

Os cenários novos verificam edição autenticada de nome/descrição, limites de tamanho, CSRF e bloqueio de operador, busca pelo nome personalizado, persistência após sincronização e retorno ao nome externo ao limpar o campo. O bot usa a apresentação local nos detalhes/resumo e no registro de novos pedidos, sem publicar automaticamente a descrição externa. A exclusão é idempotente e auditada, retira o produto das listagens/novas compras, conserva pedidos/entregas já existentes e não é revertida por sincronização. A reimportação explícita conserva textos/preço e exige nova autorização de revenda.

O fluxo de saldo insuficiente foi testado em modo interativo e texto: nenhuma compra ou débito é criado; o atalho abre o fluxo Pix, produz uma cobrança simulada e não credita saldo pendente. Menus antigos são rejeitados. O menu padrão envia três botões visíveis, mantendo acesso à carteira e listas de categorias, e o painel também permite escolher a lista inicial completa. O smoke de API/worker reais confirmou duas respostas interativas sem duplicação, usando serviços externos HTTP simulados.

No painel desktop/celular, os testes verificam conservação e recarga de nome/descrição, limpeza dos campos, cancelamento/confirmação da exclusão, falha recuperável e persistência da preferência do menu. As capturas dos novos modais foram inspecionadas localmente. Uma reprodução local com Fastify confirmou a rejeição de DELETE sem corpo com cabeçalho JSON vazio; o cliente agora omite esse cabeçalho quando não envia corpo, e o teste da interface confere a requisição de exclusão.

O operador confirmou que o novo teste de venda na 1.0.6 passou; API e worker usavam a mesma cotação válida no mesmo banco. Não foi aplicada outra alteração no cálculo de cotação nesta versão. A migração 202610150005 adiciona apenas colunas opcionais de apresentação/exclusão e um índice. Os testes externos usam mocks; nenhuma VPS, chave real ou compra/pagamento real foi acessado pelo assistente. A renderização dos novos menus deve ser conferida no WhatsApp após atualizar; a aplicação não controla a rolagem nem a abertura automática das listas no aparelho.

## Versão 1.0.6

A [execução no Ubuntu 24.04](https://github.com/gilprodz69-lgtm/revenda-whatsapp/actions/runs/38662721175), commit de código `d12ea88`, foi aprovada: **94 testes unitários, 51 de integração e 28 de interface, 173 no total**, TypeScript, builds, smoke API/worker, auditoria npm, scripts, updater e inicialização Docker. O teste de migração da Evolution confirmou a preservação dos registros de teste no banco/volume entre 2.3.7 e 2.4.0-rc2.

O diagnóstico enviado pelo operador mostrou modo BCB salvo sem nenhum registro de cotação. A consulta pública real ao BCB reproduziu HTTP 400 com espaços `+` no filtro OData e retornou HTTP 200 com fechamento ao usar `%20`. Os testes verificaram a codificação, valor/data/validade gravados, consulta explícita em modo manual e rejeição de respostas HTTP inválidas, JSON inválido, data inválida e taxa vencida. PostgreSQL/API confirmaram obtenção da taxa ao salvar BCB, cálculo do produto com a nova taxa e erro explícito quando a preferência é salva mas a consulta falha. O painel distingue preferência de renovação e existência de taxa válida, conserva o estado após recarregar e permite repetir a consulta após erro.

Os registros do operador também mostraram três respostas 502 no detalhe de produto, seguidas de 200. Os testes de transporte verificaram classificação de 502 não JSON, três tentativas máximas em GET, logs sem corpo e POST de compra sem repetição automática, mantendo resultado incerto para reconciliação. As integrações privadas dos testes são simuladas; a consulta real de BCB foi pública e somente leitura. Nenhuma VPS, chave real Partner ou compra/pagamento real foi acessado pelo assistente. Formatação local aprovada.

## Versão 1.0.5

A [execução no Ubuntu 24.04](https://github.com/gilprodz69-lgtm/revenda-whatsapp/actions/runs/38660878396), commit de código `4e3e540`, passou em 14/10/2026 (Brasília): **83 testes unitários, 49 de integração e 24 de interface, 156 no total**, TypeScript, builds, smoke API/worker, auditoria npm, scripts, updater, imagens e inicialização Docker. O smoke da Evolution confirmou novamente os registros de teste preservados na migração 2.3.7 → 2.4.0-rc2.

O diagnóstico fornecido pelo operador apontou `USDT` em 20 posições do catálogo, rejeitadas pelo literal `USD`. O exemplo HTML original foi testado diretamente e passa; um cenário com 90 produtos simulados reproduziu os mesmos 20 índices em USDT e confirmou a leitura completa sem alterar a moeda/preço. A prévia agora informa a moeda original; somente USD pode ser importado/vendido nesta versão.

Os testes com PostgreSQL verificaram catálogo misto, importação USD, recusa de seleção contendo USDT sem gravação parcial e desativação de produto cuja moeda mudou sem sobrescrever seu custo USD anterior. A compra não reserva saldo em moeda sem suporte; se a moeda muda após a reserva e antes do primeiro envio, o pedido falha e o saldo é liberado sem POST de compra. O painel desktop/celular identifica USDT, bloqueia a seleção individual e o exclui da seleção em lote. A formatação local passou.

Nenhuma taxa USDT/USD foi presumida. As chamadas externas dos testes são simuladas; o diagnóstico real veio da saída enviada pelo operador. O assistente não acessou a VPS nem realizou compras ou pagamentos reais.

## Versão 1.0.4

A [execução no Ubuntu 24.04](https://github.com/gilprodz69-lgtm/revenda-whatsapp/actions/runs/38659057689), commit de código `faa03d8`, passou em 14/10/2026 (horário de Brasília): **81 testes unitários, 45 de integração e 22 de interface, 148 no total**, TypeScript, builds, smoke API/worker, auditoria npm, scripts, updater e inicialização Docker. O teste de migração da Evolution 2.3.7 para 2.4.0-rc2 confirmou a preservação dos registros de teste no banco/volume e a indicação de ativação pendente.

O fluxo Expay foi verificado no PostgreSQL: valor informado → cobrança sem e-mail/documento inventados → resumo, QR e código em mensagens separadas, com o código sem menu ou legenda. Testes nos modos interativo/texto confirmaram ordem de gravação, envio de texto puro e processamento repetido sem nova cobrança/mensagem. Sessões antigas em coleta de e-mail/CPF continuam; a exigência do adaptador Mercado Pago foi preservada. O contrato oficial Expay de `POST /charges` foi consultado novamente: `customer`, `customer.email` e `customer.document` são opcionais.

A importação seletiva foi validada com prévia sem gravação, busca/código/fornecedor, seleção deduplicada, rejeição de itens ausentes sem importação parcial, auditoria transacional e preservação das regras existentes. A sincronização periódica atualiza somente serviços já cadastrados. As rotas exigem sessão/permissão e CSRF na gravação; recusas de autenticação da Partner retornam erro da integração sem encerrar a sessão admin. A interface foi testada em desktop/celular com seleção entre páginas/filtros, revisão e recuperação após erro; capturas locais foram inspecionadas. Formatação local aprovada.

As APIs externas são simuladas nos testes. Nenhuma VPS, credencial real, conta WhatsApp ou cobrança real foi acessada. O erro específico da captura do operador não foi reproduzido com a conta real; a nova janela apresenta mensagens próprias para as falhas de integração.

## Versão 1.0.3

A [execução no Ubuntu 24.04](https://github.com/gilprodz69-lgtm/revenda-whatsapp/actions/runs/38655654871), commit de código `b3660c2`, passou em 14/10/2026: 78 testes unitários, 36 de integração e 18 de interface (132 no total), TypeScript, build, smoke API/worker, auditoria npm, updater, imagens e inicialização Docker. O menu principal e a carteira usam listas nativas; o fluxo de compra recebeu seleções `listResponseMessage`, rejeitou menus antigos e confirmou um pedido uma única vez. O smoke verificou duas chamadas `sendList` sem depender da varredura periódica.

A persistência das integrações foi verificada no PostgreSQL: chaves Partner/Expay cifradas, presença indicada no GET sem devolver os segredos, gateway/ID mantidos e credenciais preservadas ao salvar novamente sem enviar chaves. Os testes do painel confirmaram esses estados após salvar, recarregar e salvar novamente, em desktop e celular. A formatação passou no verificador local. Os serviços externos dos testes de envio e configuração foram simulados; nenhuma credencial real do operador foi utilizada.

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
