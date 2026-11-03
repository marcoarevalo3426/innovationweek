import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

let server;
let serverStarted = false;
let directory;
let child;
let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  if (serverStarted) await server.stop();
  if (directory) rmSync(directory,{recursive:true,force:true});
  process.exitCode = code;
}
// Test uploads must never inherit a production S3 bucket from a developer environment.
const env = {...process.env, NODE_ENV:'test', INNOVATION_TEST_DATABASE:'true', IMAGE_STORAGE:'local', RATE_LIMIT_STORE:'memory'};
if (process.env.TEST_USE_LOCAL_POSTGRES !== 'true') {
  directory = mkdtempSync(join(tmpdir(),'nep-pg-tests-'));
  const listener = createServer();
  await new Promise(resolve => listener.listen(0,'127.0.0.1',resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  server = new EmbeddedPostgres({databaseDir:directory,user:'innovation',password:'isolated_test_only',port,persistent:true,authMethod:'scram-sha-256',postgresFlags:['-c','listen_addresses=127.0.0.1'],onLog:()=>{},onError:message=>process.stderr.write(String(message)+'\n')});
  try {
    await server.initialise();
    await server.start();
    serverStarted = true;
    await server.createDatabase('innovation_tests');
  } catch (error) {
    console.error('Cannot start isolated PostgreSQL:',error.message);
    console.error('If the macOS sandbox blocks shared memory, run npm run db:local in Terminal, then TEST_USE_LOCAL_POSTGRES=true npm test.');
    await finish(1);
    process.exit(1);
  }
  Object.assign(env,{PGHOST:'127.0.0.1',PGPORT:String(port),PGDATABASE:'innovation_tests',PGUSER:'innovation',PGPASSWORD:'isolated_test_only',PGSSLMODE:'disable'});
} else if (!['127.0.0.1','localhost','::1'].includes(env.PGHOST || '127.0.0.1')) {
  throw new Error('TEST_USE_LOCAL_POSTGRES only permits a loopback test server.');
}
const files = readdirSync('tests').filter(name=>name.endsWith('.test.js')).map(name=>join('tests',name));
child = spawn(process.execPath,['--test',...files],{env,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
child.once('exit',code=>finish(code ?? 1));
