#!/usr/bin/env bash
# Keep the streamed entry point inside a function: a truncated download cannot run a partial installation.
set -euo pipefail
bootstrap() {
	local target=/opt/revenda-whatsapp repository=https://github.com/gilprodz69-lgtm/revenda-whatsapp.git
	local release
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
	if ! command -v git >/dev/null || ! command -v python3 >/dev/null; then
		apt-get update -qq
		DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ca-certificates python3
	fi
	release=$(curl -fsSL --retry 3 --max-time 30 https://api.github.com/repos/gilprodz69-lgtm/revenda-whatsapp/releases/latest | python3 -c 'import json,re,sys; tag=json.load(sys.stdin)["tag_name"]; assert re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+",tag), "Tag de release invalida"; print(tag)')
	if [[ ! -e "$target" ]]; then
		printf 'Baixando Revenda WhatsApp %s…\n' "$release"
		git -c credential.helper= clone --depth 1 --branch "$release" --single-branch "$repository" "$target"
	else
		[[ -d "$target/.git" && "$(git -C "$target" remote get-url origin)" == "$repository" ]] || {
			echo 'O diretório /opt/revenda-whatsapp existente não pertence a este projeto.' >&2
			return 1
		}
		if [[ -f "$target/.env" && -s "$target/secrets/installed-version" ]]; then
			printf 'Instalação existente: atualizando para %s com backup e preservação dos dados.\n' "$release"
			exec bash "$target/scripts/update.sh" "$release" </dev/tty
		fi
		echo 'Instalação inicial incompleta encontrada; retomando a configuração existente.'
	fi
	exec bash "$target/scripts/install.sh" </dev/tty
}
bootstrap "$@"
