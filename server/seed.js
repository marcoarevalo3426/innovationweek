import { randomUUID } from 'node:crypto';
import { db, get, run, transaction, audit } from './db.js';
if(process.env.NODE_ENV==='production')throw Error('Demo seeding is disabled in production.');
if((await get('SELECT COUNT(*) AS n FROM ideas')).n)throw Error('Seed requires an empty gallery. No existing data was changed.');
const demos=[
 ['Connected production','alex.morgan','Our crews repeat the same manual steps between production systems.','A shared workspace that connects the tools we already use, with smarter handoffs and fewer spreadsheets.','Engineers, production coordinators and UX designers'],
 ['A greener way to broadcast','jamie.lee','It is hard to see the full environmental impact of a live production.','A simple production footprint dashboard to help teams compare transport, power and equipment decisions.','Sustainability specialists, data analysts and operations'],
 ['The right expert, a click away','sam.taylor','Great knowledge sits in different teams and locations.','An internal skills map that connects someone with a question to the colleague who can help.','People teams, software developers and curious colleagues'],
 ['Less setup. More showtime.','robin.chen','Similar production setups are configured from scratch too often.','Reusable setup recipes with checklists and one-click configuration templates.','Technical directors, broadcast engineers and automation specialists'],
 ['A smarter kit room','morgan.reed','Equipment availability changes quickly between productions.','A live inventory companion with QR scanning, maintenance reminders and better handover notes.','Warehouse teams, mobile developers and asset managers'],
 ['Make the handover human','casey.patel','Important context can get lost when a project moves between shifts.','Short structured handovers that surface decisions, risks and the next best action.','Operations, production teams and service designers'],
 ['Learn a little, every day','jordan.smith','It is difficult to find time for learning during busy production schedules.','Five-minute learning moments created by our own experts and available wherever teams work.','Learning designers, editors and subject matter experts'],
 ['Bring remote teams closer','taylor.james','Distributed teams have fewer chances for informal collaboration.','A lightweight virtual collaboration space to share works in progress and find partners for new ideas.','Remote production specialists, designers and community champions']
];
await transaction(async()=>{for (const [index,[title,name,problem,solution,skills]] of demos.entries()) {
  const email=name+'@nepgroup.com';
  let user=await get('SELECT * FROM users WHERE email=$1',email);
  if(!user){await run('INSERT INTO users(id,email,is_admin,created_at) VALUES($1,$2,0,$3)',randomUUID(),email,new Date().toISOString());user=await get('SELECT * FROM users WHERE email=$1',email);}
  const now=new Date(Date.now()-index*3600000).toISOString();
  await run('INSERT INTO ideas(id,user_id,title,problem,solution,skills,image,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8)',randomUUID(),user.id,title,problem,solution,skills,now,now);
}
await audit('local-demo','demo.seeded',{count:demos.length,fictitious:true});});
console.log(`Added ${demos.length} sample ideas from fictitious users. These are demo content.`);
await db.close();
