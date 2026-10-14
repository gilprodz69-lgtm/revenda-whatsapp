# Operação e troubleshooting

## Serviços

```bash
sudo docker compose ps
sudo bash scripts/healthcheck.sh
sudo docker compose logs --tail=100 api worker
sudo docker compose restart worker
```

Não publique saída de `docker compose config` nem `docker inspect`: podem conter variáveis secretas. Para validar configuração sem mostrar valores, use `docker compose config --quiet`. Os logs da nossa API não incluem corpos; logs da Evolution são de componente externo. Seu entrypoint original imprime a conexão PostgreSQL, por isso usamos wrapper com as mesmas migrations oficiais e saída protegida.

Backend pode estar saudável sem conta Partner/Pix configurada. Dashboard distingue saldo indisponível e heartbeat do worker. Os jobs mantêm erros na fila e códigos seguros no banco; consulte Logs e Pedidos em revisão no painel. Para incidentes, forneça o `requestId` da Partner, sem conteúdo entregue.

Se um webhook esgotar as retentativas, ele aparece em Logs → Eventos em revisão. Corrija a causa e use Reprocessar; o corpo permanece cifrado e a deduplicação financeira continua ativa.

### WhatsApp desconectado ou QR ausente

Use Consultar conexão para obter estado atual; depois Conectar ou Reconectar. QR expira: gere novamente quando necessário. Pareamento depende da Evolution/Baileys/WhatsApp no momento da conexão. Sem número privado resolvido, eventos `@lid` são ignorados para evitar enviar credenciais ao identificador errado. Se a Evolution fornecer `remoteJidAlt` com número real, ele é usado como fallback. Grupos, status/broadcasts e `fromMe` são ignorados.

Mensagens pendentes ficam na outbox durante desconexão. Envios com resultado desconhecido não são repetidos automaticamente. Abra o histórico/WhatsApp conectado e use reenvio auditado da entrega após verificar o destinatário e a situação.

### Ativação e tempo de resposta

Em **Configurações → Palavras-chave para iniciar o bot**, cadastre palavras ou frases separadas por vírgula e clique em **Salvar atendimento**. O texto inteiro deve corresponder a uma entrada; diferenças de caixa, acentos, espaços repetidos e pontuação final `.!?` são ignoradas. Por exemplo, `comprar, quero comprar, vendas`. Deixar vazio impede novos atendimentos automáticos. Sessões já abertas continuam aceitando números e comandos do menu; expiram após 30 minutos sem interação. Saudações adicionais da versão anterior são preservadas até salvar a nova lista.

O bot atende apenas conversas privadas: grupos são ignorados tanto no webhook quanto no worker, inclusive quando existe um telefone privado alternativo no evento. Isso também se aplica a eventos antigos ainda pendentes.

Em **Configurações → Formato do atendimento no WhatsApp**, escolha **Botões e listas** (padrão) ou **Menu em texto**. O menu principal oferece Comprar serviços, Meu saldo e Suporte. Pelo saldo, o cliente acessa Adicionar saldo, Meus pedidos e Minha conta. Categorias e produtos usam listas paginadas de até dez opções; quantidade e confirmação usam botões. Valores diferentes, e-mail e CPF continuam aceitando texto. Os menus numéricos permanecem disponíveis como alternativa.

As seleções interativas têm identificadores vinculados à etapa atual; cliques de menus anteriores ou sessões expiradas são ignorados. A mensagem interativa é armazenada cifrada junto da resposta na outbox. Timeout, erro 5xx ou ausência do ID de envio deixam resultado desconhecido sem repetir automaticamente. Rejeições HTTP 400/404/405/422 permitem enviar a alternativa em texto.

O contrato segue os endpoints `sendButtons`/`sendList` da [Evolution 2.4.0-rc2](https://github.com/evolution-foundation/evolution-api/releases/tag/2.4.0-rc2), que inclui as correções de mensagens interativas introduzidas na rc1. A imagem oficial está fixada por digest no Compose. A aceitação HTTP não comprova que o WhatsApp exibiu o componente no aparelho. Confira usando outro número; se necessário, selecione Menu em texto.

### Ativação da Evolution 2.4.0-rc2

Esta versão candidata foi selecionada explicitamente pelo operador. Antes de conectar/enviar, abra **WhatsApp → Iniciar ativação → Abrir cadastro oficial**, conclua o cadastro da Evolution e confirme o código recebido no painel. O retorno do cadastro para `/evolution/activate?code=...` preenche o código e o remove da URL; o proprietário precisa confirmar o envio, com sessão e CSRF válidos. Também é possível colar o código manualmente. O botão Consultar ativação atualiza o estado após concluir o processo.

O painel acessa os endpoints internos oficiais `/license/status`, `/license/register` e `/license/activate`; não expõe o manager nem a porta da Evolution. Não altera a chave `EVOLUTION_API_KEY` existente. A licença e o identificador da instalação são persistidos pela Evolution no próprio banco, incluído no backup. O health check distingue serviço iniciado de ativação pendente. Quando recebe `LICENSE_REQUIRED`, a outbox permanece PENDING para recuperação após ativar. Timeout genérico continua UNKNOWN.

A nova Evolution contata o serviço oficial de licenciamento no boot e durante a operação. O painel não cadastra automaticamente o e-mail do administrador nesse serviço. O usuário conclui o cadastro oficial. As notas da rc2 informam um caminho opcional `EVOLUTION_OPERATOR_EMAIL` para e-mails já registrados; esta aplicação não o configura automaticamente. A migração da 2.3.7 aplica as migrations oficiais, mantendo banco e volume `evolution_instances`.

### Aparência do painel

O admin segue o sistema de consulta: fonte Montserrat local, tema preto/violeta, alternativa clara, navegação e botões arredondados, cartões com brilho no cursor e animações de entrada. A preferência de tema é mantida no navegador; o padrão para novos acessos é escuro. A edição de produtos usa modal com seções de Preços, Promoções e Disponibilidade. Escape fecha o modal quando não há gravação em andamento; foco e rolagem ficam contidos nele. As animações respeitam a preferência de movimento reduzido do dispositivo.

Após persistir uma mensagem, a aplicação avisa imediatamente as filas de processamento e envio. A varredura de recuperação a cada 15 segundos permanece para falhas temporárias; não é mais necessária no caminho normal. O limite de 20 envios por minuto continua ativo. Filas cheias, desconexões, Evolution e chamadas externas ainda podem aumentar a latência.

### Pedido UNKNOWN / REVIEW

Não libere saldo manualmente só porque houve timeout. Abra pedido, confira tentativas/requestId, saldo reservado e referência. Reconciliar busca pelo mesmo `externalOrderId` e repete o corpo original conforme a idempotência documentada. REVIEW interrompe novas tentativas automáticas. Escalone ao fornecedor se o resultado continuar incerto. Após localizar entrega válida, a captura acontece uma vez.

Rejeições comprovadas sem tentativa anterior incerta liberam a reserva. Erro `FAILED` genérico, HTTP 5xx, timeout, payload inválido ou divergência entre pedido e entrega exigem recuperação/revisão.

Estorno local cancela envios ainda pendentes; quando um envio está SENDING/UNKNOWN, primeiro confira o resultado com o comprador e regularize a entrega. Um produto já enviado não é revogado no fornecedor por este estorno. A justificativa administrativa precisa refletir sua política comercial.

### Pix não creditado

Confira seleção Expay, chave `X-API-Key` da API atual, ID da loja se aplicável e URL HTTPS `/webhooks/pix/expay`. A chave antiga `merchant_key` pertence a outro contrato. A confirmação depende da consulta autenticada da cobrança; o corpo do webhook nunca credita saldo. Consulte UUID, referência, valor, BRL, método Pix e status na Expay. O polling também recupera notificações perdidas durante sete dias. Nunca use ajuste de carteira para simular aprovação de Pix. Ajuste administrativo é uma operação financeira separada com justificativa/auditoria.

### Cotação vencida / estoque

Ative BCB ou informe cotação manual real com validade. Não há taxa padrão. Sync atualiza custos e disponibilidade; regras locais permanecem. Produtos ausentes/sem estoque/inativos/não autorizados não são oferecidos. O custo é reconferido antes do primeiro POST: se subir acima do estimado, o pedido é cancelado e reserva liberada para nova confirmação.

## Backup e restauração

```bash
sudo bash scripts/backup.sh
sudo systemctl status revenda-backup.timer
sudo journalctl -u revenda-backup.service --since today
sudo bash scripts/restore.sh /CAMINHO/backup.tar.gpg
```

O timer executa diariamente às 03:00 de America/Sao_Paulo, com variação de até 5 minutos. Backup pausa API/worker/Evolution por um breve período para obter dumps consistentes e sessão persistente; PostgreSQL e Redis continuam ativos. O proxy pode retornar indisponibilidade enquanto a API estiver pausada. É guardado um snapshot Redis de apoio, porém na restauração o DB Redis da aplicação é limpo e reconstruído a partir do banco/outbox. Cache Evolution permanece; sessões são recuperadas do banco e volume. Os arquivos da sessão recuperada são sobrepostos aos existentes; em restauração para outra identidade de loja, use uma instalação/volumes novos conforme revisão do operador.

Backups: dumps de `revenda`/`evolution`, sessão Evolution, `.env`, versão e manifesto, em tar cifrado AES-256 via GPG. Hash SHA-256 acompanha o arquivo. Retenção padrão: 14 dias. Passphrase fica em `secrets/backup-passphrase`; guarde-a fora da VPS. Copie backups também para armazenamento externo seguro — a instalação não configura provedor remoto sem conta informada.

Restore exige confirmação literal, cria backup prévio e verifica que a ENCRYPTION_KEY corresponde. Não substitui automaticamente `.env`/senhas de banco do servidor. Para recuperar em VPS nova, recupere o `.env` original e a passphrase em ambiente protegido antes de inicializar os volumes; repita a instalação/migração com os segredos originais. Contas criadas pelo instalador não sobrescrevem as contas restauradas.

## Atualizar e rollback

O comando único de [INSTALL_VPS.txt](../INSTALL_VPS.txt) instala a release estável mais recente em uma VPS nova e atualiza instalações existentes com backup. Não recria a configuração inicial nem redefine contas, chaves, banco ou sessões do WhatsApp. Repetir a mesma versão apenas verifica a saúde. A atualização pode interromper brevemente o atendimento enquanto os serviços são reconstruídos.

Publique versões com tags explícitas (ex.: v1.0.1). O updater usa o remote `origin` do repositório configurado pelo operador, não uma URL inventada.

```bash
sudo bash scripts/update.sh v1.0.1
```

O updater verifica árvore limpa e compatibilidade da versão principal, faz backup, guarda commit anterior, constrói imagens, migra e valida saúde. **Nunca usa `down -v`**. Tags disponíveis e conteúdo de releases devem ser revisados pelo responsável pelo GitHub; assinatura de release não é imposta pelo script atual.

Se o esquema continuar compatível, volte ao commit guardado em `secrets/rollback-commit`, reconstrua as imagens e recrie API/worker/admin. Se uma migração for incompatível, pare os gravadores e restaure o backup anterior usando a versão de código correspondente. Não há downgrade automático de schema nem promessa de rollback sem perda de registros posteriores ao backup. Concilie pagamentos/pedidos externos realizados depois do snapshot.

## Parar e remover

`sudo bash scripts/uninstall.sh` remove containers/rede do Compose e desativa o timer após confirmação; preserva volumes, Docker, backups e segredos. Eliminação definitiva de dados não é automatizada por este script.
