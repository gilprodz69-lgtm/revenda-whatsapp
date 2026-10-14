#!/usr/bin/env bash
set -euo pipefail
[[ "$DB_PASSWORD" =~ ^[a-f0-9]{64}$ && "$EVOLUTION_DB_PASSWORD" =~ ^[a-f0-9]{64}$ ]] || {
	echo 'Senhas de banco devem ser hexadecimais de 64 caracteres.' >&2
	exit 1
}
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres >/dev/null <<SQL
CREATE USER app WITH PASSWORD '$DB_PASSWORD';
CREATE USER evolution WITH PASSWORD '$EVOLUTION_DB_PASSWORD';
CREATE DATABASE revenda OWNER app;
CREATE DATABASE evolution OWNER evolution;
REVOKE ALL ON DATABASE revenda FROM PUBLIC;
REVOKE ALL ON DATABASE evolution FROM PUBLIC;
SQL
