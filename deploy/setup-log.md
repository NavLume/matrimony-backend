# Server setup log

A running record of every step taken to put the site online: what was set up, where, with which choices, and why.
It becomes the full "how our hosting works" guide once the server is running. **No secret values here**, only where
each one lives. Settings values: [env-checklist.md](env-checklist.md). How to run and update: [README.md](README.md).

## Where everything lives

| Piece | Service | Account | Notes |
|---|---|---|---|
| Domain `msbdmatrimony.com` | Namecheap | Shammo Bhai | Ownership and yearly renewal stay here; nameservers point to Cloudflare |
| DNS, HTTPS in front, protection | Cloudflare (Free) | Navlumeai | Zone active 26 Nov 2026 |
| Files (photos, CVs, ID documents) and backups | Cloudflare R2 | Navlumeai | Waiting for Shammo Bhai to turn on the subscription |
| Server `msbd-app` | DigitalOcean Droplet | team "My Team" (user is a member without billing access) | Bangalore, Ubuntu 24.04 |
| Database `msbd-db` | DigitalOcean Managed PostgreSQL 16 | same | Bangalore, same private network as the server |
| Account emails | Brevo (Free) | NavLume (Navlumeai Gmail) | 2FA codes go to Shammo Bhai's phone |
| Code | GitHub | — | backend and frontend repositories |

Monthly cost: server $24 + database $15.15 = **$39.15**. Cloudflare, R2 (within the free tier) and Brevo: $0.

## Steps, in order

### 1. Server bought — 26 Nov 2026
- DigitalOcean, Create Droplet: region **Bangalore (BLR1)**; image **Ubuntu 24.04 LTS** (standard updates until April
  2029; 22.04 would end April 2027); plan **Basic, Regular SSD, 2 vCPU / 4 GB / 80 GB / 4 TB, $24**.
- Public **IPv4 on, IPv6 off**; Monitoring on (free); Backups **off** (the server keeps no data; see "Backups" in
  README.md); Volumes, startup script and the bundled database **off**.
- Login: SSH key only. Key pair made on the user's PC with `ssh-keygen -t ed25519`:
  private key `C:\Users\USER\.ssh\msbd_do` (never shared, protected by a passphrase kept in the password manager),
  public key added to DigitalOcean as **msbd-key**.
- Name **msbd-app**. Result: public IP **139.59.20.173**, private IP 10.122.0.2, network **default-blr1**.

### 2. Database bought — 26 Nov 2026
- DigitalOcean, Create Database Cluster: **PostgreSQL 16** (the version the code is tested on), **Standard** edition
  (permanent choice), **Bangalore**, Basic shared CPU, **1 vCPU / 1 GB / 22 connections**, **10 GiB**, storage
  autoscale **off** (keeps the bill fixed), name **msbd-db**, $15.15.
- Created in network **default-blr1**, the same private network as the server.
- Connection: port **25060**, TLS required. Admin user `doadmin` (password on the database's Overview page; never
  copied into chat).
- **Trusted sources: only `msbd-app`.** Before this the database accepted connections from anywhere; now nothing else
  can reach it, including our own PCs. Migrations will run from the server.

### 3. Domain moved to Cloudflare — 26 Nov 2026
- Cloudflare (Navlumeai account), Connect a domain, **Free** plan; the 8 records Namecheap had were imported.
- Shammo Bhai set Namecheap's nameservers to `shaz.ns.cloudflare.com` and `thomas.ns.cloudflare.com`.
  Cloudflare shows "Your domain is now protected by Cloudflare".
- Still pointing at Namecheap's parking page: the `A` record (162.255.119.15) and the `www` CNAME. They will point to
  the server when the site goes live.
- Kept: Namecheap's email forwarding (5 MX records and its SPF TXT).

### 4. Email service (Brevo) — 26 Nov 2026
- Why: the backend refuses to start in production without a real email service (registration links, password
  resets, staff invitations). Brevo Free allows 300 emails a day; Resend's free plan only 100.
- Account on Shammo Bhai's Navlumeai Gmail (company NavLume / Marriage Solution BD, address Lalmatia head office),
  phone verified, Free plan, no card.
- Domain authenticated: four records added in Cloudflare DNS:

  | Type | Name | Purpose |
  |---|---|---|
  | TXT | `@` | proves to Brevo that we own the domain (`brevo-code:...`) |
  | CNAME (DNS only) | `brevo1._domainkey` | DKIM signature key 1 |
  | CNAME (DNS only) | `brevo2._domainkey` | DKIM signature key 2 |
  | TXT | `_dmarc` | DMARC policy `p=none`, reports to Brevo |

  Together they tell Gmail and others that mail from @msbdmatrimony.com sent through Brevo is genuine, so it does not
  land in spam. The CNAMEs must stay grey-cloud (DNS only).
- Sender **Marriage Solution BD <no-reply@msbdmatrimony.com>** added; Brevo shows it Verified with DKIM and DMARC OK.
- SMTP: `smtp-relay.brevo.com:587`, login on Brevo's SMTP & API page. The SMTP key is made on the server day.

### 5. Deployment files written — 26 Nov 2026 (in the repositories, not yet committed)
- `frontend/Dockerfile`, `frontend/.dockerignore`, `frontend/next.config.ts` (`output: "standalone"`; checked with a
  production build).
- `backend/Dockerfile`: a `tools` stage for migrations and operator scripts.
- `backend/deploy/`: `compose.yaml` (caddy, frontend, backend, redis, tools), `Caddyfile`, env examples, README,
  this log and the settings checklist.

### 6. First login and securing the server — 26 Nov 2026
- First SSH login as root (the host fingerprint was accepted once; the PC now remembers it).
- `apt update && apt upgrade` (40 updates, 29 security), then a reboot for the new kernel (6.8.0-151).
  Ubuntu's own automatic security updates (unattended-upgrades) are on by default. Never run `do-release-upgrade`:
  we stay on 24.04 on purpose.
- Admin user **deploy**: in the `sudo` group, logs in with the same SSH key (copied from root); its sudo password is
  in the password manager ("MSBD server - deploy sudo password").
- SSH locked down in `/etc/ssh/sshd_config.d/00-msbd-hardening.conf`: no root login, no password login, keys only.
  Checked: root is refused (`Permission denied (publickey)`), deploy gets in.
- From now on: `ssh -i $env:USERPROFILE\.ssh\msbd_do deploy@139.59.20.173`.

### 7. Swap and Docker — 26 Nov 2026
- 2 GB swap file `/swapfile`, listed in `/etc/fstab` so it survives a restart (the website build needs more than
  4 GB of RAM at its peak).
- Docker Engine 29.10.1 and Docker Compose v5.8.0 from Docker's own apt repository (`/etc/apt/sources.list.d/docker.list`,
  signing key `/etc/apt/keyrings/docker.asc`); they update with the normal `apt upgrade`.
- `deploy` is in the `docker` group (runs docker without sudo; this group is as powerful as root, so only admins
  belong in it). `docker run --rm hello-world` worked.

### 8. Firewall — 26 Nov 2026
- DigitalOcean Cloud Firewall **msbd-web-fw**, applied to msbd-app (Networking → Firewalls). Not ufw on the server:
  Docker opens its own ports and would slip past ufw; the cloud firewall sits outside the server.
- Inbound: SSH 22 from anywhere (keys only); HTTP 80 and HTTPS 443 **only from Cloudflare's 15 IPv4 ranges**
  (https://www.cloudflare.com/ips-v4, checked 26 Nov 2026); everything else blocked. Outbound: all allowed.
- Checked from outside: port 80 on the IP times out (blocked), port 22 answers.
- If Cloudflare ever adds ranges, add them to both rules (they announce changes on that page).

## Next
- R2: Shammo Bhai turns on the subscription; then buckets `msbd-files` and `msbd-backups` (private) and a token
  limited to them.
- First login to the server, updates, a sudo user, SSH hardening, swap, Docker, firewall.
- Cloudflare origin certificate and SSL mode Full (strict); DNS to the server.
- Database: `matrimony` database, migrations, runtime role, agency, first admin.
- Commit and push the code, build and start, smoke test, backups.
