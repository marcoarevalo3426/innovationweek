import { rmSync } from 'node:fs';
import { createPool } from '../../server/pg-config.js';
export default async function(){
  if(process.env.E2E_DATA_DIR)rmSync(process.env.E2E_DATA_DIR,{recursive:true,force:true});
  if(/^e2e_[a-f0-9]+$/.test(process.env.E2E_PGSCHEMA || '')){
    const pool=createPool();
    try{await pool.query(`DROP SCHEMA ${process.env.E2E_PGSCHEMA} CASCADE`);}finally{await pool.end();}
  }
}
