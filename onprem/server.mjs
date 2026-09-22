import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {connect,migrate,transaction,workspace,audit} from './db.mjs';
import {authenticate,fail,digest,token,cookieToken,sessionCookie,verifyPassword} from './security.mjs';
import {changes} from '../server/access.js';
const root=new URL('../public/',import.meta.url);
async function body(req){if(!req.headers['content-type']?.startsWith('application/json'))fail(415,'JSON required.');let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>1900000)fail(413,'Request exceeds 1.9 MB.');parts.push(chunk)}try{return JSON.parse(Buffer.concat(parts).toString())}catch{fail(400,'Invalid JSON.')}}
function send(res,status,data,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'same-origin','x-frame-options':'DENY',...headers});res.end(typeof data==='string'?data:JSON.stringify(data))}
const safeUser=u=>({id:u.id,email:u.email,role:u.role,enabled:!!u.enabled,version:u.version,created_at:u.created_at});
export function createApp(pool,{origin=process.env.APP_ORIGIN,allowHttp=process.env.ALLOW_HTTP==='true'}={}){
 if(!origin||new URL(origin).origin!==origin)throw Error('APP_ORIGIN must be an exact origin without a trailing slash.');
 const secure=new URL(origin).protocol==='https:';if(!secure&&!allowHttp)throw Error('Use HTTPS or explicitly enable ALLOW_HTTP for local testing.');
 return http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,origin),path=url.pathname,method=req.method;
   if(path==='/healthz'){await pool.query('SELECT 1');return send(res,200,{ok:true})}
   if(!['GET','HEAD'].includes(method)){
    if(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')fail(403,'Same-origin request required.');
   }
   if(path==='/api/auth/login'&&method==='POST'){
    const input=await body(req),email=String(input.username||'').trim().toLowerCase();
    if(!email||email.length>254||typeof input.password!=='string'||input.password.length>256)fail(400,'Invalid login.');
    const key=digest(email),now=Date.now();
    const attempts=await transaction(pool,async c=>{await c.query('DELETE FROM login_limits WHERE reset_at<=?',[now]);await c.query('INSERT INTO login_limits(identity_hash,attempts,reset_at) VALUES(?,1,?) ON DUPLICATE KEY UPDATE attempts=attempts+1',[key,now+900000]);return (await c.query('SELECT attempts FROM login_limits WHERE identity_hash=?',[key]))[0].attempts});
    if(attempts>5)fail(429,'Too many attempts. Try again in 15 minutes.');
    const [candidate]=await pool.query('SELECT * FROM users WHERE email=?',[email]);
    const valid=await verifyPassword(input.password,candidate?.password_hash);if(!candidate||!candidate.enabled||!valid)fail(401,'Incorrect username or password.');
    const raw=token();await transaction(pool,async c=>{
     const [current]=await c.query('SELECT * FROM users WHERE id=?',[candidate.id]);if(!current?.enabled||current.password_hash!==candidate.password_hash)fail(401,'Account changed. Sign in again.');
     await c.query('DELETE FROM sessions WHERE expires_at<=? OR user_id=?',[now,current.id]);
     await c.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',[digest(raw),current.id,now+1800000]);
     await c.query('DELETE FROM login_limits WHERE identity_hash=?',[key]);
    });return send(res,200,{ok:true},{'set-cookie':sessionCookie(raw,secure)});
   }
   if(path==='/api/auth/logout'||path==='/api/admin/auth/logout'){
    if(method!=='POST')fail(405,'POST required.');const raw=cookieToken(req);if(raw)await pool.query('DELETE FROM sessions WHERE token_hash=?',[digest(raw)]);
    return send(res,200,{ok:true},{'set-cookie':sessionCookie('',secure,0)});
   }
   if(path.startsWith('/api/')){
    const admin=path.startsWith('/api/admin/');
    const publicWorkspaceRead=path==='/api/workspace'&&method==='GET';
    const user=publicWorkspaceRead?null:await authenticate(pool,req,admin);
    if(path==='/api/admin/auth/status'&&method==='GET')return send(res,200,{setupRequired:false,authenticated:true});
    if(path==='/api/admin/users'&&method==='GET')return send(res,200,{users:(await pool.query('SELECT id,email,role,enabled,version,created_at FROM users ORDER BY email')).map(safeUser)});
    if(path==='/api/admin/users'&&method==='PUT'){
     const input=await body(req);if(typeof input.id!=='string'||!['admin','reader'].includes(input.role)||typeof input.enabled!=='boolean'||!Number.isInteger(input.version))fail(400,'Invalid access update.');
     await transaction(pool,async c=>{
      const actor=await authenticate(c,req,true);const [old]=await c.query('SELECT id,email,role,enabled,version FROM users WHERE id=?',[input.id]);if(!old)fail(404,'User not found.');if(old.version!==input.version)fail(409,'User changed. Reload before saving.');
      if(old.role==='admin'&&old.enabled&&(input.role!=='admin'||!input.enabled)){const [{n}]=await c.query("SELECT COUNT(*) n FROM users WHERE role='admin' AND enabled=1");if(n<=1)fail(409,'The last enabled administrator cannot be disabled or demoted.')}
      await c.query('UPDATE users SET role=?,enabled=?,version=version+1 WHERE id=?',[input.role,input.enabled,input.id]);
      await c.query('DELETE FROM sessions WHERE user_id=?',[input.id]);
      await audit(c,actor,'Changed application access',{before:old,after:{id:input.id,role:input.role,enabled:input.enabled}});
     });return send(res,200,{ok:true});
    }
    if(path==='/api/admin/history'&&method==='GET'){
     const offset=Math.min(100000,Math.max(0,parseInt(url.searchParams.get('offset'))||0));const rows=await pool.query('SELECT * FROM history ORDER BY at DESC,id DESC LIMIT 51 OFFSET ?',[offset]);return send(res,200,{events:rows.slice(0,50).map(r=>({...r,details:JSON.parse(r.details)})),hasMore:rows.length>50});
    }
    if(['/api/workspace','/api/admin/workspace','/api/admin/backup'].includes(path)&&method==='GET'){
     const data=await transaction(pool,c=>workspace(c));if(path.endsWith('/backup'))return send(res,200,data.state);if(!admin)data.state.audit=[];return send(res,200,{...data,role:admin?'admin':'reader',user:user?safeUser(user):{id:'public-reader',email:'',role:'reader',enabled:true}});
    }
    if(path==='/api/workspace'&&method!=='GET')fail(403,'This inventory is read-only.');
    if(['/api/admin/workspace','/api/admin/restore'].includes(path)&&method==='PUT'){
     const {state,revision,change}=await body(req);if(!Number.isInteger(revision)||revision<0)fail(400,'Valid revision required.');try{globalThis.CmdbModel.validate(state)}catch(e){fail(400,e.message)}
     const result=await transaction(pool,async c=>{
      const actor=await authenticate(c,req,true),previous=await workspace(c);if(previous.revision!==revision)fail(409,'Inventory changed. Reload before saving.');
      const restoring=path.endsWith('/restore');
      if(!restoring){
       const removedRacks=previous.state.racks.filter(r=>!state.racks.some(n=>n.id===r.id));
       if(removedRacks.some(r=>previous.state.hosts.some(h=>h.placements.some(p=>p.rackId===r.id)&&!state.hosts.some(n=>n.id===h.id))))fail(400,'Rack deletion must retain its hosts.');
       const removedApps=previous.state.applications.filter(a=>!state.applications.some(n=>n.id===a.id));if(removedApps.some(a=>previous.state.hosts.some(h=>h.records.some(r=>r.applicationId===a.id))))fail(400,'Assigned applications cannot be deleted. Remove assignments first.');
      }
      const now=new Date().toISOString(),action=restoring?'Restored inventory backup':String(change?.action||'Updated inventory').slice(0,120);
      const {applications,...data}=state;data.audit=[{actorId:actor.id,actorEmail:actor.email,at:now,action,object:String(change?.object||'Inventory').slice(0,400)},...(previous.state.audit||[])].slice(0,10000);
      await c.query('UPDATE workspace SET data=?,revision=revision+1,updated_at=? WHERE id=1',[JSON.stringify(data),now]);
      await c.query('DELETE FROM applications');for(const app of applications)await c.query('INSERT INTO applications(id,data) VALUES(?,?)',[app.id,JSON.stringify(app)]);
      await audit(c,actor,action,changes(previous.state,state));return {revision:revision+1,updatedAt:now,audit:data.audit};
     });return send(res,200,result);
    }
    fail(404,'Not found.');
   }
   if(path==='/signin-with-chatgpt'){res.writeHead(302,{location:'/login?return_to='+encodeURIComponent(url.searchParams.get('return_to')==='/admin'?'/admin':'/')});return res.end()}
   if(path==='/login')return send(res,200,await readFile(new URL('./login.html',import.meta.url),'utf8'),{'content-type':'text/html; charset=utf-8'});
   const assets={'/':'index.html','/admin':'index.html','/admin/':'index.html','/app.js':'app.js','/model.js':'model.js','/styles.css':'styles.css','/icon.svg':'icon.svg','/login.js':'../onprem/login.js'};
   if(!assets[path]||!['GET','HEAD'].includes(method))fail(404,'Not found.');
   if(['/admin','/admin/'].includes(path)){try{await authenticate(pool,req,true)}catch{res.writeHead(302,{location:'/login?return_to=%2Fadmin'});return res.end()}}
   let data=await readFile(new URL(assets[path],root),'utf8');if(path==='/app.js'){
    data=data.replace('/signin-with-chatgpt?return_to=', '/login?return_to=').replace('Sign in with ChatGPT','Sign in').replace("lockAdmin();renderAdminLogin(false)","location.href='/login?return_to=%2Fadmin'");
    data+=`\nif(location.pathname==='/admin'||location.pathname==='/admin/'){const b=document.createElement('button');b.className='btn';b.textContent='Sign out';b.onclick=async()=>{const r=await fetch('/api/auth/logout',{method:'POST'});if(r.ok)location.href='/login?return_to=%2Fadmin';else alert('Sign out failed. Please retry.')};document.querySelector('.top-right').append(b);}`;
   }
   const type=path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':'text/html';return send(res,200,data,{'content-type':type+'; charset=utf-8'});
  }catch(e){if(!e.status)console.error('Request failed',e.code||e.name);send(res,e.status||500,{error:e.status?e.message:'Database request failed; changes were not confirmed.',...(e.status===401?{reauthenticationRequired:true}:{})})}
 });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const pool=await connect();await migrate(pool);const server=createApp(pool);server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('CMDB listening on port '+(process.env.PORT||3000)));
 for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>server.close(async()=>{await pool.end();process.exit(0)}));
}
