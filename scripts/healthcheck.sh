#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
load_env
wait_for() {
	local label=$1
	shift
	for attempt in {1..90}; do
		if "$@" >/dev/null 2>&1; then return 0; fi
		sleep 2
	done
	error "Health check sem resposta: $label. Consulte os logs protegidos e repita scripts/healthcheck.sh."
}
wait_for backend dc exec -T api node -e 'fetch("http://localhost:3000/health/ready").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
wait_for worker dc exec -T worker node -e 'import("./dist/core/db.js").then(async({redis})=>{const v=await redis.get("worker:heartbeat");await redis.quit();if(!v)process.exit(1)}).catch(()=>process.exit(1))'
wait_for Evolution dc exec -T evolution node -e 'fetch("http://localhost:8080").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
wait_for painel dc exec -T admin wget -q -O /dev/null http://127.0.0.1:8080/health
if [[ ${1:-} != --internal ]]; then wait_for HTTPS curl -fsS --max-time 10 "https://$APP_DOMAIN/health/ready"; fi
echo 'Backend, banco, Redis, worker, Evolution e painel responderam aos health checks.'
activation=$(dc exec -T evolution node -e 'fetch("http://127.0.0.1:8080/license/status").then(async r=>{if(!r.ok)throw Error();const d=await r.json();console.log(d.status)}).catch(()=>process.exit(1))') || error 'Não foi possível consultar a ativação da Evolution.'
if [[ "$activation" != active ]]; then
	echo "Evolution aguardando ativação: abra https://$APP_DOMAIN, entre como proprietário e acesse WhatsApp → Iniciar ativação. O atendimento será liberado após concluir o cadastro oficial."
fi
