import { db, JobSchema, SourceSchema, ProviderSchema, McpSchema } from "./store";
import { decrypt, encrypt, ApiError } from "./security";
import { atomic } from "./transactions";
import { jobContext, RetryScheduled } from "./job-context";
import { scanRegistry } from "./collector";
import { scanSessions, listSessions, timeline } from "./sessions";
import { probeProvider } from "./providers";
import { scanAssets,searchSkills,inspectAsset,snapshotAsset,snapshotDetail,previewDeployment,applyDeployment } from "./assets";
import { probeMcp, executeMcp } from "./mcp";

await db.initialize();
let running: {id:string;cancel:()=>void}|undefined;
(globalThis as any).onmessage=async(event:MessageEvent)=>{
  const message=event.data;
  if(message?.type==="cancel"&&message.id===running?.id){running?.cancel();return;}
  if(message?.type!=="run"||typeof message.id!=="string"||running)return;
  const id=message.id,context=jobContext(id);running={id,cancel:context.cancel};
  try {
    const job=await db.getRepository(JobSchema).findOneBy({id,status:"running"});if(!job)throw new ApiError(409,"job_not_active");
    const input=JSON.parse(decrypt(job.payloadCipher));
    await context.context.check();
    let result:unknown;
    if(job.kind==="trajectory.snapshot")result=await (await import("./trajectory-snapshots")).createContextSnapshot(input,id,context.context);
    else if(job.kind==="trajectory.cleanup")result=await (await import("./trajectory-snapshots")).sweepContextSnapshots(context.context);
    else if(job.kind==="assets.scan")result=await scanAssets(input.rootId,context.context);
    else if(job.kind==="assets.search")result=await searchSkills(input);
    else if(job.kind==="assets.inspect")result=input.snapshotId?await snapshotDetail(input.snapshotId):await inspectAsset(input.id,context.context);
    else if(job.kind==="assets.snapshot")result=await snapshotAsset(input.id,context.context);
    else if(job.kind==="assets.preview")result=await previewDeployment(input,context.context);
    else if(job.kind==="assets.apply"||job.kind==="assets.restore")result=await applyDeployment(input.id,job.kind==="assets.restore",context.context);
    else if(job.kind==="registry.scan")result=await scanRegistry(context.context);
    else if(job.kind==="sessions.scan")result=await scanSessions(input.sourceId,context.context);
    else if(job.kind==="sessions.search"){
      await context.context.progress("search",0,null);
      const page=await listSessions(input,context.context);result={ids:page.items.map(s=>s.id),total:page.total,next:page.next,unavailable:page.unavailable};
    }else if(job.kind==="sessions.timeline"){
      result=await timeline(input.id,input.options,context.context,false);
    }else if(job.kind==="provider.probe"){
      const provider=await db.getRepository(ProviderSchema).findOneBy({id:input.id});if(!provider)throw new ApiError(404,"provider_not_found");
      await context.context.progress("connect",0,1,provider.name);result=await probeProvider(provider);
    }else if(job.kind==="mcp.probe"){
      const connection=await db.getRepository(McpSchema).findOneBy({id:input.id});if(!connection)throw new ApiError(404,"mcp_not_found");
      await context.context.progress("catalog",0,null,connection.name);result=await probeMcp(connection);
    }else if(job.kind==="mcp.debug"){
      const connection=await db.getRepository(McpSchema).findOneBy({id:input.id});if(!connection)throw new ApiError(404,"mcp_not_found");
      await context.context.progress("execute",0,1,connection.name);result=await executeMcp(connection,input.kind,input.name,input.arguments,{id:null,name:`Debug ${id.slice(0,8)}`,project:null},context.context.signal,true);
    }else if(job.kind==="model.debug")result=await (await import("./playground")).executeModelDebug(id,input,context.context);
    else throw new ApiError(400,"unsupported_job");
    await context.context.check();
    await atomic(database=>{
      const current=database.query('SELECT cancelRequested FROM background_jobs WHERE id=?').get(id) as {cancelRequested:number}|null;
      if(!current||current.cancelRequested)throw new ApiError(499,"job_cancelled");
      database.query("UPDATE background_jobs SET status='completed',phase='completed',resultCipher=?,endedAt=?,heartbeatAt=?,updatedAt=? WHERE id=? AND status IN ('running','waiting')").run(encrypt(JSON.stringify(result)),Date.now(),Date.now(),Date.now(),id);
    });
  }catch(error){
    if(error instanceof RetryScheduled)return;
    const job=await db.getRepository(JobSchema).findOneBy({id});
    const code=error instanceof ApiError?error.code:error instanceof Error?error.message.slice(0,160):"job_failed";
    if(job?.kind==="trajectory.snapshot"&&(context.context.signal.aborted||code==="job_cancelled"))await (await import("./trajectory-snapshots")).deleteContextSnapshot(id).catch(()=>{});
    await db.getRepository(JobSchema).update(id,{status:context.context.signal.aborted||code==="job_cancelled"?(job&&["mcp.debug","assets.apply","assets.restore"].includes(job.kind)?"uncertain":"cancelled"):"failed",phase:"stopped",error:code,endedAt:Date.now(),updatedAt:Date.now()});
  }finally{context.close();running=undefined;(globalThis as any).postMessage({type:"done",id});}
};
