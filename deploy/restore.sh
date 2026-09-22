#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# -ne 2 || "$2" != "--replace" || ! -f "$1" ]]; then
  echo 'Usage: bash deploy/restore.sh backups/FILE.sql.gz --replace'
  echo 'Replaces database inventory, users, passwords and history. Back up first.'
  exit 1
fi
gzip -t "$1"
docker compose stop app
if ! gzip -dc "$1" | docker compose exec -T db sh -c 'export MYSQL_PWD="$(cat /run/secrets/db_root_password)"; exec mariadb -uroot'; then
  echo 'Restore failed. Application remains stopped; inspect the database before restarting.'
  exit 1
fi
docker compose exec -T db sh -c 'export MYSQL_PWD="$(cat /run/secrets/db_root_password)"; exec mariadb -uroot cmdb -e "DELETE FROM sessions; DELETE FROM login_limits;"'
docker compose start app
echo 'Database restored and old sessions revoked.'
