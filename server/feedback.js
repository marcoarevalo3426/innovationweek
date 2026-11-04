import { randomUUID } from 'node:crypto';
import { all, get, run, audit, transaction } from './db.js';
import { textValue, isRecord } from '../shared/input-validation.js';
import { toCsv } from '../shared/csv.js';

const fail = message => Object.assign(new Error(message), {status:400});
const categoryName = category => category === 'general' ? 'General feedback' : 'Website feedback';

export function mountFeedback(app, limit) {
  app.post('/api/feedback', limit, async (req, res) => {
    if (!isRecord(req.body) || Object.keys(req.body).some(key => !['general','website'].includes(key))) throw fail('Use the website and general feedback fields.');
    const entries = ['website','general'].map(category => ({category, text:textValue(req.body[category], {label:categoryName(category),max:4000,optional:true})})).filter(entry => entry.text);
    if (!entries.length) throw fail('Please enter website feedback or Innovation Week feedback before submitting.');
    await transaction(async () => {
      const at = new Date().toISOString();
      for (const entry of entries) await run('INSERT INTO feedback(id,user_id,email,category,feedback,created_at) VALUES($1,$2,$3,$4,$5,$6)', randomUUID(), req.user.id, req.user.email, entry.category, entry.text, at);
      await audit(req.user.email, 'feedback.submitted', {categories:entries.map(entry=>entry.category)});
    });
    res.status(201).json({ok:true,saved:entries.length});
  });

  // /api/admin authentication and authorization middleware is mounted first.
  app.get('/api/admin/feedback', async (req, res) => {
    const category = req.query.category ?? 'all';
    if (!['all','general','website'].includes(category)) throw fail('Choose All, General feedback or Website feedback.');
    const rawOffset = req.query.offset ?? '0';
    if (typeof rawOffset !== 'string' || !/^\d{1,9}$/.test(rawOffset)) throw fail('Invalid feedback page.');
    const offset = Number(rawOffset);
    if (req.query.download === '1') {
      await audit(req.user.email, 'admin.feedback_exported', {category});
      res.attachment('innovation-feedback.csv').type('text/csv; charset=utf-8');
      res.write(toCsv(['Date','Feedback','Category','Email'], []));
      let cursor = null;
      while (!res.destroyed) {
        const rows = await all(`SELECT id,created_at,feedback,category,email FROM feedback
          WHERE ($1::text='all' OR category=$1) AND ($2::text IS NULL OR (created_at,id)<($2,$3))
          ORDER BY created_at DESC,id DESC LIMIT 100`, category, cursor?.created_at ?? null, cursor?.id ?? null);
        if (!rows.length) break;
        const csv = toCsv([], rows.map(row=>[row.created_at,row.feedback,categoryName(row.category),row.email])).slice('\uFEFF\r\n'.length);
        if (!res.write(csv)) await new Promise(resolve => {
          const done=()=>{res.off('drain',done);res.off('close',done);resolve();};
          res.once('drain',done);res.once('close',done);
        });
        cursor = rows.at(-1);
      }
      return res.end();
    }
    const rows = await all('SELECT id,created_at,feedback,category,email FROM feedback WHERE ($1::text=\'all\' OR category=$1) ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET $2', category, offset);
    const total = (await get('SELECT COUNT(*) AS n FROM feedback WHERE ($1::text=\'all\' OR category=$1)', category)).n;
    await audit(req.user.email, 'admin.feedback_viewed', {category,offset});
    res.json({rows,total});
  });
}
