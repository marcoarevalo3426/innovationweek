import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const path=resolve(process.env.DATA_DIR||'./data','monitor-requests.json');
const points=[];let failedQueries=[];
let crashAt;try{crashAt=JSON.parse(readFileSync(path,'utf8')).crashAt;}catch{}
export function recordDbError(){failedQueries.push(Date.now());}
export function monitoringMiddleware(req,res,next){
  const start=performance.now();
  res.on('finish',()=>{
    if(!req.path.startsWith('/api/')||req.path==='/api/health'||req.user?.id==='nep-monitor-synthetic-v1'||req.path==='/api/auth/verify'&&req.body?.email==='nep.monitor.synthetic@nepgroup.com')return;
    const route=req.method+' '+(req.route?.path||'/api/unmatched');
    points.push({at:Date.now(),route,status:res.statusCode,ms:Math.round(performance.now()-start),adminChange:req.path.startsWith('/api/admin/users')&&['PATCH','PUT','POST'].includes(req.method)});
    if(points.length>20000)points.splice(0,points.length-20000);
  });next();
}
function flush(){
  const cutoff=Date.now()-900000;while(points[0]?.at<cutoff)points.shift();failedQueries=failedQueries.filter(x=>x>=cutoff);
  const groups={};for(const p of points)(groups[p.route]||=[]).push(p);
  const endpoints=Object.entries(groups).map(([route,values])=>{const sorted=values.map(p=>p.ms).sort((a,b)=>a-b);return{route,count:values.length,p95:sorted[Math.ceil(sorted.length*.95)-1],errors:values.filter(p=>p.status>=500).length,timeouts:values.filter(p=>[408,504].includes(p.status)).length};}).sort((a,b)=>b.count-a.count).slice(0,200);
  const count=predicate=>points.filter(predicate).length;
  const payload={at:new Date().toISOString(),endpoints,errors:{exceptions:0,submissions:count(p=>p.route==='POST /api/ideas'&&p.status>=400),uploads:count(p=>p.route.startsWith('POST /api/ideas')&&p.status>=400)},database:{failedWrites:failedQueries.length},external:{emailFailures:count(p=>p.route==='POST /api/auth/request'&&p.status>=500),rateLimits:count(p=>p.status===429)},security:{loginFailures:count(p=>p.route==='POST /api/auth/verify'&&p.status>=400),permissionDenials:count(p=>p.status===403),suspiciousAccess:count(p=>p.status===404&&p.route.includes('/api/')),adminChanges:count(p=>p.adminChange&&p.status<400)}};
  if(crashAt&&Date.now()-Date.parse(crashAt)<900000){payload.errors.exceptions=1;payload.crashAt=crashAt;}
  try{writeFileSync(path+'.tmp',JSON.stringify(payload),{mode:0o600});renameSync(path+'.tmp',path);}catch(e){console.error('Monitor telemetry write failed:',e.code);}
}
setInterval(flush,15000).unref();
process.on('uncaughtExceptionMonitor',()=>{try{let old=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};old.errors={...old.errors,exceptions:(old.errors?.exceptions||0)+1};old.crashAt=new Date().toISOString();writeFileSync(path,JSON.stringify(old),{mode:0o600});}catch{}});
