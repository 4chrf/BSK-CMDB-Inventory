import '../public/model.js';
import { identity, adminGuard, changes } from './access.js';
import { createAuthTables, authRoute, session, sessionGuard, resetRequestedOwnerPassword } from './admin-auth.js';
import originalSeed from '../public/seed.json';
import appShell from '../public/index.html';

const seed = globalThis.CmdbModel.migrate(originalSeed);
const { applications: seedApplications, ...seedWorkspace } = seed;
const json = (data, status=200) => new Response(JSON.stringify(data), {status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
let prepared;
async function initialize(DB) {
  if (!DB) throw new Error('Database binding is unavailable.');
  if (!prepared) prepared=(async()=>{
    await DB.batch([
      DB.prepare("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','reader')),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),version INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL)"),
      DB.prepare("CREATE TABLE IF NOT EXISTS access_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL)"),
      DB.prepare("CREATE TABLE IF NOT EXISTS change_history (id TEXT PRIMARY KEY,at TEXT NOT NULL,actor_id TEXT NOT NULL,actor_email TEXT NOT NULL,action TEXT NOT NULL,details TEXT NOT NULL)"),
      DB.prepare("CREATE TRIGGER IF NOT EXISTS keep_last_admin_update BEFORE UPDATE OF role,enabled ON app_users WHEN OLD.role='admin' AND OLD.enabled=1 AND (NEW.role!='admin' OR NEW.enabled=0) AND (SELECT count(*) FROM app_users WHERE role='admin' AND enabled=1)<=1 BEGIN SELECT RAISE(ABORT,'LAST_ADMIN'); END"),
      DB.prepare("CREATE TRIGGER IF NOT EXISTS keep_last_admin_delete BEFORE DELETE ON app_users WHEN OLD.role='admin' AND OLD.enabled=1 AND (SELECT count(*) FROM app_users WHERE role='admin' AND enabled=1)<=1 BEGIN SELECT RAISE(ABORT,'LAST_ADMIN'); END"),
      DB.prepare('CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, write_token TEXT NOT NULL, updated_at TEXT NOT NULL)'),
      DB.prepare('CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, owner TEXT NOT NULL DEFAULT \'\', description TEXT NOT NULL DEFAULT \'\', source TEXT NOT NULL DEFAULT \'\')')
    ]);
    await createAuthTables(DB);
    await DB.batch([
      DB.prepare("INSERT OR IGNORE INTO workspace(id,data,revision,write_token,updated_at) VALUES(1,?,0,'seed-v2',?)").bind(JSON.stringify(seedWorkspace),new Date().toISOString()),
      DB.prepare("INSERT OR IGNORE INTO applications(id,name,owner,description,source) SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),coalesce(json_extract(value,'$.owner'),''),coalesce(json_extract(value,'$.description'),''),coalesce(json_extract(value,'$.source'),'') FROM json_each(?) WHERE (SELECT write_token FROM workspace WHERE id=1)='seed-v2'").bind(JSON.stringify(seedApplications))
    ]);
  })().catch(error=>{prepared=null;throw error});
  await prepared;
}
async function read(DB) {
  const results=await DB.batch([DB.prepare('SELECT data,revision,updated_at FROM workspace WHERE id=1'),DB.prepare('SELECT * FROM applications ORDER BY name COLLATE NOCASE')]);
  const row=results[0].results[0];
  return {state:{...JSON.parse(row.data),applications:results[1].results},revision:row.revision,updatedAt:row.updated_at};
}
export default {
  async fetch(request, env) {
    const url=new URL(request.url);
    if (url.pathname==='/seed.json' || url.pathname==='/model.js.map') return json({error:'Not found'},404);
    // Serve the application shell directly for the hidden administration route.
    // Fetching /index.html through the static-assets binding canonicalizes it to /
    // with a 307 response, which loses the /admin route in the browser.
    if (url.pathname==='/admin' || url.pathname==='/admin/') return new Response(appShell,{status:200,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!request.headers.get('oai-authenticated-user-id') || !request.headers.get('oai-authenticated-user-email')) return json({error:'Sign in again to verify your private Site identity.',reauthenticationRequired:true},401);
    const origin=request.headers.get('origin');
    if (origin && origin!==url.origin) return json({error:'Cross-origin requests are not allowed.'},403);
    if (request.headers.get('sec-fetch-site')==='cross-site') return json({error:'Cross-site requests are not allowed.'},403);
    try {
      await initialize(env.DB);
      const user=await identity(request,env.DB);
      if(!user?.enabled)return json({error:'Your application access is disabled. Contact an administrator.'},403);
      await resetRequestedOwnerPassword(env.DB,user);
      if(url.pathname.startsWith('/api/admin/auth/'))return await authRoute(request,env.DB,user,url.pathname);
      const adminPath=url.pathname.startsWith('/api/admin/');
      const sessionHash=adminPath?await session(request,env.DB,user):null;
      const isAdmin=!!sessionHash;
      if(adminPath&&!isAdmin)return json({error:'Sign in to administration to continue.',loginRequired:true},401);
      if(!adminPath&&url.pathname!=='/api/workspace')return json({error:'Not found'},404);
      if(!adminPath&&request.method!=='GET')return json({error:'This inventory is read-only.'},403);
      const authorizedWrite=`${adminGuard} AND ${sessionGuard}`;
      const writeIdentity=[user.id,sessionHash,user.id,Date.now()];
      if(request.method!=='GET' && !isAdmin)return json({error:'Administrator access required.'},403);
      if(url.pathname==='/api/admin/users' && request.method==='GET') {
        if(!isAdmin)return json({error:'Administrator access required.'},403);
        return json({users:(await env.DB.prepare('SELECT * FROM app_users ORDER BY email').all()).results});
      }
      if(url.pathname==='/api/admin/history' && request.method==='GET') {
        if(!isAdmin)return json({error:'Administrator access required.'},403);
        const limit=50,offset=Math.max(0,Number.parseInt(url.searchParams.get('offset')||'0')||0);
        const rows=(await env.DB.prepare('SELECT * FROM change_history ORDER BY at DESC,id DESC LIMIT ? OFFSET ?').bind(limit+1,offset).all()).results;
        return json({events:rows.slice(0,limit).map(r=>({...r,details:JSON.parse(r.details)})),hasMore:rows.length>limit});
      }
      if(url.pathname==='/api/admin/users' && request.method==='PUT') {
        if(!request.headers.get('content-type')?.startsWith('application/json'))return json({error:'JSON required.'},415);
        const text=await request.text();if(text.length>10000)return json({error:'Request too large.'},413);
        const {id,role,enabled,version}=JSON.parse(text);
        if(typeof id!=='string'||!['admin','reader'].includes(role)||typeof enabled!=='boolean'||!Number.isInteger(version))return json({error:'Invalid user update.'},400);
        const previous=await env.DB.prepare('SELECT * FROM app_users WHERE id=?').bind(id).first();
        if(!previous)return json({error:'User not found. Users must first sign in through the private Site.'},404);
        const token=crypto.randomUUID(),now=new Date().toISOString();
        const result=await env.DB.batch([
          env.DB.prepare(`UPDATE app_users SET role=?,enabled=?,version=version+1 WHERE id=? AND version=? AND ${authorizedWrite} RETURNING id`).bind(role,enabled?1:0,id,version,...writeIdentity),
          env.DB.prepare('INSERT INTO change_history(id,at,actor_id,actor_email,action,details) SELECT ?,?,?,?,?,? WHERE changes()>0').bind(token,now,user.id,user.email,'Changed application access',JSON.stringify({id,email:previous.email,before:{role:previous.role,enabled:!!previous.enabled},after:{role,enabled}})),
          env.DB.prepare("DELETE FROM admin_sessions WHERE user_id=? AND EXISTS(SELECT 1 FROM change_history WHERE id=?) AND (?='reader' OR ?=0)").bind(id,token,role,enabled?1:0)
        ]);
        if(!result[0].results.length)return json({error:'Access or user record changed. Reload before trying again.'},409);
        return json({ok:true});
      }
      if(adminPath)url.pathname=url.pathname.replace('/api/admin/','/api/');
      if(url.pathname!=='/api/workspace' && url.pathname!=='/api/backup' && url.pathname!=='/api/restore')return json({error:'Not found'},404);
      if(url.pathname==='/api/backup') {
        if(!isAdmin)return json({error:'Administrator access required.'},403);
        if(request.method!=='GET')return json({error:'Method not allowed.'},405);
        return json((await read(env.DB)).state);
      }
      if(url.pathname==='/api/restore' && request.method!=='PUT')return json({error:'Method not allowed.'},405);
      if (request.method==='GET') { const data=await read(env.DB); if(!isAdmin)data.state.audit=[]; return json({...data,role:isAdmin?'admin':'reader',user:{id:user.id,email:user.email}}); }
      if (request.method!=='PUT') return json({error:'Method not allowed.'},405);
      if (!request.headers.get('content-type')?.startsWith('application/json')) return json({error:'JSON required.'},415);
      const body=await request.text();
      if (new TextEncoder().encode(body).byteLength>1900000) return json({error:'Workspace exceeds the 1.9 MB limit. Export a backup and contact the owner.'},413);
      const {state,revision,change}=JSON.parse(body);
      if (!Number.isInteger(revision) || revision<0) return json({error:'A valid revision is required.'},400);
      try { globalThis.CmdbModel.validate(state); } catch(error) { return json({error:error.message},400); }
      const now=new Date().toISOString();
      const safeChange={actorId:user.id,actorEmail:user.email,at:now,action:url.pathname==='/api/restore'?'Restored inventory backup':String(change?.action||'Updated workspace').slice(0,120),object:String(change?.object||'Inventory').slice(0,400)};
      const { applications, ...workspace }=state;
      const previous=await read(env.DB);
      if(previous.revision!==revision)return json({error:'The inventory has changed. Reload before saving.',conflict:true},409);
      try { globalThis.CmdbModel.validatePlacementChanges(previous.state,state); }
      catch(error) { return json({error:error.message},400); }
      const removedRacks=previous.state.racks.filter(r=>!state.racks.some(n=>n.id===r.id));
      if(url.pathname!=='/api/restore' && removedRacks.some(r=>previous.state.hosts.some(h=>h.placements.some(p=>p.rackId===r.id)&&!state.hosts.some(n=>n.id===h.id))))return json({error:'Delete racks separately from their hosts. Rack deletion must retain host records.'},400);
      const removedApps=previous.state.applications.filter(a=>!applications.some(n=>n.id===a.id));
      if(url.pathname!=='/api/restore' && removedApps.some(a=>previous.state.hosts.some(h=>h.records.some(r=>r.applicationId===a.id))))return json({error:'Applications assigned to hosts cannot be deleted. Save removal of assignments first.'},400);
      const oldAudit=previous.state.audit||[];
      const diff=changes(previous.state,state);
      workspace.audit=[safeChange,...oldAudit].slice(0,10000);
      // Optimistic revision check and a unique token keep all table updates atomic.
      const token=crypto.randomUUID();
      const appJSON=JSON.stringify(applications);
      const results=await env.DB.batch([
        env.DB.prepare(`UPDATE workspace SET data=?,revision=revision+1,write_token=?,updated_at=? WHERE id=1 AND revision=? AND ${authorizedWrite} RETURNING revision`).bind(JSON.stringify(workspace),token,now,revision,...writeIdentity),
        env.DB.prepare('DELETE FROM applications WHERE EXISTS (SELECT 1 FROM workspace WHERE id=1 AND write_token=?)').bind(token),
        env.DB.prepare("INSERT INTO applications(id,name,owner,description,source) SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),coalesce(json_extract(value,'$.owner'),''),coalesce(json_extract(value,'$.description'),''),coalesce(json_extract(value,'$.source'),'') FROM json_each(?) WHERE (SELECT write_token FROM workspace WHERE id=1)=?").bind(appJSON,token),
        env.DB.prepare('INSERT INTO change_history(id,at,actor_id,actor_email,action,details) SELECT ?,?,?,?,?,? WHERE (SELECT write_token FROM workspace WHERE id=1)=?').bind(token,now,user.id,user.email,safeChange.action,JSON.stringify(diff),token)
      ]);
      if (!results[0].results.length) return json({error:'The database changed in another tab or device. Reload the latest inventory before saving again.',conflict:true},409);
      return json({revision:results[0].results[0].revision,updatedAt:now,audit:workspace.audit});
    } catch(error) {
      if(error.message.includes('LAST_ADMIN'))return json({error:'The last enabled administrator cannot be disabled or demoted.'},409);
      console.error('CMDB request failed',error.message);
      return json({error:error instanceof SyntaxError?'Invalid JSON.':'The database request failed. Your changes have not been confirmed; please retry.'},error instanceof SyntaxError?400:503);
    }
  }
};
