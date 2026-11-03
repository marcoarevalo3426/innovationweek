// Atomic counters shared by every API node. No email addresses are stored as keys.
export class PgRateLimitStore {
  localKeys = false;
  constructor(pool, prefix) { this.pool = pool; this.prefix = prefix; }
  init({ windowMs }) {
    this.windowMs = windowMs;
    this.timer = setInterval(() => this.pool.query('DELETE FROM api_rate_limits WHERE prefix=$1 AND expires<$2', [this.prefix, Date.now()]).catch(error => console.error('Rate limit cleanup failed:', error.code)), 60000);
    this.timer.unref();
  }
  async increment(key) {
    const now = Date.now();
    const { rows } = await this.pool.query(`INSERT INTO api_rate_limits(prefix,key,hits,expires) VALUES($1,$2,1,$3)
      ON CONFLICT(prefix,key) DO UPDATE SET
      hits=CASE WHEN api_rate_limits.expires<=$4 THEN 1 ELSE api_rate_limits.hits+1 END,
      expires=CASE WHEN api_rate_limits.expires<=$4 THEN EXCLUDED.expires ELSE api_rate_limits.expires END
      RETURNING hits,expires`, [this.prefix, key, now + this.windowMs, now]);
    return { totalHits: Number(rows[0].hits), resetTime: new Date(Number(rows[0].expires)) };
  }
  async decrement(key) { await this.pool.query('UPDATE api_rate_limits SET hits=GREATEST(0,hits-1) WHERE prefix=$1 AND key=$2', [this.prefix,key]); }
  async resetKey(key) { await this.pool.query('DELETE FROM api_rate_limits WHERE prefix=$1 AND key=$2', [this.prefix,key]); }
  shutdown() { clearInterval(this.timer); }
}
