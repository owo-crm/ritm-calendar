import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import vm from 'node:vm';
import {handleRequest} from './worker.js';
import {initial} from './core.js';
const html=fs.readFileSync(new URL('./index.html',import.meta.url),'utf8');
const origin='https://ritm.example';
// Test fixture only. Production CALENDAR_KEY must be generated randomly.
const testKey='A'.repeat(43),base=origin+'/c/'+testKey+'/';
function database(){const sql=new DatabaseSync(':memory:');sql.exec(fs.readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));return {sql,CALENDAR_KEY:testKey,DB:{prepare(query){return {bind(...args){return {async first(){return sql.prepare(query).get(...args)||null}}}}}}}}
const request=(path='',method='GET',body,headers={})=>new Request(base+path,{method,headers:{origin,'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});
test('Personal link opens the app without cookies or login and protects both code and data',async()=>{
 const env=database();
 for(const path of ['/','/index.html','/api/state','/c/'+'B'.repeat(43)+'/','/c/'+testKey.slice(1)+'/']){
  const response=await handleRequest(new Request(origin+path,{headers:{'oai-authenticated-user-id':'calendar-owner'}}),env,html);
  assert.equal(response.status,404);assert.ok(!(await response.text()).includes('const STORE='));
 }
 const response=await handleRequest(request(),env,html);assert.equal(response.status,200);const content=await response.text();
 assert.ok(content.includes("const LIVE_URL='"+base+"'"));assert.ok(!content.includes('__RITM_ORIGIN__'));assert.ok(!content.includes('ChatGPT'));assert.ok(!content.includes('/api/login'));
 assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(response.headers.get('set-cookie'),null);
 const redirect=await handleRequest(new Request(base.slice(0,-1)),env,html);assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),base);
 assert.equal((await handleRequest(request('', 'HEAD'),env,html)).body,null);
 const downloaded=await (await handleRequest(request('ritm-calendar.html'),env,html)).text();assert.ok(downloaded.includes(base));
});
test('JSON saves through the link API, rejects foreign origins and keeps concurrent revisions',async()=>{
 const env=database();const body={account:'calendar-owner',revision:0,state:initial()};
 assert.equal((await handleRequest(request('api/state','PUT',body,{origin:'https://foreign.example'}),env,html)).status,403);
 const [a,b]=await Promise.all([handleRequest(request('api/state','PUT',body),env,html),handleRequest(request('api/state','PUT',body),env,html)]);
 assert.deepEqual([a.status,b.status].sort(),[200,409]);
 const read=await handleRequest(request('api/state'),env,html);assert.equal((await read.json()).revision,1);
 const unchanged=await handleRequest(request('api/state','GET',null,{'if-none-match':read.headers.get('etag')}),env,html);assert.equal(unchanged.status,304);assert.equal(unchanged.body,null);
 assert.equal(env.sql.prepare('SELECT COUNT(*) as n FROM ritm_calendars').get().n,1);
 const raw=env.sql.prepare('SELECT state_json FROM ritm_calendars').get().state_json;assert.equal(JSON.parse(raw).version,3);assert.ok(!raw.includes(testKey));
});
test('Changing the link key revokes the old link and preserves the saved JSON',async()=>{
 const env=database();await handleRequest(request('api/state','PUT',{account:'calendar-owner',revision:0,state:initial()}),env,html);
 env.CALENDAR_KEY='C'.repeat(43);assert.equal((await handleRequest(request('api/state'),env,html)).status,404);
 const newRequest=new Request(origin+'/c/'+env.CALENDAR_KEY+'/api/state');const response=await handleRequest(newRequest,env,html);assert.equal(response.status,200);assert.equal((await response.json()).revision,1);
});
test('Missing configuration never starts a public writable calendar',async()=>{
 assert.equal((await handleRequest(request(),{},html)).status,404);
 assert.equal((await handleRequest(request(),{CALENDAR_KEY:testKey},html)).status,503);
 assert.equal((await handleRequest(request('api/state'),{CALENDAR_KEY:testKey,DB:{prepare(){throw Error('offline')}}},html)).status,503);
});
test('Two independent clients use relative APIs on the personal link and merge their changes',async()=>{
 const ctx={__RITM_TEST__:true,setTimeout,clearTimeout,AbortController,structuredClone};vm.createContext(ctx);vm.runInContext(html.split('<script>')[1].split('</script>')[0],ctx);const c=ctx.RitmCore,env=database();
 function persistence(){let current=null,previous=null;return c.createPersistence([{name:'memory',async read(){return {current,previous}},async write(next,expected,prev){assert.equal(current,expected);current=next;previous=prev}}])}
 function device(){return c.createCloudPersistence({cache:persistence(),legacy:persistence(),request:c.createCloudRequest((path,options)=>{
  assert.equal(path,'api/state');return handleRequest(new Request(new URL(path,base),{...options,headers:{...options.headers,origin}}),env,html);
 })})}
 const a=device(),b=device();const sa=(await a.load()).state,sb=(await b.load()).state;
 sa.entries.push({id:'cash',title:'Продукты',type:'expense',category:'food',date:'2026-09-06',amount:1200,status:'paid'});
 sb.tasks.push({id:'task',title:'Умыться',due:'2026-09-06',duration:5,priority:'normal',done:false,eventId:null});
 await a.save(sa);await b.save(sb);const final=(await a.load()).state;assert.equal(final.entries[0].amount,1200);assert.ok(final.tasks.some(t=>t.id==='task'));
});
