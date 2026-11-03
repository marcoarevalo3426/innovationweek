import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build a small, pinned API-only manifest. The frontend is already built in dist/.
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const dependencies = {};
for (const name of ['@aws-sdk/client-s3', '@aws-sdk/rds-signer', 'compression', 'cookie-parser', 'dotenv', 'express', 'express-rate-limit', 'helmet', 'multer', 'nodemailer', 'pg', 'sharp']) {
  const version = lock.packages?.['node_modules/' + name]?.version;
  if (!version) throw new Error('Missing locked runtime dependency: ' + name);
  dependencies[name] = version;
}
if (!process.argv[2]) throw new Error('Pass a disposable Linux staging directory as the destination.');
const destination = resolve(process.argv[2], 'package.json');
if (existsSync(resolve(process.argv[2], '.git'))) throw new Error('Refusing to replace a Git checkout manifest; use a disposable staging copy.');
writeFileSync(destination, JSON.stringify({ name: manifest.name, version: manifest.version, private: true, type: 'module', engines: manifest.engines, scripts: { start: 'node server/index.js' }, dependencies }, null, 2) + '\n');
console.log('Pinned API runtime manifest written.');
