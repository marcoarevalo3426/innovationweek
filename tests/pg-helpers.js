import { randomUUID } from 'node:crypto';
import { createPool } from '../server/pg-config.js';

export async function testDatabase() {
  if (process.env.INNOVATION_TEST_DATABASE !== 'true') throw new Error('Use npm test to provision an isolated PostgreSQL test environment.');
  const pool = createPool();
  const schema = 'test_' + randomUUID().replaceAll('-','');
  await pool.query(`CREATE SCHEMA ${schema}`);
  const env = {...process.env,PGSCHEMA:schema};
  return {
    env,
    pool: createPool(env),
    async cleanup() {
      await this.pool.end();
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}
