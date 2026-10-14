#!/usr/bin/env bash
set -euo pipefail
umask 077
source "$(dirname "$0")/common.sh"
source "$ROOT_DIR/scripts/install-inputs.sh"
root_required
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || error 'Este instalador exige Ubuntu Server 24.04 LTS.'
[[ "$(uname -m)" == x86_64 ]] || error 'O instalador homologável desta versão exige CPU x86_64/amd64 (imagem Evolution fixada).'
[[ $(nproc) -ge 2 ]] || error 'Mínimo recomendado e exigido: 2 vCPUs.'
[[ $(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo) -ge 3800 ]] || error 'Mínimo: 4 GB de RAM.'
[[ $(df -Pm "$ROOT_DIR" | awk 'NR==2{print $4}') -ge 15000 ]] || error 'Mínimo: 15 GB de disco livre.'
[[ -f package-lock.json ]] || error 'Clone o repositório completo, incluindo package-lock.json.'
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl gnupg openssl git ufw dnsutils python3 >/dev/null
install_docker() {
	curl -fsSI --max-time 15 https://download.docker.com >/dev/null || error 'Sem acesso ao repositório oficial Docker.'
	if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
		for pkg in docker.io podman-docker docker-compose docker-compose-v2; do
			if dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed'; then error "Pacote conflitante $pkg encontrado. Revise a instalação Docker existente antes de continuar."; fi
		done
		install -m 0755 -d /etc/apt/keyrings
		curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
		chmod a+r /etc/apt/keyrings/docker.asc
		cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
		apt-get update -qq
		DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
	fi
	systemctl enable --now docker >/dev/null
	docker info >/dev/null || error 'Docker Engine indisponível.'
}
install -d -m 0700 secrets backups
if [[ ! -f .env ]]; then
	APP_DOMAIN=${APP_DOMAIN:-}
	ACME_EMAIL=${ACME_EMAIL:-}
	ADMIN_EMAIL=${ADMIN_EMAIL:-}
	printf '\nConfiguração inicial da Revenda WhatsApp\n'
	[[ -n "$APP_DOMAIN" ]] || prompt_value APP_DOMAIN 'Domínio do painel (ex.: loja.exemplo.com, sem https://): '
	APP_DOMAIN=${APP_DOMAIN,,}
	valid_domain "$APP_DOMAIN" || error 'Domínio inválido. Informe um domínio/subdomínio sem protocolo, porta ou caminho.'
	[[ -n "$ACME_EMAIL" ]] || prompt_value ACME_EMAIL 'E-mail para certificados HTTPS: '
	[[ -n "$ADMIN_EMAIL" ]] || prompt_value ADMIN_EMAIL 'E-mail do administrador: '
	valid_email "$ACME_EMAIL" && valid_email "$ADMIN_EMAIL" || error 'E-mail inválido.'
	if [[ ! -f secrets/admin-password ]]; then
		prompt_password admin_password 'Senha inicial do administrador (mínimo 14 caracteres): '
		prompt_password confirm_password 'Repita a senha: '
		[[ ${#admin_password} -ge 14 && "$admin_password" == "$confirm_password" ]] || error 'Senhas diferentes ou curtas.'
		printf '%s' "$admin_password" >secrets/admin-password
		unset admin_password confirm_password
	fi
	for integration in partner expay; do
		file="secrets/$integration-api-key"
		if [[ ! -f "$file" ]]; then
			prompt_password integration_key "Chave de API $integration (Enter para configurar depois no painel): "
			minimum=16
			maximum=500
			if [[ "$integration" == partner ]]; then
				minimum=20
				maximum=300
			fi
			[[ -z "$integration_key" || (${#integration_key} -ge $minimum && ${#integration_key} -le $maximum) ]] || error "Chave deve ter entre $minimum e $maximum caracteres."
			printf '%s' "$integration_key" >"$file"
			unset integration_key
		fi
	done
	EXPAY_STORE_ID=${EXPAY_STORE_ID:-}
	prompt_value EXPAY_STORE_ID 'ID da loja Expay (opcional, Enter para usar o merchant da chave): '
	[[ -z "$EXPAY_STORE_ID" || "$EXPAY_STORE_ID" =~ ^[a-zA-Z0-9_-]{1,255}$ ]] || error 'ID da loja Expay inválido.'
	POSTGRES_PASSWORD=$(openssl rand -hex 32)
	DB_PASSWORD=$(openssl rand -hex 32)
	EVOLUTION_DB_PASSWORD=$(openssl rand -hex 32)
	REDIS_PASSWORD=$(openssl rand -hex 32)
	ENCRYPTION_KEY=$(openssl rand -hex 32)
	WEBHOOK_SECRET=$(openssl rand -hex 32)
	EVOLUTION_API_KEY=$(openssl rand -hex 32)
	cat >.env <<EOF
COMPOSE_PROJECT_NAME=revenda
APP_DOMAIN=$APP_DOMAIN
ACME_EMAIL=$ACME_EMAIL
APP_ORIGIN=https://$APP_DOMAIN
PUBLIC_API_URL=https://$APP_DOMAIN
NODE_ENV=production
TRUST_PROXY=1
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
DB_PASSWORD=$DB_PASSWORD
EVOLUTION_DB_PASSWORD=$EVOLUTION_DB_PASSWORD
REDIS_PASSWORD=$REDIS_PASSWORD
DATABASE_URL=postgresql://app:$DB_PASSWORD@postgres:5432/revenda?schema=public
REDIS_URL=redis://:$REDIS_PASSWORD@redis:6379/0
ENCRYPTION_KEY=$ENCRYPTION_KEY
WEBHOOK_SECRET=$WEBHOOK_SECRET
EVOLUTION_API_KEY=$EVOLUTION_API_KEY
EVOLUTION_URL=http://evolution:8080
PARTNER_URL=https://ggsoma.store/api/partner/v1
PARTNER_API_KEY=
PARTNER_REQUESTS_PER_MINUTE=60
PARTNER_ORDERS_PER_MINUTE=10
PIX_GATEWAY=disabled
EXPAY_API_KEY=
EXPAY_STORE_ID=$EXPAY_STORE_ID
MP_ACCESS_TOKEN=
MP_WEBHOOK_SECRET=
ADMIN_EMAIL=$ADMIN_EMAIL
BACKUP_RETENTION_DAYS=14
EOF
fi
chmod 0600 .env
[[ -f secrets/admin-password ]] || error 'Arquivo secrets/admin-password ausente. Reponha a senha inicial original ou uma senha protegida; contas existentes não serão sobrescritas.'
chmod 0640 secrets/admin-password
chown root:1000 secrets/admin-password
for integration in partner expay; do
	file="secrets/$integration-api-key"
	[[ -f "$file" ]] || : >"$file"
	chmod 0640 "$file"
	chown root:1000 "$file"
done
[[ -f secrets/backup-passphrase ]] || openssl rand -hex 48 >secrets/backup-passphrase
chmod 0600 secrets/backup-passphrase
load_env
show_dns_instructions
install_docker
dc config --quiet
# Keep the active SSH port before enabling the firewall; database/cache have no published ports.
configure_ssh_firewall
echo 'Baixando imagens fixadas e construindo backend/painel…'
dc pull postgres redis evolution proxy
dc build api admin
dc up -d postgres redis
dc run --rm migrate
dc up -d
cat >/etc/systemd/system/revenda-backup.service <<EOF
[Unit]
Description=Backup criptografado da Revenda
Requires=docker.service
After=docker.service
[Service]
Type=oneshot
ExecStart=/bin/bash "$ROOT_DIR/scripts/backup.sh"
UMask=0077
EOF
cat >/etc/systemd/system/revenda-backup.timer <<EOF
[Unit]
Description=Backup diário da Revenda
[Timer]
OnCalendar=*-*-* 03:00:00 America/Sao_Paulo
RandomizedDelaySec=300
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now revenda-backup.timer >/dev/null
printf '%s\n' "$(docker version --format '{{.Server.Version}}')" >secrets/docker-version
python3 -c 'import json; print(json.load(open("package.json"))["version"])' >secrets/installed-version
bash scripts/healthcheck.sh --internal
if curl -fsS --max-time 20 "https://$APP_DOMAIN/health/ready" >/dev/null 2>&1; then
	echo "Instalação disponível em https://$APP_DOMAIN"
else
	echo "Serviços iniciados. HTTPS pendente: aponte o registro A de $APP_DOMAIN para o IPv4 desta VPS."
	echo 'Se houver AAAA, ele deve apontar para o IPv6 funcional da mesma VPS. Libere portas 80/443 no firewall do provedor.'
	printf 'Após propagar o DNS, execute: sudo bash "%s/scripts/healthcheck.sh"\n' "$ROOT_DIR"
	echo 'O proxy tenta emitir HTTPS novamente sozinho; não é necessário reinstalar.'
fi
echo 'Entre com a senha definida, confira Partner/Expay, cotação e preços, sincronize/autorize os produtos e conecte o WhatsApp.'
echo "Webhook opcional da loja Expay: https://$APP_DOMAIN/webhooks/pix/expay. A consulta automática também confirma os pagamentos."
echo 'Guarde secrets/backup-passphrase e a ENCRYPTION_KEY do .env em local separado e protegido. Nenhum segredo foi exibido.'
