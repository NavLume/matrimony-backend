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
