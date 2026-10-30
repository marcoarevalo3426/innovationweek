import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import sharp from 'sharp';
import nodemailer from 'nodemailer';
import { randomInt, randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, dataDir, get, all, run, audit, transaction, settings, votingState, submissionState } from './db.js';
import { isLocalAuthEnabled } from './auth-mode.js';
const app = express();
const production = process.env.NODE_ENV === 'production';
const localAuth = isLocalAuthEnabled();
const mailMode = process.env.MAIL_MODE || (production ? 'smtp' : 'console');
const adminEmails = (process.env.ADMIN_EMAILS || (production ? '' : 'admin@nepgroup.com')).split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const emailValid = email => typeof email === 'string' && email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@nepgroup\.com$/i.test(email) && !email.startsWith('.') && !email.includes('..') && !email.includes('.@');
if (adminEmails.some(e => !emailValid(e))) throw Error('ADMIN_EMAILS must contain nepgroup.com email addresses.');
if (production && (mailMode !== 'smtp' || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 || !process.env.APP_ORIGIN)) throw Error('Production requires SMTP, APP_ORIGIN, and a SESSION_SECRET of at least 32 characters.');
if (production && !adminEmails.length && !(await get("SELECT id FROM users WHERE is_admin=1"))) throw Error('Configure ADMIN_EMAILS for the initial administrator.');
const secretPath = resolve(dataDir, '.session-secret');
if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(48).toString('hex'), {
  mode: 0o600
});
const secret = process.env.SESSION_SECRET || readFileSync(secretPath, 'utf8');
const hash = s => createHash('sha256').update(s).digest('hex');
const otpHash = (email, code) => createHmac('sha256', secret).update(email + ':' + code).digest('hex');
const transporter = !localAuth && mailMode === 'smtp' ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT || 587) === 465,
  requireTLS: Number(process.env.SMTP_PORT || 587) !== 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  connectionTimeout: 10000,
  socketTimeout: 10000
}) : null;
if (transporter && (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.MAIL_FROM)) throw Error('Set SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM.');
const uploadDir = resolve(dataDir, 'uploads');
mkdirSync(uploadDir, {
  recursive: true
});
// Local requests use a stable development identity, without codes or sessions.
const localEmail = 'local.admin@nepgroup.com';
if (localAuth && !(await get("SELECT id FROM users WHERE email=$1", localEmail))) {
  await run("INSERT INTO users(id,email,is_admin,created_at) VALUES($1,$2,0,$3) ON CONFLICT(email) DO NOTHING", randomUUID(), localEmail, new Date().toISOString());
  await audit(localEmail, 'auth.local_account_created');
}
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
app.use(helmet({
  contentSecurityPolicy: production ? {
    directives: {
      imgSrc: ["'self'", 'blob:', 'data:'],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"]
    }
  } : false
}));
app.use(express.json({
  limit: '20kb'
}));
app.use(cookieParser());
// Custom same-origin header plus origin validation blocks cross-site cookie-authenticated mutations.
app.use('/api', async (req, res, next) => {
  if (req.path === '/health') return next();
  if (['POST', 'PUT', "DELETE", 'PATCH'].includes(req.method)) {
    if (req.get('X-Requested-With') !== 'InnovationWeek') return res.status(403).json({
      error: 'Invalid request origin.'
    });
    const origin = req.get('Origin');
    const allowed = production ? [process.env.APP_ORIGIN] : [process.env.APP_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3001', 'http://127.0.0.1:3001'];
    if (origin && !allowed.includes(origin)) return res.status(403).json({
      error: 'Invalid request origin.'
    });
  }
  const token = req.cookies.nep_session;
  // Admin privileges are temporary: the local identity is stored as a regular
  // user and receives admin access only while this server runs in local mode.
  req.user = localAuth ? {
    ...(await get("SELECT * FROM users WHERE email=$1", localEmail)),
    is_admin: 1
  } : token ? await get("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=$1 AND s.expires>$2", hash(token), Date.now()) : null;
  next();
});
const error = (status, message) => Object.assign(new Error(message), {
  status
});
const auth = (req, res, next) => req.user ? next() : next(error(401, 'Please sign in to continue.'));
const admin = (req, res, next) => req.user?.is_admin ? next() : next(error(403, 'Administrator access required.'));
const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Too many sign-in attempts. Please try again in 15 minutes.'
  }
});
const mutationLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please wait a minute.'
  }
});
app.use('/api/auth', (req, res, next) => req.path === '/me' ? next() : authLimit(req, res, next));
app.use('/api', (req, res, next) => ['GET', 'HEAD'].includes(req.method) ? next() : mutationLimit(req, res, next));
app.get('/api/health', async (_, res) => {
  try {
    await get("SELECT 1 AS ready");
    res.json({
      ok: true,
      database: 'postgres'
    });
  } catch {
    res.status(503).json({
      ok: false,
      database: 'postgres'
    });
  }
});
app.get('/api/auth/me', (req, res) => res.json({
  user: req.user,
  localAuth,
  development: !localAuth && !production && mailMode === 'console'
}));
app.use('/api/auth', (req, res, next) => {
  if (localAuth) return res.status(409).json({
    error: 'Email authentication is disabled in local development.'
  });
  next();
});
app.post('/api/auth/request', async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!emailValid(email)) throw error(400, 'Use a valid @nepgroup.com email address.');
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  const now = Date.now();
  await transaction(async () => {
    const previous = await get("SELECT * FROM challenges WHERE email=$1", email);
    if (previous && Date.now() - previous.sent_at < 60000) throw error(429, 'Please wait 60 seconds before requesting another code.');
    await run("INSERT INTO challenges(email,hash,expires,attempts,sent_at) VALUES($1,$2,$3,0,$4) ON CONFLICT(email) DO UPDATE SET hash=EXCLUDED.hash,expires=EXCLUDED.expires,attempts=0,sent_at=EXCLUDED.sent_at", email, otpHash(email, code), now + 600000, now);
  });
  try {
    if (transporter) await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: email,
      subject: 'Your NEP Innovation Week sign-in code',
      text: `Your sign-in code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this message.`
    });else console.log(`[LOCAL EMAIL] ${email}: ${code} (expires in 10 minutes)`);
  } catch (e) {
    await transaction(async () => {
      await run("DELETE FROM challenges WHERE email=$1 AND hash=$2", email, otpHash(email, code));
      await audit(email, 'auth.delivery_failed');
    });
    throw error(503, 'We could not send your code. Please try again shortly.');
  }
  await audit(email, 'auth.code_requested');
  res.json({
    ok: true,
    ...(!production && mailMode === 'console' ? {
      developmentCode: code
    } : {})
  });
});
app.post('/api/auth/verify', async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const code = String(req.body.code || '');
  if (!emailValid(email) || !/^\d{6}$/.test(code)) throw error(400, 'This code is invalid or expired. Request a new code.');
  const token = randomBytes(32).toString('hex');
  const result = await transaction(async () => {
    const challenge = await get("SELECT * FROM challenges WHERE email=$1", email);
    if (!challenge || challenge.expires < Date.now() || challenge.attempts >= 5) return {
      invalid: true
    };
    if (!timingSafeEqual(Buffer.from(challenge.hash, 'hex'), Buffer.from(otpHash(email, code), 'hex'))) {
      await run("UPDATE challenges SET attempts=attempts+1 WHERE email=$1", email);
      await audit(email, 'auth.verification_failed');
      return {
        incorrect: true
      };
    }
    let user = await get("SELECT * FROM users WHERE email=$1", email);
    if (!user) {
      await run("INSERT INTO users(id,email,is_admin,created_at) VALUES($1,$2,$3,$4)", randomUUID(), email, adminEmails.includes(email) ? 1 : 0, new Date().toISOString());
      user = await get("SELECT * FROM users WHERE email=$1", email);
    }
    await run("DELETE FROM challenges WHERE email=$1", email);
    await run("DELETE FROM sessions WHERE expires<$1", Date.now());
    await run("INSERT INTO sessions(hash,user_id,expires) VALUES($1,$2,$3)", hash(token), user.id, Date.now() + 86400000);
    await audit(email, 'auth.signed_in');
    return {
      user
    };
  });
  if (result.invalid) throw error(400, 'This code is invalid or expired. Request a new code.');
  if (result.incorrect) throw error(400, 'Incorrect code. Please check your email and try again.');
  res.cookie('nep_session', token, {
    httpOnly: true,
    secure: production,
    sameSite: 'strict',
    maxAge: 86400000,
    path: '/'
  }).json({
    user: result.user
  });
});
app.post('/api/auth/logout', auth, async (req, res) => {
  await transaction(async () => {
    await run("DELETE FROM sessions WHERE hash=$1", hash(req.cookies.nep_session));
    await audit(req.user.email, 'auth.signed_out');
  });
  res.clearCookie('nep_session', {
    path: '/',
    httpOnly: true,
    secure: production,
    sameSite: 'strict'
  }).json({
    ok: true
  });
});
app.use('/api', auth);
const ideaQuery = `SELECT i.*,u.email AS author,(SELECT COUNT(*) FROM likes l WHERE l.idea_id=i.id) AS likes,(SELECT COUNT(*) FROM votes v WHERE v.idea_id=i.id AND v.round=$1) AS votes,EXISTS(SELECT 1 FROM likes l WHERE l.idea_id=i.id AND l.user_id=$2) AS liked,EXISTS(SELECT 1 FROM votes v WHERE v.idea_id=i.id AND v.user_id=$3 AND v.round=$4) AS voted FROM ideas i JOIN users u ON i.user_id=u.id`;
app.get('/api/ideas', async (req, res) => {
  const s = await settings();
  const ideas = await all(ideaQuery + ' ORDER BY i.created_at DESC', s.round, req.user.id, req.user.id, s.round);
  res.json({
    ideas,
    settings: {
      ...s,
      status: await votingState(s),
      submission_status: await submissionState(s)
    },
    votesUsed: (await get("SELECT COUNT(*) AS n FROM votes WHERE user_id=$1 AND round=$2", req.user.id, s.round)).n,
    serverTime: Date.now()
  });
});
app.get('/api/ideas/:id', async (req, res) => {
  const s = await settings();
  const idea = await get(ideaQuery + " WHERE i.id=$5", s.round, req.user.id, req.user.id, s.round, req.params.id);
  if (!idea) throw error(404, 'Idea not found.');
  await audit(req.user.email, 'idea.viewed', {
    id: idea.id
  });
  res.json(idea);
});
app.get('/api/images/:name', (req, res) => {
  if (!/^[a-f0-9-]+\.webp$/.test(req.params.name)) throw error(404, 'Image not found.');
  res.set('Cache-Control', 'private, max-age=3600').sendFile(resolve(uploadDir, req.params.name));
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
    fields: 6,
    fieldSize: 12000
  }
}).single('image');
function fields(body) {
  const out = {};
  for (const [key, max] of [['title', 120], ['problem', 4000], ['solution', 4000], ['skills', 1000]]) {
    if (typeof body[key] !== 'string' || !body[key].trim() || body[key].trim().length > max) throw error(400, `${key[0].toUpperCase() + key.slice(1)} is required and must be ${max} characters or fewer.`);
    out[key] = body[key].trim();
  }
  return out;
}
async function ownIdea(req) {
  const idea = await get("SELECT * FROM ideas WHERE id=$1", req.params.id);
  if (!idea) throw error(404, 'Idea not found.');
  if (idea.user_id !== req.user.id && !req.user.is_admin) throw error(403, 'You can only manage your own ideas.');
  return idea;
}
function removeImage(name) {
  if (name) try {
    unlinkSync(resolve(uploadDir, name));
  } catch {}
}
async function saveImage(file) {
  if (!file) return null;
  try {
    const image = sharp(file.buffer, {
      limitInputPixels: 25000000,
      animated: false
    });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw Error();
    const name = randomUUID() + '.webp';
    await image.rotate().resize(1600, 1200, {
      fit: 'inside',
      withoutEnlargement: true
    }).webp({
      quality: 85
    }).toFile(resolve(uploadDir, name));
    return name;
  } catch {
    throw error(400, 'Upload a valid JPG, PNG or WebP image, up to 2 MB.');
  }
}
async function requireSubmissionsOpen(req, res, next) {
  if ((await submissionState()) !== 'open') return next(error(409, 'Idea submissions are closed. You can still edit your existing ideas.'));
  next();
}
app.post('/api/ideas', requireSubmissionsOpen, upload, async (req, res) => {
  const f = fields(req.body);
  const image = await saveImage(req.file);
  try {
    const idea = await transaction(async () => {
      if ((await submissionState()) !== 'open') throw error(409, 'Idea submissions are closed. You can still edit your existing ideas.');
      if (!req.user.is_admin && (await get("SELECT COUNT(*) AS n FROM ideas WHERE user_id=$1", req.user.id)).n >= 2) throw error(409, 'You have reached the limit of 2 submitted ideas.');
      const id = randomUUID();
      const now = new Date().toISOString();
      await run("INSERT INTO ideas(id,user_id,title,problem,solution,skills,image,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", id, req.user.id, f.title, f.problem, f.solution, f.skills, image, now, now);
      await audit(req.user.email, 'idea.created', {
        id,
        title: f.title
      });
      return await get("SELECT * FROM ideas WHERE id=$1", id);
    });
    res.status(201).json(idea);
  } catch (e) {
    removeImage(image);
    throw e;
  }
});
app.put('/api/ideas/:id', upload, async (req, res) => {
  await ownIdea(req);
  const f = fields(req.body);
  const fresh = await saveImage(req.file);
  try {
    const original = await transaction(async () => {
      const original = await ownIdea(req);
      const image = fresh || (req.body.removeImage === 'true' ? null : original.image);
      await run("UPDATE ideas SET title=$1,problem=$2,solution=$3,skills=$4,image=$5,updated_at=$6 WHERE id=$7", f.title, f.problem, f.solution, f.skills, image, new Date().toISOString(), original.id);
      await audit(req.user.email, 'idea.updated', {
        id: original.id
      });
      return original;
    });
    if (fresh || req.body.removeImage === 'true') removeImage(original.image);
    res.json({
      ok: true
    });
  } catch (e) {
    removeImage(fresh);
    throw e;
  }
});
app.delete('/api/ideas/:id', async (req, res) => {
  const idea = await transaction(async () => {
    const idea = await ownIdea(req);
    await run("DELETE FROM ideas WHERE id=$1", idea.id);
    await audit(req.user.email, 'idea.deleted', {
      id: idea.id,
      title: idea.title
    });
    return idea;
  });
  removeImage(idea.image);
  res.json({
    ok: true
  });
});
app.post('/api/ideas/:id/like', async (req, res) => {
  await transaction(async () => {
    if (!(await get("SELECT id FROM ideas WHERE id=$1", req.params.id))) throw error(404, 'Idea not found.');
    const liked = await get("SELECT * FROM likes WHERE user_id=$1 AND idea_id=$2", req.user.id, req.params.id);
    if (liked) await run("DELETE FROM likes WHERE user_id=$1 AND idea_id=$2", req.user.id, req.params.id);else await run("INSERT INTO likes(user_id,idea_id) VALUES($1,$2)", req.user.id, req.params.id);
    await audit(req.user.email, liked ? 'idea.unliked' : 'idea.liked', {
      id: req.params.id
    });
  });
  res.json({
    ok: true
  });
});
app.post('/api/ideas/:id/vote', async (req, res) => {
  await transaction(async () => {
    const s = await settings();
    if ((await votingState(s)) !== 'open') throw error(409, 'Voting is currently closed.');
    if (!(await get("SELECT id FROM ideas WHERE id=$1", req.params.id))) throw error(404, 'Idea not found.');
    const voted = await get("SELECT * FROM votes WHERE user_id=$1 AND idea_id=$2 AND round=$3", req.user.id, req.params.id, s.round);
    if (voted) await run("DELETE FROM votes WHERE user_id=$1 AND idea_id=$2 AND round=$3", req.user.id, req.params.id, s.round);else {
      if ((await get("SELECT COUNT(*) AS n FROM votes WHERE user_id=$1 AND round=$2", req.user.id, s.round)).n >= s.max_votes) throw error(409, `You can cast a maximum of ${s.max_votes} votes. Withdraw a vote to choose another idea.`);
      await run("INSERT INTO votes(user_id,idea_id,round) VALUES($1,$2,$3)", req.user.id, req.params.id, s.round);
    }
    await audit(req.user.email, voted ? 'vote.withdrawn' : 'vote.cast', {
      id: req.params.id,
      round: s.round
    });
  });
  res.json({
    ok: true
  });
});
app.use('/api/admin', admin);
app.get('/api/admin/users', async (req, res) => {
  await audit(req.user.email, 'admin.users_viewed');
  res.json(await all("SELECT * FROM users ORDER BY email"));
});
app.patch('/api/admin/users/:id', async (req, res) => {
  if (![0, 1].includes(req.body.is_admin)) throw error(400, 'Permission must be 0 or 1.');
  await transaction(async () => {
    const user = await get("SELECT * FROM users WHERE id=$1", req.params.id);
    if (!user) throw error(404, 'User not found.');
    if (user.is_admin && !req.body.is_admin && (await get("SELECT COUNT(*) AS n FROM users WHERE is_admin=1")).n <= 1) throw error(409, 'At least one administrator must remain.');
    await run("UPDATE users SET is_admin=$1 WHERE id=$2", req.body.is_admin, user.id);
    await audit(req.user.email, 'admin.permission_changed', {
      email: user.email,
      is_admin: req.body.is_admin
    });
  });
  res.json({
    ok: true
  });
});
app.patch('/api/admin/settings', async (req, res) => {
  await transaction(async () => {
  const old = await settings();
  const flags = ['show_timer', 'show_welcome', 'top_votes', 'top_likes', 'innovation_award', 'peoples_award'];
  const allowed = ['mode', 'starts_at', 'ends_at', 'max_votes', ...flags, 'submission_mode', 'submission_ends_at'];
  if (Object.keys(req.body).some(k => !allowed.includes(k))) throw error(400, 'Unknown setting.');
  const s = {
    ...old,
    ...req.body
  };
  if (!['open', 'closed', 'scheduled'].includes(s.mode)) throw error(400, 'Invalid voting mode.');
  if (!['open', 'closed', 'scheduled'].includes(s.submission_mode)) throw error(400, 'Invalid submission mode.');
  if (!Number.isInteger(s.max_votes) || s.max_votes < 1 || s.max_votes > 100) throw error(400, 'Maximum votes must be between 1 and 100.');
  for (const k of flags) if (![0, 1].includes(s[k])) throw error(400, 'Display settings must be 0 or 1.');
  for (const k of ['starts_at', 'ends_at', 'submission_ends_at']) if (s[k] !== null && (typeof s[k] !== 'string' || !Number.isFinite(Date.parse(s[k])))) throw error(400, 'Enter valid schedule dates.');
  if (s.mode === 'scheduled' && (!s.starts_at || !s.ends_at || Date.parse(s.ends_at) <= Date.parse(s.starts_at))) throw error(400, 'Voting end must be after the start.');
  if (s.mode === 'open' && !s.ends_at && ('mode' in req.body || 'ends_at' in req.body)) throw error(400, 'Set the voting end date and time to open voting.');
  if (s.submission_mode === 'scheduled' && !s.submission_ends_at) throw error(400, 'Set the idea submission closing date and time.');
  let startedAt = old.voting_started_at;
  const votingChanged = ['mode', 'starts_at', 'ends_at'].some(k => Object.hasOwn(req.body, k) && s[k] !== old[k]);
  if (votingChanged) {
    const now = Date.now();
    if (s.mode === 'scheduled') startedAt = Date.parse(s.starts_at) > now ? null : s.starts_at;else if (s.mode === 'open') startedAt = (await votingState(old)) === 'open' ? startedAt || new Date(now).toISOString() : new Date(now).toISOString();else if ((await votingState(old)) === 'open') startedAt = startedAt || (old.mode === 'scheduled' ? old.starts_at : new Date(now).toISOString());else if (old.mode === 'scheduled' && Date.parse(old.starts_at) <= now) startedAt = startedAt || old.starts_at;
  }
  await transaction(async () => {
    await run(`UPDATE settings SET ${allowed.map((k, i) => k + '=$' + (i + 1)).join(',')},voting_started_at=$${allowed.length + 1} WHERE id=1`, ...allowed.map(k => s[k]), startedAt);
    await audit(req.user.email, 'admin.settings_updated', req.body);
  });
  });
  res.json({
    ok: true
  });
});
app.post('/api/admin/reset-votes', async (req, res) => {
  await transaction(async () => {
    await run("UPDATE settings SET round=round+1 WHERE id=1");
    await audit(req.user.email, 'admin.votes_reset', {
      round: (await settings()).round
    });
  });
  res.json({
    ok: true
  });
});
app.get('/api/admin/audit', async (req, res) => {
  await audit(req.user.email, req.query.download ? 'admin.audit_exported' : 'admin.audit_viewed');
  if (req.query.download) {
    const limit = (await get("SELECT COALESCE(MAX(id),0) AS id FROM audit")).id;
    res.attachment('innovation-week-audit.jsonl').type('application/x-ndjson');
    let after = 0;
    while (after < limit && !res.destroyed) {
      const rows = await all("SELECT * FROM audit WHERE id>$1 AND id<=$2 ORDER BY id LIMIT 500", after, limit);
      if (!rows.length) break;
      for (const row of rows) {
        if (!res.write(JSON.stringify({ ...row, details: JSON.parse(row.details) }) + '\n')) {
          await new Promise(resolve => {
            const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
            res.once('drain', done); res.once('close', done);
          });
        }
        if (res.destroyed) break;
      }
      after = rows.at(-1).id;
    }
    res.end();
  } else {
    const offset = Math.max(0, Math.min(2147483647, Math.trunc(Number(req.query.offset) || 0)));
    res.json({
      rows: await all("SELECT * FROM audit ORDER BY id DESC LIMIT 50 OFFSET $1", offset),
      total: (await get("SELECT COUNT(*) AS n FROM audit")).n
    });
  }
});
app.use('/api', (req, res) => res.status(404).json({
  error: 'Endpoint not found.'
}));
if (existsSync(resolve('dist/index.html'))) {
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_, res) => res.sendFile(resolve('dist/index.html')));
}
app.use((err, req, res, next) => {
  const status = err.code === 'LIMIT_FILE_SIZE' ? 400 : err instanceof multer.MulterError ? 400 : err.status || 500;
  if (status === 500) console.error(err);
  if (res.headersSent) return res.destroy();
  res.status(status).json({
    error: err.code === 'LIMIT_FILE_SIZE' ? 'Image must be 2 MB or smaller.' : status === 500 ? 'Something went wrong. Please try again.' : err.message
  });
});
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
const server = app.listen(port, host, () => console.log(`Innovation Week API: http://${host}:${server.address().port} · ${localAuth ? 'local access: ' + localEmail + ' (no email authentication)' : 'email: ' + mailMode}${!localAuth && !production ? ' · local administrator: ' + adminEmails.join(', ') : ''}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => {
  await db.close();
  process.exit(0);
}));
