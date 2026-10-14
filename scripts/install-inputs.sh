#!/usr/bin/env bash
# Helpers shared by the installer and its isolated tests. Never evaluate user input.
prompt_value() {
	local name=$1 label=$2
	[[ -r /dev/tty && -w /dev/tty ]] || error 'Sem terminal interativo. Execute o comando em uma sessão SSH com terminal.'
	IFS= read -r -p "$label" "$name" </dev/tty || error 'Entrada interrompida.'
}
prompt_password() {
	local name=$1 label=$2
	[[ -r /dev/tty && -w /dev/tty ]] || error 'Sem terminal interativo para definir a senha.'
	IFS= read -r -s -p "$label" "$name" </dev/tty || error 'Entrada interrompida.'
	printf '\n' >/dev/tty
}
valid_domain() {
	local domain=$1 label
	[[ ${#domain} -le 253 && "$domain" == *.* && "$domain" =~ ^[a-z0-9.-]+$ ]] || return 1
	local labels
	IFS='.' read -r -a labels <<<"$domain"
	for label in "${labels[@]}"; do
		[[ ${#label} -ge 1 && ${#label} -le 63 && "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
	done
	[[ "$domain" != *. && "${labels[-1]}" =~ ^[a-z]{2,}$ ]]
}
valid_email() { [[ "$1" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; }
valid_ssh_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535)); }
show_dns_instructions() {
	local public_ip=${VPS_PUBLIC_IP:-}
	if [[ -z "$public_ip" ]]; then
		public_ip=$(curl -4 -fsS --connect-timeout 3 --max-time 5 https://api.ipify.org 2>/dev/null || true)
	fi
	if ! python3 -c 'import ipaddress,sys; ip=ipaddress.ip_address(sys.argv[1]); sys.exit(0 if ip.version == 4 and ip.is_global else 1)' "$public_ip" 2>/dev/null; then
		public_ip='IPv4 público informado pelo seu provedor da VPS'
	fi
	printf '\nConfigure o DNS enquanto os serviços são instalados:\n'
	printf '  Tipo: A | Nome: %s | Valor: %s\n' "$APP_DOMAIN" "$public_ip"
	printf '  Use o nome completo ou somente o subdomínio, conforme o painel DNS.\n'
	printf '  Se usar Cloudflare, selecione "Somente DNS" durante a emissão do certificado.\n'
	printf '  Remova AAAA incorreto; mantenha AAAA somente com IPv6 funcional desta VPS.\n'
	printf '  Libere TCP 80/443 no firewall do provedor. HTTPS será emitido automaticamente.\n'
	printf '  Painel: https://%s | Login: %s\n\n' "$APP_DOMAIN" "$ADMIN_EMAIL"
}
configure_ssh_firewall() {
	local ssh_connection=${SSH_CONNECTION:-} port detected_ports
	local -a ssh_ports=()
	if [[ -n "$ssh_connection" ]]; then
		port=${ssh_connection##* }
		valid_ssh_port "$port" || error 'Porta inválida em SSH_CONNECTION.'
		ssh_ports+=("$port")
	fi
	if [[ -n "${SSH_PORT:-}" ]]; then
		valid_ssh_port "$SSH_PORT" || error 'SSH_PORT inválida.'
		ssh_ports+=("$SSH_PORT")
	fi
	if [[ -x /usr/sbin/sshd ]]; then
		detected_ports=$(/usr/sbin/sshd -T 2>/dev/null | awk '$1=="port" {print $2}' || true)
		while IFS= read -r port; do
			if valid_ssh_port "$port"; then ssh_ports+=("$port"); fi
		done <<<"$detected_ports"
	fi
	[[ ${#ssh_ports[@]} -gt 0 ]] || ssh_ports+=(22)
	for port in "${ssh_ports[@]}"; do ufw allow "$port/tcp" >/dev/null; done
	printf 'Acesso SSH preservado nas portas: %s\n' "${ssh_ports[*]}"
	ufw allow 80/tcp >/dev/null
	ufw allow 443/tcp >/dev/null
	ufw allow 443/udp >/dev/null
	ufw --force enable >/dev/null
}
