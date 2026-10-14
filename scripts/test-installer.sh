#!/usr/bin/env bash
# Pure helper tests: do not install packages, alter firewall or start services.
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/install-inputs.sh"
error() {
	printf '%s\n' "$*" >&2
	exit 1
}
for domain in loja.exemplo.com exemplo.com a-b.exemplo.com xn--exemplo-9za.com; do
	valid_domain "$domain" || error "Domínio válido rejeitado: $domain"
done
for domain in localhost https://loja.com loja.com/caminho loja..com .loja.com loja.com. -loja.com loja-.com 'loja.com;id' 'loja.com$(id)' 'loja.com:443' 'lo ja.com'; do
	if valid_domain "$domain"; then error "Domínio inválido aceito: $domain"; fi
done
for port in 22 2222 65535 00022; do valid_ssh_port "$port" || error "Porta válida rejeitada: $port"; done
for port in 0 65536 999999 -1 '22;id' ''; do
	if valid_ssh_port "$port"; then error "Porta inválida aceita: $port"; fi
done
# Run the firewall setup with a fake UFW; SSH_CONNECTION may be absent under sudo.
ufw() { printf '%s\n' "$*" >&3; }
unset SSH_CONNECTION
SSH_PORT=2222
firewall_result=$(configure_ssh_firewall 3>&1)
[[ "$firewall_result" == *'allow 2222/tcp'* ]] || error 'Porta SSH explícita não preservada.'
SSH_CONNECTION='192.0.2.1 12345 192.0.2.2 2223'
firewall_result=$(configure_ssh_firewall 3>&1)
[[ "$firewall_result" == *'allow 2223/tcp'* ]] || error 'Porta da sessão SSH não preservada.'
printf 'Instalador: domínio, portas e preservação do acesso SSH aprovados.\n'
