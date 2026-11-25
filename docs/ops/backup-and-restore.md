# Backup and restore (PostgreSQL)

Written 26 November 2026. The events of the platform are kept in the PostgreSQL table `matrimony.event_outbox`, so a PostgreSQL backup is also the backup of the event history. MongoDB (an optional copy of the events) is not needed for this.

## What runs

`scripts/backup-postgres.sh` makes a dump, compresses and **encrypts** it (AES-256, passphrase from the environment), uploads it to a private bucket and removes the oldest files so that 7 daily and 4 weekly copies remain (a Sunday's file counts as the weekly one). `scripts/restore-postgres.sh` restores a file into an **empty** database; it refuses a database that has tables.

Tested on 25 November 2026 against the local development database: a 3.2 MB encrypted file, restored into a new empty database, gave the same row counts (accounts, member profiles, events) as the source; a wrong passphrase fails; a non-empty target is refused. **Not tested:** the upload and the retention step against Cloudflare R2 (no key was available), and a restore on the production server.

## Set up on the server

1. Install `postgresql-client` (same major version as the server), `openssl`, `gzip` and the AWS CLI.
2. Make a **separate private R2 bucket** just for backups (not the bucket for photos and documents) and a key that only works on that bucket.
3. Choose a long random passphrase and keep a copy somewhere other than the server. **Without it a backup cannot be opened.**
4. Use the **owner (migration) database role** for `BACKUP_DATABASE_URL`. The application's runtime role is subject to row-level security and would dump no rows.
5. Put the variables in a file readable only by the user that runs cron (for example `/etc/matrimony-backup.env`, mode 600): `BACKUP_DATABASE_URL`, `BACKUP_PASSPHRASE`, `BACKUP_BUCKET`, `BACKUP_ENDPOINT` (`https://<account-id>.r2.cloudflarestorage.com`), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
6. Cron, every night at 02:00:
   `0 2 * * * . /etc/matrimony-backup.env && /opt/matrimony/backend/scripts/backup-postgres.sh >> /var/log/matrimony-backup.log 2>&1`
   (export the variables, for example with `set -a` in the env file.)
7. Check the log the next morning, and that a new file is in the bucket.

## Rehearse a restore (do it once before launch, then every few months)

1. Create an empty database on a scratch server or the same server (`CREATE DATABASE restore_check;`).
2. Download a backup file, then:
   `BACKUP_PASSPHRASE=... scripts/restore-postgres.sh matrimony-daily-....sql.gz.enc postgresql://.../restore_check`
3. Compare the printed counts with the live database, start the API against the restored database on another port and sign in as the admin.
4. Drop the scratch database.

## Optional: an audit copy of the events

The events are metadata only (what happened, who, when). If a separate readable copy is wanted (see the question for Shammo Bhai in the memory notes), export the outbox to a file in the backup bucket, for example `psql "$BACKUP_DATABASE_URL" -c "\copy (select agency_id, id, event, created_at from matrimony.event_outbox order by created_at) to stdout csv"`. Not built as a script.

## Alerts worth setting

The log has no "backup done" line for the day, the newest file in the bucket is older than 36 hours, or the file is far smaller than yesterday's.
