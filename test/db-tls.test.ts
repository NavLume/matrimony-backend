import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseSsl } from '../src/db/config/tls.js';
import { loadConfig } from '../src/config/env.js';
import { env } from './fixtures.js';

await test('verification is always on when TLS is used, and off only when TLS is off', () => {
  assert.equal(databaseSsl(false), false);
  assert.deepEqual(databaseSsl(true), { rejectUnauthorized: true });
});

await test('a managed database authority is trusted from the given file, without turning the check off', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ca-')), 'ca.crt');
  writeFileSync(file, '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n');
  const ssl = databaseSsl(true, file);
  assert.ok(ssl && typeof ssl === 'object');
  assert.equal(ssl.rejectUnauthorized, true);
  assert.match(String((ssl as { ca?: string }).ca), /BEGIN CERTIFICATE/);
});

await test('a missing certificate file fails at start instead of silently skipping the check', () => {
  assert.throws(() => databaseSsl(true, join(tmpdir(), 'no-such-ca-file.crt')));
});

await test('DB_CA_FILE is an optional path in the configuration', () => {
  assert.equal(loadConfig(env).DB_CA_FILE, undefined);
  assert.equal(
    loadConfig({ ...env, DB_CA_FILE: '/etc/matrimony/db-ca.crt' }).DB_CA_FILE,
    '/etc/matrimony/db-ca.crt',
  );
});
