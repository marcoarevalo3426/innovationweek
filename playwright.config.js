import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.E2E_DATA_DIR=mkdtempSync(join(tmpdir(),'innovation-browser-'));
export default defineConfig({testDir:'./tests/browser',fullyParallel:false,workers:1,timeout:60000,globalTeardown:'./tests/browser/teardown.js',use:{baseURL:'http://127.0.0.1:3198',viewport:{width:1440,height:1000},launchOptions:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{},trace:'retain-on-failure'},webServer:{command:'node server/index.js',url:'http://127.0.0.1:3198/api/health',reuseExistingServer:false,env:{PORT:'3198',HOST:'127.0.0.1',DATA_DIR:process.env.E2E_DATA_DIR,APP_ORIGIN:'http://127.0.0.1:3198',MAIL_MODE:'console',ADMIN_EMAILS:'admin@nepgroup.com',NODE_ENV:'test'}}});
