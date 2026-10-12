import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { Pool } from 'pg';
import { clientInputSchema } from '../src/bo/client.js';
import { profileInputSchema } from '../src/bo/profile.js';
import { Database } from '../src/db/config/database.js';
import { ClientRepository } from '../src/db/raw/repository/client-repository.js';
import { EventRepository } from '../src/db/raw/repository/event-repository.js';
import { ProfileRepository } from '../src/db/raw/repository/profile-repository.js';
import { ReviewRepository } from '../src/db/raw/repository/review-repository.js';
import { ClientDbService } from '../src/db/service/client-db-service.js';
import { ProfileDbService } from '../src/db/service/profile-db-service.js';
import { ReviewDbService } from '../src/db/service/review-db-service.js';
import { PasswordHasher } from '../src/security/password-hasher.js';
import { ClientService } from '../src/service/client-service.js';
import { ProfileService, type ProfileActor } from '../src/service/profile-service.js';
import { ReviewService } from '../src/service/review-service.js';

// Development tool: puts a small, known set of accounts into the local database, so every feature can
// be tried in a browser. It does not delete anything. Run once on a clean database:
//
//   npx tsx --env-file=.env scripts/seed-dev-accounts.ts
//
// Passwords are for local development only and are printed at the end.

const AGENT_PASSWORD = 'Agent-Test-2026!';
const MEMBER_PASSWORD = 'Member-Test-2026!';

const url = process.env.MIGRATION_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;
if (!url || !runtimeUrl) throw new Error('MIGRATION_DATABASE_URL and DATABASE_URL are required');

const owner = new Pool({ connectionString: url, max: 2 });
const runtime = new Pool({ connectionString: runtimeUrl, max: 4 });
const db = new Database(runtime);
const hasher = new PasswordHasher();
const NOW = new Date();

const agencyId = (
  await owner.query<{ id: string }>(
    `SELECT id FROM matrimony.agencies WHERE status = 'active' ORDER BY created_at LIMIT 1`,
  )
).rows[0]!.id;
const adminId = (
  await owner.query<{ id: string }>(
    `SELECT id FROM matrimony.accounts WHERE agency_id = $1 AND role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1`,
    [agencyId],
  )
).rows[0]!.id;
const admin: ProfileActor = { agencyId, accountId: adminId, role: 'admin' };

const profiles = new ProfileService(
  new ProfileDbService(db, new ProfileRepository(), new EventRepository()),
);
const reviews = new ReviewService(
  new ReviewDbService(db, new ReviewRepository(), new ProfileRepository(), new EventRepository()),
);
const clients = new ClientService(
  new ClientDbService(db, new ClientRepository(), new EventRepository()),
  profiles,
);

async function account(role: 'agent' | 'member', name: string, email: string, password: string) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO matrimony.accounts(agency_id, id, role, display_name, email, email_verified_at, auth_issuer, auth_subject, status, locale)
     VALUES ($1, $2::uuid, $3, $4, $5, now(), 'local', ($2::uuid)::text, 'active', 'en')`,
    [agencyId, id, role, name, email],
  );
  await owner.query(
    `INSERT INTO matrimony.account_credentials(agency_id, account_id, password_hash) VALUES ($1, $2, $3)`,
    [agencyId, id, await hasher.hash(password)],
  );
  return id;
}

interface Person {
  name: string;
  email: string;
  gender: 'male' | 'female';
  born: string;
  height: number;
  district: string;
  degree: string;
  occupation: string;
  profession: string;
  phone: string;
}

const PEOPLE: Person[] = [
  {
    name: 'Rahim Uddin',
    email: 'rahim@example.test',
    gender: 'male',
    born: '1994-03-12',
    height: 172,
    district: 'dhaka',
    degree: 'bachelors',
    occupation: 'salaried',
    profession: 'engineer',
    phone: '+8801711000001',
  },
  {
    name: 'Karim Hossain',
    email: 'karim@example.test',
    gender: 'male',
    born: '1991-07-25',
    height: 176,
    district: 'chattogram',
    degree: 'masters',
    occupation: 'salaried',
    profession: 'doctor',
    phone: '+8801711000002',
  },
  {
    name: 'Imran Chowdhury',
    email: 'imran@example.test',
    gender: 'male',
    born: '1996-11-02',
    height: 169,
    district: 'sylhet',
    degree: 'bachelors',
    occupation: 'business',
    profession: 'business_owner',
    phone: '+8801711000003',
  },
  {
    name: 'Nusrat Jahan',
    email: 'nusrat@example.test',
    gender: 'female',
    born: '1997-05-18',
    height: 158,
    district: 'dhaka',
    degree: 'bachelors',
    occupation: 'salaried',
    profession: 'teacher',
    phone: '+8801711000004',
  },
  {
    name: 'Ayesha Rahman',
    email: 'ayesha@example.test',
    gender: 'female',
    born: '1995-09-30',
    height: 162,
    district: 'chattogram',
    degree: 'masters',
    occupation: 'salaried',
    profession: 'doctor',
    phone: '+8801711000005',
  },
  {
    name: 'Sadia Akter',
    email: 'sadia@example.test',
    gender: 'female',
    born: '1998-01-14',
    height: 155,
    district: 'rajshahi',
    degree: 'bachelors',
    occupation: 'student',
    profession: 'nurse',
    phone: '+8801711000006',
  },
];

const input = (p: Person, extra: Record<string, unknown> = {}) =>
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
      aboutMe: `${p.name} is looking for a respectful, family-minded partner.`,
    },
    contact: { contactName: p.name, contactRelationship: 'self', phone: p.phone, email: p.email },
    ...extra,
  });

// ---- agents
const agents = [
  { name: 'Agent Salma', email: 'agent1@example.test' },
  { name: 'Agent Kamal', email: 'agent2@example.test' },
  { name: 'Agent Nasrin', email: 'agent3@example.test' },
];
for (const agent of agents) await account('agent', agent.name, agent.email, AGENT_PASSWORD);

// ---- members with a published profile (an agent is given to each as they register)
for (const person of PEOPLE) {
  const id = await account('member', person.name, person.email, MEMBER_PASSWORD);
  const actor: ProfileActor = { agencyId, accountId: id, role: 'member' };
  const saved = await profiles.save(actor, input(person));
  const sent = await profiles.submit(actor, saved.profile!.version, 'seed');
  await reviews.approve(admin, sent.pendingReview!.id, {}, 'seed');
}

// ---- members who have registered and not yet filled in a profile
const fresh = [
  { name: 'Fresh Member One', email: 'fresh1@example.test' },
  { name: 'Fresh Member Two', email: 'fresh2@example.test' },
];
for (const person of fresh) await account('member', person.name, person.email, MEMBER_PASSWORD);

// ---- a client the agency runs, who has no login
const tania: Person = {
  name: 'Tania Sultana',
  email: 'tania@example.test',
  gender: 'female',
  born: '1996-12-05',
  height: 160,
  district: 'khulna',
  degree: 'bachelors',
  occupation: 'salaried',
  profession: 'accountant',
  phone: '+8801711000007',
};
const created = await clients.create(
  admin,
  clientInputSchema(NOW).parse({
    profile: input(tania).profile,
    contact: { contactName: 'Her uncle', contactRelationship: 'uncle', phone: tania.phone },
    assignedAgentId: null,
  }),
  'seed',
);
const submitted = await clients.submit(
  admin,
  created.id,
  created.detail.state.profile!.version,
  'seed',
);
await reviews.approve(admin, submitted.state.pendingReview!.id, {}, 'seed');

await db.close();
await owner.end();
console.log('Done.');
