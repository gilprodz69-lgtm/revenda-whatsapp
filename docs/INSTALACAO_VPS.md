# Instalação da Revenda WhatsApp na VPS

## Antes de começar

- VPS Ubuntu Server 24.04 LTS, x86_64, mínimo 2 vCPUs, 4 GB de RAM e 15 GB livres.
- Domínio ou subdomínio que você pode editar no provedor DNS, por exemplo `loja.seudominio.com`.
- Acesso SSH com `sudo` ou como `root`. Execute em terminal interativo.
- Libere TCP 80/443 no firewall do provedor, além da sua porta SSH.
- `curl` e `sudo`, normalmente já disponíveis na imagem Ubuntu do provedor.
- O repositório [gilprodz69-lgtm/revenda-whatsapp](https://github.com/gilprodz69-lgtm/revenda-whatsapp) é **público**. Não é necessário usuário, senha ou token GitHub para instalar ou atualizar.

## Um comando

Copie a linha de [INSTALL_VPS.txt](../INSTALL_VPS.txt) e execute na sessão SSH. Ela baixa o bootstrap público da tag `v1.0.0`, instala Git se necessário e inicia o assistente em `/opt/revenda-whatsapp`. As entradas do assistente são lidas do terminal, mesmo quando o bootstrap é baixado por um pipe. Você também pode gerar a linha com `node scripts/vps-command.cjs` no computador de desenvolvimento.

O assistente pedirá:

1. Domínio completo, sem `https://`, porta ou caminho.
2. E-mail para emissão do certificado HTTPS.
3. E-mail de login do administrador.
4. Senha inicial com pelo menos 14 caracteres e confirmação, ambas sem exibição.
5. Chaves de API Partner e Expay, sem exibição. Enter permite configurar depois no painel.
6. ID da loja Expay, opcional conforme sua conta.

Senhas de PostgreSQL/Redis e chaves de criptografia/webhooks são geradas automaticamente. As chaves informadas são provisionadas no banco com criptografia; a chave Expay seleciona esse gateway no primeiro provisionamento. Campos deixados vazios podem ser preenchidos no painel. Confira cotação/preços, produtos e conecte seu WhatsApp após instalar. Não é necessário expor a Evolution em outro domínio.

## Apontamentos DNS

O instalador mostra o IPv4 público obtido da VPS e o domínio informado. Cadastre:

| Tipo | Nome | Valor |
| --- | --- | --- |
| A | `loja` (ou o domínio completo, conforme o painel DNS) | IPv4 público da VPS mostrado no terminal |

Se usar o domínio principal, o campo Nome pode ser `@`. Se o IPv4 não puder ser detectado, use o IP público mostrado pelo provedor da VPS. NAT ou IPs de saída diferentes exigem o IP de entrada do servidor indicado pelo provedor. É possível informar o IP manualmente ao executar `sudo VPS_PUBLIC_IP=SEU_IPV4 bash /opt/revenda-whatsapp/scripts/install.sh`.

No Cloudflare, use **Somente DNS** durante a emissão inicial do certificado. Remova AAAA antigo; use AAAA somente se o IPv6 realmente chegar à mesma VPS. Não crie CNAME em conjunto com A no mesmo nome. Caddy emite e renova HTTPS automaticamente. Pode fazer os apontamentos depois de iniciar a instalação: o proxy continua tentando obter o certificado e os dados existentes são preservados.

Após propagar o DNS, verifique:

```bash
sudo bash /opt/revenda-whatsapp/scripts/healthcheck.sh
```

Abra `https://SEU_DOMINIO` e entre com o e-mail/senha definidos. Confira as etapas Partner, cotação, produtos, Pix e WhatsApp no [README](../README.md).

## Repetir, atualizar e diagnosticar

Repetir o comando usa a pasta existente e mantém `.env`, bancos, volumes e contas. Ele rejeita uma pasta que pertença a outro repositório e não busca silenciosamente uma versão mais nova. Para corrigir uma instalação interrompida:

```bash
sudo bash /opt/revenda-whatsapp/scripts/install.sh
```

Para atualizar, execute `sudo bash /opt/revenda-whatsapp/scripts/update.sh vX.Y.Z` com uma tag realmente publicada. Não é preciso autenticar no GitHub. Confira backup e compatibilidade em [operação](OPERACAO.md).

O comando preserva `SSH_CONNECTION` ao usar sudo para detectar a porta da sessão atual. As portas também são lidas de `sshd -T`. Se usar um encaminhamento incomum, informe explicitamente `SSH_PORT` ao executar o instalador; regras existentes do UFW são preservadas. Nenhuma porta de PostgreSQL, Redis ou Evolution é exposta publicamente.

Comandos úteis:

```bash
cd /opt/revenda-whatsapp
sudo docker compose ps
sudo docker compose logs --tail=100 proxy
sudo bash scripts/healthcheck.sh
```

Instalação com contas reais, emissão de certificado e restauração de backup devem ser conferidas na VPS conforme [homologação](HOMOLOGACAO.md). O comando de instalação não realiza compras, pagamentos ou envio de WhatsApp para clientes.
