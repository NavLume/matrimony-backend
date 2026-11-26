# Production on one server

One DigitalOcean droplet (Bangalore, Ubuntu 24.04, 2 vCPU / 4 GB) runs four containers from `compose.yaml`:

| Container | What it does | Reachable from |
|---|---|---|
| caddy | HTTPS on 80/443, passes every request to the website | Cloudflare only (firewall) |
| frontend | Next.js website; it also forwards `/api/v1/*` to the API | caddy |
| backend | Fastify API | frontend |
| redis | sessions and request limits | backend |

Outside the server: the database (DigitalOcean managed PostgreSQL 16, same VPC), files (Cloudflare R2), DNS and the
public certificate (Cloudflare, proxied, SSL mode Full (strict)). The server holds no data that needs a backup; Redis
only holds sessions (losing it signs everybody out).

Images are built on the server from the two git checkouts. With 4 GB of RAM the website build needs the swap file below.

## Files on the server that are not in git

```
/etc/msbd/backend.env      from deploy/backend.env.example, chmod 600
/etc/msbd/frontend.env     from deploy/frontend.env.example, chmod 600
/etc/msbd/db-ca.crt        the database's CA certificate (DigitalOcean: database, Connection details, Download CA certificate)
/etc/msbd/origin/cert.pem  Cloudflare origin certificate (SSL/TLS, Origin Server, Create certificate)
/etc/msbd/origin/key.pem   its private key, chmod 600
```

Keep a copy of the two env files in a password manager: a new server needs them.

## First setup (once)

1. SSH in as root with the key, create a sudo user, turn off password and root login over SSH.
2. Swap: `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`, and add it to `/etc/fstab`.
3. Install Docker Engine and the compose plugin from Docker's apt repository.
4. DigitalOcean Cloud Firewall on the droplet: SSH (22) from the operators' addresses; 80 and 443 from Cloudflare's
   IP ranges only (https://www.cloudflare.com/ips/). Without this, anyone could reach Caddy directly and send a false
   `cf-connecting-ip`.
5. Database: trusted sources = this droplet only. Create the `matrimony` database, run the migrations as `doadmin`,
   then create the runtime login (`matrimony_app`, LOGIN, NOSUPERUSER, NOBYPASSRLS, `GRANT matrimony_runtime`), the
   agency row and the first admin. The API refuses to start as a superuser or a role that bypasses row-level security.
6. Clone both repositories into `/opt/msbd/backend` and `/opt/msbd/frontend`, put the files above in `/etc/msbd`.

## Run and update

```
cd /opt/msbd/backend/deploy
docker compose run --rm tools          # migrations (also after every update that adds one)
docker compose up -d --build           # build and start, or rebuild after git pull in either repository
docker compose ps                      # all healthy?
docker compose logs -f backend         # follow a service's log
```

Update: `git pull` in both checkouts, run the migrations, then `docker compose up -d --build`. Old images:
`docker image prune -f`.

Rollback: `git checkout <previous commit>` in the checkout that changed and `docker compose up -d --build`. A migration
is never rolled back automatically.

## Backups

The managed database keeps daily backups with 7 days of point-in-time recovery, but they are deleted with the cluster.
A second copy goes to the R2 bucket `msbd-backups` with `scripts/backup-postgres.sh` (see `docs/ops/backup-and-restore.md`).

## Later

- Ubuntu 24.04 gets standard updates until April 2029.
- PostgreSQL 16 is supported until November 2028; test 17 before then.
