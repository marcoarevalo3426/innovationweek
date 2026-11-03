import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poolConfig } from '../server/pg-config.js';

function iamFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nep-iam-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const certificate = join(directory, 'ca.pem');
  writeFileSync(certificate, 'test certificate; no network connection');
  return { NODE_ENV: 'production', PG_AUTH_MODE: 'iam', PGHOST: 'event.cluster-example.ap-southeast-2.rds.amazonaws.com', PGPORT: '5432', PGDATABASE: 'innovation_week', PGUSER: 'innovation_app', AWS_REGION: 'ap-southeast-2', PGSSLMODE: 'verify-full', PGSSLROOTCERT: certificate };
}

test('IAM requests a fresh token for every new connection and ignores static passwords', async t => {
  const env = { ...iamFixture(t), PGPASSWORD: 'stale-token-must-not-be-used' };
  let calls = 0;
  let options;
  const config = poolConfig(env, { signerFactory: supplied => {
    options = supplied;
    return { async getAuthToken() { return `token-${++calls}`; } };
  } });
  assert.equal(calls, 0);
  assert.deepEqual(options, { hostname: env.PGHOST, port: 5432, username: 'innovation_app', region: 'ap-southeast-2' });
  assert.equal(await config.password(), 'token-1');
  assert.equal(await config.password(), 'token-2');
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.ssl.ca, 'test certificate; no network connection');
  assert.equal(config.database, 'innovation_week');
});

test('IAM fails closed without TLS, explicit database identity or region', t => {
  const env = iamFixture(t);
  for (const key of ['PGHOST', 'PGDATABASE', 'PGUSER']) {
    assert.throws(() => poolConfig({ ...env, [key]: '' }), /requires/);
  }
  assert.throws(() => poolConfig({ ...env, PGSSLMODE: 'disable' }), /verify-full/);
  assert.throws(() => poolConfig({ ...env, PGSSLROOTCERT: '' }), /PGSSLROOTCERT/);
  assert.throws(() => poolConfig({ ...env, AWS_REGION: '' }), /AWS_REGION/);
  assert.throws(() => poolConfig({ ...env, PG_AUTH_MODE: 'typo' }), /PG_AUTH_MODE/);
});

test('IAM propagates credential failures instead of falling back to a password', async t => {
  const config = poolConfig(iamFixture(t), { signerFactory: () => ({ async getAuthToken() { throw new Error('AWS credentials unavailable'); } }) });
  await assert.rejects(config.password(), /AWS credentials unavailable/);
});

test('password configuration remains the default and requires production credentials', t => {
  assert.equal(poolConfig({}).password, 'innovation_local_only');
  const env = { ...iamFixture(t), PG_AUTH_MODE: 'password', PGPASSWORD: 'runtime-password' };
  assert.equal(poolConfig(env).password, 'runtime-password');
  assert.throws(() => poolConfig({ ...env, PGPASSWORD: '' }), /PGPASSWORD/);
});
