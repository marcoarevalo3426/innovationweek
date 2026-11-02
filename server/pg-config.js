import { readFileSync } from 'node:fs';
import pg from 'pg';
import { Signer } from '@aws-sdk/rds-signer';

pg.types.setTypeParser(20, value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Database integer exceeds JavaScript safe range.');
  return number;
});

export function poolConfig(env = process.env, { signerFactory = options => new Signer(options) } = {}) {
  if (env.DB_CLIENT && env.DB_CLIENT !== 'postgres') throw new Error('DB_CLIENT must be postgres. SQLite is supported only as an import source.');
  const production = env.NODE_ENV === 'production';
  const authMode = env.PG_AUTH_MODE || 'password';
  if (!['password', 'iam'].includes(authMode)) throw new Error('PG_AUTH_MODE must be password or iam.');
  const required = ['PGHOST', 'PGDATABASE', 'PGUSER', ...(authMode === 'password' ? ['PGPASSWORD'] : [])];
  if ((production || authMode === 'iam') && required.some(key => !env[key])) {
    throw new Error(`Production requires ${required.join(', ')}${authMode === 'iam' ? '; IAM connections require explicit database identity' : ''}.`);
  }
  const host = env.PGHOST || '127.0.0.1';
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const mode = env.PGSSLMODE || (local ? 'disable' : 'verify-full');
  if (!['disable', 'verify-full'].includes(mode) || (!local && mode !== 'verify-full')) {
    throw new Error('Use PGSSLMODE=verify-full for remote PostgreSQL; disable is allowed only on loopback.');
  }
  if (mode === 'verify-full' && !env.PGSSLROOTCERT) throw new Error('PGSSLROOTCERT is required for verified PostgreSQL TLS.');
  const schema = env.PGSCHEMA || 'public';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid PGSCHEMA.');
  let password = env.PGPASSWORD || (production ? undefined : 'innovation_local_only');
  if (authMode === 'iam') {
    if (mode !== 'verify-full') throw new Error('IAM PostgreSQL connections require PGSSLMODE=verify-full.');
    const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
    if (!region) throw new Error('AWS_REGION is required for IAM PostgreSQL authentication.');
    // The default AWS credential provider uses the EC2 role in production.
    // pg calls this for each new connection, so a startup token cannot expire
    // underneath future pool connections. Never log or persist these tokens.
    const signer = signerFactory({ hostname: host, port: Number(env.PGPORT || 5432), username: env.PGUSER, region });
    password = () => signer.getAuthToken();
  }
  return {
    host,
    port: Number(env.PGPORT || 5432),
    database: env.PGDATABASE || 'innovation_week',
    user: env.PGUSER || 'innovation',
    password,
    ssl: mode === 'verify-full' ? { ca: readFileSync(env.PGSSLROOTCERT, 'utf8'), rejectUnauthorized: true } : false,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    application_name: 'nep-innovation-week',
    options: `-c search_path=${schema},pg_catalog`,
  };
}

export const createPool = (env = process.env) => new pg.Pool(poolConfig(env));
