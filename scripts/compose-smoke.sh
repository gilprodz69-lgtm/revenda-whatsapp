#!/usr/bin/env bash
# Disposable GitHub Actions environment only; never operate on a VPS installation.
set -euo pipefail
umask 077
[[ ${CI:-} == true && ${GITHUB_ACTIONS:-} == true && ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ ]] || {
	echo 'Smoke de containers permitido somente em runner descartável GitHub Actions.' >&2
	exit 1
}
ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$ROOT_DIR"
[[ ! -e .env && ! -e secrets ]] || {
	echo 'Runner deve estar sem .env e sem secrets existentes.' >&2
	exit 1
}
temp_dir=$(mktemp -d)
dc() { timeout 480 docker compose --project-name "revenda_smoke_${GITHUB_RUN_ID}_${GITHUB_RUN_ATTEMPT:-1}" --env-file "$temp_dir/env" -f "$ROOT_DIR/compose.yaml" "$@"; }
cleanup() {
	local result=$?
	if ((result != 0)); then
		dc ps -a || true
		dc logs --tail=70 api worker admin migrate || true
	fi
	dc down --volumes --remove-orphans >/dev/null 2>&1 || true
	rm -f secrets/admin-password secrets/partner-api-key secrets/expay-api-key
	rmdir secrets || true
	rm -rf -- "$temp_dir"
	exit "$result"
}
trap cleanup EXIT
mkdir -m 0700 secrets
openssl rand -hex 24 >secrets/admin-password
touch secrets/partner-api-key secrets/expay-api-key
chmod 0640 secrets/admin-password secrets/partner-api-key secrets/expay-api-key
sudo chown "$(id -u):1000" secrets/admin-password secrets/partner-api-key secrets/expay-api-key
db_password=$(openssl rand -hex 32)
redis_password=$(openssl rand -hex 32)
cat >"$temp_dir/env" <<EOF
APP_DOMAIN=revenda.invalid
ACME_EMAIL=ci@example.com
APP_ORIGIN=https://revenda.invalid
PUBLIC_API_URL=https://revenda.invalid
NODE_ENV=production
TRUST_PROXY=1
ADMIN_EMAIL=owner@example.com
POSTGRES_PASSWORD=$(openssl rand -hex 32)
DB_PASSWORD=$db_password
EVOLUTION_DB_PASSWORD=$(openssl rand -hex 32)
REDIS_PASSWORD=$redis_password
DATABASE_URL=postgresql://app:$db_password@postgres:5432/revenda?schema=public
REDIS_URL=redis://:$redis_password@redis:6379/0
ENCRYPTION_KEY=$(openssl rand -hex 32)
WEBHOOK_SECRET=$(openssl rand -hex 32)
EVOLUTION_API_KEY=$(openssl rand -hex 32)
PARTNER_API_KEY=
PIX_GATEWAY=disabled
EOF
# Explicitly replace job-level database/cache variables with this isolated stack's addresses.
while IFS= read -r line; do
	export "${line?}"
done <"$temp_dir/env"
dc config --quiet
dc up -d --no-build --wait --wait-timeout 420 postgres redis migrate api worker admin evolution
dc exec -T api node -e 'const r=await fetch("http://127.0.0.1:3000/health/ready");if(!r.ok)process.exit(1)' --input-type=module
dc exec -T worker node -e 'import("./dist/core/db.js").then(async({redis})=>{const v=await redis.get("worker:heartbeat");await redis.quit();process.exit(v?0:1)})'
dc exec -T admin wget -q -O /dev/null http://127.0.0.1:8080/health
dc exec -T evolution node -e 'const r=await fetch("http://127.0.0.1:8080");if(!r.ok)process.exit(1)' --input-type=module
dc run --rm --no-deps --entrypoint caddy proxy validate --config /etc/caddy/Caddyfile --adapter caddyfile
echo 'Compose: PostgreSQL, Redis, migrations, administrador, API, worker, painel e Evolution iniciados com saúde.'
