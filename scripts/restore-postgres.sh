#!/usr/bin/env bash
# Restore a backup made by backup-postgres.sh into an EMPTY database. Use it to rehearse a restore (do this once
# before launch, and now and then), or to recover.
#
#   restore-postgres.sh <backup-file.sql.gz.enc> <empty-database-url>
#
# The passphrase comes from BACKUP_PASSPHRASE. The target must be an empty database: this script does not drop or
# clean anything. After restoring, run the application's checks against it (the table counts below are a first look).
set -euo pipefail

file="${1:?usage: restore-postgres.sh <backup-file> <empty-database-url>}"
target="${2:?usage: restore-postgres.sh <backup-file> <empty-database-url>}"
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"

existing="$(psql "$target" -At -c "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')")"
if [ "$existing" != "0" ]; then
  echo "the target database is not empty ($existing tables); refusing to restore into it" >&2
  exit 1
fi

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$file" \
  | gunzip \
  | psql "$target" -v ON_ERROR_STOP=1 --quiet --single-transaction >/dev/null

echo "restored. rows in a few tables:"
psql "$target" -At -c "select 'accounts', count(*) from matrimony.accounts union all select 'member_profiles', count(*) from matrimony.member_profiles union all select 'event_outbox', count(*) from matrimony.event_outbox"
