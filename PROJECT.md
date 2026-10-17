# Project handoff: read this first

Last updated: 14 October 2026 (**A client's own login (14 October 2026, in review): an agent sends a client with no account a one-time link by text message or email, the client chooses their own password and the account becomes the owner of the existing assisted profile** (migration 025, `client_logins`, `docs/features/discovery-loop.md`); ideas kept apart in `docs/features/suggested-features.md`; **Phase 3 confirmed in the owner's browser pass (13 and 14 October 2026), features 1 to 13**, with fixes from it: review decisions, request approval, shared contact and an invited person joining each write an inbox line; CVs waiting are listed in the review queue; a declined request is reopened by closing it (not returned to the queue); registration names an address that already has an account (409 EMAIL_ALREADY_REGISTERED); every real-database suite passes after the staff suite was updated for automatic assignment; decisions on reviews are told to the person they are about, and CVs waiting for a decision are listed in the review queue; 3.O live notifications, more inbox lines, automatic agent assignment and direct staff accounts; 3.J CV upload and 3.K to 3.N built and in review; decisions from the friend meeting of 12 October recorded; inbox read state 3.G.1, the agent's review of requests 3.H and withdrawn requests for a matched or paused profile 3.I built and in review). If you are a coding agent that has just been opened on this project, read this file completely, then the files listed in [Where to read next](#where-to-read-next). Then tell the user, in about ten lines, what you understood, and wait.

This file lives in the **backend** repo. The **frontend** repo has a shorter `PROJECT.md` that points here.

## 1. What this project is

A **white-label, multi-tenant matrimony platform for Bangladeshi marriage agencies**.

- The first agency (tenant) is **Marriage Solution BD (MSBD)**. Each agency gets its own hostname, branding and members; one deployment serves many agencies.
- **Bengali-first** and mobile-friendly. Every screen exists in Bengali (`bn`, the default) and English (`en`).
- **Roles:** `admin` and `agent` (agency staff) and `member` (the people looking for a match, or a parent registering for a son, daughter or relative).
- **Money:** basic access is free; members pay for subscriptions through **bKash** (each agency has its own merchant account); assisted-service fees are negotiated and recorded by hand by agents.
- **Scope:** 20 launch features, 14 full-depth and 6 thin, defined in `docs/design/launch-features.md`. Excluded on purpose: CMS, chat, PDF biodata, a tenant admin UI, a super-admin portal, agency SaaS billing.
- A **React Native mobile app** is planned for later. Nothing of it exists yet.

## 2. The people and how we work

- The **user** is a frontend-focused full-stack developer who builds **both repos**. They want production-grade work ("like the best production application"), not a demo.
- The **friend** (a Java developer) wrote the backend scaffold and the design documents in `docs/design/` and only helps occasionally. **Do not edit his documents** (everything in `docs/design/` except `authentication.md`, which is ours). Report disagreements instead of silently changing them.
- Working style the user asked for:
  - **Short answers, main points only.** No long explanations unless asked.
  - Work in **small vertical slices** (one user journey through database, backend and frontend), and **finish a phase in order** before starting the next.
  - **Statuses must be honest:** "In review" until the user has tried it in a real browser; "Done" only with evidence or the user's say-so.
  - After each task, update the tracker (below) and the docs.
  - **Never paste or print secrets** (the Google client secret, signing keys, database passwords). They live only in the backend `.env`.
  - Use **they/them** for people whose pronouns are not stated.
- The backend has strict engineering rules in [AGENTS.md](AGENTS.md) (layering, tests required for SQL and sessions, versioned migrations, security review before launch). Follow them.

## 3. Repositories and stack

| Repo                 | GitHub                                              | Stack                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend` (this one) | `shammya/matrimony-backend`                         | Node 24, TypeScript (strict), Fastify, PostgreSQL 17 with row-level security, Redis (sessions and one-time codes), MongoDB (event copy, optional), `sharp` for photos, S3-compatible storage |
| `frontend`           | `shammya/launchpad-mvp` (branch `nextjs-migration`) | Next.js 16 (App Router), TypeScript, Tailwind 4, shadcn/ui, next-intl, TanStack Query, React Hook Form + Zod, Vitest, Playwright                                                             |

The two repos sit **side by side** (for example `…/matromony/backend` and `…/matromony/frontend`). The frontend generates its API types from `backend/docs/api/openapi.yaml`, so they must be next to each other.

How the agency is chosen: **the request's `Host` header**, mapped by `TENANT_HOSTS` in the backend `.env`. The browser calls `/api/v1/...` on the Next.js origin, a proxy route forwards it to the backend **with the original `Host`**. Never choose the agency from user input.

## 4. How to run it on a new machine

Needed: Node 24, PostgreSQL 17, Redis **6.2 or newer** (the code uses `GETDEL`; on Windows install Redis inside WSL, the Windows build is too old), optionally MongoDB (only the event worker and one integration test need it).

**Backend** (`backend/`):

1. `npm ci`
2. `cp .env.example .env` and fill it in. You must set: the `DATABASE_URL` and `MIGRATION_DATABASE_URL` roles, `SESSION_ENCRYPTION_KEY` (`openssl rand -hex 32`), `AUTH_JWT_PRIVATE_KEY` (`npm run auth:keygen`), `PORT=4000` (so it does not clash with Next.js on 3000), `TENANT_HOSTS`. For development also keep `MAIL_DRIVER=console` and `SMS_DRIVER=console` (emails and text messages are **printed in the backend terminal**). `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are optional: without them the Google button is simply hidden.
3. Start PostgreSQL and Redis (`docker compose up -d` works, or use local installs).
4. `npm run db:migrate` (uses `MIGRATION_DATABASE_URL`; migrations are numbered `001`…`015` and are never edited once applied).
5. Seed the local agency and runtime role with `scripts/local-seed.sql` (see README, "Local setup").
6. Create the first administrator: `scripts/provision-account.sql`, then `npm run auth:set-password -- --agency <uuid> --email <email>`. Every other staff member is invited by an admin from the Staff page (the link is printed in the backend terminal as `[dev mail]`).
7. `npm run dev` (API on 4000). `npm run dev:worker` is only for the MongoDB event copy.

**Frontend** (`frontend/`): `npm ci`, `cp .env.example .env.local` (`BACKEND_URL=http://127.0.0.1:4000`), `npm run dev`, open `http://localhost:3000`. The hostname `localhost` is the seeded agency.

**Checks before you hand work back:**

- Backend: `npm run check` (types, lint, dependency rules, unit and HTTP tests, build). Integration tests need real services: `TEST_DATABASE_URL` (database **named `matrimony_scaffold_test`**) and `TEST_REDIS_URL`, then `npm run test:integration`.
- Frontend: `npm run check`, then `npm run test:e2e` (browser tests against a stand-in backend, `tests/e2e/stub-backend.mjs`; first run `npx playwright install chromium`).
- Known, unrelated failures: 2 About-page browser tests (`public-pages.spec.ts`, the first line of the agency text appears twice). Do not "fix" them while doing other work; report them.

Neither repo's `.env`, `.env.local`, `storage/` or `node_modules/` is in git. A new machine has to recreate them.

## 5. The plan: phases and where we are

The 20 features are numbered as in `docs/design/launch-features.md` (1.1 … 5.3). The order is **foundation, then onboarding and approval, then discovery, then the paid loop, then hardening**. There are no dates, only this order.

Status key: **Done** = confirmed by the user in a real browser (or proven by tests where no screen exists). **Review** = built and tested, waiting for the user to try it. **-** = not started.

### Phase 0: Foundation (complete, except the items marked)

| Item                                                                        | Backend                                    | Frontend                                        |
| --------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| Platform base, tenants, public config                                       | Done                                       | Done                                            |
| Public shell, signed-in shell, role guards, language switch, theming        | n/a                                        | Done                                            |
| i18n (bn/en parity, formats), form helpers                                  | n/a                                        | Done                                            |
| Email + password login, session restore, refresh, logout                    | Done                                       | Done                                            |
| Forgot / reset password                                                     | Done                                       | Done                                            |
| Account emails (console and SMTP drivers)                                   | Review                                     | n/a                                             |
| Sign in with Google                                                         | Done                                       | Done                                            |
| Sign in with a phone number and code                                        | **Done**                                   | **Done**                                        |
| Add an email to a phone-only account (code to their own phone, then a link) | **Done**                                   | **Done**                                        |
| Password at phone registration, login with phone + password                 | **Done**                                   | **Done**                                        |
| Change the password with a code to the phone                                | **Done**                                   | **Done**                                        |
| Event log (outbox → MongoDB worker)                                         | Review (worker never run here: no MongoDB) | n/a                                             |
| Local environment                                                           | Done                                       | Done                                            |
| Tests and CI                                                                | n/a                                        | Done (CI workflow written, never run on GitHub) |
| Device sessions for the mobile app                                          | **Planned, deliberately skipped for now**  | n/a                                             |

### The 20 launch features, matched to `docs/design/launch-features.md`

Checked against each row's "launch completion criterion" on 9 October 2026. **Built** = what we built works and the user confirmed it (or it awaits their try: Review). **Launch criterion met?** is the stricter test from the file: **Partly** means something the file requires is missing. A feature is ticked in the file only when the full criterion has evidence.

| Phase | ID  | Feature                      | Depth | Built | Launch criterion met? | What is missing against the file                                                                                 |
| ----- | --- | ---------------------------- | ----- | ----- | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1     | 1.1 | Homepage                     | Full  | Done  | Partly                | Pricing link (needs 1.3); real MSBD branding and Bengali copy from the client                                    |
| 1     | 1.4 | Success stories              | Thin  | Done  | Partly                | Six real approved stories and the couples' consent (sample data now)                                             |
| 1     | 1.5 | About/contact                | Full  | Done  | Partly                | Three real branch addresses and map links (sample data now)                                                      |
| 2     | 1.2 | Phone OTP registration       | Full  | Done  | Partly                | Real SMS OTP (console driver now), Turnstile, security review; draft profile is created on first My Profile save |
| 2     | 2.1 | My Profile and edit requests | Full  | Done  | Yes, on dev defaults  | Final biodata fields and option lists from the client                                                            |
| 2     | 4.2 | Profile approval queue       | Full  | Done  | Yes                   | None found                                                                                                       |
| 2     | 4.3 | Agent client management      | Full  | Done  | Yes                   | Client photos and disabling staff are not built (not in the criterion)                                           |
| 3     | 3.1 | Basic search                 | Full  | -     | No                    | Everything. Now searches inside the client's released set only                                                   |
| 3     | 3.2 | Advanced search              | Thin  | -     | No                    | Everything. Works inside the released set; plan gating is decided in Phase 4                                     |
| 3     | 3.3 | Profile detail/paywall       | Full  | -     | No                    | Everything. Access follows the agent's release; payment rules come in Phase 4                                    |
| 3     | 2.2 | My Matches                   | Full  | -     | No                    | Everything. Becomes the dashboard of the set an agent approves; also unblocks 4.3                                |
| 3     | 2.3 | Interest and mutual match    | Full  | -     | No                    | Everything (connection request to someone in the set)                                                            |
| 3     | 2.4 | Inbox                        | Thin  | -     | No                    | Everything                                                                                                       |
| 4     | 5.3 | Feature gating               | Thin  | -     | No                    | Everything. Moved back from Phase 3: payment options are per agency and agent-controlled                         |
| 4     | 1.3 | Pricing page                 | Full  | -     | No                    | Everything; real plans and prices from the client                                                                |
| 4     | 4.4 | Plan management              | Thin  | -     | No                    | Everything                                                                                                       |
| 4     | 5.1 | bKash sandbox checkout       | Full  | -     | No                    | Everything; sandbox credentials                                                                                  |
| 4     | 5.2 | Manual payment recording     | Full  | -     | No                    | Everything                                                                                                       |
| 4     | 2.5 | Payment status               | Full  | -     | No                    | Everything (after 5.1 and 5.2)                                                                                   |
| 4     | 4.1 | Admin dashboard              | Thin  | -     | No                    | Everything                                                                                                       |

**Phase 3 changed on 10 October 2026** after the owner's meeting with the friend: discovery is now **agent-curated**. The system proposes a candidate list per client from their preferences, an agent or admin approves and releases it (a cap such as 50, chosen fields), the client sees and searches only that set, and sends connection requests inside it. The agent's choice wins over the client's preferences. Full description, decisions, slices and acceptance: [docs/features/discovery-loop.md](docs/features/discovery-loop.md). **Slice 3.A (detailed preferences: profession, smoking, children, relocation and seven preference lists) was built on 10 October 2026 and is in Review** (migration 012), and **slice 3.B (candidate generation, backend only, migration 013) was built the same day**: staff press Find candidates, or an approval refreshes a profile's list, and the best 100 published profiles are proposed by two-way fit, and **slice 3.C (staff review and release) was built the same day**: on a published client's page staff see the proposals with why each fits (both directions), release them into the client's window up to the cap (default 50, never exceeded), remove unsuitable ones for good, and choose which fields the client will see (migration 014). It is in Review. **Confirmed in a real browser on 11 October 2026: two real members were assigned to an agent, the agent found and released candidates, one member asked the other, the other accepted, and both showed as connected. Done: 3.A, 3.B, 3.C, 3.D, 3.E (advanced search and the full profile page) and 3.F in full (ask, accept, decline, withdraw, contact sharing, the inbox, and staff answering for a client who has no login).** Basic search was confirmed the same day, so **all of Phase 3 is Done** except what depends on later phases (plan limits on advanced search and profile access, Phase 4) and your friend's confirmation of the connection rules. **Slice 3.D (the client's own page) was built the same day**: a member opens **My matches** and sees only what staff released, with only the fields staff chose (those are the only columns read), photos when allowed, and a simple search inside that set (member code, age, religion, marital status, profession, district, minimum education); a filter on a field the member may not see is refused, so a hidden value cannot be found out by searching. It is in Review. **Slices 3.E and 3.F were built the same day, also in Review**: advanced search (height, income, family status, district of origin; complexion is not a filter) and a full profile page; connection requests (ask, answer, withdraw, two people asking each other become one accepted connection, declined is final) with an inbox, contact sharing after acceptance on each side's own say, and staff answering for clients who have no login. Migration 015 uses the original `interests` and `notifications` tables. The rules chosen without discussion are listed at the end of [docs/features/discovery-loop.md](docs/features/discovery-loop.md) for the friend to confirm. **Friend meeting of 12 October 2026 (owner reported answers to questions 1 to 29): finish Phase 3 first, then decide Phase 4.** Decisions: every client is handled by an agent and must have one assigned from the start; the agent approves a request before it reaches the asked person (reminded after 2 days, then every 3; the admin is told when a client has no agent); a declined pair can be reopened by an agent; names stay hidden until acceptance; a matched or paused profile drops out of lists and its pending requests are withdrawn with the senders told; a request may carry a short note with a word limit; every change to an approved profile is reviewed; a CV upload and a full details page for connected clients; a family member may register for a client; the admin disables staff and reassigns a leaving agent's clients; a nightly candidate refresh; payment gateway is SSLCommerz (Phase 4). **Built so far from this list: slice 3.G.1, read state for the inbox** (migration 016 `notifications.read_at`, `GET /me/notifications/unread-count`, `POST /me/notifications/read`, an unread badge on the Inbox link refreshed every 20 seconds, new lines marked New), in Review. **Slice 3.H, the agent reviews a request before the person asked sees it, was then built the same day** (migration 017, review queue and reminders, reopen, a short note; in Review, see the end of `docs/features/discovery-loop.md`). **Slice 3.I was built the same day** (a profile that matches, pauses or closes drops its waiting requests and the senders are told; no migration; in Review). **Slice 3.J, a CV (one PDF) for every profile, was built on 13 October 2026** (migration 018; a member's upload waits for staff, staff publish at once for an assisted client, a replacement keeps the old one shown until approved, only an accepted connection sees it; in Review). **Slices 3.K (a family member who uses the account must be named), 3.L (turn staff off and on, hand a leaving agent's clients over, a history of who looked after each client), 3.M (a nightly refresh of candidate proposals, and the member code field of the filter box switched on per client) and 3.N (the audit that every change to an approved profile is reviewed, and digits that follow the page's language) were built on 13 October 2026** (migrations 019 and 020; in Review). **Slice 3.O (13 October 2026): inbox lines for a release to a client, a review request, and a new client; live push by server-sent events (a database trigger and one listening connection); every new profile is given to the agent with the fewest clients; an admin can create a staff account directly** (migrations 021 to 024; in Review). Phase 3 as decided on 12 October 2026 is now built in full and waits for the owner's browser pass. Still open: Phase 4 (plans, SSLCommerz payments, request limits), Phase 5 hardening and Phase 6 agency configuration. **Known gap (raised 11 October 2026): notifications are narrow.** The inbox only holds connection events. Nobody is told when a profile, change or photo is submitted (staff) or decided (the owner), when matches are released to a member, when contact is shared, or when a client is assigned; and nothing is pushed live (the review count refreshes every 60 seconds, everything else only on open). Tracked as 3.7 on the backend tracker and 2.4+ on the frontend tracker, waiting on the friend's decision about read and unread state and how live it must be. Gating and payments are still Phase 4, so nothing here is plan-limited yet; chat is undecided and not built. The rest of the plan is a proposal until the friend confirms it, and `launch-features.md` has not been edited. 5.3 went back to Phase 4 because payment options are per agency and agent-controlled.

Not built in Phase 2: client photos, disabling or removing staff, changing a staff member's role. Staff invitations were confirmed in a browser on 11 October 2026.

### Phase 5: Hardening and launch (not started)

These are the file's "Required cross-cutting acceptance" items, plus launch work:

- A second synthetic tenant proves isolation across API reads and writes, sessions, relationships, cache keys and private media.
- Unapproved content, internal notes and protected contacts never appear in unauthorized responses; duplicate payments, stale approvals and concurrent last-quota requests stay correct.
- Provider and worker failures show truthful pending or error states and recover without duplicate charges.
- Bengali copy, dates, amounts and mobile layouts checked throughout; UTF-8 free text preserved.
- Logging, alerts and a **tested backup restore**; tests on the real stack (including MongoDB if it is kept).
- **Security review by an experienced person**, then production deployment.
- The end-to-end acceptance journey from the file (CEO registers with a real OTP, is approved, searches, expresses interest, hits a gate, pays by bKash sandbox; an agent records partial and final manual receipts; admin cards are correct) passes on staging with synthetic accounts.

### Phase 6: Agency configuration (decision needed, not started)

The owner wants each agency's admin to configure fields, visible data and payment options. It is **skipped for now**. Before any work: the friend must say whether "tenant-facing UI" in the launch file excludes an agency-admin settings screen, and whether launch can start with the platform owner configuring each agency. Phase 3 uses fixed field lists kept in one place so they can later become per-agency definitions.

### Friend feedback of 16 October 2026 (built 17 October unless noted)

- **Inbox filters:** `GET /api/v1/me/notifications` takes `group`, `read`, `from`, `to`, `q` and (staff) `client`. The search matches member codes, and names only where the reader may see names; LIKE characters in the search are escaped.
- **Candidates include everyone connected:** accepting a connection releases both profiles to each other in the same transaction (`releaseBoth`); migration 030 added the pairs accepted earlier. The candidate list item has `connection` (`status`, `direction`). The word Connections became Proposals in the frontend.
- **Payments moved outside the platform (decided, not built):** no plans, pricing page, plan limits or bKash checkout. Phase 4 is now: agreements (Registration fee before a match, Success fee after) and payment records with an invoice file (PDF, JPG or PNG up to 5 MB), cancelled by an admin with a reason and never deleted; the client sees their own history and balance; and the admin dashboard with proposal, agent and money charts (fiscal year July to June). See the trackers and `friend-feedback-2026-10-17` in memory.

- **Payments recorded in the office (built 17 October 2026):** migration 031 (`client_agreements`, `client_payments`; the runtime role may add rows, set an agreement, attach an invoice once and cancel a payment, never delete). Staff of the client (or an admin) set the agreed amount per stage (`registration`, `success`), record payments (whole taka, date not in the future, method, optional receipt number, note, accepted proposal) and attach the invoice (PDF, JPG or PNG up to 5 MB, first bytes checked, stored like CVs). Only an admin cancels a payment, with a reason; the record stays. A member sees their own ledger without the cancel reason. Endpoints under `/api/v1/staff/clients/{profileId}/payments|agreements` and `/api/v1/me/payments`. Code: `service/payment-service.ts`, `controller/payment-controller.ts`, `db/raw/repository/payment-repository.ts`. **Not built:** the admin dashboard reports (slice C). Dev database holds test payments for Rahim.

- **Admin reports (built 17 October 2026):** read-only, admin only. `GET /api/v1/admin/reports/summary?basis=&year=` (people, reviews waiting, proposals by stage and the funnel, twelve months, each agent's figures, and the money of one financial year July to June or calendar year, plus agreed and paid per client), `/proposals` (every proposal, filter and search, paged) and `/network?client=` (one client's proposals or the newest 60 accepted). Cancelled payments never count. Code: `service/report-service.ts`, `db/raw/repository/report-repository.ts`, `controller/report-controller.ts`; test `test/report-service.test.ts`.

### Mobile app groundwork (started 14 October 2026)

One app for every agency; the person types an agency code. Built so far, all additions beside the website:

- `GET /api/v1/public/agency-by-code?code=` finds an agency by `agencies.app_code` (migration 026, 4 to 12 upper-case letters or digits, filled from the slug for existing agencies). It answers with the agency's public look and its `hostname`, which the app then uses for every other call. It needs no tenant host and is limited to 20 a minute. `IdentityService.byCode` reads each configured agency once a minute into memory.
- `GET /api/v1/public/app-version?platform=&version=` answers `supported`, `updateAvailable`, `minimumVersion`, `latestVersion` and `storeUrl` from the `APP_MIN_VERSION_*`, `APP_LATEST_VERSION_*` and `APP_STORE_URL_*` settings (all optional; nothing set means every version is supported).
- **App sign-in (14 October 2026):** `POST /api/v1/auth/device/login`, `/device/refresh`, `/device/logout`, `/device/phone/start`, `/device/phone/verify`. Same checks as the website's sign-in, no cookie, no Origin/CSRF; the answer carries a refresh token that changes on every use, and an old one ends the session. The session lasts `DEVICE_SESSION_TTL_SECONDS` (30 days). Code: `AuthProcess.toDevice/refreshDevice/logoutDevice`, `controller/device-auth-controller.ts`. Registering from the app: `/device/register`, `/device/password/forgot` and `/device/phone/signup` (a number with no account gets a `signupToken` from `/device/phone/verify`). Emailed links (confirm email, reset password, client login, staff invitation) still open the website's pages and finish there; opening them in the app needs links that open the app (not built).
- **Delete my account (14 October 2026):** `POST /api/v1/me/delete-account` (members, password asked again). Hides the profile and ends every session at once; signing in within 14 days cancels it; after that an hourly job (`scheduler/account-erasure-scheduler.ts`) calls the `erase_due_members` database function, which blanks the profile and account, removes contacts, preferences, credentials and notifications, marks photos and CVs removed and returns their file keys for deletion. The agency keeps a bare history. Done by SECURITY DEFINER functions (migrations 027 and 028) because the runtime role can never delete. Not built: a delete button on the website's account page, and the same for staff (an admin disables staff instead).
- **Push notifications (14 October 2026):** `POST/DELETE /api/v1/me/push-devices` (a phone registers its token after sign-in and removes it on sign-out; migration 029). When an inbox line is added, the notification hub signals the API, which claims the unpushed lines with one UPDATE (`notifications.pushed_at`, so several API processes never double-send) and sends one short generic push per phone through the `PushSender` boundary. Text names only the kind of event (`push/messages.ts`). `PUSH_DRIVER=console` prints pushes in the backend terminal (dev only; production refuses it). Not built: the real sender (Firebase Cloud Messaging, needs a Firebase project and an Apple key), per-kind opt-out.
- Not built yet: links and QR codes that open the app, native Google sign-in. Plan and statuses: the "Mobile app" section of the frontend tracker.

### Where the live tracker is

Two interactive tracker pages hold every feature's description, endpoints and a status with a note:

- Backend: https://claude.ai/artifact/RzGP4ky7jbKQMoUVA2WFYw
- Frontend: https://claude.ai/artifact/Ck84aYSJZ4krz5jTD9Rpnk

They belong to the original user's Claude account. **If you cannot open them, this file is the source of truth**: keep the tables above up to date instead, and tell the user so they can decide whether to rebuild the trackers.

## 6. Authentication (the largest piece of work so far)

The original design used an external identity provider (Auth0). On 7 October 2026 the user decided to drop it (cost, and phone sign-in needs a paid plan) and build the application's **own** sign-in. Full design, reasons and defences: [docs/design/authentication.md](docs/design/authentication.md). In short:

- **Three ways in, one kind of session:** email + password, Google, phone number + code. All end in the same server-side session (random id in an HttpOnly `Strict` cookie, state in Redis, 8 hours absolute), a short-lived ES256 access token kept only in browser memory, and a CSRF header on state-changing calls.
- **Passwords:** Argon2id. **Registration by email:** a link is emailed; the account is created only when the link is opened and the person confirms; that also signs them in.
- **Never link by email or phone alone.** A new way of proving identity is attached to an existing account only by its signed-in owner, or after the account's password.
- **Privacy:** answers do not reveal whether an email has an account, or whether a password login is for a known number. The one exception is asking for a login code, which says when a phone number is not registered.
- **Google:** direct (no Firebase). A login with no account asks the person to agree to the terms on a page, and one button creates the account.
- **Phone:** six-digit code, 5 minutes, single use, 5 guesses; one code a minute and 5 an hour per number, 2000 a day per agency. A new number gets a page for name, **password** and terms (the password is required, so the member can later log in with the number and it, with no text message, which also saves SMS cost); the member has no email at first.
- **Who is sent a code (cost control):** a code to **log in** is sent only to a registered number (any other is told `PHONE_NOT_REGISTERED` so the page can offer registration; this reveals who has an account, a trade-off the user chose on 9 October 2026, limited by the per-number and per-address limits); a code to **register** goes to any allowed number. Only Bangladeshi numbers are sent codes by default (`SMS_ALLOWED_COUNTRIES`). Cloudflare Turnstile (free) before a code is sent, on both the login and register pages, is decided but not built; add it before launch (needs a Cloudflare account).
- **Phone and password login:** `POST /auth/login` takes an email or a phone number (one of them) with the password; same answers and the same pause after five wrong passwords, counted per number.
- **Choosing a new password with a code:** a signed-in member with a verified phone can set a new password with a code to that phone (`POST /me/password`); it ends every session. It is the recovery path for a phone member without an email.
- **Adding an email to a phone-only account:** needs a code sent to the account's own phone (so a stolen session is not enough), then a link sent to the new address; opening the link stores it, verified, and signs nobody in. A password is then set with the usual forgot-password link. An existing email is never replaced.
- **Staff accounts:** an admin invites a person by email as an agent or an admin (`/admin/staff/invitations`); the person opens the link (7 days, once), chooses a password and is signed in. The role comes only from the invitation. An address that already has an account is never invited. Not built: disabling staff, changing a role.
- **Development senders:** emails and texts are printed in the backend terminal (`MAIL_DRIVER=console`, `SMS_DRIVER=console`). The configuration refuses both in production.

Not built in authentication: a real SMS gateway and a real email service, the production Google consent screen, changing an existing email, changing a password while signed in, a list of devices, two-factor for staff, device sessions for the mobile app, and the **security review**.

## 7. Decisions still open (the user or the client must answer)

- **Real email service** (SES, Brevo, SendGrid, Mailgun…) and a verified sender domain.
- **SMS gateway** that reaches Bangladeshi numbers reliably, with price and sender-name registration.
- **Google consent screen to production** (needs a published privacy policy and each agency's callback address).
- **How the mobile app finds its agency:** one branded app per agency, or one shared app where the person picks.
- **Sign-in defaults chosen without the client:** 8-hour sessions, 10-character passwords, 5 wrong passwords pause an email for 15 minutes, 3 emails an hour per address, 10 devices per account, phone code limits.
- **Biodata fields and option lists** (religion, education, income bands…): My Profile runs on development defaults listed on its tracker card.
- **Discovery model (10 October 2026):** the agent-curated flow in [docs/features/discovery-loop.md](docs/features/discovery-loop.md) needs the friend's confirmation, plus the full preference field list and the cap rules listed there.
- **Agency-admin configuration (Phase 6):** is a settings screen for an agency's admin allowed at launch, or does the platform owner configure each agency? Self-registered members without an agent are deferred.
- **Plans, prices, durations, quotas**, **bKash sandbox credentials**, **real agency content**, **the final terms and privacy texts** (placeholders now, versioned in `src/bo/registration.ts`).
- **Is MongoDB needed for launch?** Nothing reads the events yet; the PostgreSQL outbox already keeps them.
- **Digit style** in Bengali pages (Latin digits for now; one switch in the frontend).
- The `public_config` shape is a draft for the friend to review.

## 8. Things that will trip you up

- `docs/design/` (except `authentication.md`) is the friend's. Do not rewrite it.
- `docs/api/openapi.yaml` is a **pure contract** (routes, fields, error codes). Feature stories belong in the tracker, not there. It uses CRLF line endings; an unquoted `: ` in a summary breaks the frontend type generator.
- Never edit an applied migration. Add a new numbered file; migrations are run explicitly, never at startup.
- Services and processes must be `async` (guards throw as rejected promises). Cursors for lists use a microsecond `position` string.
- Real-database tests matter: a mock cannot prove row-level security, constraints or atomicity. A Postgres "inconsistent types for parameter" error has already been caught this way.
- Rate limits live in Redis and survive test runs: integration tests use random client addresses for that reason.
- Keep the frontend's stand-in backend (`tests/e2e/stub-backend.mjs`) in step with `openapi.yaml` in the same change.
- Long shell heredocs with quotes break easily on Windows; write scripts to a file instead.

**Chat (17 October 2026):** a client-to-client text chat after an accepted proposal (migration 032, `chat-service.ts`, `chat-controller.ts`, hourly `chat-maintenance-scheduler.ts`). Both people must agree. Private: staff see only that a chat exists and how active it is, and read it only when it is reported or a person invites their own agent (every reading is logged and visible). Phones, emails and links are masked to `[hidden]`. Chats end when a profile is unpublished or an account is deleted; messages are erased 90 days after. Assisted clients with no login are not eligible. The platform owner switches chat off per agency with `UPDATE agencies SET chat_enabled = false`. Verified: `test/chat.test.ts` (6 tests), a real-backend smoke run and a two-member browser run. Not run: the full test suites.

**Identity verification (17 October 2026):** a client or the agent of an assisted client sends one identity document (migration 033, `verification-service.ts`); staff who look after the client approve or reject it. An approved profile has `verified_at` and shows a Verified mark to other members (`verified` on match, proposal and client list items). The document is private and is deleted from storage when the request is decided or withdrawn; opening it is logged as an event. Nobody decides their own submission except an admin. Open: a change of name or birth date does not remove the mark yet.

**Meetings, notes and follow-ups (17 October 2026):** staff set meetings for accepted proposals, record what each side said after (private to that side's staff), keep private client notes and follow-ups, and read one agenda (migration 034, `meeting-service.ts`). Both people are told when a meeting is set or changed (`meeting_update` notification). A client sees only time and place. Time is entered and shown in Bangladesh time.

Verified for both: real-backend smoke runs and browser runs with two members and an agent; the existing targeted tests pass. Not done: dedicated automated tests for these two services, the full test suites.

**Guardian (17 October 2026):** a client's parent or relative gets a login (role `guardian`, migration 035, `guardian-service.ts`, `guardian-process.ts`) to see the client's proposals and give advice only. One guardian per profile, invited by email by the agent; the client must agree first (in the app for a client who signs in, recorded by the agent for one with no login). The guardian reads through the profile they look after (`guardedProfile`), with the same visible fields as the client, and is refused on chat, payments, profile, matches list, connecting and answering. Advice (`guardian_advice`) is shown to the client, the agent and the guardian. Verified: 646 unit tests pass, real-backend and browser runs. Not done: a dedicated automated test file for the guardian service, the full integration and Playwright runs.

## 9. Where to read next

1. [AGENTS.md](AGENTS.md): the rules for working in this repo.
2. [README.md](README.md): structure, endpoints, setup.
3. [docs/design/authentication.md](docs/design/authentication.md): the sign-in design.
4. [docs/design/launch-features.md](docs/design/launch-features.md) and [core-entities.md](docs/design/core-entities.md): what the 20 features are and the data behind them (friend's).
5. [docs/api/openapi.yaml](docs/api/openapi.yaml): the API contract.
6. In the frontend repo: `PROJECT.md`, `docs/architecture.md` and `docs/design-guidelines.md`.

## 10. Keeping this file true

When you finish a task, update section 5 (statuses), section 6 or 7 if they changed, and the "Last updated" date. Say what is verified and what is not. A wrong status here misleads the next person more than a missing one.
