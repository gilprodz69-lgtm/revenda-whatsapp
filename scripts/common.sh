#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$ROOT_DIR"
export COMPOSE_PROJECT_NAME=revenda
load_env() {
	[[ -f .env ]] || {
		echo 'Arquivo .env ausente. Execute scripts/install.sh.' >&2
		exit 1
	}
	while IFS= read -r line || [[ -n "$line" ]]; do
		[[ -z "$line" || "$line" == \#* ]] && continue
		local key=${line%%=*} value=${line#*=}
		[[ "$key" =~ ^[A-Z][A-Z0-9_]*$ && "$line" == *=* ]] || {
			echo 'Formato inválido em .env.' >&2
			exit 1
		}
		export "$key=$value"
	done <.env
}
dc() { docker compose --project-directory "$ROOT_DIR" --env-file "$ROOT_DIR/.env" -f "$ROOT_DIR/compose.yaml" "$@"; }
root_required() { [[ $EUID -eq 0 ]] || {
	echo 'Execute com sudo.' >&2
	exit 1
}; }
error() {
	echo "$*" >&2
	exit 1
}
