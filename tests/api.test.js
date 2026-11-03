import { testDatabase } from './pg-helpers.js';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const database=await testDatabase();
const root=mkdtempSync(join(tmpdir(),'innovation-tests-'));
const server=spawn(process.execPath,['server/index.js'],{env:{...database.env,DATA_DIR:root,PORT:'0',HOST:'127.0.0.1',MAIL_MODE:'console',NODE_ENV:'test',ADMIN_EMAILS:'admin@nepgroup.com'},stdio:['ignore','pipe','pipe']});
let base;const ready=new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(Error('Server startup timeout')),10000);server.stdout.on('data',d=>{output+=d;const m=output.match(/http:\/\/127.0.0.1:(\d+)/);if(m){clearTimeout(timeout);base=m[0];resolve();}});server.once('exit',code=>{clearTimeout(timeout);reject(Error('Server exited: '+code+' '+output));});});
const clients={};
async function request(path,{method='GET',body,client,header=true}={}){const res=await fetch(base+'/api'+path,{method,headers:{...(header?{'X-Requested-With':'InnovationWeek'}:{}),...(body instanceof FormData?{}:{'Content-Type':'application/json'}),...(client?{Cookie:clients[client]||''}:{})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});const cookie=res.headers.get('set-cookie');if(client&&cookie)clients[client]=cookie.split(';')[0];const raw=await res.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}return {status:res.status,data,headers:res.headers};}
async function login(email,client){const sent=await request('/auth/request',{method:'POST',body:{email}});assert.equal(sent.status,200);assert.match(sent.data.developmentCode,/^\d{6}$/);const verified=await request('/auth/verify',{method:'POST',body:{email,code:sent.data.developmentCode},client});assert.equal(verified.status,200);return {user:verified.data.user,code:sent.data.developmentCode};}
const ideaBody=title=>({title,problem:'Production teams repeat manual work.',solution:'Build a connected tool that automates it.',skills:'Engineering, operations and design'});
function form(body,file){const f=new FormData();for(const[k,v]of Object.entries(body))f.append(k,v);if(file)f.append('image',new Blob([file],{type:'image/png'}),'image.png');return f;}

test('Full local API workflow and security rules',async t=>{
 await ready;
 t.after(async()=>{if(server.exitCode===null){const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;}await database.cleanup();rmSync(root,{recursive:true,force:true});});
 let alice,bob,admin;let first,second,third;
 await t.test('requires authentication and same-origin mutation header',async()=>{const health=await request('/health');assert.match(health.headers.get('cache-control'),/private.*no-store/);assert.match(health.headers.get('vary'),/Cookie/);assert.equal((await request('/ideas')).status,401);assert.equal((await request('/auth/request',{method:'POST',header:false,body:{email:'x@nepgroup.com'}})).status,403);});
 await t.test('validates exact NEP email domain',async()=>{for(const email of ['a@gmail.com','a@nepgroup.com.evil.com','a@sub.nepgroup.com','a b@nepgroup.com','a..b@nepgroup.com','a1@nepgroup.com','a+b@nepgroup.com','a_b@nepgroup.com','a-b@nepgroup.com'])assert.equal((await request('/auth/request',{method:'POST',body:{email}})).status,400);});
 await t.test('a new colleague needs no invitation and gets an ordinary account only after verification',async()=>{
   const email='new.colleague.ideas@nepgroup.com';
   const count=async()=>Number((await database.pool.query('SELECT count(*) FROM users WHERE email=$1',[email])).rows[0].count);
   assert.equal(await count(),0);
   const sent=await request('/auth/request',{method:'POST',body:{email:'  NEW.COLLEAGUE.IDEAS@NEPGROUP.COM  '}});
   assert.equal(sent.status,200);assert.match(sent.data.developmentCode,/^\d{6}$/);
   assert.equal(await count(),0);
   assert.equal((await request('/ideas',{client:'new-colleague'})).status,401);
   const wrong=sent.data.developmentCode==='000000'?'111111':'000000';
   assert.equal((await request('/auth/verify',{method:'POST',body:{email,code:wrong},client:'new-colleague'})).status,400);
   assert.equal(await count(),0);
   const verified=await request('/auth/verify',{method:'POST',body:{email,code:sent.data.developmentCode},client:'new-colleague'});
   assert.equal(verified.status,200);assert.equal(verified.data.user.email,email);assert.equal(verified.data.user.is_admin,0);
   assert.equal(await count(),1);
   assert.equal((await request('/ideas',{client:'new-colleague'})).status,200);
   assert.equal((await request('/admin/users',{client:'new-colleague'})).status,403);
   assert.equal((await request('/auth/verify',{method:'POST',body:{email,code:sent.data.developmentCode}})).status,400);
 });
 await t.test('verifies six-digit codes, assigns explicit admin and prevents replay',async()=>{alice=await login('alice@nepgroup.com','alice');bob=await login('bob@nepgroup.com','bob');admin=await login('admin@nepgroup.com','admin');assert.equal(alice.user.is_admin,0);assert.equal(admin.user.is_admin,1);assert.equal((await request('/auth/verify',{method:'POST',body:{email:'alice@nepgroup.com',code:alice.code}})).status,400);await request('/auth/request',{method:'POST',body:{email:'cooldown@nepgroup.com'}});assert.equal((await request('/auth/request',{method:'POST',body:{email:'cooldown@nepgroup.com'}})).status,429);});
 await t.test('footer settings require admin, validate external URLs, persist and appear in gallery',async()=>{
   const initial=(await request('/ideas',{client:'alice'})).data.settings;
   assert.equal(initial.footer_text,'For more information,');
   assert.equal(initial.footer_link_text,'Click here');
   assert.equal(initial.footer_url,'https://nepgroup.atlassian.net/wiki/x/AQBTyw');
   const patch=(body,client='admin')=>request('/admin/settings',{client,method:'PATCH',body});
   assert.equal((await patch({footer_text:'Denied'},'alice')).status,403);
   for(const footer_url of ['javascript:alert(1)','data:text/html,test','https://user:password@example.com','not-a-url','https://example.com/with space']) assert.equal((await patch({footer_url})).status,400);
   assert.equal((await patch({footer_text:'   '})).status,400);
   assert.equal((await patch({footer_link_text:'x'.repeat(81)})).status,400);
   assert.equal((await patch({footer_text:'  Read the event guide,  ',footer_link_text:'Open guide',footer_url:'https://example.com/guide?year=2026'})).status,200);
   await patch({show_timer:0});
   const saved=(await request('/ideas',{client:'bob'})).data.settings;
   assert.equal(saved.footer_text,'Read the event guide,');assert.equal(saved.footer_link_text,'Open guide');assert.equal(saved.footer_url,'https://example.com/guide?year=2026');
   assert.equal(saved.max_votes,initial.max_votes);assert.equal(saved.mode,initial.mode);
   await patch({footer_text:initial.footer_text,footer_link_text:initial.footer_link_text,footer_url:initial.footer_url,show_timer:initial.show_timer});
 });
 await t.test('locks an OTP after five wrong attempts',async()=>{const email='locked@nepgroup.com';const {data}=await request('/auth/request',{method:'POST',body:{email}});const wrong=data.developmentCode==='111111'?'222222':'111111';for(let n=0;n<5;n++)assert.equal((await request('/auth/verify',{method:'POST',body:{email,code:wrong}})).status,400);assert.equal((await request('/auth/verify',{method:'POST',body:{email,code:data.developmentCode}})).status,400);});
 await t.test('starts empty and enforces two-idea limit with validated image upload',async()=>{assert.equal((await request('/ideas',{client:'alice'})).data.ideas.length,0);const img=await sharp({create:{width:20,height:20,channels:3,background:'#663399'}}).png().toBuffer();let res=await request('/ideas',{client:'alice',method:'POST',body:form(ideaBody('Connected production'),img)});assert.equal(res.status,201);first=res.data;assert.match(first.image,/\.webp$/);assert.equal((await request('/images/'+first.image)).status,401);assert.equal((await request('/images/'+first.image,{client:'alice'})).status,200);res=await request('/ideas',{client:'alice',method:'POST',body:form(ideaBody('Greener broadcast'))});second=res.data;assert.equal(res.status,201);assert.equal((await request('/ideas',{client:'alice',method:'POST',body:form(ideaBody('Third idea'))})).status,409);third=(await request('/ideas',{client:'bob',method:'POST',body:form(ideaBody('Virtual collaboration'))})).data;});
 await t.test('rejects invalid fields and unsafe or oversize images',async()=>{assert.equal((await request('/ideas',{client:'bob',method:'POST',body:form({...ideaBody(''),title:''})})).status,400);assert.equal((await request('/ideas',{client:'bob',method:'POST',body:form(ideaBody('Bad image'),Buffer.from('<svg/>'))})).status,400);assert.equal((await request('/ideas',{client:'bob',method:'POST',body:form(ideaBody('Too big'),Buffer.alloc(2*1024*1024+1))})).status,400);});
 await t.test('enforces ownership and enables image removal',async()=>{assert.equal((await request('/ideas/'+first.id,{client:'bob',method:'PUT',body:form(ideaBody('Take over'))})).status,403);assert.equal((await request('/ideas/'+first.id,{client:'bob',method:'DELETE'})).status,403);assert.equal((await request('/ideas/'+first.id,{client:'alice',method:'PUT',body:form({...ideaBody('Updated connected production'),removeImage:'true'})})).status,200);assert.equal((await request('/ideas/'+first.id,{client:'alice'})).data.image,null);});
 await t.test('likes toggle without duplicates and have no overall limit',async()=>{for(const i of [first,second,third])assert.equal((await request(`/ideas/${i.id}/like`,{client:'alice',method:'POST'})).status,200);let data=(await request('/ideas',{client:'alice'})).data;assert.equal(data.ideas.reduce((n,i)=>n+i.likes,0),3);await request(`/ideas/${first.id}/like`,{client:'alice',method:'POST'});data=(await request('/ideas',{client:'alice'})).data;assert.equal(data.ideas.find(i=>i.id===first.id).likes,0);});
 await t.test('restricts administrator endpoints and validates settings',async()=>{assert.equal((await request('/admin/users',{client:'alice'})).status,403);assert.equal((await request('/admin/settings',{client:'admin',method:'PATCH',body:{max_votes:0}})).status,400);assert.equal((await request('/admin/settings',{client:'admin',method:'PATCH',body:{is_admin:1}})).status,400);});
 await t.test('welcome setting defaults on and saves independently of voting',async()=>{
   const initial=(await request('/ideas',{client:'alice'})).data.settings;
   assert.equal(initial.show_welcome,1);assert.equal(initial.voting_started_at,null);
   const patch=body=>request('/admin/settings',{client:'admin',method:'PATCH',body});
   assert.equal((await patch({show_welcome:2})).status,400);
   assert.equal((await patch({show_welcome:0})).status,200);
   assert.equal((await request('/ideas',{client:'alice'})).data.settings.show_welcome,0);
   assert.equal((await patch({show_welcome:1})).status,200);
 });
 await t.test('voting closed by default; maximum two distinct votes with withdrawal',async()=>{assert.equal((await request(`/ideas/${first.id}/vote`,{client:'alice',method:'POST'})).status,409);assert.equal((await request('/admin/settings',{client:'admin',method:'PATCH',body:{mode:'open',ends_at:new Date(Date.now()+86400000).toISOString()}})).status,200);await Promise.all([first,second].map(i=>request(`/ideas/${i.id}/vote`,{client:'alice',method:'POST'})));assert.equal((await request(`/ideas/${third.id}/vote`,{client:'alice',method:'POST'})).status,409);assert.equal((await request('/ideas',{client:'alice'})).data.votesUsed,2);await request(`/ideas/${first.id}/vote`,{client:'alice',method:'POST'});assert.equal((await request(`/ideas/${third.id}/vote`,{client:'alice',method:'POST'})).status,200);});
 await t.test('reset restores allowance, clears current counts, and retains likes',async()=>{assert.equal((await request('/admin/reset-votes',{client:'admin',method:'POST'})).status,200);const data=(await request('/ideas',{client:'alice'})).data;assert.equal(data.votesUsed,0);assert.equal(data.settings.round,2);assert.equal(data.ideas.reduce((n,i)=>n+i.votes,0),0);assert.equal(data.ideas.reduce((n,i)=>n+i.likes,0),2);await request('/admin/settings',{client:'admin',method:'PATCH',body:{max_votes:1}});assert.equal((await request(`/ideas/${first.id}/vote`,{client:'alice',method:'POST'})).status,200);assert.equal((await request(`/ideas/${second.id}/vote`,{client:'alice',method:'POST'})).status,409);});
 await t.test('evaluates schedule boundaries and displays settings',async()=>{const now=Date.now();const patch=body=>request('/admin/settings',{client:'admin',method:'PATCH',body});assert.equal((await patch({mode:'scheduled',starts_at:new Date(now+100000).toISOString(),ends_at:new Date(now+200000).toISOString(),top_votes:1,top_likes:1,innovation_award:1,peoples_award:1})).status,200);assert.equal((await request('/ideas',{client:'alice'})).data.settings.status,'upcoming');assert.equal((await request(`/ideas/${first.id}/vote`,{client:'bob',method:'POST'})).status,409);await patch({starts_at:new Date(now-1000).toISOString()});assert.equal((await request('/ideas',{client:'alice'})).data.settings.status,'open');assert.equal((await request(`/ideas/${first.id}/vote`,{client:'bob',method:'POST'})).status,200);await patch({starts_at:new Date(now-200000).toISOString(),ends_at:new Date(now-1000).toISOString()});assert.equal((await request('/ideas',{client:'alice'})).data.settings.status,'closed');assert.equal((await request(`/ideas/${second.id}/vote`,{client:'bob',method:'POST'})).status,409);assert.equal((await patch({ends_at:new Date(now-300000).toISOString()})).status,400);});
 await t.test('assigns co-admin permissions, supports moderation, and retains a final admin',async()=>{assert.equal((await request('/admin/users/'+bob.user.id,{client:'admin',method:'PATCH',body:{is_admin:1}})).status,200);assert.equal((await request('/admin/users',{client:'bob'})).status,200);assert.equal((await request('/ideas/'+first.id,{client:'bob',method:'PUT',body:form(ideaBody('Admin moderated'))})).status,200);await request('/admin/users/'+bob.user.id,{client:'admin',method:'PATCH',body:{is_admin:0}});assert.equal((await request('/admin/users',{client:'bob'})).status,403);assert.equal((await request('/admin/users/'+admin.user.id,{client:'admin',method:'PATCH',body:{is_admin:0}})).status,409);});
 await t.test('deletes ideas, permits replacement, and records actions in export and log file',async()=>{assert.equal((await request('/ideas/'+second.id,{client:'alice',method:'DELETE'})).status,200);assert.equal((await request('/ideas',{client:'alice',method:'POST',body:form(ideaBody('A replacement idea'))})).status,201);const logs=(await request('/admin/audit',{client:'admin'})).data;assert.ok(logs.total>20);assert.ok(logs.rows.some(l=>l.action==='idea.deleted'));const exported=await request('/admin/audit?download=1',{client:'admin'});assert.match(exported.headers.get('content-disposition'),/attachment/);assert.ok(exported.data.includes('auth.signed_in'));assert.ok(readFileSync(join(root,'audit.jsonl'),'utf8').includes('admin.votes_reset'));});
 await t.test('manual submission closure blocks new ideas for users and admins but retains editing',async()=>{
   const patch=body=>request('/admin/settings',{client:'admin',method:'PATCH',body});
   assert.equal((await patch({submission_mode:'closed'})).status,200);
   assert.equal((await request('/ideas',{client:'alice'})).data.settings.submission_status,'closed');
   for(const client of ['bob','admin'])assert.equal((await request('/ideas',{client,method:'POST',body:form(ideaBody('Late idea'))})).status,409);
   assert.equal((await request('/ideas/'+third.id,{client:'bob',method:'PUT',body:form(ideaBody('Edited after closure'))})).status,200);
   assert.equal((await request(`/ideas/${third.id}/like`,{client:'bob',method:'POST'})).status,200);
   assert.equal((await patch({submission_mode:'open'})).status,200);
   assert.equal((await request('/ideas',{client:'bob',method:'POST',body:form(ideaBody('Reopened submission'))})).status,201);
 });
 await t.test('submission deadline closes automatically and survives a later voting change',async()=>{
   const patch=body=>request('/admin/settings',{client:'admin',method:'PATCH',body});
   assert.equal((await patch({submission_mode:'invalid'})).status,400);
   assert.equal((await patch({submission_mode:'scheduled',submission_ends_at:null})).status,400);
   assert.equal((await patch({submission_mode:'scheduled',submission_ends_at:'not-a-date'})).status,400);
   assert.equal((await patch({mode:'open',ends_at:null})).status,400);
   assert.equal((await patch({submission_mode:'scheduled',submission_ends_at:new Date(Date.now()+250).toISOString()})).status,200);
   assert.equal((await request('/ideas',{client:'admin'})).data.settings.submission_status,'open');
   await new Promise(resolve=>setTimeout(resolve,300));
   assert.equal((await request('/ideas',{client:'admin'})).data.settings.submission_status,'closed');
   assert.equal((await request('/ideas',{client:'admin',method:'POST',body:form(ideaBody('After deadline'))})).status,409);
   assert.equal((await patch({mode:'open',ends_at:new Date(Date.now()+86400000).toISOString()})).status,200);
   assert.equal((await request('/ideas',{client:'admin'})).data.settings.submission_status,'closed');
   assert.equal((await request('/ideas',{client:'admin',method:'POST',body:form(ideaBody('Still closed'))})).status,409);
   assert.equal((await patch({submission_mode:'open'})).status,200);
 });
 await t.test('manual closure retains the started state and a new future schedule clears it',async()=>{
   const patch=body=>request('/admin/settings',{client:'admin',method:'PATCH',body});
   assert.ok((await request('/ideas',{client:'admin'})).data.settings.voting_started_at);
   assert.equal((await patch({mode:'closed'})).status,200);
   assert.ok((await request('/ideas',{client:'admin'})).data.settings.voting_started_at);
   assert.equal((await patch({mode:'scheduled',starts_at:new Date(Date.now()+86400000).toISOString(),ends_at:new Date(Date.now()+172800000).toISOString()})).status,200);
   assert.equal((await request('/ideas',{client:'admin'})).data.settings.voting_started_at,null);
 });
 await t.test('configured submission limits enforce increases and decreases without deleting existing ideas',async()=>{
   await request('/admin/settings',{client:'admin',method:'PATCH',body:{submission_mode:'open',max_ideas:1}});
   const colleague=await login('limit.person@nepgroup.com','limited');
   const create=title=>request('/ideas',{client:'limited',method:'POST',body:form(ideaBody(title))});
   const firstIdea=await create('Limited idea one');assert.equal(firstIdea.status,201);assert.equal((await create('Blocked at one')).status,409);
   assert.equal((await request('/admin/settings',{client:'admin',method:'PATCH',body:{max_ideas:3}})).status,200);
   const extra=await Promise.all([2,3,4].map(n=>create('Limited idea '+n)));assert.deepEqual(extra.map(r=>r.status).sort(),[201,201,409]);
   for(const max_ideas of [0,101,'3'])assert.equal((await request('/admin/settings',{client:'admin',method:'PATCH',body:{max_ideas}})).status,400);
   await request('/admin/settings',{client:'admin',method:'PATCH',body:{max_ideas:2}});
   assert.equal((await database.pool.query('SELECT COUNT(*) AS n FROM ideas WHERE user_id=$1',[colleague.user.id])).rows[0].n,3);
   assert.equal((await create('Blocked after reduction')).status,409);
   assert.equal((await request('/ideas/'+firstIdea.data.id,{client:'limited',method:'PUT',body:form(ideaBody('Existing idea remains editable'))})).status,200);
 });
 await t.test('idea CSV is admin-only, follows vote/like sort order and preserves full idea text',async()=>{
   const high=await request('/ideas',{client:'admin',method:'POST',body:form({...ideaBody('Export, high "quoted"'),problem:'Line one\nLine two'})});
   const low=await request('/ideas',{client:'admin',method:'POST',body:form(ideaBody('Export low'))});assert.equal(high.status,201);assert.equal(low.status,201);
   const round=(await database.pool.query('SELECT round FROM settings')).rows[0].round;
   for(const user of [alice.user,bob.user])await database.pool.query('INSERT INTO votes VALUES($1,$2,$3)',[user.id,high.data.id,round]);
   await database.pool.query('INSERT INTO votes VALUES($1,$2,$3)',[admin.user.id,low.data.id,round]);
   for(const user of [alice.user,bob.user])await database.pool.query('INSERT INTO likes VALUES($1,$2)',[user.id,low.data.id]);
   assert.equal((await request('/admin/ideas/export',{client:'alice'})).status,403);
   assert.equal((await request('/admin/ideas/export?sort=invalid',{client:'admin'})).status,400);
   const desc=await request('/admin/ideas/export',{client:'admin'});assert.equal(desc.status,200);assert.match(desc.headers.get('content-type'),/text\/csv/);assert.match(desc.headers.get('content-disposition'),/innovation-ideas.csv/);
   const quoted='"Export, high ""quoted"""';assert.ok(desc.data.indexOf(quoted)<desc.data.indexOf('"Export low"'));assert.match(desc.data,/"Line one\r?\nLine two"/);
   const asc=(await request('/admin/ideas/export?sort=votes&direction=asc',{client:'admin'})).data;assert.ok(asc.indexOf('"Export low"')<asc.indexOf(quoted));
   const likes=(await request('/admin/ideas/export?sort=likes&direction=desc',{client:'admin'})).data;assert.ok(likes.indexOf('"Export low"')<likes.indexOf(quoted));
 });
 await t.test('account removal confirms ownership impact, revokes sessions and cleans related records/images',async()=>{
   const removed=await login('removed.person@nepgroup.com','removed');
   const image=await sharp({create:{width:2,height:2,channels:3,background:'#ffffff'}}).png().toBuffer();
   const idea=await request('/ideas',{client:'removed',method:'POST',body:form(ideaBody('Remove with account'),image)});assert.equal(idea.status,201);
   await database.pool.query('INSERT INTO likes VALUES($1,$2)',[removed.user.id,third.id]);
   await database.pool.query('INSERT INTO likes VALUES($1,$2)',[admin.user.id,idea.data.id]);
   const round=(await database.pool.query('SELECT round FROM settings')).rows[0].round;
   await database.pool.query('INSERT INTO votes VALUES($1,$2,$3)',[removed.user.id,third.id,round]);
   await database.pool.query('INSERT INTO votes VALUES($1,$2,$3)',[admin.user.id,idea.data.id,round]);
   await request('/auth/request',{method:'POST',body:{email:removed.user.email}});
   const url='/admin/users/'+removed.user.id;
   assert.equal((await request(url,{client:'alice',method:'DELETE',body:{confirmed:true}})).status,403);
   assert.equal((await request(url,{client:'admin',method:'DELETE',body:{}})).status,400);
   assert.equal((await request('/admin/users/'+admin.user.id,{client:'admin',method:'DELETE',body:{confirmed:true}})).status,409);
   assert.ok(existsSync(join(root,'uploads',idea.data.image)));
   assert.equal((await request(url,{client:'admin',method:'DELETE',body:{confirmed:true}})).status,200);
   for(const table of ['users','ideas','likes','votes','sessions']){
     const column=table==='users'?'id':'user_id';assert.equal((await database.pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=$1`,[removed.user.id])).rows[0].n,0);
   }
   for(const table of ['likes','votes'])assert.equal((await database.pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE idea_id=$1`,[idea.data.id])).rows[0].n,0);
   assert.equal((await database.pool.query('SELECT COUNT(*) AS n FROM challenges WHERE email=$1',[removed.user.email])).rows[0].n,0);
   assert.ok(!existsSync(join(root,'uploads',idea.data.image)));assert.equal((await request('/ideas',{client:'removed'})).status,401);
   assert.ok((await request('/admin/users',{client:'admin'})).data.every(u=>u.id!==removed.user.id));
   assert.ok((await request('/admin/audit',{client:'admin'})).data.rows.some(r=>r.action==='admin.account_deleted'));
 });
 await t.test('monitor actions are not audited and legacy monitor rows are excluded from view/export',async()=>{
   await login('nep.monitor.synthetic@nepgroup.com','monitor');
   await request('/ideas/'+third.id,{client:'monitor'});
   await request(`/ideas/${third.id}/like`,{client:'monitor',method:'POST'});
   assert.equal((await database.pool.query("SELECT COUNT(*) AS n FROM audit WHERE LOWER(BTRIM(actor))='nep.monitor.synthetic@nepgroup.com'")).rows[0].n,0);
   await database.pool.query("INSERT INTO audit(at,actor,action,details) VALUES('now',' NEP.MONITOR.SYNTHETIC@NEPGROUP.COM ','legacy.monitor','{}')");
   const logs=(await request('/admin/audit',{client:'admin'})).data;
   assert.ok(!logs.rows.some(r=>r.actor.trim().toLowerCase()==='nep.monitor.synthetic@nepgroup.com'));
   const exported=await request('/admin/audit?download=1',{client:'admin'});
   assert.ok(!exported.data.toLowerCase().includes('nep.monitor.synthetic@nepgroup.com'));
 });
 await t.test('participation is admin-only and counts distinct ideas independently by current or all rounds',async()=>{
   const participant=await login('report.person@nepgroup.com','report');
   const ids=(await database.pool.query('SELECT id FROM ideas ORDER BY id LIMIT 3')).rows.map(r=>r.id);assert.equal(ids.length,3);
   const round=(await database.pool.query('SELECT round FROM settings')).rows[0].round;
   for(const id of ids.slice(0,2)){
     await database.pool.query('INSERT INTO likes(user_id,idea_id) VALUES($1,$2)',[participant.user.id,id]);
     await database.pool.query('INSERT INTO votes(user_id,idea_id,round) VALUES($1,$2,$3)',[participant.user.id,id,round]);
   }
   for(const id of [ids[0],ids[2]]) await database.pool.query('INSERT INTO votes(user_id,idea_id,round) VALUES($1,$2,$3)',[participant.user.id,id,round-1]);
   const monitor=(await database.pool.query("SELECT id FROM users WHERE email='nep.monitor.synthetic@nepgroup.com'")).rows[0];
   await database.pool.query('INSERT INTO votes(user_id,idea_id,round) VALUES($1,$2,$3)',[monitor.id,ids[0],round]);
   assert.equal((await request('/admin/participation',{client:'alice'})).status,403);
   assert.equal((await request('/admin/participation?scope=invalid',{client:'admin'})).status,400);
   const current=(await request('/admin/participation',{client:'admin'})).data;
   assert.equal(current.round,round);assert.deepEqual(current.rows.find(r=>r.id===participant.user.id),{id:participant.user.id,email:'report.person@nepgroup.com',voted:2,liked:2});
   assert.ok(!current.rows.some(r=>r.email==='nep.monitor.synthetic@nepgroup.com'||r.email==='new.colleague.ideas@nepgroup.com'));
   const history=(await request('/admin/participation?scope=all',{client:'admin'})).data;
   assert.equal(history.rows.find(r=>r.id===participant.user.id).voted,3);
   const csv=await request('/admin/participation?scope=all&download=1&search=report.person',{client:'admin'});assert.equal(csv.status,200);assert.match(csv.headers.get('content-type'),/text\/csv/);assert.ok(csv.data.includes('"Report Person","report.person@nepgroup.com","3","2"'));assert.ok(!csv.data.includes('nep.monitor.synthetic'));assert.ok(!csv.data.includes('bob@nepgroup.com'));
   assert.equal((await request('/admin/participation?download=1',{client:'alice'})).status,403);

 });
 await t.test('like schedules are independent of voting and closing freezes likes and unlikes for everyone',async()=>{
   const patch=body=>request('/admin/settings',{client:'admin',method:'PATCH',body});
   const before=(await request('/ideas',{client:'alice'})).data.settings;
   assert.equal(before.likes_mode,'open');assert.equal(before.likes_status,'open');
   assert.equal((await request('/admin/settings',{client:'alice',method:'PATCH',body:{likes_mode:'closed'}})).status,403);
   assert.equal((await patch({likes_mode:'closed'})).status,200);
   const count=(await database.pool.query('SELECT COUNT(*) AS n FROM likes')).rows[0].n;
   for(const client of ['alice','bob','admin'])assert.equal((await request(`/ideas/${third.id}/like`,{client,method:'POST'})).status,409);
   assert.equal((await database.pool.query('SELECT COUNT(*) AS n FROM likes')).rows[0].n,count);
   const now=Date.now(),start=new Date(now+60000).toISOString(),end=new Date(now+120000).toISOString();
   for(const body of [{likes_mode:'invalid'},{likes_mode:'scheduled',likes_starts_at:null,likes_ends_at:end},{likes_mode:'scheduled',likes_starts_at:start,likes_ends_at:start},{likes_ends_at:'invalid'}])assert.equal((await patch(body)).status,400);
   assert.equal((await patch({likes_mode:'scheduled',likes_starts_at:start,likes_ends_at:end})).status,200);
   assert.equal((await request('/ideas',{client:'bob'})).data.settings.likes_status,'upcoming');
   assert.equal((await request(`/ideas/${third.id}/like`,{client:'bob',method:'POST'})).status,409);
   await patch({likes_starts_at:new Date(now-60000).toISOString()});
   assert.equal((await request('/ideas',{client:'bob'})).data.settings.likes_status,'open');
   assert.equal((await request(`/ideas/${third.id}/like`,{client:'bob',method:'POST'})).status,200);
   assert.equal((await request(`/ideas/${third.id}/like`,{client:'bob',method:'POST'})).status,200);
   await patch({likes_starts_at:new Date(now-120000).toISOString(),likes_ends_at:new Date(now-60000).toISOString()});
   const after=(await request('/ideas',{client:'alice'})).data.settings;assert.equal(after.likes_status,'closed');
   for(const key of ['mode','starts_at','ends_at','max_votes','round'])assert.equal(after[key],before[key]);
   assert.equal((await request(`/ideas/${third.id}/like`,{client:'bob',method:'POST'})).status,409);
   await patch({show_timer:before.show_timer?0:1});assert.equal((await request('/ideas',{client:'alice'})).data.settings.likes_mode,'scheduled');
 });
 await t.test('like reset requires admin confirmation, preserves votes/settings and permits new likes after reopening',async()=>{
   const snapshot=(await request('/ideas',{client:'admin'})).data.settings;
   const votes=(await database.pool.query('SELECT * FROM votes ORDER BY user_id,idea_id,round')).rows;
   const n=(await database.pool.query('SELECT COUNT(*) AS n FROM likes')).rows[0].n;assert.ok(n>0);
   assert.equal((await request('/admin/reset-likes',{client:'alice',method:'POST',body:{confirmed:true}})).status,403);
   assert.equal((await request('/admin/reset-likes',{client:'admin',method:'POST',body:{}})).status,400);
   assert.equal((await database.pool.query('SELECT COUNT(*) AS n FROM likes')).rows[0].n,n);
   const result=await request('/admin/reset-likes',{client:'admin',method:'POST',body:{confirmed:true}});assert.equal(result.status,200);assert.equal(result.data.cleared,n);
   const gallery=(await request('/ideas',{client:'bob'})).data;assert.ok(gallery.ideas.every(i=>i.likes===0&&!i.liked));assert.equal(gallery.settings.likes_status,'closed');
   assert.deepEqual((await database.pool.query('SELECT * FROM votes ORDER BY user_id,idea_id,round')).rows,votes);
   for(const key of ['mode','starts_at','ends_at','max_votes','round','likes_mode','likes_starts_at','likes_ends_at'])assert.equal(gallery.settings[key],snapshot[key]);
   assert.equal((await request(`/ideas/${third.id}/like`,{client:'bob',method:'POST'})).status,409);
   await request('/admin/settings',{client:'admin',method:'PATCH',body:{likes_mode:'open',likes_ends_at:null}});
   assert.equal((await request(`/ideas/${third.id}/like`,{client:'bob',method:'POST'})).status,200);
   assert.equal((await database.pool.query('SELECT COUNT(*) AS n FROM likes')).rows[0].n,1);
   assert.ok((await request('/admin/audit',{client:'admin'})).data.rows.some(r=>r.action==='admin.likes_reset'));
 });
 await t.test('clearing logs requires admin and explicit confirmation and preserves all event data',async()=>{
   const counts=async()=>{const result={};for(const table of ['users','ideas','likes','votes'])result[table]=(await database.pool.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n;return result;};
   const before=await counts();const oldCount=(await database.pool.query('SELECT COUNT(*) AS n FROM audit')).rows[0].n;
   assert.equal((await request('/admin/audit',{client:'alice',method:'DELETE',body:{confirmed:true}})).status,403);
   for(const body of [{},{confirmed:'true'}])assert.equal((await request('/admin/audit',{client:'admin',method:'DELETE',body})).status,400);
   assert.equal((await database.pool.query('SELECT COUNT(*) AS n FROM audit')).rows[0].n,oldCount);
   const cleared=await request('/admin/audit',{client:'admin',method:'DELETE',body:{confirmed:true}});
   assert.equal(cleared.status,200);assert.equal(cleared.data.cleared,oldCount);
   const rows=(await database.pool.query('SELECT * FROM audit')).rows;assert.equal(rows.length,1);assert.equal(rows[0].action,'admin.audit_cleared');assert.equal(rows[0].actor,'admin@nepgroup.com');
   const copy=readFileSync(join(root,'audit.jsonl'),'utf8');assert.ok(copy.includes('admin.audit_cleared'));assert.ok(!copy.includes('vote.cast'));assert.ok(!copy.includes('legacy.monitor'));
   assert.deepEqual(await counts(),before);
 });
 await t.test('logout revokes the existing session token',async()=>{const token=clients.alice;assert.equal((await request('/auth/logout',{client:'alice',method:'POST'})).status,200);clients.alice=token;assert.equal((await request('/ideas',{client:'alice'})).status,401);});
});
