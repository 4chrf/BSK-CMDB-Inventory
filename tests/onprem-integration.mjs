// Run only against a disposable, empty MariaDB database. No production tests.
import assert from 'node:assert/strict';
import {connect,migrate,workspace} from '../onprem/db.mjs';
import {manageAccount} from '../onprem/accounts.mjs';
import {createApp} from '../onprem/server.mjs';
if(process.env.DB_NAME!=='cmdb_test')throw Error('Integration tests require DB_NAME=cmdb_test');
const pool=await connect();await migrate(pool);
const origin='http://127.0.0.1:39092';let app;
try{
 assert.equal((await pool.query('SELECT COUNT(*) n FROM users'))[0].n,0,'Use a fresh test database');
 await manageAccount(pool,{command:'create-user',email:'admin@example.test',role:'admin',password:'Initial-Test-Password-2026'});
 await manageAccount(pool,{command:'create-user',email:'reader@example.test',role:'reader',password:'Reader-Test-Password-2026'});
 app=createApp(pool,{origin,allowHttp:true});await new Promise(r=>app.listen(39092,'127.0.0.1',r));
 const req=(path,method='GET',body,cookie='')=>fetch(origin+path,{method,headers:{origin,...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined});
 const login=async(email,password)=>{const r=await req('/api/auth/login','POST',{username:email,password});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0]};
 let admin=await login('admin@example.test','Initial-Test-Password-2026');const reader=await login('reader@example.test','Reader-Test-Password-2026');
 assert.equal((await req('/api/admin/workspace','GET',null,reader)).status,403);
 assert.equal((await req('/api/workspace','PUT',{},reader)).status,403);
 let r=await req('/api/admin/users','GET',null,admin),users=(await r.json()).users;const owner=users.find(u=>u.role==='admin'),viewer=users.find(u=>u.role==='reader');
 assert.equal((await req('/api/admin/users','PUT',{id:owner.id,version:0,role:'reader',enabled:true},admin)).status,409);
 const get=async()=>await(await req('/api/admin/workspace','GET',null,admin)).json();
 const put=s=>req('/api/admin/workspace','PUT',{state:s.state,revision:s.revision},admin);
 const original=await get();let s=structuredClone(original);
 s.state.applications.push({id:'test-app',name:'Test application',owner:'',description:''});s.state.racks.push({id:'test-rack',name:'Test rack',room:'Test room',aisle:'A',units:42,sample:true});
 const record=Object.fromEntries(globalThis.CmdbModel.fieldKeys.map(k=>[k,'']));Object.assign(record,{server:'TEST-HOST',application:'Test application',applicationId:'test-app'});
 s.state.hosts.push({id:'test-host',server:'TEST-HOST',sample:true,type:'physical',vmware:{vcenter:'',cluster:'',esxiHost:'',vmName:''},records:[record],placements:[{rackId:'test-rack',unit:1,height:2}],connections:[]});assert.equal((await put(s)).status,200);
 assert.equal((await put(original)).status,409);
 s=await get();s.state.applications=[];assert.equal((await put(s)).status,400);
 s=await get();s.state.racks=[];s.state.hosts=[];assert.equal((await put(s)).status,400);
 s=await get();s.state.racks=[];s.state.hosts[0].placements=[];assert.equal((await put(s)).status,200);assert.equal((await get()).state.hosts.length,1);
 s=await get();s.state.hosts[0].records[0].owner='Updated owner';assert.equal((await put(s)).status,200);
 s=await get();s.state.hosts=[];assert.equal((await put(s)).status,200);s=await get();s.state.applications=[];assert.equal((await put(s)).status,200);
 const backup=await(await req('/api/admin/backup','GET',null,admin)).json();s=await get();assert.equal((await req('/api/admin/restore','PUT',{state:backup,revision:s.revision},admin)).status,200);
 assert.equal((await req('/api/admin/users','PUT',{id:viewer.id,version:0,role:'reader',enabled:false},admin)).status,200);assert.equal((await req('/api/workspace','GET',null,reader)).status,401);
 await manageAccount(pool,{command:'reset-password',email:owner.email,password:'Replacement-Test-Password-2026'});assert.equal((await req('/api/admin/workspace','GET',null,admin)).status,401);admin=await login(owner.email,'Replacement-Test-Password-2026');
 const history=await(await req('/api/admin/history','GET',null,admin)).json();assert(history.events.some(e=>e.action==='Changed application access'));assert(history.events.some(e=>e.action==='reset-password'));
 await migrate(pool);assert.deepEqual((await workspace(pool)).state.hosts,backup.hosts);
 // Shared transaction lock prevents concurrent demotion of both administrators.
 await manageAccount(pool,{command:'create-user',email:'second@example.test',role:'admin',password:'Second-Test-Password-2026'});
 const second=await login('second@example.test','Second-Test-Password-2026');users=(await(await req('/api/admin/users','GET',null,admin)).json()).users;const a=users.find(u=>u.email===owner.email),b=users.find(u=>u.email==='second@example.test');
 const results=await Promise.all([req('/api/admin/users','PUT',{id:a.id,version:a.version,role:'reader',enabled:true},admin),req('/api/admin/users','PUT',{id:b.id,version:b.version,role:'reader',enabled:true},second)]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
 console.log('PASS MariaDB: login, read-only authorization, CRUD, references, revisions, backups, reset, disabled users, persistence and concurrent last-admin protection');
}finally{if(app)await new Promise(r=>app.close(r));await pool.end()}
