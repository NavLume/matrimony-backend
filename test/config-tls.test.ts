import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/env.js';
import { env } from './fixtures.js';

/** Everything else a production deployment needs, so only the connection rules decide. */
const production = {
  ...env,
  NODE_ENV: 'production',
  STORAGE_DRIVER: 's3',
  S3_BUCKET: 'matrimony-private',
  MAIL_DRIVER: 'smtp',
  MAIL_FROM: 'Marriage Solution BD <no-reply@example.com>',
  SMTP_HOST: 'smtp.example.com',
};
const managed = {
  DB_SSL: 'verify-full',
  DATABASE_URL: 'postgresql://app:pw@db.example.com/matrimony',
  REDIS_URL: 'rediss://redis.example.com:6380',
  MONGO_URL: 'mongodb+srv://user:pw@cluster.example.com/db',
};
const onThisMachine = {
  ALLOW_PLAINTEXT_LOCAL_SERVICES: 'true',
  DB_SSL: 'disable',
  DATABASE_URL: 'postgresql://app:pw@postgres:5432/matrimony',
  REDIS_URL: 'redis://:pw@redis:6379',
  MONGO_URL: 'mongodb://mongo:27017/events',
};

await test('production with managed services and verified TLS is accepted', () => {
  assert.doesNotThrow(() => loadConfig({ ...production, ...managed }));
});

await test('production refuses plain connections by default, local or not', () => {
  for (const field of ['DB_SSL', 'REDIS_URL', 'MONGO_URL'])
    assert.throws(
      () =>
        loadConfig({ ...production, ...onThisMachine, ALLOW_PLAINTEXT_LOCAL_SERVICES: 'false' }),
      new RegExp(field),
    );
});

await test('with the switch on, services on this machine may be reached without TLS', () => {
  assert.doesNotThrow(() => loadConfig({ ...production, ...onThisMachine }));
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'postgres', 'db_1']) {
    assert.doesNotThrow(
      () =>
        loadConfig({
          ...production,
          ...onThisMachine,
          DATABASE_URL: `postgresql://app:pw@${host}:5432/matrimony`,
        }),
      host,
    );
  }
});

await test('with the switch on, a service anywhere else still needs verified TLS', () => {
  // A dotted name, a public or private-network address: it is across a network.
  for (const host of ['db.example.com', '10.0.0.5', '203.0.113.9'])
    assert.throws(
      () =>
        loadConfig({
          ...production,
          ...onThisMachine,
          DATABASE_URL: `postgresql://app:pw@${host}:5432/matrimony`,
        }),
      /DB_SSL/,
      host,
    );
  assert.throws(
    () =>
      loadConfig({
        ...production,
        ...onThisMachine,
        REDIS_URL: 'redis://:pw@redis.example.com:6379',
      }),
    /REDIS_URL/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...production,
        ...onThisMachine,
        MONGO_URL: 'mongodb://mongo.example.com:27017/e',
      }),
    /MONGO_URL/,
  );
});

await test('the switch never allows weakening a TLS connection that is used', () => {
  for (const flag of [
    'tlsAllowInvalidCertificates=true',
    'tlsInsecure=true',
    'tlsAllowInvalidHostnames=true',
  ])
    assert.throws(
      () =>
        loadConfig({
          ...production,
          ...onThisMachine,
          MONGO_URL: `mongodb://mongo:27017/e?tls=true&${flag}`,
        }),
      /MONGO_URL/,
      flag,
    );
});

await test('the switch only accepts true or false', () => {
  assert.equal(loadConfig(env).ALLOW_PLAINTEXT_LOCAL_SERVICES, false);
  assert.throws(() => loadConfig({ ...env, ALLOW_PLAINTEXT_LOCAL_SERVICES: 'yes' }));
});

await test('without MONGO_URL production starts: the event copy to MongoDB is optional', () => {
  const without = (extra: Record<string, string>) => {
    const all: Record<string, string | undefined> = { ...production, ...extra };
    delete all.MONGO_URL;
    return loadConfig(all as NodeJS.ProcessEnv);
  };
  assert.equal(without(managed).MONGO_URL, undefined);
  // The same holds on one machine with plain local services.
  assert.doesNotThrow(() => without(onThisMachine));
});

await test('a MONGO_URL that is set is still checked in production', () => {
  assert.throws(
    () =>
      loadConfig({
        ...production,
        ...managed,
        MONGO_URL: 'mongodb://mongo.example.com:27017/events',
      }),
    /MONGO_URL/,
  );
});
