# Suggested features (not decided, not built)

Ideas that came up while testing, kept apart from what is built and from what the friend has decided. Each says
who suggested it, why, and what it would change. Nothing here is built until it is moved to a feature note.

## S1. "Client only" mode for a client who has a login (suggested 14 October 2026)

**Status:** suggested by the owner, to be discussed with the friend. **Not built.** The first release of a client's
login (see `discovery-loop.md`, "A client's own login") is built without it: both the client and the agent can
act, as they do for any member with a login.

**What it is.** A per-client setting, changed only by an admin after a discussion with the client (a note is
required: how and when the client agreed). When it is on, only the client sends and accepts connection requests
and shares contact details; the agent cannot. The client can turn it off themselves at any time. Agents ask an admin
to change it with a button on the client page.

**Why it was suggested.** A client who does not want their agent involved in answering requests; and the opposite
case, where a client cannot operate and the agency runs things for them (that case is covered by withdrawing the
login, so a separate "agent only" mode was not kept).

**What would change for a client in this mode**

1. The sender of a request sees "Waiting for their answer" straight away: there is no review step.
2. The client's agent is still told about every request and still gets the same reminders (after 2 days, then
   every 3 days, and the admin from the third), worded as "waiting for your client", but cannot act.
3. The agent sees everything on the client's page, read-only.
4. There is no agent filter on incoming requests: the client declines what they do not want.
5. A request that nobody answers is closed after 14 days and the sender is told "no answer"; the agent gets an
   inbox line about it, and the sender can ask again.

**Unchanged in this mode:** reviews of the client's own profile edits, photos and CV; the agent still curates and
releases candidates.

**Open points for the friend**

- Is the mode wanted at launch, or only when agencies ask for it? (Our view: rare in an assisted agency.)
- Should the 14-day expiry apply to every client, not only this mode?
- Should admins alone change the mode (current suggestion), or also the assigned agent when the client agrees?

## S2. "Done for you" list and notices for a client's login (suggested 14 October 2026)

**Status:** suggested, not built in the first release. The client sees every request sent, accepted or declined
and every contact share done in their name, with date and who did it, and is notified when their agent acts for
them. This is the trust half of S1 and is useful even without the mode.

## S3. Smaller ideas noted in testing (not decided)

- A "Change password" form (current and new password) on the account page for email accounts. Today only phone
  accounts have one, and email accounts use "Forgot your password?".
- Request emails greet by the name typed ("Dear Nila") and not by the part of the address before the `@`.
- Faster agent reminders for requests (first after 1 day), and bulk approval of several requests.
- Low-risk profile edits (about me, hobbies) going live at once with a review afterwards. This would change the
  rule "every change to an approved profile is reviewed".
- "Interested" and "Not interested, because…" on a released profile, so a client has something to do while they wait.
- Cloudflare Turnstile on registration and a tighter limit on the "already registered" answer (before launch).
