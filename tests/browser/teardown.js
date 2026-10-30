import { rmSync } from 'node:fs';
export default async function(){if(process.env.E2E_DATA_DIR)rmSync(process.env.E2E_DATA_DIR,{recursive:true,force:true});}
