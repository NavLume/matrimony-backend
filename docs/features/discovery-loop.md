# Discovery loop (Phase 3): agent-curated matching

Status: **proposal, 10 October 2026.** Written after the owner's meeting with the friend who wrote `docs/design/launch-features.md`. It changes how features 2.2, 3.1, 3.2, 3.3 and 2.3 work. The friend has not yet reviewed this text, and `launch-features.md` has not been edited. Do not treat anything below as final until he confirms it.

## Outcome

A client does not search the whole agency. Staff decide, per client, what that client may see. The client sees only that released set, can search inside it, and can send a connection request to someone in it.

## Actors and flow

1. The **client** (or an agent on their behalf) fills in detailed partner preferences.
2. The **system** builds a candidate list from approved profiles in the same agency that fit those preferences.
3. An **agent or admin** reviews the candidate list for that client: removes unsuitable profiles, sets how many the client may see (for example 50) and which fields are shown (photo, name, bio and so on), then **releases** it.
4. The **client dashboard** shows only the released set, with the fields staff allowed. Search and advanced search work inside the released set only.
5. The client sends a **connection request** to someone in the set. The recipient receives it as a notification and accepts or declines. Contact details stay behind explicit consent.
6. Staff see all data of every client. A client never sees anything outside the released set.

Chat after acceptance is **not decided** and is a hard exclusion in `launch-features.md`. Do not build it.

## Decisions made (owner, 10 October 2026)

| #   | Question                                       | Answer                                                             |
| --- | ---------------------------------------------- | ------------------------------------------------------------------ |
| 1   | How is the set chosen?                         | System proposes from preferences; the agent approves (option B)    |
| 2   | Preferences versus the agent's choice          | The agent's choice wins                                            |
| 3   | Payment and access                             | The agent controls it; payment options are configurable per agency |
| 4   | Who configures per-agency fields and features? | The agency admin eventually; **skipped for now**, see below        |
| 5   | Self-registered members with no agent          | **Deferred.** They get an empty or waiting dashboard for now       |

### The cap (decided 10 October 2026)

The cap is a **window**: the client sees at most N released profiles at a time (for example 50). A profile the client has sent a connection request to **stays** in the window. The agent or admin can raise or lower N per client at any time and tops the window up by releasing more. There is no running total and no per-period quota, so no history of everything ever shown is needed.

### Preference fields for slice 3.A (proposed by the assistant from a web search plus judgement, 10 October 2026)

Existing preferences stay. New ones, each with a matching profile field so candidates can be matched: **profession** (a coded list, because the current occupation is only a type and cannot say "doctor" or "nurse"), complexion, religious practice, diet, smoking, children, willingness to relocate, current country. Left out on purpose: polygamy, hijab or beard, disability and health (sensitive, agency-specific; Phase 6 or the agent's judgement). **Complexion** is decided (owner, 10 October 2026): it is **shown to staff but never used to filter or exclude profiles automatically**. The client's complexion preference is stored and visible to the agent, who applies it by hand when reviewing a candidate list. Candidate generation (3.B) must ignore `complexionCodes`. If an agency later wants automatic filtering, it becomes a per-agency setting in Phase 6. (Similar filters were removed by Shaadi.com after a petition.) The friend has not yet been told.

## Decision still open: agency-admin configuration

The owner wants every feature to be customisable per agency by the agency admin (fields, visible data, payment options). This is deferred and tracked as **Phase 6**. Two points need the friend's answer before any work starts:

1. Does `launch-features.md`'s hard exclusion "tenant-facing UI" (and `PROJECT.md`'s "tenant admin UI") mean a platform-owner portal, or also a settings screen for one agency's admin? Feature 4.4 (agency admin edits the plans) already exists in scope.
2. Can launch start with the platform owner configuring each agency (database or script), with a screen added later?

Until then, Phase 3 uses **fixed field lists** in code (the development defaults already used by My Profile), written so the field definitions are in one place and can later come from per-agency configuration. Do not hard-code field names across many layers.

## Consequences for the existing plan

- **5.3 Feature gating** moves back to Phase 4. Payment options are per agency and the agent controls access, so the gate cannot be designed before that rule is clear. Phase 3 enforces the agent's released set, which is the main access control.
- **3.2 Advanced search** is no longer gated by plan in Phase 3; its extra filters work inside the released set. Whether plan gating applies on top is part of the payment rules, decided in Phase 4.
- **4.3 Agent client management** gains the review and release of a client's candidate list.
- **2.2 My Matches** becomes the client dashboard of released profiles. The old "published agent recommendations" are covered by the agent's approval.

## Slices (in order)

| Slice | What                                                                                                                                                                                                                                                                                              | Depends on |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 3.A   | Detailed partner preferences on a profile (client or agent fills), extending 2.1. **Built 10 Oct 2026, awaiting the owner's browser check** (migration 012; current country deferred)                                                                                                             | none       |
| 3.B   | Candidate list generation from preferences (approved, same-agency profiles only). **Built 10 Oct 2026, backend only** (migration 013, two staff endpoints, auto-refresh after approval); the staff screen comes with 3.C                                                                          | 3.A        |
| 3.C   | Agent review and release per client: remove profiles, set the cap and visible fields. **Built 10 Oct 2026, awaiting the owner's browser check** (migration 014, four staff endpoints, the Candidates panel on the Client page)                                                                    | 3.B        |
| 3.D   | Client dashboard: the released set with the allowed fields; basic search inside it (3.1). **Built 10 Oct 2026, awaiting the owner's browser check** (no migration; GET /me/matches and the photo route; the My matches page)                                                                      | 3.C        |
| 3.E   | Advanced search (height, income, family status, district of origin) and the full profile view (3.2, 3.3). **Built 10 Oct 2026, awaiting the owner's browser check** (the list is a preview; a detail page shows every allowed field; complexion is not a filter; no plan gating yet, see Phase 4) |
| 3.F   | Connection requests with notifications (2.3, 2.4): ask, answer, withdraw, share contact, the inbox, and staff answering for clients with no login. **Built 10 Oct 2026, awaiting the owner's browser check** (migration 015 uses the original `interests` and `notifications` tables)             |

## Acceptance (to refine per slice before building)

- A client never receives a profile that staff did not release to them, in any list, search, detail or error response.
- An unapproved profile, an internal note or a protected contact never appears for a client.
- Releasing, removing and the cap are decided inside one transaction; two staff editing the same client's list do not corrupt it.
- Another agency's profiles never appear (tenant isolation, proved with a second synthetic tenant).
- A connection request to the same person twice, or two people requesting each other, ends as one pair.
- Bengali and mobile layouts for the dashboard, empty state and request states.

## Open questions for the owner or friend

- The full list of preference fields, and which fields staff may show or hide per client.
- Does a released profile stay visible after the other person pauses or closes their profile?
- What does a self-registered member see until staff take them on (empty state wording)?
- Does the recipient need to be a client of the same agent, or only in the same agency?

## Connections, the inbox and the full view: rules the assistant chose (10 October 2026), to confirm

The owner asked for advanced search, the full profile view and connection requests together. The rules below were not discussed and are the assistant's calls; the friend should confirm them.

- **Storage:** the original `interests` table is the connection (one row per pair, whoever asked first) and `notifications` is the inbox. Nothing parallel was created. Migration 015 only grants the runtime role what it needs and adds one check.
- **Who can ask:** a member with a published profile, someone in their released window. Anything else is "not found".
- **Both ask:** two people asking each other end as one accepted connection, and both are told.
- **Declined is final** for the pair (neither can ask again). **Withdrawn** can be asked again, by either side, on the same row.
- **The person asked sees the asker** through the _asked person's own_ visible-field settings, even if the asker was never in their window. That does let a client reach someone outside what their agent curated, but only by asking, and the asked person decides.
- **A client with no login** (assisted): the agent who looks after them is told and answers on their behalf from the client page. If nobody is assigned, nobody is told and an admin can still answer from the client page. A member who runs their own profile is answered by themselves, never by staff.
- **Contact details** (name, relationship, phone, email, never the permanent address) are shared only after acceptance and only on each side's own say. For an assisted client, staff share it for them. Stored as the consent timestamps the original design already had.
- **Names in the inbox** appear only if staff let that member see names; otherwise "Someone (member M…)".
- **Advanced search** is the file's five filters minus complexion (never a filter, by the owner's decision): height, income, family status, district of origin. Each works only on a field the client may see. Plan gating is not applied: gating and payments are Phase 4.
- **Preview and detail:** a list card shows headline fields (name, age, photo, profession, district, religion); the detail page shows every field staff allowed.
- **Read or unread state** was added on 12 October 2026 (slice 3.G.1, migration 016): each line has `read`, `GET /me/notifications/unread-count` and `POST /me/notifications/read`.
- **Not built:** chat, email or SMS for a request, a limit on requests per day, photo for assisted contact sharing, the friend's "interest.accepted" outbox consumer.

## Slice 3.H: the agent reviews a request first (built 12 October 2026, in review)

Decided with the friend on 12 October 2026 and reported by the owner. The rules chosen in 3.F above
change as follows; where this section and the earlier one differ, this one is current.

- **A request to a member with a login waits for review** (`interests.status = 'in_review'`). The
  agent who looks after the person asked reviews it; an admin reviews it when nobody does, and an
  admin may review any request. The person asked is told, and can see the asker, only after approval.
  A request that is still in review is never shown to the person asked, in a list, a profile or the
  inbox (the match queries leave it out unless the viewer is the asker).
- **Approve** makes it `pending`, and the person asked is told as before. **Reject** ends it as
  `declined` and the asker is told it was declined. Nothing tells the asker the difference between
  a person's decline and an agent's.
- **A client with no login** (assisted) is answered for by their agent anyway, so their request goes
  straight to `pending` and to the agent, with no second step. If they have no agent, the admins are
  told. A request is never left with nobody.
- **Withdrawing** works while the request waits for review.
- **Asking while the other person's request is in review** changes nothing: it is not theirs to see yet.
- **Reopen:** staff who look after either side move a declined pair back to `withdrawn`, which either
  side may ask again. Members cannot.
- **Reminders:** the first after 2 days, then every 3. They go to the agent, or the admins when nobody
  looks after the person asked; from the third reminder (about a week) the admins as well. The job runs
  inside the API process every 15 minutes (`scheduler/review-reminder-scheduler.ts`), and rows due are
  locked with `SKIP LOCKED`, so two processes never remind twice.
- **A short note** (at most 300 characters and 40 words) may travel with a request. Only the person
  asked sees it.
- **Staff screens:** a Requests page (`/requests`) with a badge in the navigation, and Approve / Reject
  / Allow asking again on a client's page.
- **Endpoints:** `GET /staff/connection-reviews`, `POST /staff/connections/{id}/review`,
  `POST /staff/connections/{id}/reopen`. Migration 017.
- **Not built:** live push (the unread badge refreshes every 20 seconds).

## Slice 3.I: a profile that is no longer published (built 12 October 2026, in review)

- When staff move a published profile to **matched**, **paused** or **closed**, in the same transaction
  every request still waiting (`in_review` or `pending`), to or from it, becomes `withdrawn`.
- The people who **had asked it** are told in their inbox (their agent, for a client with no login):
  matched says "they have matched with another participant" (`connection_matched`); paused or closed says
  they are not available (`connection_unavailable`). The profile's own outgoing requests are withdrawn
  quietly: nobody is told.
- It was already out of windows, lists, search, candidate generation and profile pages, because they only
  read published profiles; this adds the withdrawal and the explanation. A detail page now answers 404.
- Coming back to published does not revive requests. They stay withdrawn and can be asked again.
- Done in `ProfileService.changeStatus` through one query (`withdrawOpenRequests`), so the status and the
  withdrawals commit or fail together. No new migration.

## Slice 3.J: a CV for every profile (built 13 October 2026, in review)

Decided with the friend on 12 October 2026 (answers 14 and 16) and by the owner on 13 October: **PDF only
(photos inside the PDF are fine), one CV per profile that the owner can replace, shown to the other person
only after a connection is accepted.**

- **Storage and model.** Migration 018 `profile_cvs`. A profile has at most one `published` CV and at most
  one `pending` or `rejected` replacement (partial unique indexes). A removed CV keeps its row and its file
  is deleted. The runtime role cannot delete rows. Files go through the same `FileStorage` as photos
  (local disk in development, S3-compatible in production), under `{agency}/{profile}/cv-{id}.pdf`.
- **Who uploads.** A member for their own profile: it waits for staff. Staff for an assisted client:
  published at once. Staff cannot upload for a member who runs their own profile
  (`PROFILE_SELF_SERVICE`) but they review what the member uploaded.
- **Replacing.** The old CV stays published until the new one is approved. Approving retires the old one
  (its file is deleted); turning down keeps the old one and shows the member the reason.
- **Who sees it.** The owner, staff who look after the profile, and a member with an **accepted**
  connection to them. Never in a list, search or window. For anyone else the answer is the same as "no CV".
- **The file is checked** by its bytes (`%PDF-` header, `%%EOF` trailer, 5 MB) and screened for
  `/JavaScript`, `/JS`, `/Launch`, `/OpenAction`, `/AA`, embedded files, rich media and submit forms,
  including `#xx`-escaped names. It is a screen, not a guarantee: content inside compressed object streams
  is not seen, so the file is only ever served with `X-Content-Type-Options: nosniff`, a sandboxing
  `Content-Security-Policy`, `Cache-Control: private, no-store`, and only to someone allowed to see it.
- **Endpoints.** `GET/PUT/DELETE /me/profile/cv`, `GET /me/profile/cv/file`, `GET /me/matches/{id}/cv`,
  `GET /me/matches/{id}/cv/file`, `GET/PUT/DELETE /staff/clients/{id}/cv`, `GET .../cv/file`,
  `POST .../cv/review`.
- **Frontend.** A CV section on My profile, on the client's page (staff) and a CV card on a connected
  person's full profile. The same-origin proxy forwards `X-File-Name` and allows 5 MB on the CV paths.
- **Not built:** virus scanning, scanning inside compressed PDF streams, a preview inside the page
  (the CV opens in a new tab), photos for assisted clients.

## Slices 3.K to 3.N (built 13 October 2026, in review)

Decided with the friend on 12 October 2026 (answers 14 to 29) and built together.

### 3.K A family member who uses the account

- A profile whose `managedFor` is not `self` (child, sibling, relative, other) is run through an account that
  a family member uses. Before it can be sent for review the contact person and the relationship must be
  given (`REQUIRED_WHEN_FOR_SOMEONE_ELSE`, backend and frontend rules match).
- The form shows a note in the contact section and marks the two fields required; staff see "Account used
  by a family member" with the name and relationship on the client's page.
- Consent: the registration already records the authority confirmation when someone registers for another
  person. Nothing more is stored; the agent handles the account, as decided.

### 3.L Staff: turn off, hand over, history

- `PUT /admin/staff/{id}/status` turns a staff account off or on. Not your own (`CANNOT_DISABLE_SELF`), never
  the last active admin (`LAST_ADMIN`), not an unaccepted invitation (`STAFF_NOT_ACCEPTED`). A disabled person
  is refused on their next request, because the account is read as active on every request.
- `POST /admin/staff/{id}/hand-over` gives every client of one agent to another, or to nobody. Waiting
  requests and reminders follow the client, because they follow who looks after the person asked.
- `GET /staff/clients/{id}/assignments` is the history, newest first (migration 019 `client_assignments`):
  every change of agent, who made it, and the starting point for clients assigned before it was kept.
  Admins read it, and the agent who looks after the client now.
- The staff list says how many clients each person has.

### 3.M The nightly refresh, and the member code field

- Once a day for each agency, from 2 am Bangladesh time, every published client's proposals are refreshed
  (the same rule as the button: released and removed are never touched). `job_runs` (migration 019) holds
  the day's claim, so a restart or a second process never repeats it. Runs inside the API process.
- The member code field in a member's filter box is off until staff turn it on for that client
  (`allowCodeSearch`, migration 020; default off). It only finds profiles in the member's own window, never
  anyone else in the agency. _Interpretation:_ answer 28 was read as "the agent or admin decides which
  fields appear in the member's filter box"; searching the whole agency by code was not built.

### 3.N Every change reviewed, and digits

- Audit of what changes an approved profile: a member's save is refused (`PROFILE_EDIT_REQUIRES_REVIEW`)
  and goes through an edit request; staff cannot change a member who runs their own profile; for an
  assisted client staff changes also go through an edit request reviewed by someone else; photos and a
  member's CV are reviewed. Not reviewed, by decision: status changes by staff, the assignment, the release
  settings, and a CV that staff upload for an assisted client.
- Digits follow the page's language: Bengali digits in Bengali, Latin in English (numbers, sizes, dates).
  Phone numbers, member codes and one-time codes stay Latin. `lib/format.ts` is the one place, and
  `useNumber` formats a number placed straight into a page.

## Slice 3.O: notifications for the rest, live push, an agent for everyone, direct staff accounts (built 13 October 2026, in review)

Decided by the owner on 13 October 2026, after the list of what the meeting decided and was not yet built.

### More inbox lines

- **Released to a client:** a client who signs in gets "your agent released N profiles" (`candidates_released`),
  written in the same transaction as the release. A client with no login is not told: their agent did it.
- **Sent for review:** when a profile, a change to one, a photo or a CV is sent, the agent who looks after the
  profile and every active admin get a line (`review_requested`, with what it was). Never the sender.
- **A new client:** the agent a client was given to is told (`client_assigned`).
- The inbox, the unread count and "mark as read" now cover every kind of line. A line that is not about a
  connection has `connectionId: null`.

### Live push

- Migration 021: a trigger on `notifications` sends `pg_notify('notifications', {agency, account})` after
  commit. The API process holds one `LISTEN` connection (`NotificationHub`), reconnecting with a growing
  pause and telling every listener once it is back, so nobody misses a line.
- `GET /me/notifications/stream` is a server-sent event stream for the signed-in account. It carries only
  the unread count (`event: unread`), once at start and again each time a line is added for the account.
  Five streams per account, ten minutes each (the page reconnects with a fresh token), a heartbeat every
  20 seconds. Several API processes work, because each listens.
- The page reads it with `fetch` (the stream needs the bearer token, which `EventSource` cannot send);
  the same-origin proxy passes this one path through as a stream. Polling on the badge stays as a fallback.
- What a tab does on an `unread` event: sets the badge, and reads the inbox, the review requests and the
  review count again.

### An agent for everyone

- A profile created without an agent (a member's first save, or a client an admin adds without choosing) is
  given to the active agent who looks after the fewest clients, at once, in the same transaction. The history
  records it as `automatic` with nobody as the person who did it, and the agent is told. With no active
  agent in the agency it stays unassigned (admins see it in the list of clients nobody looks after).
- Existing unassigned profiles are not changed.

### Creating staff directly

- `POST /admin/staff` creates an active staff account at once with a first password the admin chose
  (checked like any password, hashed, never kept). An address that has an account is refused. Staff can
  still be invited by email, which lets the person choose their own password and is the better way.
- Migration 023 and 024: the application may write `accounts.status`, and the database refuses it for any
  account that is not staff, so a mistake can never switch a member off through that grant.

### Answers still to confirm

- **Member code (answer 28):** built as "staff decide which fields appear in the member's filter box", on a
  per-client switch. A search across the whole agency by code was not built; it would let a client reach a
  profile the agent never released, which sits badly with an agent-curated model.
- **Family (answer 27):** the family member who uses the account is named in My profile (contact person and
  relationship, required when the profile is for someone else). Anything more about them is a field to add
  to that section.

## Fixes found in the owner's browser test of the review step (13 October 2026)

- **A decision is told to the person it is about.** When a profile, a change, a photo or a CV is approved
  or rejected, the owner of the profile who signs in, and whoever sent the request when that is someone
  else, get an inbox line (`review_decided`, with `what` and `decision`). Never the person who decided.
  Written in the same transaction as the decision (`notifyDecided`), so the unread count and the live
  stream pick it up. A client with no login is not told: their agent decided.
- **CVs are in the review queue.** A CV waiting for a decision is listed in the queue as kind `cv_upload`
  and counted in the waiting number. It is still decided on the client's page (CV tab), not through the
  `/reviews/{id}` endpoints; the queue row links there. A CV that is shown counts as approved; replaced or
  removed CVs are not listed.

- **The asker is told when a request is approved** (13 October 2026, from the owner's browser test).
  When the agent of the person asked approves a request, the asker gets an inbox line
  (`connection_forwarded`: "the agent of X approved your request; it now waits for their answer") beside the
  line the person asked receives. Rejecting still tells the asker it was declined.
- **"Allow asking again" closes a declined request** (status `withdrawn`) so either side can send a new one.
  It does not put the old request back in the review queue, and tells nobody. The staff list words it as
  "Closed. The person who asked can ask again."
- Approve, reject, accept/decline for a client, allow asking again and share-a-client's-contact each ask for
  confirmation in the frontend.
- **Sharing contact details tells the other side** (13 October 2026): an inbox line `contact_shared` goes to the
  other side of the accepted connection (the member, or the agent of a client with no login), in the same
  transaction. Staff and members both trigger it. The line leads a member to the person's page, where the
  details are.
- **The admin is told when staff they invited join** (13 October 2026): accepting an invitation writes a
  `staff_joined` inbox line (name and role) for the admin who invited, or for every active admin when that
  admin is no longer an active admin, in the same transaction as the account. Never for the person who
  joined. This is the first inbox line that is not about a profile, so `about` and `forProfileId` of a
  notification can now be null, and `staff` carries `{ name, role }` for these lines.
