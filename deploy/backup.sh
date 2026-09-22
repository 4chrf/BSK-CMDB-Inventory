#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
file="backups/cmdb-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
trap 'rm -f "$file.tmp"' EXIT
docker compose exec -T db sh -c 'export MYSQL_PWD="$(cat /run/secrets/db_root_password)"; exec mariadb-dump -uroot --single-transaction --quick --routines --events --triggers --databases cmdb' | gzip > "$file.tmp"
gzip -t "$file.tmp"
mv "$file.tmp" "$file"
printf 'Backup created: %s\n' "$file"
