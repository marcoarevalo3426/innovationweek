import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as viteServer } from 'vite';
import { apiProxy } from '../dev/api-proxy.js';

async function frontend(target) {
  const vite=await viteServer({configFile:false,logLevel:'silent',server:{host:'127.0.0.1',port:0,proxy:apiProxy(target)}});
  await vite.listen();
  return {vite,base:`http://127.0.0.1:${vite.httpServer.address().port}`};
}

test('local proxy forwards sign-in as JSON and returns JSON 503 when the API is down',async t=>{
  const backend=httpServer((req,res)=>{
    assert.equal(req.url,'/api/auth/request');
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,developmentCode:'123456'}));
  });
  await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
  const {vite,base}=await frontend(`http://127.0.0.1:${backend.address().port}`);
  t.after(async()=>{await vite.close();if(backend.listening)await new Promise(resolve=>backend.close(resolve));});
  const request=()=>fetch(base+'/api/auth/request',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({email:'test@nepgroup.com'})});
  const sent=await request();assert.equal(sent.status,200);assert.equal((await sent.json()).developmentCode,'123456');
  await new Promise(resolve=>backend.close(resolve));
  const unavailable=await request();assert.equal(unavailable.status,503);assert.match(unavailable.headers.get('Content-Type'),/application\/json/);assert.match((await unavailable.json()).error,/app service is unavailable/);
});
