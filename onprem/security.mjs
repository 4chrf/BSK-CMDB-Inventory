import {randomBytes,scrypt as scryptCallback,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(scryptCallback);
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const token=()=>randomBytes(32).toString('hex');
export function validPassword(value){return typeof value==='string'&&value.length>=14&&value.length<=256}
export async function hashPassword(password){if(!validPassword(password))throw Error('Password must contain 14–256 characters.');const salt=randomBytes(16).toString('hex');const hash=await scrypt(password,salt,64,{N:16384,r:8,p:1});return `scrypt:${salt}:${hash.toString('hex')}`}
export async function verifyPassword(password,encoded){if(typeof password!=='string'||password.length>256)return false;const [,salt,hex]=(encoded||'scrypt:dummy:').split(':');const actual=await scrypt(password,salt||'dummy',64,{N:16384,r:8,p:1});const expected=Buffer.from(hex||'','hex');return actual.length===expected.length&&timingSafeEqual(actual,expected)}
export function cookieToken(req){const raw=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('cmdb_session='))?.slice(13);return /^[a-f0-9]{64}$/.test(raw||'')?raw:null}
export function sessionCookie(value,secure,maxAge=1800){return `cmdb_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure?'; Secure':''}`}
export function fail(status,message){const e=Error(message);e.status=status;throw e}
export async function authenticate(c,req,admin=false){const raw=cookieToken(req);if(!raw)fail(401,'Sign in required.');const [u]=await c.query('SELECT u.id,u.email,u.role,u.enabled,u.version,u.created_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.enabled=1',[digest(raw),Date.now()]);if(!u)fail(401,'Sign in required.');if(admin&&u.role!=='admin')fail(403,'Administrator access required.');return u}
