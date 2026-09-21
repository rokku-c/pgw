import { readdir,realpath,lstat,readFile,mkdir,rename,rm,mkdtemp } from "node:fs/promises";
import { join,dirname,basename,resolve,isAbsolute } from "node:path";
import { homedir } from "node:os";
import { db,AssetSchema,AssetRootSchema,SnapshotSchema,DeploymentSchema,record,audit } from "./store";
import { atomic } from "./transactions";
import { encrypt,decrypt,hash,ApiError } from "./security";
import { readPackage,writePackage,skillMetadata,within } from "./packages";
import type { WorkContext } from "./job-context";
import type { AssetRoot,Asset,AssetSnapshot,AssetDeployment,SkillPackage } from "../shared/types";

const nativeRoots=process.env.PGW_NATIVE_DISCOVERY==="0"?[]:[
  {name:"Claude Code",agent:"claude",path:join(homedir(),".claude/skills")},
  {name:"Codex",agent:"codex",path:join(process.env.CODEX_HOME||join(homedir(),".codex"),"skills")},
  {name:"Pi",agent:"pi",path:join(homedir(),".pi/agent/skills")},
  {name:"Shared",agent:"shared",path:join(homedir(),".agents/skills")},
  {name:"Claude plugins",agent:"claude",path:join(homedir(),".claude/plugins")},
  {name:"Codex plugins",agent:"codex",path:join(homedir(),".codex/plugins")},
] as const;
export async function assetRoots(){
  await atomic(database=>{for(const root of nativeRoots){const meta=record();database.query('INSERT OR IGNORE INTO asset_roots(id,createdAt,updatedAt,name,path,agent,project,enabled,followSymlinks,capture,revision,lastScanAt,lastError,count) VALUES(?,?,?,?,?,?,NULL,1,0,0,1,NULL,NULL,0)').run(meta.id,meta.createdAt,meta.updatedAt,root.name,root.path,root.agent);}});
  return db.getRepository(AssetRootSchema).find({order:{createdAt:"ASC"}});
}
export async function saveAssetRoot(input:Pick<AssetRoot,"name"|"path"|"agent"|"project"|"enabled"|"followSymlinks"|"capture">,id?:string,revision?:number){
  if(!isAbsolute(input.path)||input.path.includes("\0"))throw new ApiError(400,"absolute_path_required");
  const canonical=await realpath(input.path).catch(()=>{throw new ApiError(400,"source_missing");});
  if(canonical===homedir()||canonical==="/"||!(await lstat(canonical)).isDirectory())throw new ApiError(400,"source_too_broad");
  const item=await atomic(database=>{
    const old=id?database.query('SELECT * FROM asset_roots WHERE id=?').get(id) as AssetRoot|null:null;
    if(id&&!old)throw new ApiError(404,"source_not_found");if(old&&old.revision!==revision)throw new ApiError(409,"source_changed");
    if(database.query('SELECT id FROM asset_roots WHERE path=? AND id!=?').get(canonical,id||""))throw new ApiError(409,"source_exists");
    const value:AssetRoot={...record(),lastScanAt:null,lastError:null,count:0,...old,...input,path:canonical,revision:(old?.revision||0)+1,updatedAt:Date.now()};
    database.query('INSERT INTO asset_roots(id,createdAt,updatedAt,name,path,agent,project,enabled,followSymlinks,capture,revision,lastScanAt,lastError,count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updatedAt=excluded.updatedAt,name=excluded.name,path=excluded.path,agent=excluded.agent,project=excluded.project,enabled=excluded.enabled,followSymlinks=excluded.followSymlinks,capture=excluded.capture,revision=excluded.revision,lastError=NULL').run(value.id,value.createdAt,value.updatedAt,value.name,value.path,value.agent,value.project,value.enabled?1:0,value.followSymlinks?1:0,value.capture?1:0,value.revision,value.lastScanAt,value.lastError,value.count);
    return value;
  });await audit("assets.source_updated",item.id,{enabled:item.enabled,capture:item.capture,followSymlinks:item.followSymlinks});return item;
}
async function asset(id:string){const value=await db.getRepository(AssetSchema).findOneBy({id,kind:"skill"});if(!value)throw new ApiError(404,"asset_not_found");return value;}
async function authorizedRoot(path:string){
  const roots=await db.getRepository(AssetRootSchema).findBy({enabled:true});
  for(const root of roots){const canonical=await realpath(root.path).catch(()=>null);if(canonical&&within(canonical,path))return root;}
  throw new ApiError(403,"asset_source_disabled");
}
export async function snapshotAsset(id:string,context?:WorkContext){
  const item=await asset(id),path=await realpath(item.path);await authorizedRoot(path);
  const pkg=await readPackage(dirname(path),context);if(!pkg.files.some(f=>f.path==="SKILL.md"))throw new ApiError(409,"skill_entry_missing");
  const old=await db.getRepository(SnapshotSchema).findOneBy({assetId:id,hash:pkg.hash});
  if(old){const{contentCipher,...publicValue}=old;return publicValue;}
  await context?.check();const value={...record(),assetId:id,hash:pkg.hash,bytes:pkg.bytes,files:pkg.files.map(({content,...file})=>file),contentCipher:encrypt(JSON.stringify(pkg)),version:item.version};
  await db.getRepository(SnapshotSchema).save(value);await audit("assets.snapshot_created",id,{snapshotId:value.id,hash:pkg.hash});
  const{contentCipher,...publicValue}=value;return publicValue;
}
export async function inspectAsset(id:string,context?:WorkContext){
  const item=await asset(id);const path=await realpath(item.path);await authorizedRoot(path);
  await context?.check();const size=(await lstat(path)).size;if(size>1024*1024)throw new ApiError(413,"skill_entry_too_large");
  const content=await Bun.file(path).slice(0,1024*1024+1).text();if(Buffer.byteLength(content)>1024*1024)throw new ApiError(413,"skill_entry_too_large");const metadata=skillMetadata(content);
  const snapshots=await db.query('SELECT id,createdAt,updatedAt,assetId,hash,bytes,files,version FROM asset_snapshots WHERE assetId=? ORDER BY createdAt DESC',[id]);
  const peers=await db.getRepository(AssetSchema).createQueryBuilder("a").where("a.kind='skill' AND a.id!=:id AND (a.name=:name OR a.hash=:hash)",{id,name:item.name,hash:item.hash}).getMany();
  return {asset:item,content,metadata,snapshots:snapshots.map((s:any)=>({...s,files:JSON.parse(s.files)})),duplicates:peers.filter(p=>p.hash===item.hash),conflicts:peers.filter(p=>p.name===item.name&&p.hash!==item.hash)};
}
export async function snapshotDetail(id:string){const value=await db.getRepository(SnapshotSchema).findOneBy({id});if(!value)throw new ApiError(404,"snapshot_not_found");const pkg=JSON.parse(decrypt(value.contentCipher)) as SkillPackage;const entry=pkg.files.find(f=>f.path==="SKILL.md");return {id:value.id,hash:value.hash,createdAt:value.createdAt,version:value.version,files:value.files,content:entry?Buffer.from(entry.content,"base64").toString("utf8"):""};}
export async function scanAssets(rootId?:string,context?:WorkContext){
  const roots=await assetRoots();const allowed: {id:string;path:string}[]=[];
  for(const root of roots.filter(r=>r.enabled)){const canonical=await realpath(root.path).catch(()=>null);if(canonical)allowed.push({id:root.id,path:canonical});}
  let skills=0,errors=0,skippedLinks=0,limited=false;
  for(const root of roots.filter(r=>r.enabled&&(!rootId||r.id===rootId))){
    const canonical=await realpath(root.path).catch(()=>null);
    if(!canonical){await db.getRepository(AssetRootSchema).update(root.id,{lastScanAt:Date.now(),lastError:"source_missing",count:0});continue;}
    const queue=[canonical],visited=new Set<string>(),seen=new Set<string>();let failed=0,rootLimited=false;
    while(queue.length){
      await context?.check();
      const fresh=await db.getRepository(AssetRootSchema).findOneBy({id:root.id});if(!fresh?.enabled||fresh.revision!==root.revision)throw new ApiError(409,"source_changed");
      const directory=queue.shift()!;if(visited.has(directory))continue;visited.add(directory);
      if(visited.size>15000||seen.size>=2000){rootLimited=true;break;}
      await context?.progress("discover",seen.size,null,basename(directory));
      const entries=await readdir(directory,{withFileTypes:true}).catch(()=>{failed++;return [];});
      for(const entry of entries){
        if(["node_modules",".git",".DS_Store"].includes(entry.name)||entry.name.startsWith(".pgw-"))continue;
        let path=join(directory,entry.name);
        if(entry.isSymbolicLink()){
          if(!root.followSymlinks){skippedLinks++;continue;}
          const target=await realpath(path).catch(()=>null);if(!target||!allowed.some(a=>within(a.path,target))){skippedLinks++;continue;}
          const info=await lstat(target);if(info.isDirectory())queue.push(target);else if(info.isFile()&&entry.name==="SKILL.md")path=target;else continue;
        }else if(entry.isDirectory()){queue.push(path);continue;}
        else if(!entry.isFile())continue;
        if(basename(path)!=="SKILL.md")continue;
        try{
          const canonicalFile=await realpath(path);if(seen.has(canonicalFile))continue;seen.add(canonicalFile);
          if((await lstat(canonicalFile)).size>1024*1024)throw new ApiError(413,"skill_entry_too_large");
          const content=await Bun.file(canonicalFile).slice(0,1024*1024+1).text();if(Buffer.byteLength(content)>1024*1024)throw new ApiError(413,"skill_entry_too_large");const metadata=skillMetadata(content);
          let packageVersion:string|null=null;
          for(const parent of [dirname(canonicalFile),dirname(dirname(canonicalFile)),dirname(dirname(dirname(canonicalFile)))]){
            if(!allowed.some(a=>within(a.path,parent)))break;
            const manifest=join(parent,"package.json");const info=await lstat(manifest).catch(()=>null);
            if(info?.isFile()&&!info.isSymbolicLink()&&info.size<128000){try{const parsed=JSON.parse(await Bun.file(manifest).slice(0,128001).text());if(typeof parsed.version==="string")packageVersion=parsed.version.slice(0,100);}catch{}if(packageVersion)break;}
          }
          const repository=db.getRepository(AssetSchema),previous=await repository.findOneBy({path:canonicalFile});
          const origins=Array.isArray(previous?.metadata.origins)?previous.metadata.origins as {rootId:string;path:string}[]:[];
          const item=await repository.save({...record(),...previous,kind:"skill",name:metadata.name||basename(dirname(path)),source:root.agent,path:canonicalFile,version:metadata.version||packageVersion,hash:hash(content),description:metadata.description,status:"available",metadata:{...previous?.metadata,rootId:root.id,project:root.project,versionSource:metadata.version?"frontmatter":packageVersion?"package":"content_hash",allowedTools:metadata.tools,warnings:metadata.warnings,origins:[...origins.filter(o=>o.rootId!==root.id),{rootId:root.id,path}]},updatedAt:Date.now()});
          skills++;if(root.capture)await snapshotAsset(item.id,context);
        }catch{failed++;}
      }
    }
    if(!failed&&!rootLimited){const existing=await db.getRepository(AssetSchema).findBy({kind:"skill"});for(const item of existing)if(item.metadata.rootId===root.id&&!seen.has(item.path)&&!await Bun.file(item.path).exists())await db.getRepository(AssetSchema).update(item.id,{status:"unavailable",updatedAt:Date.now()});}
    errors+=failed;limited||=rootLimited;
    await db.getRepository(AssetRootSchema).update({id:root.id,revision:root.revision},{lastScanAt:Date.now(),count:seen.size,lastError:failed?`${failed} unreadable`:rootLimited?"scan_limit":null,updatedAt:Date.now()});
  }
  return {skills,errors,skippedLinks,limited};
}
function publicDeployment(value:AssetDeployment){const{beforeCipher,afterCipher,...rest}=value;return rest;}
export async function listDeployments(){return db.query('SELECT id,createdAt,updatedAt,assetId,snapshotId,target,targetRoot,agent,status,beforeHash,afterHash,error,diff FROM asset_deployments ORDER BY createdAt DESC LIMIT 100').then(rows=>rows.map((row:any)=>({...row,diff:JSON.parse(row.diff)})));}
async function targetPackage(path:string,context?:WorkContext){const info=await lstat(path).catch((error:NodeJS.ErrnoException)=>{if(error.code==="ENOENT")return null;throw error;});if(!info)return null;if(info.isSymbolicLink()||!info.isDirectory())throw new ApiError(409,"target_not_directory");return readPackage(path,context);}
export async function previewDeployment(input:{assetId:string;snapshotId:string;targetRoot:string;name:string;agent:string},context?:WorkContext){
  const snap=await db.getRepository(SnapshotSchema).findOneBy({id:input.snapshotId,assetId:input.assetId});if(!snap)throw new ApiError(404,"snapshot_not_found");
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(input.name)||[".",".."].includes(input.name))throw new ApiError(400,"invalid_skill_directory");
  if(!isAbsolute(input.targetRoot))throw new ApiError(400,"absolute_path_required");
  const root=await realpath(input.targetRoot).catch(()=>{throw new ApiError(400,"target_root_missing");});
  if(!(await lstat(root)).isDirectory()||root===homedir()||root==="/")throw new ApiError(400,"target_root_invalid");
  const target=join(root,input.name),before=await targetPackage(target,context),after=JSON.parse(decrypt(snap.contentCipher)) as SkillPackage;
  if(!after.files.some(f=>f.path==="SKILL.md"))throw new ApiError(409,"skill_entry_missing");
  if(before?.files.length&&!before.files.some(file=>file.path==="SKILL.md"))throw new ApiError(409,"target_not_skill");
  const changes:AssetDeployment["diff"]=[];
  const beforeMap=new Map(before?.files.map(f=>[f.path,f])||[]);
  for(const file of after.files){const old=beforeMap.get(file.path);if(!old)changes.push({path:file.path,action:"add"});else if(old.hash!==file.hash||old.executable!==file.executable||old.mode!==file.mode)changes.push({path:file.path,action:"change"});beforeMap.delete(file.path);}
  for(const path of beforeMap.keys())changes.push({path,action:"remove"});
  const beforeDirs=new Map(before?.directories?.map(d=>[d.path,d.mode])||[]);
  for(const directory of after.directories||[]){const mode=beforeDirs.get(directory.path);if(mode===undefined)changes.push({path:`${directory.path}/`,action:"add"});else if(mode!==directory.mode)changes.push({path:`${directory.path}/`,action:"change"});beforeDirs.delete(directory.path);}
  for(const path of beforeDirs.keys())changes.push({path:`${path}/`,action:"remove"});
  const item=await db.getRepository(DeploymentSchema).save({...record(),assetId:input.assetId,snapshotId:input.snapshotId,target,targetRoot:root,agent:input.agent,status:"prepared",beforeHash:before?.hash||null,afterHash:after.hash,beforeCipher:before?encrypt(JSON.stringify(before)):null,afterCipher:encrypt(JSON.stringify(after)),stagePath:null,error:null,diff:changes});
  await audit("assets.install_prepared",item.id,{target,files:changes.length});return publicDeployment(item);
}
export async function applyDeployment(id:string,restore:boolean,context?:WorkContext){
  let item=await db.getRepository(DeploymentSchema).findOneBy({id});if(!item)throw new ApiError(404,"deployment_not_found");
  const required=restore?"applied":"prepared";
  if(item.status!==required)throw new ApiError(409,"deployment_state_changed");
  const expected=restore?item.afterHash:item.beforeHash;
  const candidateCipher=restore?item.beforeCipher:item.afterCipher;
  const candidate=candidateCipher?JSON.parse(decrypt(candidateCipher)) as SkillPackage:null;
  if(await realpath(item.targetRoot)!==item.targetRoot||!within(item.targetRoot,item.target))throw new ApiError(403,"target_root_changed");
  const existing=await targetPackage(item.target,context);if((existing?.hash||null)!==expected)throw new ApiError(409,"target_changed");
  await context?.check();
  await atomic(database=>{
    const row=database.query('SELECT status FROM asset_deployments WHERE id=?').get(id) as {status:string}|null;
    if(row?.status!==required)throw new ApiError(409,"deployment_state_changed");
    if(database.query("SELECT id FROM asset_deployments WHERE target=? AND id!=? AND status IN ('applying','restoring','uncertain')").get(item!.target,id))throw new ApiError(409,"target_busy");
    database.query('UPDATE asset_deployments SET status=?,error=NULL,updatedAt=? WHERE id=?').run(restore?"restoring":"applying",Date.now(),id);
  });
  if(expected===(candidate?.hash||null)){
    await db.getRepository(DeploymentSchema).update(id,{status:restore?"restored":"applied",updatedAt:Date.now()});
    return publicDeployment(await db.getRepository(DeploymentSchema).findOneByOrFail({id}));
  }
  const stage=await mkdtemp(join(dirname(item.targetRoot),".pgw-stage-")).catch(async error=>{await db.getRepository(DeploymentSchema).update(id,{status:required,error:"staging_failed",updatedAt:Date.now()});throw error;});
  const next=join(stage,"next"),backup=join(stage,"previous");let moved=false,installed=false,committed=false;
  try{
    await db.getRepository(DeploymentSchema).update(id,{stagePath:stage});
    if(candidate)await writePackage(next,candidate,context);
    await context?.check();
    if(await realpath(item.targetRoot)!==item.targetRoot)throw new ApiError(403,"target_root_changed");
    const current=await targetPackage(item.target,context);if((current?.hash||null)!==expected)throw new ApiError(409,"target_changed");
    if(current){await rename(item.target,backup);moved=true;const actual=await readPackage(backup);if(actual.hash!==expected)throw new ApiError(409,"target_changed");}
    if(await lstat(item.target).catch(()=>null))throw new ApiError(409,"target_changed");
    if(candidate){await rename(next,item.target);installed=true;}
    const state=restore?"restored":"applied";
    await db.getRepository(DeploymentSchema).update(id,{status:state,error:null,updatedAt:Date.now()});committed=true;
    await audit(restore?"assets.install_restored":"assets.install_applied",id,{target:item.target});
    await rm(stage,{recursive:true,force:true});
    await db.getRepository(DeploymentSchema).update(id,{stagePath:null});
    item=await db.getRepository(DeploymentSchema).findOneByOrFail({id});return publicDeployment(item);
  }catch(error){
    let rollbackFailed=false;
    if(!committed){
      try{
        if(installed){const actual=await readPackage(item.target);if(actual.hash!==candidate?.hash)throw new Error("installed_target_modified");await rename(item.target,next);}
        if(moved){if(await lstat(item.target).catch(()=>null))throw new Error("target_occupied");await rename(backup,item.target);}
      }catch{rollbackFailed=true;}
      await db.getRepository(DeploymentSchema).update(id,{status:rollbackFailed?"uncertain":required,error:error instanceof ApiError?error.code:"deployment_failed",stagePath:rollbackFailed?stage:null,updatedAt:Date.now()});
      if(!rollbackFailed)await rm(stage,{recursive:true,force:true});
    }
    throw error;
  }
}

export async function searchSkills(input:{query?:string;offset?:number;limit?:number;rootId?:string;duplicates?:boolean}){
  const query=db.getRepository(AssetSchema).createQueryBuilder("a").where("a.kind='skill'");
  if(input.query)query.andWhere("instr(lower(a.name||' '||coalesce(a.description,'')||' '||a.source),lower(:q))>0",{q:input.query});
  if(input.rootId)query.andWhere("json_extract(a.metadata,'$.rootId')=:root",{root:input.rootId});
  if(input.duplicates)query.andWhere("a.hash IN(SELECT hash FROM assets WHERE kind='skill' GROUP BY hash HAVING count(*)>1)");
  const offset=input.offset||0,limit=input.limit||40;
  const [items,total]=await query.orderBy('a.name','ASC').skip(offset).take(limit).getManyAndCount();
  const counts=await db.query("SELECT hash,count(*) count FROM assets WHERE kind='skill' GROUP BY hash HAVING count(*)>1");
  return {items:items.map(item=>({...item,duplicateCount:counts.find((c:any)=>c.hash===item.hash)?.count||1})),total,next:offset+items.length<total?offset+items.length:null};
}
