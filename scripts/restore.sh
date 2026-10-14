#!/usr/bin/env bash
set -euo pipefail
umask 077
source "$(dirname "$0")/common.sh"
root_required
load_env
backup_path=$(realpath -- "${1:?Uso: sudo bash scripts/restore.sh /caminho/backup.tar.gpg}")
[[ -f "$backup_path" ]] || error 'Backup não encontrado.'
echo 'A restauração substitui os bancos e sessões atuais. Todos os pedidos incertos serão reconciliados após o reinício.'
read -r -p 'Digite RESTAURAR para confirmar: ' confirmation
[[ "$confirmation" == RESTAURAR ]] || error 'Restauração cancelada.'
bash scripts/backup.sh
exec 9>secrets/backup.lock
flock -n 9 || error 'Outro backup/restauração em andamento.'
temp_dir=$(mktemp -d "$ROOT_DIR/backups/.restore-XXXXXXXX")
trap 'rm -rf -- "$temp_dir"' EXIT
gpg --batch --pinentry-mode loopback --passphrase-file secrets/backup-passphrase --decrypt "$backup_path" 2>/dev/null >"$temp_dir/archive.tar"
python3 - "$temp_dir" <<'PY'
import sys,tarfile,pathlib
root=pathlib.Path(sys.argv[1])
allowed={'revenda.dump','evolution.dump','redis.rdb','evolution-instances.tar.gz','environment','version','manifest'}
with tarfile.open(root/'archive.tar') as archive:
 for entry in archive.getmembers():
  name=entry.name.removeprefix('./')
  if entry.isdir() and name in ('','.'): continue
  if name not in allowed or not entry.isfile(): raise SystemExit('Conteúdo de backup inesperado.')
  with archive.extractfile(entry) as src, open(root/name,'wb') as dest: dest.write(src.read())
PY
[[ -f "$temp_dir/revenda.dump" && -f "$temp_dir/evolution.dump" && -f "$temp_dir/environment" ]] || error 'Backup incompleto.'
backup_key=$(sed -n 's/^ENCRYPTION_KEY=//p' "$temp_dir/environment")
[[ "$backup_key" == "$ENCRYPTION_KEY" ]] || error 'A ENCRYPTION_KEY atual difere do backup. Restaure o .env protegido apropriado antes de continuar.'
dc stop -t 90 api worker evolution >/dev/null
dc exec -T postgres pg_restore -U postgres --single-transaction --clean --if-exists --exit-on-error --dbname revenda <"$temp_dir/revenda.dump"
dc exec -T postgres pg_restore -U postgres --single-transaction --clean --if-exists --exit-on-error --dbname evolution <"$temp_dir/evolution.dump"
# Queues are rebuilt from the durable database outbox. Clear APP Redis only, keep Evolution cache.
dc exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli -n 0 FLUSHDB' >/dev/null
dc run --rm -T --no-deps --entrypoint tar evolution -xzf - -C /evolution/instances <"$temp_dir/evolution-instances.tar.gz"
dc up -d
bash scripts/healthcheck.sh --internal
echo 'Restauração finalizada. Verifique conexão WhatsApp e pedidos em revisão.'
