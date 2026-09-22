import {hashPassword,digest,fail} from './security.mjs';
import {transaction,audit} from './db.mjs';
export async function manageAccount(pool,{command,email,role='reader',password}){
 email=String(email||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)fail(400,'Supply a valid email.');if(!['admin','reader'].includes(role))fail(400,'Role must be admin or reader.');if(!['create-user','reset-password'].includes(command))fail(400,'Unknown command.');
 const hash=await hashPassword(password);
 return transaction(pool,async c=>{const [old]=await c.query('SELECT id FROM users WHERE email=?',[email]);
 if(command==='create-user'){if(old)fail(409,'Account already exists.');await c.query('INSERT INTO users(id,email,role,enabled,password_hash,created_at) VALUES(?,?,?,1,?,?)',[crypto.randomUUID(),email,role,hash,new Date().toISOString()])}
 else {if(!old)fail(404,'Account not found.');await c.query('UPDATE users SET password_hash=?,version=version+1 WHERE id=?',[hash,old.id]);await c.query('DELETE FROM sessions WHERE user_id=?',[old.id]);await c.query('DELETE FROM login_limits WHERE identity_hash=?',[digest(email)])}
 await audit(c,{id:'local-console',email:'local-console'},command,{email,role:command==='create-user'?role:undefined});return {ok:true};});
}
