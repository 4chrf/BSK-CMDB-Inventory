// Identities come only from the private Sites dispatch boundary. Never expose
// this Worker on an origin where a caller can supply these headers directly.
export const INITIAL_OWNER_SUBJECT = 'REPLACE_WITH_VERIFIED_SITE_OWNER_SUBJECT';
export async function identity(request, DB) {
  const id = request.headers.get('oai-authenticated-user-id');
  const email = request.headers.get('oai-authenticated-user-email');
  if (!id || !email) return null;
  const now = new Date().toISOString();
  // A single, explicitly provisioned owner invitation. Bind it once to the
  // authenticated Site-scoped subject; subsequent decisions use that subject.
  if (id === INITIAL_OWNER_SUBJECT) {
    await DB.batch([
      DB.prepare("INSERT OR IGNORE INTO access_metadata(key,value) VALUES('initial_owner_subject',?)").bind(id),
      DB.prepare("INSERT OR IGNORE INTO app_users(id,email,role,enabled,version,created_at) SELECT ?,?,'admin',1,0,? WHERE (SELECT value FROM access_metadata WHERE key='initial_owner_subject')=?").bind(id,email,now,id)
    ]);
  }
  await DB.prepare("INSERT OR IGNORE INTO app_users(id,email,role,enabled,version,created_at) VALUES(?,?,'reader',1,0,?)").bind(id,email,now).run();
  return DB.prepare('SELECT * FROM app_users WHERE id=?').bind(id).first();
}
export const adminGuard = "EXISTS (SELECT 1 FROM app_users WHERE id=? AND role='admin' AND enabled=1)";
export function changes(before, after) {
  const result=[];
  for(const kind of ['hosts','racks','applications']) {
    const old=new Map((before[kind]||[]).map(x=>[x.id,x]));
    const next=new Map((after[kind]||[]).map(x=>[x.id,x]));
    for(const id of new Set([...old.keys(),...next.keys()])) {
      const a=old.get(id),b=next.get(id);
      if(JSON.stringify(a)!==JSON.stringify(b))result.push({kind,id,name:b?.server||b?.name||a?.server||a?.name,action:!a?'added':!b?'deleted':'updated',fields:[...new Set([...Object.keys(a||{}),...Object.keys(b||{})])].filter(k=>JSON.stringify(a?.[k])!==JSON.stringify(b?.[k])),before:a||null,after:b||null});
    }
  }
  for(const key of ['sources','notes','importedAt'])if(JSON.stringify(before[key])!==JSON.stringify(after[key]))result.push({kind:'metadata',id:key,action:'updated',before:before[key],after:after[key]});
  return result;
}
