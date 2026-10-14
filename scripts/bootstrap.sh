#!/usr/bin/env bash
# Keep the streamed entry point inside a function: a truncated download cannot run a partial installation.
set -euo pipefail
bootstrap() {
	local target=/opt/revenda-whatsapp repository=https://github.com/gilprodz69-lgtm/revenda-whatsapp.git
	local release=v1.0.0
	[[ $EUID -eq 0 ]] || {
		echo 'Execute o comando com sudo conforme o README.' >&2
		return 1
	}
	[[ -r /dev/tty && -w /dev/tty ]] || {
		echo 'Execute em uma sessão SSH com terminal interativo.' >&2
		return 1
	}
	source /etc/os-release
	[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || {
		echo 'Use Ubuntu Server 24.04 LTS.' >&2
		return 1
	}
	[[ "$(uname -m)" == x86_64 ]] || {
		echo 'Esta versão exige CPU x86_64/amd64.' >&2
		return 1
	}
	[[ ! -L "$target" ]] || {
		echo 'O destino não pode ser um link simbólico.' >&2
		return 1
	}
	if ! command -v git >/dev/null; then
		apt-get update -qq
		DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ca-certificates
	fi
	if [[ ! -e "$target" ]]; then
		printf 'Baixando Revenda WhatsApp %s…\n' "$release"
		git -c credential.helper= clone --depth 1 --branch "$release" --single-branch "$repository" "$target"
	else
		[[ -d "$target/.git" && "$(git -C "$target" remote get-url origin)" == "$repository" ]] || {
			echo 'O diretório /opt/revenda-whatsapp existente não pertence a este projeto.' >&2
			return 1
		}
		echo 'Instalação existente encontrada; retomando sem trocar a versão ou os dados.'
	fi
	exec bash "$target/scripts/install.sh" </dev/tty
}
bootstrap "$@"
