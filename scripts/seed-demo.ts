import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { profileInputSchema } from '../src/bo/profile.js';
import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/config/logger.js';
import { createApiContainer } from '../src/container.js';
import { databaseSsl } from '../src/db/config/tls.js';
import { PasswordHasher } from '../src/security/password-hasher.js';
import type { ProfileActor } from '../src/service/profile-service.js';

// Demo accounts for showing the platform (website, client app, agent app) with full data: six published and
// verified clients, one matchmaker who looks after them, released matches, proposals, a chat, a meeting and money.
//
//   docker compose run --rm tools npx tsx scripts/seed-demo.ts            create (prints each password once)
//   docker compose run --rm tools npx tsx scripts/seed-demo.ts --remove   after the demo: erase them
//
// Every demo account has an address at demo.invalid (a domain that can never receive mail), which is how --remove
// finds them. The profiles are hidden from the public website's "Meet our members" and are released only to each
// other. They are made-up people: remove them after the demo so they never reach real clients or the reports.

const DOMAIN = 'demo.invalid';
const remove = process.argv.includes('--remove');

const migrationUrl = process.env.MIGRATION_DATABASE_URL;
if (!migrationUrl) throw new Error('MIGRATION_DATABASE_URL is required');
const owner = new Pool({
  connectionString: migrationUrl,
  max: 2,
  ssl: databaseSsl(process.env.DB_SSL !== 'disable', process.env.DB_CA_FILE || undefined),
});

const agencyId = (
  await owner.query<{ id: string }>(
    `SELECT id FROM matrimony.agencies WHERE status = 'active' ORDER BY created_at LIMIT 1`,
  )
).rows[0]!.id;

if (remove) {
  const found = await owner.query<{ id: string; profile_id: string | null }>(
    `SELECT a.id, p.id AS profile_id
       FROM matrimony.accounts a
       LEFT JOIN matrimony.member_profiles p ON p.agency_id = a.agency_id AND p.owner_account_id = a.id
      WHERE a.agency_id = $1 AND a.email LIKE $2 AND a.status <> 'disabled'`,
    [agencyId, `%@${DOMAIN}`],
  );
  for (const row of found.rows) {
    // The erase function checks the agency of the transaction, as the API's own calls do.
    const tx = await owner.connect();
    try {
      await tx.query('BEGIN');
      await tx.query("SELECT set_config('app.agency_id', $1, true)", [agencyId]);
      if (row.profile_id) {
        await tx.query(
          `UPDATE matrimony.member_profiles SET status = 'closed' WHERE agency_id = $1 AND id = $2`,
          [agencyId, row.profile_id],
        );
        await tx.query('SELECT * FROM matrimony.erase_profile_data($1, $2)', [
          agencyId,
          row.profile_id,
        ]);
      }
      // The address is freed (so the demo can be made again) and the login turned off.
      await tx.query(
        `UPDATE matrimony.accounts SET status = 'disabled', email = $3 WHERE agency_id = $1 AND id = $2`,
        [agencyId, row.id, `removed-${row.id}@${DOMAIN}`],
      );
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
  }
  await owner.end();
  console.log(`Removed ${found.rows.length} demo accounts (profiles erased, logins turned off).`);
  process.exit(0);
}

const already = await owner.query(
  `SELECT 1 FROM matrimony.accounts WHERE agency_id = $1 AND email LIKE $2 AND status <> 'disabled' LIMIT 1`,
  [agencyId, `%@${DOMAIN}`],
);
if (already.rowCount) {
  console.log('Demo accounts already exist. Run with --remove first to make them again.');
  await owner.end();
  process.exit(0);
}

const config = loadConfig();
const container = await createApiContainer(config, createLogger(config));
const hasher = new PasswordHasher();
const NOW = new Date();
const correlation = 'demo-seed';

const adminId = (
  await owner.query<{ id: string }>(
    `SELECT id FROM matrimony.accounts WHERE agency_id = $1 AND role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1`,
    [agencyId],
  )
).rows[0]!.id;
const admin: ProfileActor = { agencyId, accountId: adminId, role: 'admin' };

/** A readable password, shown once on the screen and never stored as typed. */
const newPassword = () => `Demo-${randomBytes(6).toString('base64url')}-26`;
const passwords: { who: string; email: string; password: string }[] = [];

async function account(role: 'agent' | 'member', name: string, email: string) {
  const id = randomUUID();
  const password = newPassword();
  await owner.query(
    `INSERT INTO matrimony.accounts(agency_id, id, role, display_name, email, email_verified_at, auth_issuer, auth_subject, status, locale)
     VALUES ($1, $2::uuid, $3, $4, $5, now(), 'local', ($2::uuid)::text, 'active', 'bn')`,
    [agencyId, id, role, name, email],
  );
  await owner.query(
    `INSERT INTO matrimony.account_credentials(agency_id, account_id, password_hash) VALUES ($1, $2, $3)`,
    [agencyId, id, await hasher.hash(password)],
  );
  if (role === 'member') {
    // The agreements of the agency's current terms, so the demo member is not stopped by the agree-again page.
    const versions = await owner.query<{ kind: string; version: number }>(
      `SELECT kind, max(version) AS version FROM matrimony.legal_documents WHERE agency_id = $1 GROUP BY kind`,
      [agencyId],
    );
    const versionOf = (kind: string) => {
      const found = versions.rows.find((row) => row.kind === kind);
      return found ? `agency-v${found.version}` : 'draft-2026-10';
    };
    for (const purpose of ['terms', 'privacy'])
      await owner.query(
        `INSERT INTO matrimony.consent_events(agency_id, account_id, purpose, document_version, action)
         VALUES ($1, $2, $3, $4, 'accepted')`,
        [agencyId, id, purpose, versionOf(purpose)],
      );
  }
  passwords.push({ who: name, email, password });
  return id;
}

interface Person {
  key: string;
  name: string;
  gender: 'male' | 'female';
  born: string;
  height: number;
  district: string;
  degree: string;
  occupation: string;
  profession: string;
  about: string;
}

const PEOPLE: Person[] = [
  {
    key: 'tanvir',
    name: 'Tanvir Ahmed',
    gender: 'male',
    born: '1993-04-16',
    height: 175,
    district: 'dhaka',
    degree: 'masters',
    occupation: 'salaried',
    profession: 'engineer',
    about:
      'Software engineer at a Dhaka firm. Calm, family-minded and fond of travel. Looking for a kind, educated partner who values both family and career.',
  },
  {
    key: 'rafiq',
    name: 'Rafiqul Islam',
    gender: 'male',
    born: '1990-09-02',
    height: 172,
    district: 'chattogram',
    degree: 'masters',
    occupation: 'salaried',
    profession: 'doctor',
    about:
      'Doctor at a private hospital in Chattogram. Practising, honest and warm with family. Hopes to marry someone patient and caring.',
  },
  {
    key: 'shahriar',
    name: 'Shahriar Hasan',
    gender: 'male',
    born: '1995-12-20',
    height: 170,
    district: 'sylhet',
    degree: 'bachelors',
    occupation: 'business',
    profession: 'business_owner',
    about:
      'Runs a family trading business in Sylhet. Cheerful, responsible and close to his parents. Looking for a partner with a good heart.',
  },
  {
    key: 'farzana',
    name: 'Farzana Akter',
    gender: 'female',
    born: '1996-06-11',
    height: 160,
    district: 'dhaka',
    degree: 'masters',
    occupation: 'salaried',
    profession: 'teacher',
    about:
      'Teaches English at a college in Dhaka. Loves reading and cooking for family. Looking for an understanding and respectful life partner.',
  },
  {
    key: 'nabila',
    name: 'Nabila Rahman',
    gender: 'female',
    born: '1997-02-25',
    height: 157,
    district: 'chattogram',
    degree: 'bachelors',
    occupation: 'salaried',
    profession: 'banker',
    about:
      'Works at a bank in Chattogram. Organised, gentle and religious. Hopes for a partner who is honest and supportive.',
  },
  {
    key: 'mehjabin',
    name: 'Mehjabin Chowdhury',
    gender: 'female',
    born: '1994-10-08',
    height: 162,
    district: 'sylhet',
    degree: 'masters',
    occupation: 'salaried',
    profession: 'doctor',
    about:
      'Doctor at a government hospital in Sylhet. Caring and hardworking, from a well-known family. Looking for an educated, kind partner.',
  },
];

const valid = <T>(fn: () => T, fallback: () => T): T => {
  try {
    return fn();
  } catch {
    return fallback();
  }
};

const profileInput = (p: Person, phone: string, email: string) =>
  valid(
    () =>
      profileInputSchema(NOW).parse({
        profile: {
          fullName: p.name,
          dateOfBirth: p.born,
          gender: p.gender,
          maritalStatus: 'never_married',
          heightCm: p.height,
          religionCode: 'islam',
          currentDistrictCode: p.district,
          highestDegreeCode: p.degree,
          occupationCode: p.occupation,
          professionCode: p.profession,
          aboutMe: p.about,
        },
        contact: { contactName: p.name, contactRelationship: 'self', phone, email },
      }),
    // A code the option lists do not know (an older list): fall back to plain values.
    () =>
      profileInputSchema(NOW).parse({
        profile: {
          fullName: p.name,
          dateOfBirth: p.born,
          gender: p.gender,
          maritalStatus: 'never_married',
          heightCm: p.height,
          religionCode: 'islam',
          currentDistrictCode: p.district,
          highestDegreeCode: 'bachelors',
          occupationCode: p.occupation,
          aboutMe: p.about,
        },
        contact: { contactName: p.name, contactRelationship: 'self', phone, email },
      }),
  );

// ---- the matchmaker
const agentId = await account('agent', 'Demo Matchmaker', `agent@${DOMAIN}`);
const agent: ProfileActor = { agencyId, accountId: agentId, role: 'agent' };

// ---- six clients: profile, review, the matchmaker, verified, the fee agreed and part paid, hidden from the site
interface Client {
  person: Person;
  actor: ProfileActor;
  profileId: string;
}
const clients: Client[] = [];
for (const [index, person] of PEOPLE.entries()) {
  const email = `${person.key}@${DOMAIN}`;
  const accountId = await account('member', person.name, email);
  const actor: ProfileActor = { agencyId, accountId, role: 'member' };
  const phone = `+88017000990${index + 1}`;
  const saved = await container.profiles.save(actor, profileInput(person, phone, email));
  const sent = await container.profiles.submit(actor, saved.profile!.version, correlation);
  await container.reviews.approve(admin, sent.pendingReview!.id, {}, correlation);
  const profileId = saved.profile!.id;
  await container.clients.assign(admin, profileId, agentId, correlation);
  await owner.query(
    `UPDATE matrimony.member_profiles
        SET verified_at = now(), verified_by = $3, verified_checks = ARRAY['identity', 'photo', 'marital_status'],
            website_hidden = true
      WHERE agency_id = $1 AND id = $2`,
    [agencyId, profileId, agentId],
  );
  await container.payments.setAgreement(agent, profileId, 'total', 50000, correlation);
  await container.payments.record(
    agent,
    profileId,
    {
      stage: 'registration',
      amount: 15000,
      paidOn: NOW.toISOString().slice(0, 10),
      method: 'bkash',
      reference: `DEMO-${index + 1}`,
      note: 'Demo payment',
    },
    correlation,
  );
  clients.push({ person, actor, profileId });
}

// ---- matches: each client gets the three demo clients of the other gender, never a real member
const demoIds = new Set(clients.map((c) => c.profileId));
for (const client of clients) {
  await container.candidates.generate(agent, client.profileId);
  const proposed = await container.candidates.list(agent, client.profileId, {
    state: 'proposed',
    limit: 100,
  } as never);
  const others = proposed.items.map((item) => item.candidateId).filter((id) => demoIds.has(id));
  if (others.length)
    await container.candidates.release(
      agent,
      client.profileId,
      { candidateIds: others } as never,
      correlation,
    );
}

// ---- proposals: Tanvir and Farzana accepted (with a chat and a meeting); Rafiq asked Nabila (waiting for her answer)
const by = (key: string) => clients.find((c) => c.person.key === key)!;
async function propose(from: Client, to: Client, accept: boolean) {
  const sent = await container.connections.send(
    from.actor,
    to.profileId,
    correlation,
    'Assalamu alaikum. I liked your profile and would like to talk with our families.',
  );
  if (sent.status === 'in_review')
    await container.connections.review(agent, sent.connectionId, true, correlation);
  if (accept) await container.connections.respond(to.actor, sent.connectionId, true, correlation);
  return sent.connectionId;
}

const accepted = await propose(by('tanvir'), by('farzana'), true);
await propose(by('rafiq'), by('nabila'), false);
await propose(by('shahriar'), by('mehjabin'), true);

try {
  const chat = await container.chats.request(by('tanvir').actor, accepted, correlation);
  const chatId = chat.id;
  if (chat.status !== 'active')
    await container.chats.respond(by('farzana').actor, chatId, true, correlation);
  await container.chats.send(
    by('tanvir').actor,
    chatId,
    'Assalamu alaikum, thank you for accepting.',
  );
  await container.chats.send(by('farzana').actor, chatId, 'Walaikum assalam. Nice to meet you.');
  await container.chats.send(
    by('tanvir').actor,
    chatId,
    'Our families would like to meet this Friday, if that suits you.',
  );
} catch (error) {
  console.log('Chat skipped:', (error as Error).message);
}

try {
  const friday = new Date(NOW.getTime() + 3 * 24 * 3600 * 1000);
  friday.setUTCHours(10, 0, 0, 0);
  await container.meetings.schedule(
    agent,
    accepted,
    {
      scheduledAt: friday.toISOString(),
      kind: 'family_meeting',
      place: 'Lalmatia office',
      note: 'First family meeting',
    },
    correlation,
  );
} catch (error) {
  console.log('Meeting skipped:', (error as Error).message);
}

await container.close();
await owner.end();

console.log('\nDemo accounts are ready. Write these down now; they are not shown again.\n');
for (const row of passwords)
  console.log(`${row.who.padEnd(22)} ${row.email.padEnd(28)} ${row.password}`);
console.log(
  '\nRemove after the demo: docker compose run --rm tools npx tsx scripts/seed-demo.ts --remove',
);
process.exit(0);
