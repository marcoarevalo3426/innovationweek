import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, parseApiResponse, SERVICE_UNAVAILABLE_MESSAGE } from '../src/api-client.js';

test('HTML and malformed responses never leak a JSON parsing error into sign-in', async () => {
  for (const [body, type, status] of [
    ['<!doctype html><html>frontend</html>','text/html',200],
    ['<!doctype html><html>proxy failure</html>','text/html',502],
    ['<!doctype html><html>mislabelled</html>','application/json',200],
    ['', 'application/json', 503],
    ['"unexpected string"', 'application/json',200],
  ]) {
    await assert.rejects(parseApiResponse(new Response(body,{status,headers:{'Content-Type':type}})), error => {
      assert.equal(error.message,SERVICE_UNAVAILABLE_MESSAGE);
      assert.equal(error.status,status);
      assert.ok(!error.message.includes('<')&&!error.message.includes('Unexpected token'));
      return true;
    });
  }
});

test('valid sign-in responses and server validation errors retain their meaning', async () => {
  const result={ok:true,developmentCode:'123456'};
  assert.deepEqual(await parseApiResponse(Response.json(result)),result);
  await assert.rejects(parseApiResponse(Response.json({error:'Use a valid @nepgroup.com email address.'},{status:400})),error=>error.status===400&&error.message.includes('@nepgroup.com'));
  assert.equal(await parseApiResponse(new Response(null,{status:204})),null);
});

test('sign-in requests explicitly accept JSON, and network failure is actionable',async()=>{
  const result=await api('/auth/request',{method:'POST',body:{email:'person@nepgroup.com'}},async(url,options)=>{
    assert.equal(url,'/api/auth/request');assert.equal(options.headers.Accept,'application/json');
    assert.equal(options.credentials,'same-origin');assert.equal(options.headers['X-Requested-With'],'InnovationWeek');
    assert.deepEqual(JSON.parse(options.body),{email:'person@nepgroup.com'});
    return Response.json({ok:true,developmentCode:'123456'});
  });
  assert.equal(result.developmentCode,'123456');
  await assert.rejects(api('/auth/request',{},async()=>{throw new TypeError('Failed to fetch');}),error=>error.code==='API_NETWORK_ERROR'&&error.message===SERVICE_UNAVAILABLE_MESSAGE);
});
