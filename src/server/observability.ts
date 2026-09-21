import { setting,audit } from "./store";
import { atomic } from "./transactions";
import { ApiError } from "./security";
import type { CapturePolicy,CaptureStage,CaptureInfo,CapturePage } from "../shared/types";

export const captureDefaults:CapturePolicy={enabled:true,revision:3,retentionDays:7,maxStageBytes:16*1024*1024,maxStorageBytes:512*1024*1024};
export function captureHeaders(headers:Headers){return Object.fromEntries(headers.entries());}
export function captureUrl(value:string){return value;}
let writer:Worker|undefined,viewer:Worker|undefined,sequence=0,queuedBytes=0;
const pending=new Map<number,number>();
const reads=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;view:boolean;cleanup:()=>void}>();
function worker(view=false){
  let target=view?viewer:writer;
  if(!target){
    target=new Worker(new URL(view?"./trajectory-worker.ts":"./trace-worker.ts",import.meta.url).href,{type:"module"});
    if(view)viewer=target;else writer=target;
    target.onmessage=event=>{
      const value=event.data;
      if(value.type==="ack"){queuedBytes-=pending.get(value.sequence)||0;pending.delete(value.sequence);}
      else if(value.type==="read"){const waiting=reads.get(value.sequence);if(waiting){clearTimeout(waiting.timer);waiting.cleanup();reads.delete(value.sequence);value.error?waiting.reject(new ApiError(value.status||500,value.error)):waiting.resolve(value.result);}}
    };
    target.onerror=()=>{
      console.error("Observability worker unavailable");target?.terminate();
      if(view)viewer=undefined;else{writer=undefined;pending.clear();queuedBytes=0;}
      for(const [id,waiting]of reads)if(waiting.view===view){clearTimeout(waiting.timer);waiting.cleanup();waiting.reject(new ApiError(503,"capture_unavailable"));reads.delete(id);}
    };
  }
  return target;
}
function send(value:Record<string,unknown>,bytes=0){
  if(queuedBytes+bytes>128*1024*1024)return false;
  const id=++sequence;
  try{pending.set(id,bytes);queuedBytes+=bytes;worker().postMessage({...value,sequence:id});return true;}
  catch{queuedBytes-=pending.get(id)||0;pending.delete(id);return false;}
}
async function read<T>(operation:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<T>{
  signal?.throwIfAborted();
  if(reads.size>=24)throw new ApiError(429,"capture_reads_busy");
  const id=++sequence,view=["inspect","compare","sessions","nodes","node"].includes(operation)||operation.startsWith("snapshot.");
  return new Promise<T>((resolve,reject)=>{
    const cancel=()=>{const waiting=reads.get(id);if(!waiting)return;clearTimeout(waiting.timer);waiting.cleanup();reads.delete(id);if(view)viewer?.postMessage({type:"cancel",sequence:id});reject(signal?.reason||new ApiError(499,"job_cancelled"));};
    const cleanup=()=>signal?.removeEventListener("abort",cancel);
    const timer=setTimeout(()=>{reads.delete(id);cleanup();if(view)viewer?.postMessage({type:"cancel",sequence:id});reject(new ApiError(503,"capture_read_timeout"));},30000);
    reads.set(id,{resolve,reject,timer,view,cleanup});signal?.addEventListener("abort",cancel,{once:true});
    try{worker(view).postMessage({type:"read",sequence:id,operation,args});}catch(error){clearTimeout(timer);cleanup();reads.delete(id);reject(error instanceof Error?error:new Error("capture_unavailable"));}
  });
}
export async function capturePolicy(){
  const value=await setting<CapturePolicy>("observability",captureDefaults);
  if(value.revision>=captureDefaults.revision)return value;
  const next={...value,enabled:true,revision:captureDefaults.revision,maxStageBytes:value.maxStageBytes===2*1024*1024?captureDefaults.maxStageBytes:value.maxStageBytes};
  await atomic(database=>database.query("UPDATE settings SET value=?,updatedAt=? WHERE id='observability'").run(JSON.stringify(next),Date.now()));
  return next;
}
export async function configureCapture(input:Omit<CapturePolicy,"revision">){
  const value=await atomic(database=>{
    const row=database.query("SELECT value FROM settings WHERE id='observability'").get() as {value:string}|null;
    const previous=row?JSON.parse(row.value) as CapturePolicy:captureDefaults;
    const next={...input,revision:previous.revision+1};
    database.query("INSERT INTO settings(id,createdAt,updatedAt,value) VALUES('observability',?,?,?) ON CONFLICT(id) DO UPDATE SET updatedAt=excluded.updatedAt,value=excluded.value").run(Date.now(),Date.now(),JSON.stringify(next));return next;
  });
  send({type:"sweep"});await audit("observability.configured","local",{enabled:value.enabled,retentionDays:value.retentionDays,revision:value.revision});return value;
}
export interface RequestCapture {
  json:(stage:CaptureStage,value:unknown,estimatedBytes?:number)=>void;
  chunk:(stage:CaptureStage,chunk:Uint8Array)=>void;
  metadata:(value:Record<string,unknown>)=>void;
  secret:(value:string)=>void;
  finish:(status:string,error:string|null)=>void;
}
const noop:RequestCapture={json(){},chunk(){},metadata(){},secret(){},finish(){}};
export function beginCapture(policy:CapturePolicy,requestId:string,requestGroupId:string,metadata:Record<string,unknown>,secrets:string[]):RequestCapture{
  if(!policy.enabled)return noop;
  let dropped=false,ended=false;
  if(!send({type:"begin",requestId,requestGroupId,policy,metadata,secrets},4096))return noop;
  const push=(value:Record<string,unknown>,bytes=0)=>{if(!ended&&!send({...value,requestId},bytes))dropped=true;};
  return {
    json(stage,value,estimatedBytes=65536){push({type:"json",stage,value},Math.max(4096,estimatedBytes));},
    chunk(stage,chunk){push({type:"chunk",stage,chunk},chunk.byteLength);},
    metadata(value){push({type:"metadata",value},4096);},
    secret(value){if(value)push({type:"secret",value},value.length);},
    finish(status,error){if(ended)return;push({type:"end",status,error,dropped},4096);ended=true;},
  };
}
export const inspectCapture=(id:string)=>read<CaptureInfo>("info",{id});
export const captureStage=(id:string,stage:CaptureStage,after=-1)=>read<CapturePage>("stage",{id,stage,after});
export async function deleteCapture(id:string){await read("delete",{id});await audit("observability.deleted",id);return {ok:true};}
export async function deleteAllCaptures(){await read("deleteAll",{});await audit("observability.cleared","local");return {ok:true};}
export async function closeCaptures(){
  const deadline=Date.now()+3000;
  while(pending.size&&Date.now()<deadline)await Bun.sleep(20);
  writer?.terminate();viewer?.terminate();writer=undefined;viewer=undefined;pending.clear();queuedBytes=0;
  for(const waiting of reads.values()){clearTimeout(waiting.timer);waiting.cleanup();waiting.reject(new ApiError(503,"capture_unavailable"));}reads.clear();
}

export const inspectTrajectory=(args:Parameters<typeof import("./trajectory-inspector").inspectTrajectory>[0],signal?:AbortSignal)=>read("inspect",args,signal);
export const compareTrajectory=(args:Parameters<typeof import("./trajectory-inspector").compareTrajectory>[0],signal?:AbortSignal)=>read("compare",args,signal);

export const trajectorySessions=(args:Parameters<typeof import("./trajectory-sessions").trajectorySessions>[0],signal?:AbortSignal)=>read("sessions",args,signal);
export const trajectoryNodes=(args:Parameters<typeof import("./trajectory-sessions").trajectoryNodes>[0],signal?:AbortSignal)=>read("nodes",args,signal);
export const trajectoryNodeDetail=(args:Parameters<typeof import("./trajectory-sessions").trajectoryNodeDetail>[0],signal?:AbortSignal)=>read("node",args,signal);

export const contextSnapshots=(args:Parameters<typeof import("./trajectory-snapshots").contextSnapshots>[0],signal?:AbortSignal)=>read("snapshot.list",args,signal);
export const inspectContextSnapshot=(args:Parameters<typeof import("./trajectory-snapshots").inspectContextSnapshot>[0],signal?:AbortSignal)=>read("snapshot.inspect",args,signal);
export const compareContextSnapshots=(args:Parameters<typeof import("./trajectory-snapshots").compareContextSnapshots>[0],signal?:AbortSignal)=>read("snapshot.compare",args,signal);
export async function deleteContextSnapshot(id:string){await read("snapshot.delete",{id});await audit("trajectory.snapshot_deleted",id);return {ok:true};}
