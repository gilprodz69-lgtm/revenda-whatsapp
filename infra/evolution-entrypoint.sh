#!/usr/bin/env bash
set -euo pipefail
cd /evolution
export DATABASE_URL="$DATABASE_CONNECTION_URI"
# The upstream entrypoint prints DATABASE_URL. Execute its documented migration commands
# directly and keep any failure output in a protected, transient container file.
umask 077
log_file=$(mktemp)
trap 'rm -f "$log_file"' EXIT
if ! npm run db:deploy >"$log_file" 2>&1 || ! npm run db:generate >>"$log_file" 2>&1; then
	echo 'Falha na migração da Evolution. Verifique banco e credenciais; detalhes omitidos para proteger segredos.' >&2
	exit 1
fi
rm -f "$log_file"
trap - EXIT
exec npm run start:prod
