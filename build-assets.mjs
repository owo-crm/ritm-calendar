import {mkdir,copyFile,cp} from 'node:fs/promises';
const source=new URL('./node_modules/pdfjs-dist/',import.meta.url);
const target=new URL('./assets/pdfjs/',import.meta.url);
await mkdir(target,{recursive:true});
for(const name of ['pdf.mjs','pdf.worker.mjs'])await copyFile(new URL('build/'+name,source),new URL(name,target));
for(const name of ['cmaps','standard_fonts','wasm','iccs'])await cp(new URL(name,source),new URL(name,target),{recursive:true});
await copyFile(new URL('LICENSE',source),new URL('LICENSE',target));
