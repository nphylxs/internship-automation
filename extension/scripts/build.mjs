import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';

await mkdir(new URL('../dist/',import.meta.url),{recursive:true});
const result=await build({entryPoints:['popup/main.jsx'],bundle:true,minify:true,format:'esm',target:['chrome110'],outfile:'dist/popup.js',define:{'process.env.NODE_ENV':'"production"'},metafile:true,legalComments:'linked'});
const css=spawnSync(process.execPath,['node_modules/@tailwindcss/cli/dist/index.mjs','-i','popup/input.css','-o','dist/popup.css','--minify'],{stdio:'inherit'});
if(css.status!==0)process.exit(css.status || 1);
await writeFile('dist/build-meta.json',JSON.stringify({outputs:Object.keys(result.metafile.outputs)},null,2)+'\n');
const licenses = [['react','LICENSE'],['react-dom','LICENSE'],['scheduler','LICENSE'],['framer-motion','LICENSE.md'],['motion-dom','LICENSE.md'],['motion-utils','LICENSE.md'],['tailwindcss','LICENSE']];
await writeFile('dist/THIRD_PARTY_LICENSES.txt',(await Promise.all(licenses.map(async ([name,file]) => `${name}\n${'='.repeat(name.length)}\n${await readFile(`node_modules/${name}/${file}`,'utf8')}`))).join('\n\n'));
console.log('Popup built locally: dist/popup.js and dist/popup.css');
