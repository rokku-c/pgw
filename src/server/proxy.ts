import { z } from "zod";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { callContext, recordCallContext } from "./trajectory-context";
import { db, ClientSchema, RouteSchema, ProviderSchema, TrafficSchema, PreferenceSchema, record, setting, audit } from "./store";
import { ApiError, bearer, decrypt, hash, readJson, requestBodyBytes, requestBodySize } from "./security";
import { endpoint, upstreamHeaders } from "./providers";
import { boundOutput, reserveBudget, settleBudget } from "./budget";
import { emptyUsage, mergeUsage, usageCost, type Usage } from "./usage";
import { convertRequest, convertResponse, isReasoningDrop } from "./protocols";
import { StreamConversion } from "./stream-conversion";
import { EventStreamParser, type ServerEvent } from "./event-stream";
import { balancedTargets, beginRouteSession, frozenPreferences, pinRoute, recordResponse, releaseRouteSession, unpinRejectedRoute, responseBinding, providerFingerprint, circuitPermit, circuitResult, retryAfter, type FrozenPreference, type RouteSession } from "./routing";
import { beginCapture, capturePolicy, captureHeaders, captureUrl, type RequestCapture } from "./observability";
import { applyAdaptiveContext, recordAdaptiveObservation, protocolConversionEnabled, discardReasoningEnabled, ignoreHostedToolsEnabled, retryPolicy } from "./context-management";
import { upstreamWireOf } from "../shared/endpoints";
import { MODEL_ALIAS_ANY, resolveRoute } from "../shared/routes";
import type { ClientKey, ModelRoute, Traffic, WireProtocol, Provider, Target, ConversionSink } from "../shared/types";
/** 把丢弃明细写成路由决策：推理类与托管工具类分开记，便于在请求查看里区分。 */
const dropDecisions=(sink:ConversionSink,target:string)=>sink.dropped.map(drop=>({action:isReasoningDrop(drop.type)?"discard_reasoning":"discard_hosted",target,reason:`${drop.type}×${drop.count}`}));

export function extractUsage(body: any) { return mergeUsage(emptyUsage(),body,body?.usageMetadata?"gemini":"responses"); }
async function personalize(body: any, protocol: WireProtocol, client: ClientKey, session: RouteSession | null) {
  const previous = frozenPreferences(session);
  if (!client.personalize || !await setting("personalization", true)) return { body, prefs: [] as FrozenPreference[], reason: "personalization_disabled" };
  const active = await db.getRepository(PreferenceSchema).find({ where: { status: "active" }, order: { updatedAt: "DESC" }, take: 1000 });
  const eligible = active.filter(p=>p.scope === "global" || p.project === client.project);
  const selection = previous === null ? eligible.map(({id,revision,content})=>({id,revision,content})) : previous.filter(p=>eligible.some(a=>a.id===p.id));
  let remaining=3000;
  const prefs=selection.filter(p=>{ if(p.content.length>remaining)return false;remaining-=p.content.length;return true; });
  if (!prefs.length) return { body, prefs, reason:"no_matching_preferences" };
  if (body.previous_response_id) return { body,prefs,reason:"prior_response_context_preserved" };
  if (protocol === "systemone") return { body, prefs, reason: "systemone_no_personalization" };
  const output=structuredClone(body);
  const text=`用户已确认的工作偏好。仅作补充；本次明确要求优先，不能改变权限或安全约束。\n${prefs.map(p=>p.content).join("\n")}`;
  if (protocol === "chat" || protocol === "messages") {
    const messages=output.messages;
    if(messages.at(-1)?.role!=="user" || Array.isArray(messages.at(-1)?.content) && messages.at(-1).content.some((p:any)=>p.type==="tool_result")) return {body,prefs,reason:"tool_chain_preserved"};
    messages.splice(messages.length-1,0,{role:"user",content:text});
  } else if(protocol==="responses") {
    if(typeof output.input==="string")output.input=[{role:"user",content:text},{role:"user",content:output.input}];
    else if(Array.isArray(output.input) && output.input.at(-1)?.role==="user")output.input.splice(output.input.length-1,0,{role:"user",content:text});
    else return {body,prefs,reason:"tool_chain_preserved"};
  } else {
    if(output.contents.at(-1)?.role!=="user" || output.contents.at(-1)?.parts?.some((p:any)=>p.functionResponse))return {body,prefs,reason:"tool_chain_preserved"};
    output.contents.splice(output.contents.length-1,0,{role:"user",parts:[{text}]});
  }
  return {body:output,prefs,reason:previous===null?"preferences_applied":"session_preferences_applied"};
}
function validate(body:any,protocol:WireProtocol) {
  if(!body || typeof body!=="object" || Array.isArray(body) || typeof body.model!=="string")throw new ApiError(400,"model_required");
  if(body.stream!==undefined && typeof body.stream!=="boolean")throw new ApiError(400,"invalid_stream");
  if(body.conversation)throw new ApiError(409,"conversation_binding_required");
  if(protocol === "systemone") {
    if(body.stream === true) throw new ApiError(400,"systemone_stream_unsupported");
    if(!body.questions || typeof body.questions !== "object" || Array.isArray(body.questions) || !Object.keys(body.questions).length) throw new ApiError(400,"questions_required");
    return;
  }
  if(protocol==="messages" || protocol==="chat") z.object({messages:z.array(z.object({role:z.string().min(1),content:z.union([z.string(),z.array(z.record(z.string(),z.unknown())),z.null()]).optional()}).passthrough()).min(1).max(10000)}).passthrough().parse(body);
  else if(protocol==="responses") {
    z.object({input:z.union([z.string(),z.array(z.record(z.string(),z.unknown()))]).optional(),previous_response_id:z.string().min(1).max(300).optional(),background:z.boolean().optional()}).passthrough().parse(body);
    if(body.background)throw new ApiError(400,"background_mode_requires_async_adapter");
  } else z.object({contents:z.array(z.object({role:z.string().optional(),parts:z.array(z.record(z.string(),z.unknown()))}).passthrough()).min(1).max(10000)}).passthrough().parse(body);
}
async function responseOperation(request:Request,client:ClientKey,id:string) {
  if(!["GET","DELETE"].includes(request.method))throw new ApiError(405,"method_not_supported");
  const {provider,binding}=await responseBinding(client,id);
  const result=await fetch(endpoint(provider,`/responses/${encodeURIComponent(id)}`),{method:request.method,headers:upstreamHeaders(provider),redirect:"error",signal:AbortSignal.any([request.signal,AbortSignal.timeout(15000)])});
  const text=await result.text();
  if(request.method==="DELETE" && result.ok)await db.query('DELETE FROM response_bindings WHERE ownerKey=? AND responseId=?',[client.runId?`run:${client.runId}`:`client:${client.id}`,id]);
  await audit(request.method==="GET"?"response.retrieved":"response.deleted",binding.affinityId,{status:result.status});
  return new Response(text,{status:result.status,headers:{"content-type":"application/json"}});
}
export async function proxy(request:Request):Promise<Response> {
  const key=bearer(request)||request.headers.get("x-goog-api-key")||"";
  const client=key?await db.getRepository(ClientSchema).findOneBy({keyHash:hash(key),enabled:true}):null;
  if(!client || client.expiresAt!==null && client.expiresAt<=Date.now())throw new ApiError(401,"invalid_api_key");
  const url=new URL(request.url);
  let path=url.pathname;
  const prefix=path.match(/^\/providers\/(openai|anthropic|google|gemini|typesafe)(\/.*)$/);
  if(prefix){
    path=prefix[2];
    if(prefix[1]==="openai" && !["/v1/models","/v1/responses","/v1/chat/completions"].includes(path) && !path.startsWith("/v1/responses/"))throw new ApiError(404,"protocol_endpoint_mismatch");
    if(prefix[1]==="anthropic" && path!=="/v1/messages")throw new ApiError(404,"protocol_endpoint_mismatch");
    if(["google","gemini"].includes(prefix[1]) && !path.startsWith("/v1beta/models/"))throw new ApiError(404,"protocol_endpoint_mismatch");
    if(prefix[1]==="typesafe" && path!=="/v1/systemone")throw new ApiError(404,"protocol_endpoint_mismatch");
  }
  const operation=path.match(/^\/v1\/responses\/([A-Za-z0-9_-]{1,300})$/);
  if(operation)return responseOperation(request,client,operation[1]);
  const allowed=(await db.getRepository(RouteSchema).findBy({enabled:true})).filter(r=>!client.routeIds.length || client.routeIds.includes(r.id));
  if(path==="/v1/models" && request.method==="GET"){
    // 客户端的模型别名也算可用模型名；无别名时输出与原先完全一致。
    const aliased=(client.modelAliases||[]).filter(a=>a.name!==MODEL_ALIAS_ANY&&allowed.some(r=>r.id===a.routeId)).map(a=>a.name);
    const names=[...new Set([...allowed.map(r=>r.alias),...aliased])];
    return Response.json({object:"list",data:names.map(id=>({id,object:"model",owned_by:"personal-gateway"}))});
  }
  const gemini=path.match(/^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/);
  const protocol:WireProtocol|undefined=gemini?"gemini":({"/v1/responses":"responses","/v1/chat/completions":"chat","/v1/messages":"messages","/v1/systemone":"systemone"} as Record<string,WireProtocol>)[path];
  if(!protocol || request.method!=="POST")throw new ApiError(404,"endpoint_not_found");
  const captureConfig=await capturePolicy();
  const conversionEnabled=await protocolConversionEnabled();
  // 两个降级开关只在真正需要转换时读取，避免同协议透传路径多一次设置查询。
  const discardReasoning=conversionEnabled&&await discardReasoningEnabled();
  const ignoreHostedTools=conversionEnabled&&await ignoreHostedToolsEnabled();
  const retryConfig=await retryPolicy();
  const original=await readJson(request,16*1024*1024,captureConfig.enabled);
  if(gemini && original && typeof original==="object" && !Array.isArray(original)){ original.model=decodeURIComponent(gemini[1]);original.stream=gemini[2]==="streamGenerateContent"; }
  validate(original,protocol);
  const route=resolveRoute(allowed,original.model,client.modelAliases);
  if(!route)throw new ApiError(404,"model_not_available");
  if(!route.targets.length)throw new ApiError(503,"route_unavailable");
  const group=crypto.randomUUID();
  const sessionKey=request.headers.get("x-pgw-session");
  const session=await beginRouteSession(client,{...route,protocol},sessionKey,original.previous_response_id,group);
  let detached=false,uncertain=false;
  const decisions:Traffic["decisions"]=[];
  try {
    const context=await callContext(request,client,group,session?.id||null);
    const {body,prefs,reason}=await personalize(structuredClone(original),protocol,client,session);
    decisions.push({action:"personalization",reason});
    const outputTokens=boundOutput(body,{...route,protocol});
    await db.getRepository(ClientSchema).update(client.id,{lastUsedAt:Date.now()});
    let lastError:ApiError|undefined;
    if(session?.providerId && !route.targets.some(t=>t.providerId===session.providerId && t.model===session.model))throw new ApiError(409,"pinned_target_removed");
    const targets=session?.providerId?route.targets.filter(t=>t.providerId===session.providerId && t.model===session.model):await balancedTargets(route);
    const attemptLimit=Math.max(1,targets.length+(retryConfig.enabled?retryConfig.maxRetries:0));
    for(let targetIndex=0;targetIndex<attemptLimit;targetIndex++) {
      const target=targets[targetIndex%targets.length];
      const provider=await db.getRepository(ProviderSchema).findOneBy({id:target.providerId,enabled:true});
      if(!provider){ decisions.push({action:"skip",target:target.providerId,reason:"provider_disabled"});continue; }
      const upstreamWire:WireProtocol=upstreamWireOf(protocol,target.protocol,provider.protocol);
      const converted=upstreamWire!==protocol;
      if(converted&&!conversionEnabled){lastError=new ApiError(409,"protocol_conversion_disabled");decisions.push({action:"skip",target:provider.id,reason:"protocol_conversion_disabled"});continue;}
      const managed=await applyAdaptiveContext(body,protocol,route,provider,target.model);
      if(managed.compressed)decisions.push({action:"context_compress",target:provider.id,reason:`${managed.removed}:${managed.limit}`});
      const effectiveBody=managed.body;
      // 一次尝试一个 sink：请求方向的丢弃随 traffic 创建落库，随后清空，留给 finish() 记录响应方向的丢弃。
      const sink:ConversionSink={reasoning:discardReasoning,hosted:ignoreHostedTools,dropped:[]};
      let upstreamPayload:any;
      try{upstreamPayload=converted?convertRequest(effectiveBody,protocol,upstreamWire,target.model,sink):{...effectiveBody,model:target.model};}
      catch(error){if(error instanceof ApiError){lastError=error;decisions.push({action:"skip",target:provider.id,reason:error.code});continue;}throw error;}
      if(converted)decisions.push({action:"convert",target:provider.id,reason:`${protocol}→${upstreamWire}:${body.stream?"stream":"json"}`});
      if(sink.dropped.length){decisions.push(...dropDecisions(sink,provider.id));sink.dropped.length=0;}
      if(session?.providerFingerprint && session.providerFingerprint!==providerFingerprint(provider))throw new ApiError(409,"pinned_provider_changed");
      const circuit=await circuitPermit(provider,target.model);
      decisions.push({action:circuit.allowed?"select":"skip",target:provider.id,reason:session?.providerId?`session_pinned:${circuit.reason}`:circuit.reason});
      if(!circuit.allowed){ lastError=new ApiError(503,"circuit_open");continue; }
      const started=Date.now();
      const traffic:Traffic={...record(),clientId:client.id,clientName:client.name,routeId:route.id,model:route.alias,providerId:provider.id,providerName:provider.name,protocol,status:"running",upstreamStatus:null,latencyMs:null,firstByteMs:null,firstTokenMs:null,decodingMs:null,...emptyUsage(),costMicros:null,error:null,stream:!!body.stream,project:client.project,patchIds:prefs.map(p=>`${p.id}:${p.revision}`),runId:client.runId,accounting:"pending",pricing:{input:route.inputPrice,output:route.outputPrice,cacheRead:route.cacheReadPrice,cacheWrite:route.cacheWritePrice,cacheWriteLong:route.cacheWriteLongPrice},requestGroupId:group,affinityId:session?.id||null,responseId:null,decisions:[...decisions],bytesTotal:0,progressAt:null};
      let capture:RequestCapture = { json(){}, chunk(){}, metadata(){}, secret(){}, finish(){} };
      try{ await reserveBudget(traffic.id,client,route,outputTokens,{key:`${route.id}:${target.providerId}:${target.model}`,maxConcurrent:target.maxConcurrent}); await db.getRepository(TrafficSchema).save(traffic);
        await recordCallContext(traffic,context);
        capture=beginCapture(captureConfig,traffic.id,group,{method:request.method,requestUrl:captureUrl(request.url),requestHeaders:captureHeaders(request.headers),protocol,model:route.alias,provider:provider.name,client:client.name,bodyBytes:requestBodySize(request),stream:!!body.stream,upstreamProtocol:upstreamWire,converted,context},[key]);
        const incoming=requestBodyBytes(request);if(incoming)capture.chunk("request",incoming);
      }
      catch(error){ await settleBudget(traffic.id,traffic,true);await circuitResult(circuit.id,false,null);if(error instanceof ApiError&&error.code==="target_concurrency_limit"){decisions.push({action:"skip",target:provider.id,reason:error.code});continue;}throw error; }
      const controller=new AbortController();
      let idleTimer:ReturnType<typeof setTimeout>,output:ReadableStreamDefaultController<Uint8Array>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
      const touch=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>controller.abort(new Error("upstream_idle_timeout")),60000);};touch();
      const timeout=setTimeout(()=>controller.abort(new Error("upstream_timeout")),300000);
      let submitted=false,rejected=true,terminal=false,responseStatus="unknown",usage=emptyUsage(),failure:string|null=null;
      // 进行中的实时进度：每 500ms 落一次已耗时/已写字节/当前 token。
      // 首字节到达前没有任何写入钩子，正是「等待时长看不到」的直接原因，这个定时器覆盖那段。
      let bytesTotal=0;
      const progressTimer=setInterval(()=>{
        void db.getRepository(TrafficSchema).update(traffic.id,{latencyMs:Date.now()-started,firstByteMs:traffic.firstByteMs,firstTokenMs:traffic.firstTokenMs,bytesTotal,inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,progressAt:Date.now()}).catch(()=>{});
      },500);
      let finishPromise:Promise<void>|undefined;
      const cancel=()=>controller.abort(new Error("client_cancelled"));
      request.signal.addEventListener("abort",cancel,{once:true});
      const finish=(status:Traffic["status"],error:string|null=null):Promise<void>=>{
        if(finishPromise)return finishPromise;
        finishPromise=(async()=>{
          clearInterval(progressTimer);clearTimeout(timeout);clearTimeout(idleTimer);request.signal.removeEventListener("abort",cancel);controller.signal.removeEventListener("abort",aborted);
          // 响应方向的丢弃在这里统一落库：finishPromise 保证只跑一次，覆盖正常结束、上游错误、流内异常与客户端取消。
          const flushed=sink.dropped.length>0;
          if(flushed)traffic.decisions.push(...dropDecisions(sink,provider.id));
          const knownRejected=!submitted||rejected;
          Object.assign(traffic,usage);
          if(knownRejected){traffic.inputTokens=0;traffic.outputTokens=0;traffic.costMicros=0;}
          else if(terminal&&status==="completed")traffic.costMicros=usageCost(usage,traffic.pricing);
          traffic.accounting=knownRejected?"rejected":terminal&&status==="completed"&&usage.inputTokens!==null&&usage.outputTokens!==null?"reported":"estimated";
          traffic.decodingMs=terminal&&traffic.firstTokenMs!==null?Math.max(0,Date.now()-started-traffic.firstTokenMs):null;
          uncertain=submitted&&!rejected&&!terminal;
          await settleBudget(traffic.id,terminal&&status==="completed"?traffic:{inputTokens:null,outputTokens:null,costMicros:null},knownRejected);
          if(terminal && protocol==="responses" && upstreamWire==="responses" && traffic.responseId)await recordResponse(session,traffic.responseId,target,provider,responseStatus,group);
          if(knownRejected)await unpinRejectedRoute(session,group);
          await db.getRepository(TrafficSchema).update(traffic.id,{status,error,latencyMs:Date.now()-started,firstByteMs:traffic.firstByteMs,firstTokenMs:traffic.firstTokenMs,decodingMs:traffic.decodingMs,upstreamStatus:traffic.upstreamStatus,inputTokens:traffic.inputTokens,outputTokens:traffic.outputTokens,cacheReadTokens:traffic.cacheReadTokens,cacheWriteTokens:traffic.cacheWriteTokens,cacheWriteLongTokens:traffic.cacheWriteLongTokens,reasoningTokens:traffic.reasoningTokens,costMicros:traffic.costMicros,accounting:traffic.accounting,responseId:traffic.responseId,bytesTotal,progressAt:Date.now(),...(flushed?{decisions:traffic.decisions}:{}),updatedAt:Date.now()});
          capture.finish(status,error);
          const upstreamFailure=error && error!=="client_cancelled" && ![400,401,403,404,413,422].includes(traffic.upstreamStatus||0)?error:null;
          await recordAdaptiveObservation(traffic,provider,target.model,protocol,error);
          await circuitResult(circuit.id,status==="completed",upstreamFailure,traffic.upstreamStatus===429?cooldown:null);
        })();
        return finishPromise;
      };
      let cooldown:number|null=null;
      const aborted=()=>{
        const reason=request.signal.aborted?"client_cancelled":controller.signal.reason?.message||"upstream_interrupted";
        void (async()=>{try{await reader?.cancel();await finish(request.signal.aborted?"cancelled":"failed",reason);if(detached)await releaseRouteSession(session,group,uncertain);output?.error(new Error(reason));}catch(error){console.error("Stream cleanup",error);output?.error(error);}})();
      };
      controller.signal.addEventListener("abort",aborted,{once:true});
      try {
        if(request.signal.aborted)throw new ApiError(499,"client_cancelled");
        await pinRoute(session,target,provider,prefs,group);
        const payload=upstreamPayload;
        capture.json("effective",effectiveBody,requestBodySize(request)+16384);
        if(converted&&upstreamWire!=="gemini")payload.stream=!!effectiveBody.stream;
        let upstreamPath=upstreamWire==="responses"?"/responses":upstreamWire==="chat"?"/chat/completions":upstreamWire==="systemone"?"/systemone":"/messages";
        if(upstreamWire==="gemini"){delete payload.model;delete payload.stream;upstreamPath=`/models/${encodeURIComponent(target.model)}:${effectiveBody.stream?"streamGenerateContent?alt=sse":"generateContent"}`;}
        if(upstreamWire==="chat"&&effectiveBody.stream)payload.stream_options={...payload.stream_options,include_usage:true};
        const headers=upstreamHeaders(provider);
        const beta=request.headers.get("anthropic-beta");if(upstreamWire==="messages"&&beta&&!converted)headers.set("anthropic-beta",beta);
        const reqId=request.headers.get("x-client-request-id");if(reqId&&reqId.length<=200)headers.set("x-client-request-id",reqId);
        capture.json("upstream",{method:"POST",url:captureUrl(endpoint(provider,upstreamPath)),headers:captureHeaders(headers),body:payload},JSON.stringify(payload).length+4096);
        submitted=true;rejected=false;uncertain=true;
        const response=upstreamWire === "systemone"
          ? await (async () => {
              if (!provider.secretCipher) throw new ApiError(502,"provider_api_key_missing");
              const result = await new TypeSafeClient({ apiKey: decrypt(provider.secretCipher), baseURL: provider.baseUrl, defaultModel: target.model, retry: { maxRetries: 0 }, timeout: 300000 }).systemOne(payload, { signal: controller.signal }).withResponse();
              return new Response(JSON.stringify(result.data), { status: result.response.status, headers: { "content-type": "application/json" } });
            })()
          : await fetch(endpoint(provider,upstreamPath),{method:"POST",headers,body:JSON.stringify(payload),redirect:"error",signal:controller.signal});
        touch();traffic.upstreamStatus=response.status;capture.metadata({responseStatus:response.status,responseHeaders:captureHeaders(response.headers)});
        if(!response.ok){
          rejected=[400,401,403,404,413,422,429].includes(response.status);cooldown=retryAfter(response.headers.get("retry-after"));
          if(response.body){const errorReader=response.body.getReader();const errorChunks:Uint8Array[]=[];let errorSize=0;while(errorSize<1024*1024){const next=await errorReader.read();if(next.done)break;errorSize+=next.value.length;errorChunks.push(next.value);if(errorSize>=1024*1024)break;}capture.chunk("response",Buffer.concat(errorChunks));await errorReader.cancel().catch(()=>{});}
          await finish("failed",`upstream_${response.status}`);
          lastError=new ApiError(response.status===429?429:502,`upstream_${response.status}`);
          const retryable=retryConfig.enabled&&retryConfig.statuses.includes(response.status)&&targetIndex<attemptLimit-1&&!session?.providerId;
          if(retryable){decisions.push({action:"retry",target:provider.id,reason:`upstream_${response.status}#${targetIndex+1}`});await Bun.sleep(Math.min(30000,retryConfig.backoffMs*Math.max(1,2**Math.min(targetIndex,8))));continue;}
          if(response.status===429&&!session?.providerId){decisions.push({action:"fallback",target:provider.id,reason:"explicit_rate_limit_rejection"});continue;}
          throw lastError;
        }
        if(!body.stream){
          if(!response.body)throw new ApiError(502,"empty_upstream_response");
          reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
          while(true){const next=await reader.read();if(next.done)break;touch();if(traffic.firstByteMs===null)traffic.firstByteMs=Date.now()-started;size+=next.value.length;bytesTotal=size;if(size>32*1024*1024)throw new ApiError(502,"upstream_response_too_large");chunks.push(next.value);}
          const bytes=Buffer.concat(chunks);capture.chunk("response",bytes);const text=bytes.toString("utf8");let parsed:any;
          try{parsed=JSON.parse(text);}catch{throw new ApiError(502,"invalid_upstream_response");}
          if(parsed.error)throw new ApiError(502,"upstream_error_body");
          usage=mergeUsage(usage,parsed,upstreamWire);traffic.responseId=upstreamWire==="responses"&&typeof parsed.id==="string"?parsed.id:null;
          responseStatus=upstreamWire==="responses"?(parsed.status||"completed"):"completed";
          traffic.firstTokenMs=traffic.firstByteMs;
          terminal=!['queued','in_progress'].includes(responseStatus);
          if(!terminal)throw new ApiError(502,"unexpected_background_response");
          const answer=converted?convertResponse(parsed,upstreamWire,protocol,original.model,sink):parsed;
          capture.chunk("output",converted?new TextEncoder().encode(JSON.stringify(answer)):bytes);
          await finish(responseStatus==="failed"?"failed":"completed",responseStatus==="failed"?"upstream_response_failed":null);
          if(converted)return new Response(JSON.stringify(answer),{status:response.status,headers:{"content-type":"application/json","x-pgw-request-id":group,"x-pgw-attempt-id":traffic.id,"x-pgw-conversion":"json"}});
          return new Response(text,{status:response.status,headers:{"content-type":"application/json","x-pgw-request-id":group,"x-pgw-attempt-id":traffic.id}});
        }
        if(!response.body||!response.headers.get("content-type")?.includes("text/event-stream")){await response.body?.cancel();throw new ApiError(502,"invalid_upstream_stream");}
        reader=response.body.getReader();
        // 透传时客户端收到的就是上游字节，output 与 response 完全相同：只存一份，
        // 读侧按 metadata.outputSource 回退到 response（省掉一份等量重复）。
        if(!converted)capture.metadata({outputSource:"response"});
        let produced=false;
        // 客户端看到的模型名回显它自己请求的名字，而不是背后的路由别名。
        const conversion=converted?new StreamConversion(upstreamWire,protocol,original.model,chunk=>{produced=true;if(traffic.firstTokenMs===null)traffic.firstTokenMs=Date.now()-started;capture.chunk("output",chunk);output?.enqueue(chunk);},sink):null;
        const markToken=()=>{if(traffic.firstTokenMs===null)traffic.firstTokenMs=Date.now()-started;};
        const parse=(event:ServerEvent)=>{
          if(conversion){conversion.accept(event);usage=conversion.usage;terminal=conversion.complete;responseStatus=conversion.status;traffic.responseId=protocol==="responses"?conversion.id:conversion.upstreamId;return;}
          if(event.data==="[DONE]"){if(protocol==="chat")terminal=true;return;}
          if(["ping","keepalive"].includes(event.event) && !event.data.startsWith("{"))return;
          let item:any;try{item=JSON.parse(event.data);}catch{throw new ApiError(502,"invalid_upstream_event");}
          if(item.choices?.some((choice:any)=>choice.delta?.content||choice.delta?.reasoning_content||choice.delta?.tool_calls?.length)||item.candidates?.some((candidate:any)=>candidate.content?.parts?.length)||["content_block_delta","response.output_text.delta","response.reasoning_summary_text.delta","response.reasoning_text.delta","response.function_call_arguments.delta","response.custom_tool_call_input.delta"].includes(item.type))markToken();
          usage=mergeUsage(usage,item,protocol);
          if(protocol==="responses"){
            if(typeof item.response?.id==="string")traffic.responseId=item.response.id;
            if(["response.completed","response.incomplete","response.failed"].includes(item.type)){terminal=true;responseStatus=item.type.slice(9);if(item.type==="response.failed")failure="upstream_response_failed";}
          }else if(protocol==="messages"&&item.type==="message_stop")terminal=true;
          else if(protocol==="gemini"&&item.candidates?.length&&item.candidates.every((c:any)=>c.finishReason))terminal=true;
          if(item.type==="error"||item.error){terminal=true;failure="upstream_stream_error";}
        };
        const parser=new EventStreamParser(parse);
        detached=true;
        const stream=new ReadableStream<Uint8Array>({
          start(controller){output=controller;},
          async pull(controller){
            try{
              produced=false;
              while(!produced){
                const next=await reader!.read();
                if(next.done){
                  const incomplete=parser.finish();if(incomplete)failure="truncated_upstream_event";
                  if(conversion){if(failure)throw new ApiError(502,failure);conversion.finish();usage=conversion.usage;terminal=conversion.complete;responseStatus=conversion.status;}
                  await finish(terminal&&!failure?"completed":"failed",failure||(!terminal?"stream_incomplete":null));await releaseRouteSession(session,group,uncertain);controller.close();return;
                }
                touch();if(traffic.firstByteMs===null)traffic.firstByteMs=Date.now()-started;
                bytesTotal+=next.value.length;
                capture.chunk("response",next.value);
                parser.push(next.value);
                if(!conversion){controller.enqueue(next.value);produced=true;}
              }
            }catch(error){
              const reason=error instanceof ApiError?error.code:controllerSignalReason();
              await reader!.cancel().catch(()=>{});
              if(conversion&&!request.signal.aborted)conversion.fail(reason);
              await finish(request.signal.aborted?"cancelled":"failed",reason);await releaseRouteSession(session,group,uncertain);
              if(conversion&&!request.signal.aborted)controller.close();else controller.error(new Error(reason));
            }
          },
          async cancel(){await reader!.cancel().catch(()=>{});await finish("cancelled","client_cancelled");await releaseRouteSession(session,group,uncertain);controller.abort();},
        });
        function controllerSignalReason(){return request.signal.aborted?"client_cancelled":controller.signal.reason?.message||"stream_interrupted";}
        return new Response(stream,{headers:{"content-type":"text/event-stream","cache-control":"no-cache","x-pgw-request-id":group,"x-pgw-attempt-id":traffic.id,"x-accel-buffering":"no",...(converted?{"x-pgw-conversion":"stream"}:{})}});
      }catch(error){
        await reader?.cancel().catch(()=>{});
        await finish(request.signal.aborted?"cancelled":"failed",error instanceof ApiError?error.code:controller.signal.reason?.message||"upstream_unreachable");
        if(error instanceof ApiError)throw error;
        throw new ApiError(request.signal.aborted?499:502,request.signal.aborted?"client_cancelled":controller.signal.reason?.message||"upstream_unreachable");
      }
    }
    await audit("routing.unavailable",group,{decisions});
    throw lastError||new ApiError(503,"route_unavailable");
  }catch(error){if(error instanceof ApiError)error.requestId=group;throw error;}finally{if(!detached)await releaseRouteSession(session,group,uncertain);}
}
