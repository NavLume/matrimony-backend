# Server settings checklist

What goes in the two settings files on the server, where each value comes from, and whether it is ready.
**No secret value is ever written here**, only where to find it. Secrets are typed by the operator straight into
the file on the server (`/etc/msbd/backend.env`, `chmod 600`) and kept in the password manager.

Status: ✅ known · ⏳ waiting on something · 🔒 secret, the operator enters it on the server

Last updated: 26 November 2026

## /etc/msbd/backend.env

| Variable | Value or source | Status |
|---|---|---|
| `NODE_ENV` | `production` | ✅ |
| `LOG_LEVEL` | `info` | ✅ |
| `DATABASE_URL` | `postgresql://matrimony_app:<password>@<private host>:25060/matrimony`; host from DigitalOcean, msbd-db, Connection details, **VPC network**; no `?sslmode=` | ⏳ after the runtime role is created · 🔒 password |
| `MIGRATION_DATABASE_URL` | `postgresql://doadmin:<password>@<private host>:25060/matrimony`; doadmin password from msbd-db Overview (show) | ⏳ after the `matrimony` database is created · 🔒 password |
| `DB_SSL` | `verify-full` | ✅ |
| `DB_CA_FILE` | `/etc/msbd/db-ca.crt` (msbd-db, Download CA certificate) | ⏳ download on the server day |
| `DB_POOL_MAX` | `10` (the 1 GB database allows 22 connections) | ✅ |
| `REDIS_URL` | `redis://redis:6379` | ✅ |
| `ALLOW_PLAINTEXT_LOCAL_SERVICES` | `true` (only Redis, on the same server) | ✅ |
| `TENANT_HOSTS` | `{"msbdmatrimony.com":"<agency id>","www.msbdmatrimony.com":"<agency id>"}` | ⏳ agency id after the agency row is created |
| `AUTH_JWT_PRIVATE_KEY` | new key: `npm run auth:keygen` (never the development one) | 🔒 generate on the server day |
| `SESSION_ENCRYPTION_KEY` | new: `openssl rand -hex 32` | 🔒 generate on the server day |
| `TRUST_PROXY` | `172.30.0.0/24` (the compose network "app") | ✅ |
| `MAIL_DRIVER` | `smtp` | ✅ |
| `MAIL_FROM` | `Marriage Solution BD <no-reply@msbdmatrimony.com>` (Brevo sender, verified) | ✅ |
| `SMTP_HOST` | `smtp-relay.brevo.com` | ✅ |
| `SMTP_PORT` | `587` | ✅ |
| `SMTP_TLS` | `starttls` | ✅ |
| `SMTP_USER` | Brevo, Settings, SMTP & API: "Login" (`...@smtp-brevo.com`) | ✅ known, copy on the day |
| `SMTP_PASSWORD` | Brevo, Settings, SMTP & API, Generate SMTP key, name `msbd-server` (shown once) | 🔒 generate on the server day; Brevo login needs Shammo Bhai's 2FA code |
| `SMS_DRIVER` | leave out (no SMS provider yet; phone sign-in stays hidden) | ✅ |
| `STORAGE_DRIVER` | `s3` | ✅ |
| `S3_BUCKET` | `msbd-files` | ⏳ Cloudflare R2 bucket not created yet |
| `S3_REGION` | `auto` | ✅ |
| `S3_ENDPOINT` | `https://<Cloudflare account id>.r2.cloudflarestorage.com` | ⏳ R2 not set up yet |
| `S3_ACCESS_KEY_ID` | R2 API token scoped to the buckets | ⏳ R2 · 🔒 |
| `S3_SECRET_ACCESS_KEY` | same token | ⏳ R2 · 🔒 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | optional; a **new** secret (the old one was exposed) and the callback `https://msbdmatrimony.com/api/v1/auth/google/callback` | ⏳ decide whether Google sign-in is on at the demo |

## /etc/msbd/frontend.env

| Variable | Value | Status |
|---|---|---|
| `CLIENT_IP_HEADER` | `cf-connecting-ip` | ✅ |
| `GOOGLE_SITE_VERIFICATION` | optional, Search Console | ⏳ after launch |
| `BACKEND_URL` | set by `compose.yaml` (`http://backend:3000`), not in this file | ✅ |

## Other files on the server

| File | Source | Status |
|---|---|---|
| `/etc/msbd/db-ca.crt` | DigitalOcean, msbd-db, Download CA certificate | ⏳ |
| `/etc/msbd/origin/cert.pem` | Cloudflare, SSL/TLS, Origin Server, Create certificate | ⏳ |
| `/etc/msbd/origin/key.pem` | same (shown once) | ⏳ · 🔒 |

## Not settings, but needed before the site works

- Cloudflare DNS: replace the Namecheap parking `A` record (162.255.119.15) and the `www` CNAME with the droplet
  (139.59.20.173), both proxied; SSL mode Full (strict).
- DigitalOcean Cloud Firewall: 80/443 from Cloudflare only, 22 from the operator.
- Database: create `matrimony`, run migrations, the `matrimony_app` role, the agency row, the first admin.
