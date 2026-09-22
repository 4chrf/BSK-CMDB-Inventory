import {connect,migrate} from './db.mjs';
import {manageAccount} from './accounts.mjs';
const [command,email,role]=process.argv.slice(2);
if(!['create-user','reset-password'].includes(command)||!email){console.error('Usage: node onprem/cli.mjs create-user EMAIL admin|reader\n       node onprem/cli.mjs reset-password EMAIL\nPassword is read without echo from the terminal or from stdin.');process.exit(1)}
async function password(){
 if(!process.stdin.isTTY){let s='';for await(const chunk of process.stdin){s+=chunk;if(s.length>1024)throw Error('Password input too long.')}return s.replace(/[\r\n]+$/,'')}
 process.stdout.write('Password (14–256 characters): ');process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
 return new Promise((resolve,reject)=>{let value='';const finish=()=>{process.stdin.setRawMode(false);process.stdin.pause();process.stdin.off('data',onData);process.stdout.write('\n')};const onData=chunk=>{for(const c of chunk){if(c==='\u0003'){finish();return reject(Error('Cancelled'))}if(c==='\r'||c==='\n'){finish();return resolve(value)}if(c==='\u007f'){value=value.slice(0,-1)}else if(c>=' '&&value.length<256)value+=c}};process.stdin.on('data',onData)});
}
let pool;try{const pw=await password();pool=await connect();await migrate(pool);await manageAccount(pool,{command,email,role:role||'reader',password:pw});console.log('Account updated.')}catch(e){console.error(e.status?e.message:'Account operation failed: '+e.message);process.exitCode=1}finally{if(pool)await pool.end()}
