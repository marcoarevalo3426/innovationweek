import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {testDatabase} from './pg-helpers.js';
import {fullName,textValue,hasUnsafeKeys} from '../shared/input-validation.js';

test('readable text and international names are validated without SQL keyword blacklists',()=>{
  assert.equal(fullName("  Élodie O’Neil-Smith  "),'Élodie O’Neil-Smith');
  for(const name of ['', '123', '<script>alert(1)</script>', 'Alex\nExample', 'Alex\0Example'])assert.throws(()=>fullName(name));
  assert.equal(textValue("O'Brien; SELECT ideas",{max:100}),"O'Brien; SELECT ideas");
  assert.equal(textValue('  ',{optional:true}),'');
  for(const value of [null,{},[],7,'a\0b','x'.repeat(4001)])assert.throws(()=>textValue(value));
  assert.equal(hasUnsafeKeys(JSON.parse('{"__proto__":{"is_admin":1}}')),true);
});

test('feedback, immutable votes and targeted admin corrections enforce security boundaries',async t=>{
  const database=await testDatabase(),dir=mkdtempSync(join(tmpdir(),'nep-feedback-'));
  const server=spawn(process.execPath,['server/index.js'],{env:{...database.env,DATA_DIR:dir,PORT:'0',HOST:'127.0.0.1',NODE_ENV:'test',LOCAL_AUTH_BYPASS:'false',MAIL_MODE:'console',ADMIN_EMAILS:'admin@nepgroup.com'},stdio:['ignore','pipe','pipe']});
  let stderr='';server.stderr.on('data',chunk=>stderr+=chunk);
  t.after(async()=>{if(server.exitCode===null){const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;}await database.cleanup();rmSync(dir,{recursive:true,force:true});});
  const base=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error(stderr||'Startup timeout')),10000);server.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(stderr));});});
  const cookies={};
  async function request(path,{user,method='GET',body,raw,headers={}}={}){
    const response=await fetch(base+'/api'+path,{method,headers:{'X-Requested-With':'InnovationWeek',...(body instanceof FormData?{}:{'Content-Type':'application/json'}),...(user?{Cookie:cookies[user]}:{}),...headers},body:raw??(body instanceof FormData?body:body?JSON.stringify(body):undefined)});
    if(user&&response.headers.get('set-cookie'))cookies[user]=response.headers.get('set-cookie').split(';')[0];
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}return{status:response.status,data,headers:response.headers};
  }
  const identities={};
  for(const user of ['alice','bob','admin']){
    const email=user+'@nepgroup.com';const sent=await request('/auth/request',{method:'POST',body:{email}});
    const login=await request('/auth/verify',{user,method:'POST',body:{email,code:sent.data.developmentCode}});assert.equal(login.status,200);identities[user]=login.data.user;
  }
  const post=(body,options={})=>request('/feedback',{user:'alice',method:'POST',body,...options});

  await t.test('requires a signed-in user, CSRF protection and a valid nonempty object',async()=>{
    assert.equal((await request('/feedback',{method:'POST',body:{general:'Hello'}})).status,401);
    assert.equal((await post({general:'Hello'},{headers:{Origin:'https://evil.example'}})).status,403);
    for(const body of [{},{website:'  ',general:'\n\t'},{website:null},{website:[]},{website:{value:'bad'}},{general:'x',email:'spoof@nepgroup.com'},{website:'a\0b'}])assert.equal((await post(body)).status,400);
    for(const raw of ['[]','{"__proto__":{"is_admin":1}}','{"general":'])assert.equal((await post(undefined,{raw})).status,400);
    assert.equal((await post({general:'x'.repeat(4001)})).status,400);
    assert.equal((await post({general:'x'.repeat(70000)})).status,413);
    assert.equal((await database.pool.query('SELECT COUNT(*) AS n FROM feedback')).rows[0].n,0);
  });
  await t.test('saves only populated categories and binds the verified email on the server',async()=>{
    assert.equal((await post({website:'  Easier navigation, please.  ',general:'   '})).status,201);
    assert.equal((await post({general:'More time for collaboration.'})).status,201);
    assert.equal((await post({website:'Clearer buttons.',general:'Great event!'})).data.saved,2);
    const rows=(await database.pool.query('SELECT * FROM feedback')).rows;assert.equal(rows.length,4);
    assert.ok(rows.every(row=>row.email==='alice@nepgroup.com'&&row.user_id===identities.alice.id&&row.feedback.trim()));
    assert.equal(rows.find(row=>row.feedback==='Easier navigation, please.').category,'website');
    assert.ok(rows.every(row=>Number.isFinite(Date.parse(row.created_at))));
    assert.equal((await request('/admin/feedback',{user:'bob'})).status,403);
  });
  await t.test('SQL-like and HTML-like text remain literal data; filters cannot become SQL',async()=>{
    const payload="'); DROP TABLE users; -- <img src=x onerror=alert(1)>";
    assert.equal((await request('/feedback',{user:'bob',method:'POST',body:{website:payload}})).status,201);
    assert.equal((await database.pool.query('SELECT feedback FROM feedback WHERE email=$1',['bob@nepgroup.com'])).rows[0].feedback,payload);
    assert.equal((await database.pool.query('SELECT COUNT(*) AS n FROM users')).rows[0].n,3);
    assert.equal((await request('/admin/feedback?category='+encodeURIComponent("general';DROP TABLE users;--"),{user:'admin'})).status,400);
    assert.equal((await request('/admin/feedback?offset=0%20UNION%20SELECT',{user:'admin'})).status,400);
    assert.equal((await request('/ideas/'+encodeURIComponent("' OR 1=1 --"),{user:'alice'})).status,400);
    assert.equal((await request('/admin/ideas/export?sort=likes;DROP%20TABLE%20ideas',{user:'admin'})).status,400);
  });
  await t.test('admin filters, pagination and all-feedback CSV preserve categories, dates and safe cells',async()=>{
    for(let n=0;n<105;n++)await database.pool.query('INSERT INTO feedback VALUES($1,$2,$3,$4,$5,$6)',['extra-'+String(n).padStart(3,'0'),identities.bob.id,'bob@nepgroup.com',n%2?'general':'website',n===0?'=HYPERLINK("https://evil.example")':'Line one, "quoted"\nLine two','2026-11-05T00:00:00.000Z']);
    const all=await request('/admin/feedback',{user:'admin'});assert.equal(all.data.total,110);assert.equal(all.data.rows.length,50);
    const next=await request('/admin/feedback?offset=50',{user:'admin'});assert.equal(next.data.rows.length,50);assert.notEqual(next.data.rows[0].id,all.data.rows[0].id);
    for(const category of ['website','general'])assert.ok((await request('/admin/feedback?category='+category,{user:'admin'})).data.rows.every(row=>row.category===category));
    assert.equal((await request('/admin/feedback?download=1',{user:'alice'})).status,403);
    const csv=await request('/admin/feedback?download=1',{user:'admin'});assert.equal(csv.status,200);assert.match(csv.headers.get('content-disposition'),/innovation-feedback.csv/);
    assert.ok(csv.data.includes('"Date","Feedback","Category","Email"'));assert.ok(csv.data.includes('"Website feedback"'));assert.ok(csv.data.includes('"General feedback"'));assert.ok(csv.data.includes('"alice@nepgroup.com"'));
    assert.ok(csv.data.includes("\"'=HYPERLINK"));assert.ok(csv.data.includes('Line one, ""quoted""\nLine two'));
    assert.equal(csv.data.split('"Date","Feedback","Category","Email"').length,2);assert.equal(csv.data.split('"bob@nepgroup.com"').length-1,106);
  });

  let idea;
  await t.test('full names are required, bounded and returned with author email',async()=>{
    const create=async fields=>{const form=new FormData();for(const[k,v]of Object.entries({full_name:"Élodie O’Neil",title:"O'Brien's idea",problem:'Problem',solution:'Solution',skills:'Engineering',...fields}))form.set(k,v);return request('/ideas',{user:'bob',method:'POST',body:form});};
    for(const full_name of ['', 'a'.repeat(121),'<script>bad</script>'])assert.equal((await create({full_name})).status,400);
    const created=await create({});assert.equal(created.status,201);idea=created.data;
    const detail=await request('/ideas/'+idea.id,{user:'alice'});assert.equal(detail.data.full_name,"Élodie O’Neil");assert.equal(detail.data.author,'bob@nepgroup.com');
    const form=new FormData();for(const[k,v]of Object.entries({full_name:'Updated Person',title:'Updated',problem:'Problem',solution:'Solution',skills:'Engineering'}))form.set(k,v);
    assert.equal((await request('/ideas/'+idea.id,{user:'bob',method:'PUT',body:form})).status,200);
    assert.equal((await request('/ideas/'+idea.id,{user:'alice'})).data.full_name,'Updated Person');
  });
  await t.test('duplicate concurrent votes stay final and admins can clear only one person’s votes or likes',async()=>{
    const patch=body=>request('/admin/settings',{user:'admin',method:'PATCH',body});await patch({mode:'open',ends_at:new Date(Date.now()+86400000).toISOString()});
    const cast=()=>request('/ideas/'+idea.id+'/vote',{user:'alice',method:'POST'});
    assert.deepEqual((await Promise.all([cast(),cast()])).map(r=>r.status).sort(),[200,409]);
    for(const user of ['alice','bob'])await request('/ideas/'+idea.id+'/like',{user,method:'POST'});
    await request('/ideas/'+idea.id+'/vote',{user:'bob',method:'POST'});
    const url='/admin/users/'+identities.alice.id;
    assert.equal((await request(url+'/reset-votes',{user:'bob',method:'POST',body:{confirmed:true}})).status,403);
    assert.equal((await request(url+'/reset-votes',{user:'admin',method:'POST'})).status,400);
    assert.equal((await request(url+'/reset-votes',{user:'admin',method:'POST',body:{confirmed:true}})).data.cleared,1);
    assert.equal((await request('/ideas',{user:'alice'})).data.votesUsed,0);assert.equal((await request('/ideas',{user:'bob'})).data.votesUsed,1);
    assert.equal((await database.pool.query('SELECT COUNT(*) AS n FROM likes')).rows[0].n,2);
    assert.equal((await request(url+'/reset-likes',{user:'admin',method:'POST',body:{confirmed:true}})).data.cleared,1);
    assert.equal((await database.pool.query('SELECT COUNT(*) AS n FROM likes')).rows[0].n,1);
    assert.equal((await request('/ideas',{user:'bob'})).data.votesUsed,1);assert.equal((await cast()).status,200);
    assert.equal((await request('/admin/users/not-found/reset-votes',{user:'admin',method:'POST',body:{confirmed:true}})).status,404);
    const audit=(await database.pool.query("SELECT action FROM audit WHERE action LIKE 'admin.user_%_reset'")).rows;assert.equal(audit.length,2);
  });
});
