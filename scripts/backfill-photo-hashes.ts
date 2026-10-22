import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { variantKey } from '../src/bo/photo.js';
import { loadConfig } from '../src/config/env.js';
import { createFileStorage } from '../src/storage/config/storage.js';

// Operator tool: gives the photos uploaded before fraud signals (migration 058) their fingerprint, so the same
// picture on two profiles can be noticed. Safe to repeat: it only touches photos with no fingerprint. It reads
// each stored photo, hashes it exactly as an upload does, and writes the hash with the migration (owner)
// connection.
//
//   npm run photos:backfill-hashes

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
const storage = createFileStorage(loadConfig());
const pool = new Pool({ connectionString: url });

const rows = await pool.query(
  `SELECT agency_id, id, storage_key FROM matrimony.profile_photos
    WHERE content_hash IS NULL AND status <> 'removed'`,
);
let done = 0;
let missing = 0;
for (const row of rows.rows as { agency_id: string; id: string; storage_key: string }[]) {
  const bytes = await storage.get(variantKey(row.storage_key, 'full'));
  if (!bytes) {
    missing += 1;
    continue;
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  await pool.query(
    'UPDATE matrimony.profile_photos SET content_hash = $3 WHERE agency_id = $1 AND id = $2',
    [row.agency_id, row.id, hash],
  );
  done += 1;
}
console.log(`fingerprints added: ${done}, photo files not found: ${missing}`);
await pool.end();
