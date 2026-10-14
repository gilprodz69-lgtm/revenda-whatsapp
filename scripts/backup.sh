#!/usr/bin/env bash
set -euo pipefail
umask 077
source "$(dirname "$0")/common.sh"
root_required
load_env
[[ -s secrets/backup-passphrase ]] || error 'Passphrase de backup ausente.'
command -v gpg >/dev/null || error 'Instale gnupg antes do backup.'
exec 9>secrets/backup.lock
flock -n 9 || error 'Backup/restauração já em andamento.'
install -d -m 0700 backups
temp_dir=$(mktemp -d "$ROOT_DIR/backups/.stage-XXXXXXXX")
backup_file="$ROOT_DIR/backups/revenda-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM.tar.gpg"
resume() {
	dc up -d api worker evolution >/dev/null 2>&1 || true
	rm -rf -- "$temp_dir"
}
trap resume EXIT
echo 'Pausando gravadores para um backup consistente…'
dc stop -t 90 api worker evolution >/dev/null
dc exec -T postgres pg_dump -U postgres -Fc revenda >"$temp_dir/revenda.dump"
dc exec -T postgres pg_dump -U postgres -Fc evolution >"$temp_dir/evolution.dump"
dc exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli SAVE' >/dev/null
dc cp redis:/data/dump.rdb "$temp_dir/redis.rdb" >/dev/null
dc run --rm --no-deps --entrypoint tar evolution -C /evolution/instances -czf - . >"$temp_dir/evolution-instances.tar.gz"
cp .env "$temp_dir/environment"
cp secrets/installed-version "$temp_dir/version" 2>/dev/null || printf '1.0.0\n' >"$temp_dir/version"
printf '%s\n' 'schema=1' >"$temp_dir/manifest"
tar -C "$temp_dir" -cf - . | gpg --batch --yes --pinentry-mode loopback --passphrase-file secrets/backup-passphrase --symmetric --cipher-algo AES256 --output "$backup_file"
chmod 0600 "$backup_file"
sha256sum "$backup_file" >"$backup_file.sha256"
retention=${BACKUP_RETENTION_DAYS:-14}
[[ "$retention" =~ ^[0-9]+$ && "$retention" -ge 1 ]] || error 'Retenção inválida.'
find "$ROOT_DIR/backups" -maxdepth 1 -type f \( -name 'revenda-*.tar.gpg' -o -name 'revenda-*.tar.gpg.sha256' \) -mtime "+$retention" -delete
echo "Backup criptografado criado: $backup_file"
