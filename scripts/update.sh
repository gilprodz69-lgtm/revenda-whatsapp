#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
root_required
load_env
target=${1:?Uso: sudo bash scripts/update.sh vX.Y.Z}
[[ "$target" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || error 'Use uma tag de versão explícita (vX.Y.Z).'
git diff --quiet && git diff --cached --quiet || error 'Há alterações locais. Preserve-as antes da atualização.'
current=$(git rev-parse HEAD)
git fetch --tags origin
git rev-parse --verify "$target^{commit}" >/dev/null
installed=$(cat secrets/installed-version 2>/dev/null || echo 1.0.0)
destination=${target#v}
declared=$(git show "$target:package.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
[[ "$declared" == "$destination" ]] || error 'A tag de destino não corresponde à versão do package.json.'
[[ ${installed%%.*} == ${destination%%.*} ]] || error 'Atualização de versão principal exige revisão manual de compatibilidade e migrações.'
bash scripts/backup.sh
printf '%s\n' "$current" >secrets/rollback-commit
dc stop -t 90 api worker >/dev/null
git checkout --detach "$target"
dc build api admin
dc run --rm migrate
dc up -d
if ! bash scripts/healthcheck.sh --internal; then
	echo "Atualização sem saúde confirmada. Commit anterior salvo em secrets/rollback-commit: $current" >&2
	echo 'Não reverter automaticamente após migrations. Consulte docs/OPERACAO.md e restaure o backup se houver incompatibilidade.' >&2
	exit 1
fi
printf '%s\n' "$destination" >secrets/installed-version
echo "Atualização concluída: $installed → $destination. Volumes preservados."
