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
dc_previous() { timeout 480 docker compose --project-name "revenda_smoke_${GITHUB_RUN_ID}_${GITHUB_RUN_ATTEMPT:-1}" --env-file "$temp_dir/env" -f "$ROOT_DIR/compose.yaml" -f "$temp_dir/previous.yaml" "$@"; }
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
# Exercise the actual upstream migrations and volume reuse from the installed 2.3.7 image.
cat >"$temp_dir/previous.yaml" <<'EOF'
services:
  evolution:
    image: evoapicloud/evolution-api:v2.3.7@sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339
EOF
dc_previous up -d --wait --wait-timeout 420 postgres redis evolution
dc_previous exec -T evolution node -e 'require("fs").writeFileSync("/evolution/instances/.revenda-upgrade-smoke","TEST_ONLY_PERSISTED_SESSION")'
dc_previous exec -T postgres psql -U postgres -d evolution -v ON_ERROR_STOP=1 -c 'CREATE TABLE "RevendaUpgradeSmoke" (id integer PRIMARY KEY); INSERT INTO "RevendaUpgradeSmoke" VALUES (1);' >/dev/null
dc up -d --no-build --wait --wait-timeout 420 postgres redis migrate api worker admin evolution
dc exec -T api node -e 'const r=await fetch("http://127.0.0.1:3000/health/ready");if(!r.ok)process.exit(1)' --input-type=module
dc exec -T worker node -e 'import("./dist/core/db.js").then(async({redis})=>{const v=await redis.get("worker:heartbeat");await redis.quit();process.exit(v?0:1)})'
dc exec -T admin wget -q -O /dev/null http://127.0.0.1:8080/health
dc exec -T evolution node -e 'const r=await fetch("http://127.0.0.1:8080");if(!r.ok)process.exit(1)' --input-type=module
dc exec -T evolution node -e 'if(require("fs").readFileSync("/evolution/instances/.revenda-upgrade-smoke","utf8")!=="TEST_ONLY_PERSISTED_SESSION")process.exit(1)'
[[ "$(dc exec -T postgres psql -U postgres -d evolution -Atc 'SELECT count(*) FROM "RevendaUpgradeSmoke"')" == 1 ]] || {
	echo 'Dados da Evolution não foram preservados.' >&2
	exit 1
}
dc exec -T evolution node --input-type=module -e 'const r=await fetch("http://127.0.0.1:8080/license/status");const s=await r.json();if(!r.ok||s.status!=="inactive"||!s.instance_id)throw Error("Licensing status invalid");const gated=await fetch("http://127.0.0.1:8080/instance/fetchInstances",{headers:{apikey:process.env.AUTHENTICATION_API_KEY}});if(gated.status!==503||(await gated.json()).code!=="LICENSE_REQUIRED")throw Error("Licensing gate invalid");console.log("Evolution 2.3.7 -> 2.4.0-rc2: data/session sentinels preserved; activation required and observable.")'
dc run --rm --no-deps --entrypoint caddy proxy validate --config /etc/caddy/Caddyfile --adapter caddyfile
echo 'Compose: PostgreSQL, Redis, migrations, administrador, API, worker, painel e Evolution iniciados com saúde.'
