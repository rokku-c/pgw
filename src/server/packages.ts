import { readdir,realpath,open,lstat,mkdir,chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { join,relative,isAbsolute,basename,sep } from "node:path";
import { createHash } from "node:crypto";
import { ApiError } from "./security";
import type { SkillPackage,PackageFile } from "../shared/types";
import type { WorkContext } from "./job-context";

export function within(root:string,path:string){const value=relative(root,path);return !isAbsolute(value)&&value!==".."&&!value.startsWith("../")&&!value.startsWith("..\\");}
export function safePackagePath(path:string){if(!path||path.includes("\0")||path.includes("\\")||isAbsolute(path)||/^[A-Za-z]:/.test(path)||path.split("/").some(p=>!p||p==="."||p===".."))throw new ApiError(400,"unsafe_package_path");return path;}
export function packageHash(files:Pick<PackageFile,"path"|"hash"|"size"|"executable"|"mode">[],directories?:{path:string;mode:number}[]){
  const entries=[...files].sort((a,b)=>a.path.localeCompare(b.path)).map(({path,hash,size,executable,mode})=>({path,hash,size,executable,...(mode===undefined?{}:{mode})}));
  return createHash("sha256").update(JSON.stringify(directories?{files:entries,directories:[...directories].sort((a,b)=>a.path.localeCompare(b.path))}:entries)).digest("hex");
}
export async function readPackage(root:string,context?:WorkContext):Promise<SkillPackage>{
  const canonical=await realpath(root);const queue=[canonical],files:PackageFile[]=[],directories:{path:string;mode:number}[]=[];let bytes=0;
  while(queue.length){
    await context?.check();const directory=queue.shift()!;
    directories.push({path:relative(canonical,directory).split(sep).join("/")||".",mode:(await lstat(directory)).mode&0o777});
    if(directories.length>1000)throw new ApiError(413,"package_directory_limit");
    const entries=await readdir(directory,{withFileTypes:true});
    for(const entry of entries){
      const path=join(directory,entry.name),rel=safePackagePath(relative(canonical,path).split(sep).join("/"));
      if(entry.isSymbolicLink())throw new ApiError(409,"package_symlink_requires_review");
      if(entry.isDirectory()){queue.push(path);if(queue.length>1000)throw new ApiError(413,"package_directory_limit");continue;}
      if(!entry.isFile())throw new ApiError(409,"unsupported_package_file");
      const resolved=await realpath(path);if(!within(canonical,resolved))throw new ApiError(403,"package_path_escape");
      const handle=await open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{
        const before=await handle.stat();if(before.nlink>1)throw new ApiError(409,"package_hardlink_requires_review");if(!before.isFile()||before.size>4*1024*1024||bytes+before.size>8*1024*1024||files.length>=500)throw new ApiError(413,"package_size_limit");
        const buffer=Buffer.alloc(Number(before.size)+1);let length=0;while(length<buffer.length){const result=await handle.read(buffer,length,buffer.length-length,length);if(!result.bytesRead)break;length+=result.bytesRead;}const content=buffer.subarray(0,length);const after=await handle.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||content.length!==before.size)throw new ApiError(409,"package_changed_during_read");
        bytes+=content.length;files.push({path:rel,hash:createHash("sha256").update(content).digest("hex"),size:content.length,executable:!!(before.mode&0o111),mode:before.mode&0o777,content:content.toString("base64")});
      }finally{await handle.close();}
      await context?.progress("snapshot",files.length,null,rel);
    }
  }
  files.sort((a,b)=>a.path.localeCompare(b.path));return {files,bytes,directories,hash:packageHash(files,directories)};
}
export async function writePackage(root:string,pkg:SkillPackage,context?:WorkContext){
  if(packageHash(pkg.files,pkg.directories)!==pkg.hash)throw new ApiError(409,"snapshot_integrity_error");
  await mkdir(root,{recursive:false,mode:0o700});
  for(const directory of pkg.directories||[]){if(directory.path!==".")await mkdir(join(root,safePackagePath(directory.path)),{recursive:true,mode:0o700});}
  let count=0;
  for(const file of pkg.files){
    await context?.check();const path=join(root,safePackagePath(file.path));const content=Buffer.from(file.content,"base64");
    if(content.length!==file.size||createHash("sha256").update(content).digest("hex")!==file.hash)throw new ApiError(409,"snapshot_integrity_error");
    const parent=path.slice(0,path.length-basename(path).length);await mkdir(parent,{recursive:true,mode:0o700});
    const handle=await open(path,"wx",file.executable?0o700:0o600);try{await handle.writeFile(content);await handle.sync();}finally{await handle.close();}
    await chmod(path,file.mode===undefined?(file.executable?0o700:0o600):file.mode&0o777);
    await context?.progress("write",++count,pkg.files.length,file.path);
  }
  for(const directory of [...(pkg.directories||[])].sort((a,b)=>b.path.length-a.path.length))await chmod(directory.path==="."?root:join(root,safePackagePath(directory.path)),directory.mode&0o777);
}
export function skillMetadata(content:string){
  const front=content.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
  let metadata:Record<string,unknown>={};const warnings:string[]=[];
  if(front){try{const parsed=Bun.YAML.parse(front[1]);if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))metadata=parsed as Record<string,unknown>;else warnings.push("invalid_frontmatter");}catch{warnings.push("invalid_frontmatter");}}
  else warnings.push("missing_frontmatter");
  const name=typeof metadata.name==="string"?metadata.name.trim():null;
  const description=typeof metadata.description==="string"?metadata.description.trim():null;
  if(!name)warnings.push("missing_name");if(!description)warnings.push("missing_description");
  const nested=metadata.metadata&&typeof metadata.metadata==="object"?metadata.metadata as Record<string,unknown>:{};
  const version=typeof metadata.version==="string"?metadata.version:typeof nested.version==="string"?nested.version:null;
  const allowed=metadata["allowed-tools"];
  const tools=typeof allowed==="string"?allowed.split(/[,\s]+/).filter(Boolean):Array.isArray(allowed)?allowed.filter(v=>typeof v==="string"):[];
  return {name:name?.slice(0,200)||null,description:description?.slice(0,5000)||null,version:version?.slice(0,100)||null,tools:tools.slice(0,100),warnings};
}
