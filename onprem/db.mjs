import mariadb from 'mariadb';
import {readFile} from 'node:fs/promises';
import '../public/model.js';
export async function secret(name){return process.env[name+'_FILE']?(await readFile(process.env[name+'_FILE'],'utf8')).trim():process.env[name]||''}
export async function connect(){
 const password=await secret('DB_PASSWORD');if(!password)throw Error('DB_PASSWORD_FILE or DB_PASSWORD is required');
 return mariadb.createPool({host:process.env.DB_HOST||'db',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'cmdb',password,database:process.env.DB_NAME||'cmdb',connectionLimit:8,connectTimeout:10000,bigIntAsNumber:true,...(process.env.DB_CA_FILE?{ssl:{ca:await readFile(process.env.DB_CA_FILE,'utf8'),rejectUnauthorized:true}}:{})});
}
export async function migrate(pool){
 const statements=[
 `CREATE TABLE IF NOT EXISTS cmdb_lock (id INT PRIMARY KEY) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS users (id VARCHAR(100) PRIMARY KEY, email VARCHAR(254) NOT NULL UNIQUE, role VARCHAR(10) NOT NULL, enabled BOOLEAN NOT NULL DEFAULT 1, version INT NOT NULL DEFAULT 0, password_hash VARCHAR(300) NOT NULL, created_at VARCHAR(30) NOT NULL) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS sessions (token_hash CHAR(64) PRIMARY KEY,user_id VARCHAR(100) NOT NULL,expires_at BIGINT NOT NULL,INDEX(user_id),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS login_limits (identity_hash CHAR(64) PRIMARY KEY,attempts INT NOT NULL,reset_at BIGINT NOT NULL) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS workspace (id INT PRIMARY KEY,data LONGTEXT NOT NULL,revision INT NOT NULL DEFAULT 0,updated_at VARCHAR(30) NOT NULL) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS applications (id VARCHAR(100) PRIMARY KEY,data LONGTEXT NOT NULL) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS history (id CHAR(36) PRIMARY KEY,at VARCHAR(30) NOT NULL,actor_id VARCHAR(100) NOT NULL,actor_email VARCHAR(254) NOT NULL,action VARCHAR(120) NOT NULL,details LONGTEXT NOT NULL,INDEX(at)) ENGINE=InnoDB`
 ];for(const sql of statements)await pool.query(sql);
 await pool.query('INSERT IGNORE INTO cmdb_lock(id) VALUES(1)');
 await transaction(pool,async c=>{
  const existing=await c.query('SELECT id FROM workspace WHERE id=1');if(existing.length)return;
  const sample=process.env.SEED_SAMPLE_DATA==='true';
  const state=sample?globalThis.CmdbModel.migrate(JSON.parse(await readFile(new URL('../public/seed.json',import.meta.url),'utf8'))):{schemaVersion:2,hosts:[],racks:[],applications:[],audit:[],sources:[],notes:[],importedAt:new Date().toISOString().slice(0,10)};
  const {applications,...workspace}=state;
  await c.query('INSERT INTO workspace(id,data,updated_at) VALUES(1,?,?)',[JSON.stringify(workspace),new Date().toISOString()]);
  for(const app of applications)await c.query('INSERT INTO applications(id,data) VALUES(?,?)',[app.id,JSON.stringify(app)]);
 });
}
// Serialize inventory/access writes, including the last-admin check, across processes.
export async function transaction(pool,fn){const c=await pool.getConnection();try{await c.beginTransaction();await c.query('SELECT id FROM cmdb_lock WHERE id=1 FOR UPDATE');const result=await fn(c);await c.commit();return result}catch(e){await c.rollback();throw e}finally{c.release()}}
export async function workspace(c){const [row]=await c.query('SELECT data,revision,updated_at FROM workspace WHERE id=1');const apps=await c.query('SELECT data FROM applications ORDER BY id');return {state:{...JSON.parse(row.data),applications:apps.map(a=>JSON.parse(a.data))},revision:row.revision,updatedAt:row.updated_at}}
export async function audit(c,user,action,details){await c.query('INSERT INTO history(id,at,actor_id,actor_email,action,details) VALUES(?,?,?,?,?,?)',[crypto.randomUUID(),new Date().toISOString(),user.id,user.email,action,JSON.stringify(details)])}
