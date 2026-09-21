import { atomic } from "./transactions";
import { encrypt,decrypt,ApiError } from "./security";
import type { CapturePolicy,CaptureStage } from "../shared/types";

interface State {id:string;policy:CapturePolicy;secrets:string[];meta:Record<string,unknown>;counts:Map<string,number>;lengths:Map<string,number>;pending:Map<string,string>;decoders:Map<string,TextDecoder>;partial:boolean;reason:string|null}
const states=new Map<string,State>();
let chain=Promise.resolve(),lastSweep=0;
const defaultPolicy:CapturePolicy={enabled:true,revision:3,retentionDays:7,maxStageBytes:16*1024*1024,maxStorageBytes:512*1024*1024};
function policy(database:any):CapturePolicy{const row=database.query("SELECT value FROM settings WHERE id='observability'").get();return row?JSON.parse(row.value):defaultPolicy;}
function scrubText(text:string){return text;}
function scrub(value:any):any{return value;}
async function sweep(){
  await atomic(database=>{
    const current=policy(database);const now=Date.now();
    const expired=database.query("SELECT requestId FROM request_captures WHERE state NOT IN ('deleted','expired') AND expiresAt<=? LIMIT 100").all(now) as {requestId:string}[];
    for(const row of expired){database.query('DELETE FROM request_capture_parts WHERE requestId=?').run(row.requestId);database.query("UPDATE request_captures SET state='expired',reason='retention_expired',bytes=0,metadataCipher=?,updatedAt=? WHERE requestId=?").run(encrypt('{}'),now,row.requestId);states.delete(row.requestId);}
    if(current){let used=(database.query('SELECT coalesce(sum(bytes),0) n FROM request_capture_parts').get() as {n:number}).n;
      for(const row of database.query("SELECT requestId,bytes FROM request_captures WHERE state IN ('complete','partial') ORDER BY createdAt LIMIT 100").all() as {requestId:string;bytes:number}[]){if(used<=current.maxStorageBytes)break;database.query('DELETE FROM request_capture_parts WHERE requestId=?').run(row.requestId);database.query("UPDATE request_captures SET state='expired',reason='storage_limit',bytes=0,metadataCipher=?,updatedAt=? WHERE requestId=?").run(encrypt('{}'),now,row.requestId);used-=row.bytes;}
    }
  });lastSweep=Date.now();
}
async function store(state:State,stage:string,text:string){
  const bytes=Buffer.from(text,"utf8");let position=0;
  while(position<bytes.length){
    const used=state.lengths.get(stage)||0,remaining=state.policy.maxStageBytes-used;
    if(remaining<=0){state.partial=true;state.reason="stage_limit";return;}
    let end=Math.min(position+32768,bytes.length,position+remaining);
    while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
    if(end<=position){state.partial=true;state.reason="stage_limit";return;}
    const part=bytes.subarray(position,end),cipher=encrypt(part.toString("utf8")),sequence=state.counts.get(stage)||0;
    const stored=await atomic(database=>{
      const current=policy(database);const row=database.query('SELECT state FROM request_captures WHERE requestId=?').get(state.id) as {state:string}|null;
      if(!current?.enabled||current.revision!==state.policy.revision||!row||row.state!=="recording")return "stopped";
      const total=(database.query('SELECT coalesce(sum(bytes),0) n FROM request_captures').get() as {n:number}).n;
      if(total+part.length>current.maxStorageBytes)return "storage_limit";
      database.query('INSERT INTO request_capture_parts(requestId,stage,sequence,bytes,bodyCipher) VALUES(?,?,?,?,?)').run(state.id,stage,sequence,part.length,cipher);
      database.query('UPDATE request_captures SET bytes=bytes+?,updatedAt=? WHERE requestId=?').run(part.length,Date.now(),state.id);return "stored";
    });
    if(stored!=="stored"){state.partial=true;state.reason=stored;return;}
    state.counts.set(stage,sequence+1);state.lengths.set(stage,used+part.length);position=end;
    await Bun.sleep(0);
  }
}
async function handle(message:any){
  if(message.type==="sweep"){await sweep();return;}
  if(message.type==="clear"){states.clear();return;}
  if(message.type==="begin"){
    if(Date.now()-lastSweep>60000)await sweep();
    const meta=scrub(message.metadata);
    const now=Date.now();
    await atomic(database=>{database.query("INSERT OR IGNORE INTO request_captures(requestId,requestGroupId,policyRevision,state,createdAt,updatedAt,expiresAt,bytes,metadataCipher) VALUES(?,?,?,'recording',?,?,?,0,?)").run(message.requestId,message.requestGroupId,message.policy.revision,now,now,now+message.policy.retentionDays*86400000,encrypt(JSON.stringify(meta)));});
    states.set(message.requestId,{id:message.requestId,policy:message.policy,secrets:message.secrets,meta,counts:new Map(),lengths:new Map(),pending:new Map(),decoders:new Map(),partial:false,reason:null});return;
  }
  const state=states.get(message.requestId);if(!state)return;
  if(message.type==="secret"){state.secrets.push(message.value);return;}
  if(message.type==="metadata"){state.meta={...state.meta,...scrub(message.value)};return;}
  if(message.type==="json"){await store(state,message.stage,JSON.stringify(scrub(message.value),null,2));return;}
  if(message.type==="chunk"){
    const decoder=state.decoders.get(message.stage)||new TextDecoder();state.decoders.set(message.stage,decoder);
    let pending=(state.pending.get(message.stage)||"")+decoder.decode(message.chunk,{stream:true});
    if(pending.length>32768){let cut=pending.length-1024;if(/[\uD800-\uDBFF]/.test(pending[cut-1]))cut--;await store(state,message.stage,pending.slice(0,cut));pending=pending.slice(cut);}
    state.pending.set(message.stage,pending);return;
  }
  if(message.type==="end"){
    for(const [stage,pending]of state.pending){await store(state,stage,scrubText(pending+(state.decoders.get(stage)?.decode()||"")));}
    state.meta={...state.meta,status:message.status,error:message.error};if(message.dropped){state.partial=true;state.reason="capture_queue_limit";}
    await atomic(database=>database.query("UPDATE request_captures SET state=?,reason=?,metadataCipher=?,updatedAt=? WHERE requestId=? AND state='recording'").run(state.partial?"partial":"complete",state.reason,encrypt(JSON.stringify(state.meta)),Date.now(),state.id));states.delete(state.id);
  }
}
async function read(operation:string,args:any){
  if(operation==="deleteAll"){await atomic(database=>{database.query('DELETE FROM request_capture_parts').run();database.query("UPDATE request_captures SET state='deleted',bytes=0,reason='deleted',metadataCipher=?,updatedAt=?").run(encrypt('{}'),Date.now());});states.clear();return {ok:true};}
  if(operation==="delete"){await atomic(database=>{database.query('DELETE FROM request_capture_parts WHERE requestId=?').run(args.id);database.query("UPDATE request_captures SET state='deleted',bytes=0,reason='deleted',metadataCipher=?,updatedAt=? WHERE requestId=?").run(encrypt('{}'),Date.now(),args.id);});states.delete(args.id);return {ok:true};}
  const row=await atomic(database=>database.query('SELECT * FROM request_captures WHERE requestId=?').get(args.id) as any);
  if(!row){if(operation==="info")return {requestId:args.id,requestGroupId:"",state:"not_captured",createdAt:0,updatedAt:0,expiresAt:0,bytes:0,reason:"not_captured",metadata:{},stages:[]};if(operation==="stage")return {text:"",next:null,bytes:0,complete:false};throw new ApiError(404,"capture_not_found");}
  if(row.expiresAt<=Date.now()&&!['deleted','expired'].includes(row.state)){await atomic(database=>{database.query('DELETE FROM request_capture_parts WHERE requestId=?').run(args.id);database.query("UPDATE request_captures SET state='expired',bytes=0,reason='retention_expired',metadataCipher=?,updatedAt=? WHERE requestId=?").run(encrypt('{}'),Date.now(),args.id);});states.delete(args.id);if(operation==="info")return {requestId:args.id,requestGroupId:row.requestGroupId,state:"expired",createdAt:row.createdAt,updatedAt:Date.now(),expiresAt:row.expiresAt,bytes:0,reason:"retention_expired",metadata:{},stages:[]};throw new ApiError(410,"capture_expired");}
  if(operation==="info"){
    const stages=await atomic(database=>database.query('SELECT stage,sum(bytes) bytes,count(*) chunks FROM request_capture_parts WHERE requestId=? GROUP BY stage').all(args.id));
    const {metadataCipher,policyRevision,...rest}=row;return {...rest,metadata:JSON.parse(decrypt(metadataCipher)),stages};
  }
  if(['deleted','expired'].includes(row.state))throw new ApiError(410,"capture_expired");
  let stage=args.stage as string;
  const fallback=stage==="output"&&JSON.parse(decrypt(row.metadataCipher)).outputSource==="response";
  if(fallback)stage="response";
  const parts=await atomic(database=>database.query('SELECT sequence,bytes,bodyCipher FROM request_capture_parts WHERE requestId=? AND stage=? AND sequence>? ORDER BY sequence LIMIT 3').all(args.id,stage,args.after) as {sequence:number;bytes:number;bodyCipher:string}[]);
  const more=parts.length>2;if(more)parts.pop();return {text:parts.map(p=>decrypt(p.bodyCipher)).join(""),next:more?parts.at(-1)!.sequence:null,bytes:parts.reduce((n,p)=>n+p.bytes,0),complete:row.state==="complete",fallback};
}
(globalThis as any).onmessage=(event:MessageEvent)=>{
  const message=event.data;
  chain=chain.then(async()=>{
    if(message.type==="read"){
      try{const result=await read(message.operation,message.args);(globalThis as any).postMessage({type:"read",sequence:message.sequence,result});}
      catch(error){(globalThis as any).postMessage({type:"read",sequence:message.sequence,error:error instanceof ApiError?error.code:"capture_unavailable",status:error instanceof ApiError?error.status:500});}
    }else{
      try{await handle(message);}catch{const state=states.get(message.requestId);if(state){state.partial=true;state.reason="capture_write_failed";}}
      finally{(globalThis as any).postMessage({type:"ack",sequence:message.sequence});}
    }
  }).catch(()=>{});
};
