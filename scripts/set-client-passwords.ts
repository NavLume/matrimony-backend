import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { z } from 'zod';
import { newPasswordSchema } from '../src/bo/credentials.js';
import { PasswordHasher } from '../src/security/password-hasher.js';
import { databaseSsl } from '../src/db/config/tls.js';

// Operator tool: gives every active client (member) account of an agency the same password, for example for a demo.
// Staff (admin, agent) and guardians are never touched. The password is typed without echo, never passed on the
// command line, so it is not left in a shell history.
//
// Without --apply it only counts what it would change. With --apply it first writes the current password hashes of
// those accounts to the --backup file (so the change can be undone), then sets the new password in one transaction.
//
//   docker compose run --rm -it tools npx tsx scripts/set-client-passwords.ts --agency <uuid>
//   docker compose run --rm -it -v /home/deploy/pw-backup:/backup tools \
//     npx tsx scripts/set-client-passwords.ts --agency <uuid> --apply --backup /backup/clients-before.json
//
// To undo: --restore /backup/clients-before.json puts the saved hashes back (accounts that had no password lose the
// one this tool gave them).

const { values } = parseArgs({
  options: {
    agency: { type: 'string' },
    apply: { type: 'boolean', default: false },
    backup: { type: 'string' },
    restore: { type: 'string' },
  },
});
const agencyId = z.uuid().parse(values.agency);
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
if (values.apply && !values.backup)
  throw new Error('--apply needs --backup <file> for the current hashes');

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      let data = '';
      input.setEncoding('utf8');
      input.on('data', (chunk) => (data += chunk));
      input.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      input.on('error', reject);
      return;
    }
    process.stdout.write(prompt);
    let value = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const onData = (char: string) => {
      for (const c of char) {
        if (c === '\u0003') {
          input.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        } else if (c === '\r' || c === '\n') {
          input.setRawMode(false);
          input.pause();
          input.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        } else if (c === '\u007f' || c === '\b') {
          value = [...value].slice(0, -1).join('');
        } else {
          value += c;
        }
      }
    };
    input.on('data', onData);
  });
}

const pool = new Pool({
  connectionString: url,
  max: 1,
  ssl: databaseSsl(process.env.DB_SSL !== 'disable', process.env.DB_CA_FILE || undefined),
});
const client = await pool.connect();

type Row = { id: string; email: string | null; password_hash: string | null };

try {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.agency_id', $1, true)", [agencyId]);

  if (values.restore) {
    const { readFileSync } = await import('node:fs');
    const saved = JSON.parse(readFileSync(values.restore, 'utf8')) as {
      agencyId: string;
      accounts: Row[];
    };
    if (saved.agencyId !== agencyId) throw new Error('That backup belongs to another agency');
    for (const row of saved.accounts) {
      if (row.password_hash) {
        await client.query(
          `UPDATE matrimony.account_credentials SET password_hash = $3, password_changed_at = now()
           WHERE agency_id = $1 AND account_id = $2`,
          [agencyId, row.id, row.password_hash],
        );
      } else {
        await client.query(
          'DELETE FROM matrimony.account_credentials WHERE agency_id = $1 AND account_id = $2',
          [agencyId, row.id],
        );
      }
    }
    await client.query('COMMIT');
    console.log(`Restored the saved passwords of ${saved.accounts.length} client accounts.`);
  } else {
    const found = await client.query<Row>(
      `SELECT a.id, a.email, c.password_hash
         FROM matrimony.accounts a
         LEFT JOIN matrimony.account_credentials c ON c.agency_id = a.agency_id AND c.account_id = a.id
        WHERE a.agency_id = $1 AND a.role = 'member' AND a.status = 'active'
        ORDER BY a.created_at`,
      [agencyId],
    );
    const rows = found.rows;
    const withPassword = rows.filter((row) => row.password_hash).length;
    console.log(`Active client accounts: ${rows.length}`);
    console.log(`  with a password now:    ${withPassword}`);
    console.log(`  without a password now: ${rows.length - withPassword} (they would get one)`);
    console.log('Staff, guardians, invited and turned-off accounts are not touched.');

    if (!values.apply) {
      await client.query('ROLLBACK');
      console.log('Nothing changed. Run again with --apply --backup <file> to set the password.');
    } else {
      const password = newPasswordSchema.parse(
        await readHidden('New password for every client (not shown): '),
      );
      const again = await readHidden('Type it again: ');
      if (again.normalize('NFKC') !== password)
        throw new Error('The two passwords are not the same');

      writeFileSync(
        values.backup!,
        JSON.stringify({ agencyId, savedAt: new Date().toISOString(), accounts: rows }),
        {
          mode: 0o600,
        },
      );
      console.log(`Saved the current hashes to ${values.backup}`);

      const hash = await new PasswordHasher().hash(password);
      for (const row of rows) {
        await client.query(
          `INSERT INTO matrimony.account_credentials(agency_id, account_id, password_hash)
           VALUES ($1, $2, $3)
           ON CONFLICT (agency_id, account_id)
           DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = now()`,
          [agencyId, row.id, hash],
        );
      }
      await client.query('COMMIT');
      console.log(`Password set for ${rows.length} client accounts.`);
    }
  }
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
