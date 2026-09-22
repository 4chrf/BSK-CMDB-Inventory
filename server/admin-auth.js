import { INITIAL_OWNER_SUBJECT } from './access.js';
// Additional password gate for the private administration workspace.
// The Sites identity and persisted enabled admin role are required as well.
const COOKIE='__Secure-cmdb-admin';
const TTL=30*60*1000;
const encoder=new TextEncoder();
const hex=bytes=>Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
const random=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
const digest=async text=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(text)));
async function passwordHash(password,salt){
 const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
 return hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:encoder.encode(salt),iterations:100000},key,256));
}
function equal(a,b){let diff=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return diff===0}
const cookie=(value,maxAge=TTL/1000)=>`${COOKIE}=${value}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
const json=(data,status=200,cookieValue)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...(cookieValue?{'set-cookie':cookieValue}:{})}});
export const sessionGuard="EXISTS (SELECT 1 FROM admin_sessions WHERE token_hash=? AND user_id=? AND expires_at>?)";
export async function createAuthTables(DB){
 await DB.batch([
  DB.prepare('CREATE TABLE IF NOT EXISTS admin_credentials (user_id TEXT PRIMARY KEY,username TEXT NOT NULL COLLATE NOCASE UNIQUE,salt TEXT NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL)'),
  DB.prepare('CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL)'),
  DB.prepare('CREATE TABLE IF NOT EXISTS admin_login_limits (user_id TEXT PRIMARY KEY,attempts INTEGER NOT NULL,reset_at INTEGER NOT NULL)')
 ]);
}
export async function session(request,DB,user){
 if(user.role!=='admin'||!user.enabled)return null;
 const token=request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
 if(!token||!/^[a-f0-9]{64}$/.test(token))return null;
 const hash=await digest(token);
 const record=await DB.prepare('SELECT token_hash FROM admin_sessions WHERE token_hash=? AND user_id=? AND expires_at>?').bind(hash,user.id,Date.now()).first();
 return record?.token_hash||null;
}
// One-time reset explicitly requested by the Site owner on 2026-09-22.
// The durable marker makes retries and new Worker isolates harmless.
export async function resetRequestedOwnerPassword(DB,user){
 if(user.id!==INITIAL_OWNER_SUBJECT||user.role!=='admin'||!user.enabled)return;
 const marker='owner-password-reset-20260922';
 const guard="NOT EXISTS(SELECT 1 FROM access_metadata WHERE key=?)";
 await DB.batch([
  DB.prepare(`DELETE FROM admin_sessions WHERE user_id=? AND ${guard}`).bind(user.id,marker),
  DB.prepare(`DELETE FROM admin_credentials WHERE user_id=? AND ${guard}`).bind(user.id,marker),
  DB.prepare(`DELETE FROM admin_login_limits WHERE user_id=? AND ${guard}`).bind(user.id,marker),
  DB.prepare(`INSERT INTO change_history(id,at,actor_id,actor_email,action,details) SELECT ?,?,?,?,?,? WHERE ${guard}`).bind(crypto.randomUUID(),new Date().toISOString(),user.id,user.email,'Reset administration password',JSON.stringify({reason:'Owner requested reset on 2026-09-22; existing sessions revoked'}),marker),
  DB.prepare('INSERT OR IGNORE INTO access_metadata(key,value) VALUES(?,?)').bind(marker,new Date().toISOString())
 ]);
}
export async function authRoute(request,DB,user,path){
 if(user.role!=='admin'||!user.enabled)return json({error:'This account cannot access this workspace.'},403);
 if(path==='/api/admin/auth/status'&&request.method==='GET'){
  const credentials=await DB.prepare('SELECT user_id FROM admin_credentials WHERE user_id=?').bind(user.id).first();
  return json({setupRequired:!credentials,authenticated:!!await session(request,DB,user)});
 }
 if(request.method!=='POST')return json({error:'Method not allowed.'},405);
 if(path==='/api/admin/auth/logout'){
  const hash=await session(request,DB,user);
  if(hash)await DB.prepare('DELETE FROM admin_sessions WHERE token_hash=?').bind(hash).run();
  return json({ok:true},200,cookie('',0));
 }
 if(!['/api/admin/auth/setup','/api/admin/auth/login'].includes(path))return json({error:'Not found'},404);
 if(!request.headers.get('content-type')?.startsWith('application/json'))return json({error:'JSON required.'},415);
 const raw=await request.text();if(raw.length>4096)return json({error:'Request too large.'},413);
 const body=JSON.parse(raw),username=typeof body.username==='string'?body.username.trim().toLowerCase():'',password=body.password;
 if(!/^[a-z0-9._@-]{3,100}$/.test(username)||typeof password!=='string'||password.length>256)return json({error:'Enter a valid username and password.'},400);
 const now=Date.now();
 // Count attempts before hashing, atomically, so concurrent requests cannot bypass it.
 const limits=await DB.prepare('INSERT INTO admin_login_limits(user_id,attempts,reset_at) VALUES(?,1,?) ON CONFLICT(user_id) DO UPDATE SET attempts=CASE WHEN reset_at<=? THEN 1 ELSE attempts+1 END,reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END RETURNING attempts').bind(user.id,now+15*60*1000,now,now,now+15*60*1000).all();
 if(limits.results[0].attempts>5)return json({error:'Too many attempts. Try again in 15 minutes.'},429);
 if(path.endsWith('/setup')){
  if(password.length<14)return json({error:'Use a password of at least 14 characters.'},400);
  const salt=random(),hash=await passwordHash(password,salt);
  const result=await DB.batch([
   DB.prepare("INSERT OR IGNORE INTO admin_credentials(user_id,username,salt,password_hash,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM app_users WHERE id=? AND role='admin' AND enabled=1) RETURNING user_id").bind(user.id,username,salt,hash,new Date(now).toISOString(),user.id),
   DB.prepare('INSERT INTO change_history(id,at,actor_id,actor_email,action,details) SELECT ?,?,?,?,?,? WHERE changes()>0').bind(crypto.randomUUID(),new Date(now).toISOString(),user.id,user.email,'Configured administration login',JSON.stringify({username}))
  ]);
  if(!result[0].results.length)return json({error:'Login is already configured or the username is unavailable.'},409);
  await DB.prepare('DELETE FROM admin_login_limits WHERE user_id=?').bind(user.id).run();
  return json({ok:true});
 }
 const credentials=await DB.prepare('SELECT * FROM admin_credentials WHERE user_id=?').bind(user.id).first();
 const hash=await passwordHash(password,credentials?.salt||'missing-credentials-dummy-salt');
 if(!credentials||!equal(hash,credentials.password_hash)||!equal(username,credentials.username))return json({error:'Incorrect username or password.'},401);
 const token=random(),tokenHash=await digest(token);
 const result=await DB.batch([
  DB.prepare('DELETE FROM admin_sessions WHERE expires_at<=? OR user_id=?').bind(now,user.id),
  DB.prepare("INSERT INTO admin_sessions(token_hash,user_id,expires_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM app_users WHERE id=? AND role='admin' AND enabled=1) RETURNING token_hash").bind(tokenHash,user.id,now+TTL,user.id),
  DB.prepare('DELETE FROM admin_login_limits WHERE user_id=?').bind(user.id)
 ]);
 if(!result[1].results.length)return json({error:'Access changed. Sign in again.'},403);
 return json({ok:true,expiresAt:now+TTL},200,cookie(token));
}
