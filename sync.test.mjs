import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import vm from 'node:vm';
import {Linter} from 'eslint';
import {syncApi as authenticatedSyncApi,MAX_BODY_BYTES} from './sync-api.js';
import {initial,validate} from './core.js';
const syncApi=(request,env)=>authenticatedSyncApi(request,env,request.headers.get('oai-authenticated-user-id'));
const html=fs.readFileSync(new URL('./index.html',import.meta.url),'utf8');
const source=html.split('<script>')[1].split('</script>')[0];
const ctx={__RITM_TEST__:true,setTimeout,clearTimeout,AbortController,structuredClone};
vm.createContext(ctx);vm.runInContext(source,ctx);const c=ctx.RitmCore;
const clone=x=>JSON.parse(JSON.stringify(x));
function database(){const sql=new DatabaseSync(':memory:');sql.exec(fs.readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));return {sql,DB:{prepare(query){return {bind(...args){return {async first(){return sql.prepare(query).get(...args)||null}}}}}}}}
const origin='https://ritm.example';
const request=(method='GET',body,owner='owner-a',extra={})=>{const headers=new Headers({'oai-authenticated-user-id':owner,'origin':origin,'content-type':'application/json'});for(const [key,value]of Object.entries(extra))headers.set(key,value);return new Request(origin+'/api/state',{method,headers,body:body?JSON.stringify(body):undefined})};
const put=(state,revision=0,account='owner-a')=>({state,revision,account});
function adapter(){let data={current:null,previous:null};return {name:'local',async read(){return {...data}},async write(current,expected,previous){if(data.current!==expected){const e=Error('Conflict');e.code='conflict';throw e}data={current,previous}},get data(){return data}}}
function device(env,{legacyState,cacheAdapter=adapter(),legacyAdapter=adapter(),owner='owner-a'}={}){const cache=c.createPersistence([cacheAdapter]),legacy=c.createPersistence([legacyAdapter]);if(legacyState)legacyAdapter.write(JSON.stringify(legacyState),null,null);let online=true,dropAfterWrite=false;const fetcher=async(path,options)=>{assert.equal(path,'api/state');if(!online)throw new TypeError('Network unavailable');const body=options.body?JSON.parse(options.body):undefined;const response=await syncApi(request(options.method,body,owner,options.headers),env);if(dropAfterWrite&&options.method==='PUT'){dropAfterWrite=false;throw new TypeError('Response lost')}return response};const engine=c.createCloudPersistence({cache,legacy,request:c.createCloudRequest(fetcher)});return {engine,cacheAdapter,legacyAdapter,set online(v){online=v},drop(){dropAfterWrite=true}}}
const money=(id,amount=1000)=>({id,title:'Продукты',type:'expense',category:'food',date:'2026-09-06',amount,status:'paid'});

test('Server and browser validate the same canonical source; script lint and local/online routing',()=>{
 assert.equal(validate(initial()).version,c.validate(c.initial()).version);
 const generated=fs.readFileSync(new URL('./core.js',import.meta.url),'utf8');
 assert.equal(generated,'// Generated from calendar/index.html. Keep the validation rules identical.\n'+source.slice(source.indexOf('const STORE='),source.indexOf('function storageConflict('))+'\nexport {validate,upgrade,initial};\n');
 new vm.Script(source);
 const globals=Object.fromEntries(['document','window','localStorage','structuredClone','setInterval','setTimeout','clearTimeout','FormData','URL','Blob','AbortController'].map(k=>[k,'readonly']));
 const lint=new Linter().verify(source,[{languageOptions:{ecmaVersion:'latest',sourceType:'script',globals},rules:{'no-undef':'error','no-dupe-keys':'error','no-unreachable':'error'}}]);assert.deepEqual(lint,[]);
 assert.match(html,/connect-src 'self'/);assert.match(source,/window.location.protocol==='https:'/);assert.match(source,/if\(syncEnabled\)setInterval/);
});
test('API authentication, account isolation, CSRF, body limits, schema validation, no-cache',async()=>{
 const env=database();let response=await syncApi(request('GET',null,''),env);assert.equal(response.status,401);
 response=await syncApi(request('PUT',put(initial()),'owner-a',{origin:'https://foreign.example'}),env);assert.equal(response.status,403);
 response=await syncApi(request('PUT',put(initial()),'owner-a',{'content-type':'text/plain'}),env);assert.equal(response.status,415);
 response=await syncApi(request('PUT',put(initial(),0,'someone-else')),env);assert.equal(response.status,401);
 response=await syncApi(request('PUT',put({version:3})),env);assert.equal(response.status,400);
 const state=initial();state.extra='x'.repeat(MAX_BODY_BYTES);response=await syncApi(request('PUT',put(state)),env);assert.equal(response.status,413);
 response=await syncApi(request('PUT',put(initial())),env);assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
 assert.equal((await (await syncApi(request('GET'),env)).json()).revision,1);
 assert.equal((await (await syncApi(request('GET',null,'owner-b'),env)).json()).state,null);
 response=await syncApi(request('PUT',put(initial(),1),'owner-b'),env);assert.equal(response.status,401);
 assert.equal(env.sql.prepare('select count(*) as n from ritm_calendars').get().n,1);
});
test('Atomic compare-and-swap rejects stale creates and updates, retains previous snapshot',async()=>{
 const env=database();const [a,b]=await Promise.all([syncApi(request('PUT',put(initial())),env),syncApi(request('PUT',put(initial())),env)]);assert.deepEqual([a.status,b.status].sort(),[200,409]);
 let state=initial();state.settings.goalName='Поездка';assert.equal((await syncApi(request('PUT',put(state,1)),env)).status,200);
 state.settings.goalName='Не перезаписывать';assert.equal((await syncApi(request('PUT',put(state,1)),env)).status,409);
 const row=env.sql.prepare('select * from ritm_calendars').get();assert.equal(row.revision,2);assert.equal(JSON.parse(row.state_json).settings.goalName,'Поездка');assert.equal(JSON.parse(row.previous_state_json).settings.goalName,'Резерв');
});
test('First device uploads legacy money, sleep and checklist; a second device reads them',async()=>{
 const env=database();let old=c.setCurrentMoney(c.initial(),12345,50000);old=c.saveSleepNight(old,'2026-09-06','00:30','08:30');old=c.saveRoutine(old,{title:'Умыться',startDay:'2026-09-06',repeat:'daily',weekdays:[],until:'',time:'',duration:5,priority:'normal'},'wash');old=c.toggleRoutine(old,'wash','2026-09-06',true,Date.parse(c.instant('2026-09-06T10:00')));
 const a=device(env,{legacyState:old});const original=a.legacyAdapter.data.current;assert.equal((await a.engine.load()).connected,true);const b=device(env);const loaded=await b.engine.load();assert.equal(c.moneyTotals(loaded.state).cash,12345);assert.equal(c.moneyTotals(loaded.state).savings,50000);assert.equal(c.clock(c.plannedSleep(loaded.state,'2026-09-06').start),'00:30');assert.equal(c.routineInstances(loaded.state,'2026-09-06')[0].done,true);assert.equal(a.legacyAdapter.data.current,original);
});
test('Independent concurrent money and task updates merge; deleted rows stay deleted',async()=>{
 const env=database(),a=device(env),b=device(env);let sa=(await a.engine.load()).state,sb=(await b.engine.load()).state;
 sa=clone(sa);sb=clone(sb);sa.entries.push(money('food'));sb.tasks.push({id:'t',title:'Документы',due:'2026-09-06',duration:15,priority:'normal',done:false,eventId:null});await a.engine.save(sa);const merged=await b.engine.save(sb);assert.equal(merged.entries.length,1);assert.equal(merged.tasks.length,1);
 sa=(await a.engine.load()).state;sb=(await b.engine.load()).state;sa.entries=[];sb.settings.goalName='Обучение';await a.engine.save(sa);const deleted=await b.engine.save(sb);assert.equal(deleted.entries.length,0);assert.equal(deleted.settings.goalName,'Обучение');
});
test('Same-entry conflicts preserve remote data and a durable local draft until resolved',async()=>{
 const env=database(),a=device(env),b=device(env);const sa=(await a.engine.load()).state,sb=(await b.engine.load()).state;sa.settings.goalName='Первый вариант';sb.settings.goalName='Второй вариант';await a.engine.save(sa);await assert.rejects(b.engine.save(sb),e=>e.code==='conflict');assert.equal(b.engine.pendingState.settings.goalName,'Второй вариант');assert.equal((await a.engine.load()).state.settings.goalName,'Первый вариант');
 const reopened=device(env,{cacheAdapter:b.cacheAdapter});await reopened.engine.load();assert.equal(reopened.engine.pendingState.settings.goalName,'Второй вариант');await assert.rejects(reopened.engine.save(sb,{retry:true}),e=>e.code==='conflict');const remote=await reopened.engine.discardPending();assert.equal(remote.settings.goalName,'Первый вариант');assert.equal(reopened.engine.pendingState,null);
});
test('Dropped save response retries the exact draft without duplicate money or revision churn',async()=>{
 const env=database(),a=device(env);let state=(await a.engine.load()).state;state.entries.push(money('one-only'));a.drop();await assert.rejects(a.engine.save(state));assert.equal(a.engine.pendingState.entries.length,1);const rowBefore=env.sql.prepare('select revision from ritm_calendars').get();const result=await a.engine.save(a.engine.pendingState,{retry:true});assert.equal(result.entries.length,1);assert.equal(a.engine.pendingState,null);assert.equal(env.sql.prepare('select revision from ritm_calendars').get().revision,rowBefore.revision);
});
test('Offline pending edit survives reopening, then merges with another device after reconnect',async()=>{
 const env=database(),a=device(env),b=device(env);let sa=(await a.engine.load()).state,sb=(await b.engine.load()).state;a.online=false;sa.entries.push(money('offline'));await assert.rejects(a.engine.save(sa));sb.settings.goalName='С другого устройства';await b.engine.save(sb);
 const reopened=device(env,{cacheAdapter:a.cacheAdapter});const loaded=await reopened.engine.load();assert.equal(loaded.pending,true);const result=await reopened.engine.save(reopened.engine.pendingState,{retry:true});assert.equal(result.entries.length,1);assert.equal(result.settings.goalName,'С другого устройства');
});
test('Blocked local storage does not prevent acknowledged cloud saves',async()=>{
 const env=database(),a=device(env,{cacheAdapter:{name:'blocked',async read(){throw Error('blocked')},async write(){throw Error('blocked')}}});const state=(await a.engine.load()).state;state.entries.push(money('server'));const stored=await a.engine.save(state);assert.equal(stored.entries.length,1);assert.equal((await device(env).engine.load()).state.entries.length,1);assert.ok(a.engine.status.cacheWarning);
});
test('Existing cloud is not overwritten by a second device legacy copy, originals stay untouched',async()=>{
 const env=database(),a=device(env);const original=(await a.engine.load()).state;original.entries.push(money('cloud'));await a.engine.save(original);const local=c.initial();local.tasks.push({id:'legacy-task',title:'Старое дело',due:'',duration:5,done:false,priority:'normal',eventId:null});const b=device(env,{legacyState:local});const raw=b.legacyAdapter.data.current;const loaded=await b.engine.load();assert.equal(loaded.state.entries.length,1);assert.equal(loaded.state.tasks.length,0);assert.equal(b.engine.localCandidate.tasks.length,1);const merged=await b.engine.importLocal();assert.equal(merged.entries.length,1);assert.equal(merged.tasks.length,1);await b.engine.save(merged);await b.engine.dismissLocal();assert.equal(b.legacyAdapter.data.current,raw);assert.equal(b.engine.localCandidate,null);const fresh=device(env,{legacyAdapter:b.legacyAdapter,cacheAdapter:b.cacheAdapter});await fresh.engine.load();assert.equal(fresh.engine.localCandidate,null);
});
test('Concurrent replacement imports refuse to overwrite a newly changed account',async()=>{
 const env=database(),a=device(env),b=device(env);let sa=(await a.engine.load()).state,sb=(await b.engine.load()).state;sa.entries.push(money('preserve'));await a.engine.save(sa);sb.settings.goalName='Импорт';await assert.rejects(b.engine.save(sb,{replace:true}),e=>e.code==='conflict');await assert.rejects(b.engine.save(b.engine.pendingState,{retry:true}),e=>e.code==='conflict');assert.equal((await a.engine.load()).state.entries.length,1);
});
test('Server excludes browser cache and draft metadata from shared records',async()=>{
 const env=database(),state=initial();state._sync={owner:'malicious',pending:{}};state._saveId='local';const response=await syncApi(request('PUT',put(state)),env);const body=await response.json();assert.equal(body.state._sync,undefined);assert.equal(body.state._saveId,undefined);
});

test('Lost response during first migration does not strand subsequent edits or overwrite the account',async()=>{
 const env=database(),a=device(env);a.drop();const loaded=await a.engine.load();assert.equal(loaded.connected,false);assert.ok(loaded.state);loaded.state.entries.push(money('after-first-upload'));const saved=await a.engine.save(loaded.state);assert.equal(saved.entries.length,1);assert.equal((await device(env).engine.load()).state.entries.length,1);
});

test('Conditional refresh is private, sends no unchanged body and never rewrites a clean cache',async()=>{
 const env=database(),a=device(env);await a.engine.load();const raw=a.cacheAdapter.data.current;
 const first=await syncApi(request('GET'),env),etag=first.headers.get('etag');assert.ok(etag);
 const same=await syncApi(request('GET',null,'owner-a',{'if-none-match':etag}),env);assert.equal(same.status,304);assert.equal(await same.text(),'');
 const other=await syncApi(request('GET',null,'owner-b',{'if-none-match':etag}),env);assert.equal(other.status,200);assert.equal((await other.json()).state,null);
 const refresh=await a.engine.load();assert.equal(refresh.unchanged,true);assert.equal(a.cacheAdapter.data.current,raw);
 const b=device(env);let s=(await b.engine.load()).state;s.entries.push(money('fast-change'));await b.engine.save(s);
 const changed=await a.engine.load();assert.equal(changed.unchanged,undefined);assert.equal(changed.state.entries.length,1);assert.notEqual(a.cacheAdapter.data.current,raw);
});

test('Day bar uses Warsaw clock positions including short and long daylight-saving days',()=>{
 const s=c.initial();for(const [day,hours,at6]of [['2026-09-06',24,25],['2026-03-29',23,5/23*100],['2026-10-25',25,7/25*100]]){const m=c.dayBarModel(s,day,Date.parse(c.instant(day+'T12:00')));assert.equal(m.hours,hours);assert.ok(Math.abs(m.ticks[1].left-at6)<1e-8);assert.equal(m.ticks[0].left,0);assert.equal(m.ticks.at(-1).left,100);assert.ok(m.rows.every(row=>row.items.every(item=>item.left>=0&&item.width>0&&item.left+item.width<=100.00001)))}
});

test('Day bar clips overnight shifts, separates sleep/work, and allocates nonoverlapping lanes',()=>{
 const s=c.initial();s.settings.sleepPlan.adjust=false;s.events=[{id:'overnight',title:'Ночь',kind:'work',start:c.instant('2026-09-05T23:00'),end:c.instant('2026-09-06T02:00'),rate:35,breakMinutes:0,busy:true,note:''},{id:'overlap',title:'Ещё',kind:'work',start:c.instant('2026-09-06T01:00'),end:c.instant('2026-09-06T03:00'),rate:35,breakMinutes:0,busy:true,note:''}];
 const m=c.dayBarModel(s,'2026-09-06'),work=m.rows.find(r=>r.key==='work'),sleep=m.rows.find(r=>r.key==='sleep');assert.equal(work.lanes,2);assert.equal(work.items[0].left,0);assert.ok(Math.abs(work.items[0].width-2/24*100)<1e-8);assert.ok(sleep.items.length);assert.equal(work.items[0].lane,0);assert.equal(work.items[1].lane,1);
 for(const row of m.rows)for(let lane=0;lane<row.lanes;lane++){const items=row.items.filter(i=>i.lane===lane);for(let i=1;i<items.length;i++)assert.ok(items[i-1].end<=items[i].start)}
 assert.equal(c.progressPercent(-10,100),0);assert.equal(c.progressPercent(150,100),100);assert.equal(c.progressPercent(1,0),0);assert.equal(c.progressPercent(NaN,100),0);assert.equal(c.progressPercent(25000,100000),25);
});
