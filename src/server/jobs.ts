import { db, JobSchema, record, audit, SourceSchema, SessionSchema, AssetRootSchema } from "./store";
import { readSessionEvents } from "./session-files";
import { atomic } from "./transactions";
import { encrypt, decrypt, hash, ApiError } from "./security";
import type { BackgroundJob, JobKind, PublicJob } from "../shared/types";

type Lane = { worker?: Worker; current: string | null; ticking: boolean; kinds: JobKind[] };
const lanes: Lane[] = [
  { current:null,ticking:false,kinds:["trajectory.snapshot","trajectory.cleanup"] },
  { current:null,ticking:false,kinds:["sessions.search","sessions.timeline","assets.search","assets.inspect"] },
  { current:null,ticking:false,kinds:["registry.scan","sessions.scan","provider.probe","mcp.probe","assets.scan","assets.snapshot","assets.preview"] },
  { current:null,ticking:false,kinds:["model.debug","mcp.debug","assets.apply","assets.restore"] },
];
let stopping=false,lastSnapshotCleanup=0;
let tickTimer: ReturnType<typeof setInterval> | undefined, scanTimer: ReturnType<typeof setInterval> | undefined;
export function publicJob(job: BackgroundJob): PublicJob { const { payloadCipher,resultCipher,dedupKey,...rest }=job; return rest; }
export async function submitJob(kind:JobKind,label:string,payload:unknown,deduplicate=true) {
  const key=deduplicate?hash(JSON.stringify({kind,payload})):null;
  const value=await atomic(database=>{
    if(key){const previous=database.query("SELECT * FROM background_jobs WHERE dedupKey=? AND status IN ('queued','running','waiting') AND cancelRequested=0").get(key) as BackgroundJob|null;if(previous)return previous;}
    const active=database.query("SELECT count(*) n FROM background_jobs WHERE status IN ('queued','running','waiting')").get() as {n:number};
    if(active.n>=200)throw new ApiError(429,"job_queue_full");
    const job:BackgroundJob={...record(),kind,label,status:"queued",payloadCipher:encrypt(JSON.stringify(payload)),resultCipher:null,dedupKey:key,phase:"queued",processed:0,total:null,currentItem:null,attempts:0,nextRunAt:Date.now(),startedAt:null,endedAt:null,heartbeatAt:null,cancelRequested:false,error:null};
    const columns=Object.keys(job),values=Object.values({...job,cancelRequested:0});
    database.query(`INSERT INTO background_jobs(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`).run(...values);
    return job;
  });
  void tick();return publicJob(value);
}
export async function jobDetail(id:string) {
  const job=await db.getRepository(JobSchema).findOneBy({id});if(!job)throw new ApiError(404,"job_not_found");
  let result=job.resultCipher?JSON.parse(decrypt(job.resultCipher)):null;
  if(job.kind==="sessions.search"&&result?.ids){const found=result.ids.length?await db.getRepository(SessionSchema).createQueryBuilder("s").where("s.id IN (:...ids)",{ids:result.ids}).getMany():[];const items=result.ids.map((id:string)=>found.find(s=>s.id===id)).filter(Boolean);result={items,total:result.total,next:result.next,unavailable:result.unavailable};}
  if(job.kind==="sessions.timeline"&&result?.session){
    const session=await db.getRepository(SessionSchema).findOneBy({id:result.session.id});
    if(!session||session.generation!==result.session.generation)throw new ApiError(409,"session_file_changed");
    const source=session.sourceId?await db.getRepository(SourceSchema).findOneBy({id:session.sourceId}):null;
    result.events=await readSessionEvents(session,source,result.events);
    const current=source?await db.getRepository(SourceSchema).findOneBy({id:source.id}):null;
    if(source&&(!current||current.revision!==source.revision))throw new ApiError(409,"source_changed");
    result.session=session;
  }
  return {...publicJob(job),result};
}
export async function cancelJob(id:string) {
  await atomic(database=>{const row=database.query('SELECT status FROM background_jobs WHERE id=?').get(id) as BackgroundJob|null;if(!row)throw new ApiError(404,"job_not_found");if(!["queued","running","waiting"].includes(row.status))throw new ApiError(409,"job_not_active");database.query("UPDATE background_jobs SET cancelRequested=1,status=CASE WHEN status IN ('queued','waiting') THEN 'cancelled' ELSE status END,updatedAt=? WHERE id=?").run(Date.now(),id);});
  lanes.find(l=>l.current===id)?.worker?.postMessage({type:"cancel",id});
  return {ok:true};
}
export async function retryJob(id:string,confirmed:boolean) {
  const job=await db.getRepository(JobSchema).findOneBy({id});if(!job)throw new ApiError(404,"job_not_found");
  if(!["completed","failed","cancelled","uncertain"].includes(job.status))throw new ApiError(409,"job_not_retryable");
  if(["model.debug","mcp.debug","assets.apply","assets.restore"].includes(job.kind)&&!confirmed)throw new ApiError(400,"confirmation_required");
  return submitJob(job.kind,job.label,JSON.parse(decrypt(job.payloadCipher)),false);
}
async function tick() {
  await Promise.all(lanes.map(async lane=>{
    if(lane.ticking||stopping||lane.current)return;
    lane.ticking=true;
    try {
      const job=await atomic(database=>{
        const row=database.query(`SELECT * FROM background_jobs WHERE status IN ('queued','waiting') AND cancelRequested=0 AND nextRunAt<=? AND kind IN (${lane.kinds.map(()=>"?").join(",")}) ORDER BY createdAt LIMIT 1`).get(Date.now(),...lane.kinds) as BackgroundJob|null;
        if(!row)return null;
        database.query("UPDATE background_jobs SET status='running',phase='starting',attempts=attempts+1,startedAt=?,heartbeatAt=?,updatedAt=? WHERE id=? AND status IN ('queued','waiting')").run(Date.now(),Date.now(),Date.now(),row.id);return row;
      });
      if(!job)return;
      lane.current=job.id;
      if(!lane.worker){
        lane.worker=new Worker(new URL("./job-worker.ts",import.meta.url).href,{type:"module"});
        lane.worker.onmessage=event=>{if(event.data?.type==="done"&&event.data.id===lane.current){lane.current=null;void tick();}};
        lane.worker.onerror=event=>{
          console.error("Job worker",event.message);const id=lane.current;lane.current=null;lane.worker?.terminate();lane.worker=undefined;
          if(id)void db.getRepository(JobSchema).update(id,{status:"uncertain",error:"worker_stopped",endedAt:Date.now(),updatedAt:Date.now()});
        };
      }
      lane.worker.postMessage({type:"run",id:job.id});
    }finally{lane.ticking=false;}
  }));
}
export function startScheduler() {
  stopping=false;lastSnapshotCleanup=Date.now();tickTimer=setInterval(()=>{void tick().catch(error=>console.error("Scheduler",error));},300);tickTimer.unref();
  scanTimer=setInterval(()=>{void (async()=>{if(Date.now()-lastSnapshotCleanup>1800000){lastSnapshotCleanup=Date.now();await submitJob("trajectory.cleanup","snapshot.cleanup",{});}for(const source of await db.getRepository(SourceSchema).findBy({enabled:true}))await submitJob("sessions.scan",source.name,{sourceId:source.id});for(const root of await db.getRepository(AssetRootSchema).findBy({enabled:true}))if(!root.lastScanAt||Date.now()-root.lastScanAt>300000)await submitJob("assets.scan",root.name,{rootId:root.id});})().catch(error=>console.error("Scheduled collection",error));},30000);scanTimer.unref();
  void submitJob("trajectory.cleanup","snapshot.cleanup",{}).catch(error=>console.error("Snapshot cleanup",error));
  void tick();
}
export async function stopScheduler() {
  stopping=true;clearInterval(tickTimer);clearInterval(scanTimer);
  for(const lane of lanes)if(lane.current)await cancelJob(lane.current).catch(()=>{});
  const deadline=Date.now()+5000;
  while(lanes.some(l=>l.current)&&Date.now()<deadline)await Bun.sleep(50);
  for(const lane of lanes){
    if(lane.current)await db.getRepository(JobSchema).update(lane.current,{status:"uncertain",error:"worker_shutdown",endedAt:Date.now(),updatedAt:Date.now()});
    lane.worker?.terminate();lane.worker=undefined;lane.current=null;
  }
}
