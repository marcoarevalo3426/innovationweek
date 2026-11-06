import { mountFeedback } from './feedback.js';
import { textValue, fullName, isRecord, hasUnsafeKeys } from '../shared/input-validation.js';
import { getLikeStatus } from '../shared/event-state.js';
import { toCsv } from '../shared/csv.js';
import { isFooterUrl } from '../shared/footer-settings.js';
import { monitoringMiddleware } from './monitor-telemetry.mjs';
import express from 'express';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import sharp from 'sharp';
import nodemailer from 'nodemailer';
import { randomInt, randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, pool, dataDir, get, all, run, audit, syncAuditFile, SYNTHETIC_ACTOR, transaction, settings, votingState, submissionState } from './db.js';
import { isLocalAuthEnabled } from './auth-mode.js';
import { signInEmail } from './sign-in-email.js';
import { createImageStorage } from './image-storage.js';
import { PgRateLimitStore } from './pg-rate-limit-store.js';
import { isNepEmail, normalizeEmail } from '../shared/email-policy.js';
const app = express();
app.use(monitoringMiddleware);
const production = process.env.NODE_ENV === 'production';
const localAuth = isLocalAuthEnabled();
const mailMode = process.env.MAIL_MODE || (production ? 'smtp' : 'console');
const adminEmails = (process.env.ADMIN_EMAILS || (production ? '' : 'admin@nepgroup.com')).split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
if (adminEmails.some(e => !isNepEmail(e))) throw Error('ADMIN_EMAILS must contain nepgroup.com email addresses.');
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
const images = createImageStorage();
const rateLimitStore = process.env.RATE_LIMIT_STORE || 'memory';
if (!['memory', 'postgres'].includes(rateLimitStore)) throw Error('RATE_LIMIT_STORE must be memory or postgres.');
if (rateLimitStore === 'postgres') await pool.query('SELECT 1 FROM api_rate_limits LIMIT 0');
const sharedStore = prefix => rateLimitStore === 'postgres' ? { store: new PgRateLimitStore(pool, prefix) } : {};
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
// Authentication and per-user API data must not be stored in a shared CDN
// cache when the frontend proxies these routes through Amplify/CloudFront.
app.use(compression());
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.vary('Cookie');
  next();
});
app.use(express.json({
  limit: '64kb'
}));
app.use((req, res, next) => {
  if (req.body === undefined && !req.is('multipart/form-data')) req.body = {};
  if (req.body !== undefined && (!isRecord(req.body) || hasUnsafeKeys(req.body))) return res.status(400).json({error:'Enter a valid request object.'});
  next();
});
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
  ...sharedStore('auth'),
  keyGenerator: req => isNepEmail(req.body?.email) ? hash(normalizeEmail(req.body.email)) : ipKeyGenerator(req.ip),
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Too many sign-in attempts. Please try again in 15 minutes.'
  }
});
const mutationLimit = rateLimit({
  ...sharedStore('mutations'),
  keyGenerator: req => req.user?.id || ipKeyGenerator(req.ip),
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
  const email = normalizeEmail(req.body.email);
  if (!isNepEmail(email)) throw error(400, 'Use only letters and single periods before @nepgroup.com.');
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  const now = Date.now();
  await transaction(async () => {
    const previous = await get("SELECT * FROM challenges WHERE email=$1", email);
    if (previous && Date.now() - previous.sent_at < 60000) throw error(429, 'Please wait 60 seconds before requesting another code.');
    await run("INSERT INTO challenges(email,hash,expires,attempts,sent_at) VALUES($1,$2,$3,0,$4) ON CONFLICT(email) DO UPDATE SET hash=EXCLUDED.hash,expires=EXCLUDED.expires,attempts=0,sent_at=EXCLUDED.sent_at", email, otpHash(email, code), now + 600000, now);
  });
  try {
    if (transporter) await transporter.sendMail(signInEmail({
      from: process.env.MAIL_FROM,
      to: email,
      code
    }));else console.log(`[LOCAL EMAIL] ${email}: ${code} (expires in 10 minutes)`);
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
  const email = normalizeEmail(req.body.email);
  const code = String(req.body.code || '');
  if (!isNepEmail(email) || !/^\d{6}$/.test(code)) throw error(400, 'This code is invalid or expired. Request a new code.');
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
      // Any NEP colleague may join after verifying their code; no invitation or admin listing is needed.
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
app.param('id', (req, res, next, id) => /^[A-Za-z0-9_-]{1,128}$/.test(id) ? next() : next(error(400, 'Invalid record identifier.')));
const ideaQuery = `SELECT i.*,u.email AS author,(SELECT COUNT(*) FROM likes l WHERE l.idea_id=i.id) AS likes,(SELECT COUNT(*) FROM votes v WHERE v.idea_id=i.id AND v.round=$1) AS votes,EXISTS(SELECT 1 FROM likes l WHERE l.idea_id=i.id AND l.user_id=$2) AS liked,EXISTS(SELECT 1 FROM votes v WHERE v.idea_id=i.id AND v.user_id=$3 AND v.round=$4) AS voted FROM ideas i JOIN users u ON i.user_id=u.id`;
app.get('/api/ideas', async (req, res) => {
  const s = await settings();
  const ideas = await all(ideaQuery + " WHERE i.user_id <> 'nep-monitor-synthetic-v1' ORDER BY i.created_at DESC", s.round, req.user.id, req.user.id, s.round);
  res.json({
    ideas,
    user: req.user,
    localAuth,
    settings: {
      ...s,
      status: await votingState(s),
      submission_status: await submissionState(s),
      likes_status: getLikeStatus(s)
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
app.get('/api/images/:name', async (req, res) => {
  if (!/^[a-f0-9-]+\.webp$/.test(req.params.name)) throw error(404, 'Image not found.');
  res.set('Cache-Control', 'private, max-age=3600').type('image/webp').send(await images.get(req.params.name));
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
    fields: 7,
    fieldSize: 12000
  }
}).single('image');
function fields(body) {
  if (!isRecord(body) || hasUnsafeKeys(body) || Object.keys(body).some(key => !['full_name','title','problem','solution','skills','removeImage'].includes(key))) throw error(400, 'Invalid idea fields.');
  if (body.removeImage !== undefined && !['true','false'].includes(body.removeImage)) throw error(400, 'Invalid image removal option.');
  const out = {full_name: fullName(body.full_name)};
  for (const [key, max] of [['title',120],['problem',4000],['solution',4000],['skills',1000]]) {
    out[key] = textValue(body[key], {label:key === 'title' ? 'Innovation title' : key, max, multiline:key !== 'title'});
  }
  return out;
}
async function ownIdea(req) {
  const idea = await get("SELECT * FROM ideas WHERE id=$1", req.params.id);
  if (!idea) throw error(404, 'Idea not found.');
  if (idea.user_id !== req.user.id && !req.user.is_admin) throw error(403, 'You can only manage your own ideas.');
  return idea;
}
async function removeImage(name) {
  if (name) try { await images.remove(name); }
  catch (error) { console.error('Image cleanup failed:', error.name || error.code); }
}
async function saveImage(file) {
  if (!file) return null;
  let bytes;
  try {
    const image = sharp(file.buffer, { limitInputPixels: 25000000, animated: false });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw Error();
    bytes = await image.rotate().resize(1600, 1200, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
  } catch {
    throw error(400, 'Upload a valid JPG, PNG or WebP image, up to 2 MB.');
  }
  const name = randomUUID() + '.webp';
  try { await images.put(name, bytes); }
  catch (cause) {
    console.error('Image storage write failed:', cause.name || cause.code);
    throw error(503, 'Image storage is temporarily unavailable. Please try again.');
  }
  return name;
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
      const s = await settings();
      if ((await submissionState(s)) !== 'open') throw error(409, 'Idea submissions are closed. You can still edit your existing ideas.');
      if (!req.user.is_admin && (await get("SELECT COUNT(*) AS n FROM ideas WHERE user_id=$1", req.user.id)).n >= s.max_ideas) throw error(409, `You have reached the limit of ${s.max_ideas} submitted idea${s.max_ideas === 1 ? '' : 's'}.`);
      const id = randomUUID();
      const now = new Date().toISOString();
      await run("INSERT INTO ideas(id,user_id,title,problem,solution,skills,image,created_at,updated_at,full_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", id, req.user.id, f.title, f.problem, f.solution, f.skills, image, now, now, f.full_name);
      await audit(req.user.email, 'idea.created', {
        id,
        title: f.title
      });
      return await get("SELECT * FROM ideas WHERE id=$1", id);
    });
    res.status(201).json(idea);
  } catch (e) {
    await removeImage(image);
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
      await run("UPDATE ideas SET title=$1,problem=$2,solution=$3,skills=$4,image=$5,updated_at=$6,full_name=$8 WHERE id=$7", f.title, f.problem, f.solution, f.skills, image, new Date().toISOString(), original.id, f.full_name);
      await audit(req.user.email, 'idea.updated', {
        id: original.id
      });
      return original;
    });
    if (fresh || req.body.removeImage === 'true') await removeImage(original.image);
    res.json({
      ok: true
    });
  } catch (e) {
    await removeImage(fresh);
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
  await removeImage(idea.image);
  res.json({
    ok: true
  });
});
app.post('/api/ideas/:id/like', async (req, res) => {
  await transaction(async () => {
    if (getLikeStatus(await settings()) !== 'open') throw error(409, 'Likes are currently closed.');
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
    if (voted) throw error(409, 'Your vote is already recorded and cannot be withdrawn. Contact an administrator if you need help.');
    if ((await get('SELECT COUNT(*) AS n FROM votes WHERE user_id=$1 AND round=$2', req.user.id, s.round)).n >= s.max_votes) throw error(409, `You can cast a maximum of ${s.max_votes} votes.`);
    await run('INSERT INTO votes(user_id,idea_id,round) VALUES($1,$2,$3)', req.user.id, req.params.id, s.round);
    await audit(req.user.email, 'vote.cast', {id:req.params.id});
  });
  res.json({
    ok: true
  });
});
app.use('/api/admin', admin);
mountFeedback(app, rateLimit({
  ...sharedStore('feedback'), keyGenerator:req=>req.user.id, windowMs:60000, limit:5, skipFailedRequests:true,
  standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Please wait a minute before sharing more feedback.'}
}));
const displayPerson = email => email.split('@')[0].split(/[._-]/).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
app.get('/api/admin/ideas/export', async (req, res) => {
  const sort = req.query.sort || 'votes', direction = req.query.direction || 'desc';
  if (!['votes', 'likes'].includes(sort) || !['asc', 'desc'].includes(direction)) throw error(400, 'Choose a valid export sort order.');
  const s = await settings();
  const rows = await all(ideaQuery + " WHERE i.user_id <> 'nep-monitor-synthetic-v1' ORDER BY " + sort + ' ' + direction.toUpperCase() + ',i.title,i.id', s.round, req.user.id, req.user.id, s.round);
  await audit(req.user.email, 'admin.ideas_exported', {sort,direction,count:rows.length});
  res.attachment('innovation-ideas.csv').type('text/csv; charset=utf-8').send(toCsv(
    ['Idea ID','Innovation title','Full name','Submitted by','Votes','Likes','Problem you want to solve','Your idea for solving it','Skills of people you’d like on your team','Submitted at','Updated at','Image'],
    rows.map(row => [row.id,row.title,row.full_name,row.author,row.votes,row.likes,row.problem,row.solution,row.skills,row.created_at,row.updated_at,row.image || ''])
  ));
});
app.get('/api/admin/participation', async (req, res) => {
  // The legacy storage marker stays fixed; only active votes are reported.
  const round = (await settings()).round;
  let rows = await all(`WITH vote_counts AS (
      SELECT user_id,COUNT(*) AS voted FROM votes WHERE round=$1 GROUP BY user_id
    ), like_counts AS (
      SELECT user_id,COUNT(*) AS liked FROM likes GROUP BY user_id
    ) SELECT u.id,u.email,COALESCE(v.voted,0) AS voted,COALESCE(l.liked,0) AS liked
      FROM users u LEFT JOIN vote_counts v ON v.user_id=u.id LEFT JOIN like_counts l ON l.user_id=u.id
      WHERE LOWER(BTRIM(u.email)) <> $2 AND (COALESCE(v.voted,0)>0 OR COALESCE(l.liked,0)>0)
      ORDER BY LOWER(u.email),u.id`, round, SYNTHETIC_ACTOR);
  if (req.query.search !== undefined) {
    const search = textValue(req.query.search, {label:'Participant search',max:254,optional:true,multiline:false}).toLowerCase();
    rows = rows.filter(row => (displayPerson(row.email)+' '+row.email).toLowerCase().includes(search));
  }
  await audit(req.user.email, req.query.download ? 'admin.participation_exported' : 'admin.participation_viewed', {count:rows.length});
  if (req.query.download) return res.attachment('innovation-participation.csv').type('text/csv; charset=utf-8').send(toCsv(
    ['Name','Email','Ideas voted for','Ideas liked'], rows.map(row=>[displayPerson(row.email),row.email,row.voted,row.liked])
  ));
  res.json({rows});
});
for (const category of ['votes','likes']) app.post('/api/admin/users/:id/reset-'+category, async (req, res) => {
  if (req.body?.confirmed !== true) throw error(400, 'Confirm before clearing this user’s '+category+'.');
  const cleared = await transaction(async () => {
    const actor = await get('SELECT is_admin FROM users WHERE id=$1', req.user.id);
    if (!actor || (!localAuth && !actor.is_admin)) throw error(403, 'Administrator access required.');
    const user = await get('SELECT id,email FROM users WHERE id=$1', req.params.id);
    if (!user) throw error(404, 'User not found.');
    // category comes only from this fixed server-side list, never request data.
    const result = await run('DELETE FROM '+category+' WHERE user_id=$1', user.id);
    await audit(req.user.email, 'admin.user_'+category+'_reset', {email:user.email,cleared:result.rowCount});
    return result.rowCount;
  });
  res.json({ok:true,cleared});
});
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
app.delete('/api/admin/users/:id', async (req, res) => {
  if (req.body?.confirmed !== true) throw error(400, 'Confirm before deleting an account.');
  const removedImages = await transaction(async () => {
    const actor = await get('SELECT is_admin FROM users WHERE id=$1', req.user.id);
    if (!actor || (!localAuth && !actor.is_admin)) throw error(403, 'Administrator access required.');
    const user = await get('SELECT * FROM users WHERE id=$1', req.params.id);
    if (!user) throw error(404, 'User not found.');
    if (user.id === req.user.id) throw error(409, 'You cannot delete your own account. Ask another administrator.');
    if (user.is_admin && (await get('SELECT COUNT(*) AS n FROM users WHERE is_admin=1')).n <= 1) throw error(409, 'At least one administrator must remain.');
    const owned = await all('SELECT image FROM ideas WHERE user_id=$1', user.id);
    await run('DELETE FROM sessions WHERE user_id=$1', user.id);
    await run('DELETE FROM challenges WHERE email=$1', user.email);
    await run('DELETE FROM likes WHERE user_id=$1', user.id);
    await run('DELETE FROM votes WHERE user_id=$1', user.id);
    // Idea foreign keys also remove other users’ likes and votes on those ideas.
    await run('DELETE FROM ideas WHERE user_id=$1', user.id);
    await run('DELETE FROM users WHERE id=$1', user.id);
    await audit(req.user.email, 'admin.account_deleted', {email:user.email,ideas:owned.length});
    return owned.map(idea => idea.image).filter(Boolean);
  });
  await Promise.all(removedImages.map(removeImage));
  res.json({ok:true});
});
app.patch('/api/admin/settings', async (req, res) => {
  await transaction(async () => {
    const old = await settings();
    const flags = ['show_vote_counts', 'show_like_counts', 'show_timer', 'show_welcome', 'top_votes', 'top_likes', 'innovation_award', 'peoples_award'];
    const allowed = ['mode', 'starts_at', 'ends_at', 'max_votes', ...flags, 'submission_mode', 'submission_ends_at', 'footer_text', 'footer_link_text', 'footer_url', 'max_ideas', 'likes_mode', 'likes_starts_at', 'likes_ends_at'];
    if (Object.keys(req.body).some(k => !allowed.includes(k))) throw error(400, 'Unknown setting.');
    const s = {
      ...old,
      ...req.body
    };
    for (const [key, limit] of [['footer_text', 200], ['footer_link_text', 80]]) {
      if (typeof s[key] !== 'string' || !s[key].trim() || s[key].trim().length > limit) throw error(400, `Footer ${key === 'footer_text' ? 'message' : 'link text'} must be between 1 and ${limit} characters.`);
      s[key] = textValue(s[key], {label:'Footer text',max:limit,multiline:false});
    }
    if (typeof s.footer_url !== 'string' || !isFooterUrl(s.footer_url.trim())) throw error(400, 'Enter a full HTTP or HTTPS footer URL without embedded credentials.');
    s.footer_url = s.footer_url.trim();
    if (!['open', 'closed', 'scheduled'].includes(s.mode)) throw error(400, 'Invalid voting mode.');
    if (!['open', 'closed', 'scheduled'].includes(s.likes_mode)) throw error(400, 'Invalid like mode.');
    if (!['open', 'closed', 'scheduled'].includes(s.submission_mode)) throw error(400, 'Invalid submission mode.');
    if (!Number.isInteger(s.max_votes) || s.max_votes < 1 || s.max_votes > 100) throw error(400, 'Maximum votes must be between 1 and 100.');
    if (!Number.isInteger(s.max_ideas) || s.max_ideas < 1 || s.max_ideas > 100) throw error(400, 'Maximum ideas must be between 1 and 100.');
    for (const k of flags) if (![0, 1].includes(s[k])) throw error(400, 'Display settings must be 0 or 1.');
    for (const k of ['starts_at', 'ends_at', 'submission_ends_at', 'likes_starts_at', 'likes_ends_at']) if (s[k] !== null && (typeof s[k] !== 'string' || !Number.isFinite(Date.parse(s[k])))) throw error(400, 'Enter valid schedule dates.');
    if (s.mode === 'scheduled' && (!s.starts_at || !s.ends_at || Date.parse(s.ends_at) <= Date.parse(s.starts_at))) throw error(400, 'Voting end must be after the start.');
    if (s.mode === 'open' && !s.ends_at && ('mode' in req.body || 'ends_at' in req.body)) throw error(400, 'Set the voting end date and time to open voting.');
    if (s.likes_mode === 'scheduled' && (!s.likes_starts_at || !s.likes_ends_at || Date.parse(s.likes_ends_at) <= Date.parse(s.likes_starts_at))) throw error(400, 'Like end must be after the start.');
    if (s.submission_mode === 'scheduled' && !s.submission_ends_at) throw error(400, 'Set the idea submission closing date and time.');
    let startedAt = old.voting_started_at;
    const votingChanged = ['mode', 'starts_at', 'ends_at'].some(k => Object.hasOwn(req.body, k) && s[k] !== old[k]);
    if (votingChanged) {
      const now = Date.now();
      if (s.mode === 'scheduled') startedAt = Date.parse(s.starts_at) > now ? null : s.starts_at;else if (s.mode === 'open') startedAt = (await votingState(old)) === 'open' ? startedAt || new Date(now).toISOString() : new Date(now).toISOString();else if ((await votingState(old)) === 'open') startedAt = startedAt || (old.mode === 'scheduled' ? old.starts_at : new Date(now).toISOString());else if (old.mode === 'scheduled' && Date.parse(old.starts_at) <= now) startedAt = startedAt || old.starts_at;
    }
    {
      await run(`UPDATE settings SET ${allowed.map((k, i) => k + '=$' + (i + 1)).join(',')},voting_started_at=$${allowed.length + 1} WHERE id=1`, ...allowed.map(k => s[k]), startedAt);
      await audit(req.user.email, 'admin.settings_updated', req.body);
    }
  });
  res.json({
    ok: true
  });
});
app.post('/api/admin/reset-votes', async (req, res) => {
  if (req.body?.confirmed !== true) throw error(400, 'Confirm before resetting all votes.');
  const cleared = await transaction(async () => {
    const result = await run('DELETE FROM votes');
    await audit(req.user.email, 'admin.votes_reset', {cleared:result.rowCount});
    return result.rowCount;
  });
  res.json({ok:true,cleared});
});
app.post('/api/admin/reset-likes', async (req, res) => {
  if (req.body?.confirmed !== true) throw error(400, 'Confirm before resetting all likes.');
  const cleared = await transaction(async () => {
    const result = await run('DELETE FROM likes');
    await audit(req.user.email, 'admin.likes_reset', {cleared:result.rowCount});
    return result.rowCount;
  });
  res.json({ok:true,cleared});
});
app.delete('/api/admin/audit', async (req, res) => {
  if (req.body?.confirmed !== true) throw error(400, 'Confirm before clearing activity logs.');
  const cleared = await transaction(async () => {
    const result = await run('DELETE FROM audit');
    await audit(req.user.email, 'admin.audit_cleared', {cleared:result.rowCount});
    return result.rowCount;
  });
  await syncAuditFile();
  res.json({ok:true,cleared});
});
app.get('/api/admin/audit', async (req, res) => {
  await audit(req.user.email, req.query.download ? 'admin.audit_exported' : 'admin.audit_viewed');
  if (req.query.download) {
    const limit = (await get("SELECT COALESCE(MAX(id),0) AS id FROM audit")).id;
    res.attachment('innovation-week-audit.jsonl').type('application/x-ndjson');
    let after = 0;
    while (after < limit && !res.destroyed) {
      const rows = await all("SELECT * FROM audit WHERE id>$1 AND id<=$2 AND LOWER(BTRIM(actor)) <> $3 ORDER BY id LIMIT 500", after, limit, SYNTHETIC_ACTOR);
      if (!rows.length) break;
      for (const row of rows) {
        if (!res.write(JSON.stringify({
          ...row,
          details: JSON.parse(row.details)
        }) + '\n')) {
          await new Promise(resolve => {
            const done = () => {
              res.off('drain', done);
              res.off('close', done);
              resolve();
            };
            res.once('drain', done);
            res.once('close', done);
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
      rows: await all("SELECT * FROM audit WHERE LOWER(BTRIM(actor)) <> $2 ORDER BY id DESC LIMIT 50 OFFSET $1", offset, SYNTHETIC_ACTOR),
      total: (await get("SELECT COUNT(*) AS n FROM audit WHERE LOWER(BTRIM(actor)) <> $1", SYNTHETIC_ACTOR)).n
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
    error: err.type === 'entity.parse.failed' ? 'Invalid JSON request body.' : err.type === 'entity.too.large' ? 'Request is too large.' : err.code === 'LIMIT_FILE_SIZE' ? 'Image must be 2 MB or smaller.' : status === 500 ? 'Something went wrong. Please try again.' : err.message
  });
});
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
const server = app.listen(port, host, () => console.log(`Innovation Week API: http://${host}:${server.address().port} · ${localAuth ? 'local access: ' + localEmail + ' (no email authentication)' : 'email: ' + mailMode}${!localAuth && !production ? ' · local administrator: ' + adminEmails.join(', ') : ''}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => {
  await db.close();
  process.exit(0);
}));
