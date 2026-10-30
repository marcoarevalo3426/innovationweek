import { testDatabase } from './pg-helpers.js';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
 await t.test('requires authentication and same-origin mutation header',async()=>{assert.equal((await request('/ideas')).status,401);assert.equal((await request('/auth/request',{method:'POST',header:false,body:{email:'x@nepgroup.com'}})).status,403);});
 await t.test('validates exact NEP email domain',async()=>{for(const email of ['a@gmail.com','a@nepgroup.com.evil.com','a@sub.nepgroup.com','a b@nepgroup.com','a..b@nepgroup.com'])assert.equal((await request('/auth/request',{method:'POST',body:{email}})).status,400);});
 await t.test('verifies six-digit codes, assigns explicit admin and prevents replay',async()=>{alice=await login('alice@nepgroup.com','alice');bob=await login('bob@nepgroup.com','bob');admin=await login('admin@nepgroup.com','admin');assert.equal(alice.user.is_admin,0);assert.equal(admin.user.is_admin,1);assert.equal((await request('/auth/verify',{method:'POST',body:{email:'alice@nepgroup.com',code:alice.code}})).status,400);await request('/auth/request',{method:'POST',body:{email:'cooldown@nepgroup.com'}});assert.equal((await request('/auth/request',{method:'POST',body:{email:'cooldown@nepgroup.com'}})).status,429);});
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
 await t.test('logout revokes the existing session token',async()=>{const token=clients.alice;assert.equal((await request('/auth/logout',{client:'alice',method:'POST'})).status,200);clients.alice=token;assert.equal((await request('/ideas',{client:'alice'})).status,401);});
});
