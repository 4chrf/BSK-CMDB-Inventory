import { cp, rm, mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
await rm('dist', { recursive: true, force: true });
await cp('public', 'dist/client', { recursive: true });
await rm('dist/client/seed.json');
await mkdir('dist/server', { recursive: true });
await build({entryPoints:['server/worker.js'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:false,loader:{'.html':'text'}});
await writeFile('dist/server/wrangler.json', JSON.stringify({
  name:'bsk-infrastructure-cmdb',main:'index.js',compatibility_date:'2026-09-01',
  assets:{directory:'../client',binding:'ASSETS',run_worker_first:['/api/*','/seed.json','/admin','/admin/']},
  d1_databases:[{binding:'DB',database_name:'bsk-cmdb',database_id:'local-placeholder'}]
},null,2));
console.log('Built database worker and client assets.');
