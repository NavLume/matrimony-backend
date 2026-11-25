#!/usr/bin/env bash
# Nightly PostgreSQL backup: dump, compress, encrypt, upload to a private bucket, keep a limited history.
#
#   0 2 * * *  /opt/matrimony/backend/scripts/backup-postgres.sh >> /var/log/matrimony-backup.log 2>&1
#
# Needs: pg_dump (same major version as the server), gzip, openssl, and for the upload the AWS CLI (it talks to
# Cloudflare R2 or S3). Nothing is printed that contains a secret.
#
# Environment (set in the cron job's environment or a root-only file that the cron line sources):
#   BACKUP_DATABASE_URL   connection string of a role that can read EVERY table. Use the owner (migration) role, NOT the
#                         runtime role: row-level security would hide the rows from the runtime role and the dump would be empty.
#   BACKUP_PASSPHRASE     the passphrase the dump is encrypted with. Keep a copy somewhere other than this server.
#   BACKUP_BUCKET         a PRIVATE bucket used only for backups, not the bucket that holds photos and documents.
#   BACKUP_ENDPOINT       R2: https://<account-id>.r2.cloudflarestorage.com (leave empty for S3)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   a key for that bucket only (ideally without the permission to delete
#                         anything except through this script's retention step).
#   BACKUP_DEST           optional: a local folder. When set, the file is kept there and nothing is uploaded (for tests).
#   BACKUP_KEEP_DAILY / BACKUP_KEEP_WEEKLY      default 7 and 4.
set -euo pipefail

: "${BACKUP_DATABASE_URL:?set BACKUP_DATABASE_URL}"
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
# A Sunday's dump is also kept as the weekly copy.
kind="daily"
[ "$(date -u +%u)" = "7" ] && kind="weekly"
name="matrimony-${kind}-${stamp}.sql.gz.enc"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "$(date -u +%FT%TZ) backup start ($kind)"
# --no-owner/--no-privileges so the dump restores into any database; the roles are created by the migrations.
pg_dump --dbname="$BACKUP_DATABASE_URL" --format=plain --no-owner --no-privileges \
  | gzip -9 \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE \
  > "$work/$name"

size="$(wc -c < "$work/$name")"
# A dump of a database with ~70 migrations is never this small; a tiny file means pg_dump produced nothing useful.
if [ "$size" -lt 2000 ]; then
  echo "backup file is only $size bytes; refusing to keep it" >&2
  exit 1
fi

if [ -n "${BACKUP_DEST:-}" ]; then
  mkdir -p "$BACKUP_DEST"
  cp "$work/$name" "$BACKUP_DEST/$name"
  echo "$(date -u +%FT%TZ) kept $name ($size bytes) in $BACKUP_DEST"
  # Retention for the local folder (same rule as the bucket).
  for k in daily weekly; do
    keep="$KEEP_DAILY"; [ "$k" = "weekly" ] && keep="$KEEP_WEEKLY"
    ls -1 "$BACKUP_DEST"/matrimony-$k-*.sql.gz.enc 2>/dev/null | sort | head -n -"$keep" | xargs -r rm -f
  done
  exit 0
fi

: "${BACKUP_BUCKET:?set BACKUP_BUCKET}"
aws_args=()
[ -n "${BACKUP_ENDPOINT:-}" ] && aws_args+=(--endpoint-url "$BACKUP_ENDPOINT")
aws "${aws_args[@]}" s3 cp "$work/$name" "s3://$BACKUP_BUCKET/$name" --no-progress
echo "$(date -u +%FT%TZ) uploaded $name ($size bytes)"

# Retention: keep the newest N of each kind. The names sort by time, so the oldest come first.
for k in daily weekly; do
  keep="$KEEP_DAILY"; [ "$k" = "weekly" ] && keep="$KEEP_WEEKLY"
  aws "${aws_args[@]}" s3 ls "s3://$BACKUP_BUCKET/" \
    | awk '{print $4}' | grep "^matrimony-$k-" | sort | head -n -"$keep" \
    | while read -r old; do
        aws "${aws_args[@]}" s3 rm "s3://$BACKUP_BUCKET/$old" --only-show-errors
        echo "$(date -u +%FT%TZ) removed $old"
      done
done
echo "$(date -u +%FT%TZ) backup done"
