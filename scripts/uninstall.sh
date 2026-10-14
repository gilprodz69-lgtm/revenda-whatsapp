#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
root_required
load_env
read -r -p 'Digite PARAR para desligar/remover os containers (dados e segredos preservados): ' confirmation
[[ "$confirmation" == PARAR ]] || error 'Operação cancelada.'
systemctl disable --now revenda-backup.timer 2>/dev/null || true
dc down
echo 'Containers removidos. Volumes, backups, arquivos de ambiente e Docker foram preservados.'
