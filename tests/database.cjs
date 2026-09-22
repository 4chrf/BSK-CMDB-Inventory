const {DatabaseSync}=require('node:sqlite');
module.exports=function createDB(){
 const sql=new DatabaseSync(':memory:');
 class Statement{constructor(query,values=[]){this.query=query;this.values=values}bind(...values){return new Statement(this.query,values)}async first(){return sql.prepare(this.query).get(...this.values)||null}async all(){return {results:sql.prepare(this.query).all(...this.values)}}async run(){return sql.prepare(this.query).run(...this.values)}}
 return {sql,prepare:query=>new Statement(query),batch:async statements=>{sql.exec('BEGIN');try{const results=statements.map(s=>({results:sql.prepare(s.query).all(...s.values)}));sql.exec('COMMIT');return results}catch(error){sql.exec('ROLLBACK');throw error}}};
};
