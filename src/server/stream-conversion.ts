import type { ConversionSink, WireProtocol } from "../shared/types";
import type { ServerEvent } from "./event-stream";
import { isHostedItemType, isReasoningType } from "./protocols";
import { ApiError } from "./security";
import { emptyUsage, mergeUsage, type Usage } from "./usage";

type Block = { key:string;index:number;type:"text"|"call";id:string;name:string;text:string;closed:boolean;emitted:boolean;toolIndex:number };
export class StreamConversion {
  readonly id=`pgw_${crypto.randomUUID().replaceAll("-","")}`;
  usage:Usage=emptyUsage();
  complete=false;
  upstreamId:string|null=null;
  status="in_progress";
  private blocks=new Map<string,Block>();
  private sequence=0;
  private began=false;
  private ended=false;
  private limited=false;
  private total=0;
  private nextTool=0;
  private sourceParts=new Map<number,{key:string;type:"text"|"call"}>();
  /** messages 源：被跳过的推理块 index，其 delta / stop 一律静默忽略。 */
  private ignored=new Set<number>();
  /** responses 源：被跳过的推理或托管调用项 output_index；同时承担 responseItem 重复调用（done 与 completed.output[]）的去重。 */
  private ignoredItems=new Set<number>();
  /** chat / gemini 源的增量无法界定边界，每个类型至多记一次。 */
  private noted=new Set<string>();
  constructor(readonly from:WireProtocol,readonly to:WireProtocol,readonly model:string,private write:(chunk:Uint8Array)=>void,private readonly sink?:ConversionSink){}
  private note(type:string,dedupe=false){
    const sink=this.sink;if(!sink)return;
    if(dedupe&&this.noted.has(type))return;this.noted.add(type);
    const found=sink.dropped.find(item=>item.type===type);if(found)found.count++;else sink.dropped.push({type,count:1});
  }
  private emit(type:string,value:unknown){
    const payload=this.to==="responses"?{...(value as object),sequence_number:this.sequence++}:value;
    this.write(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`));
  }
  private chat(delta:unknown,finish:string|null=null,usage?:object){this.emit("message",{id:this.id,object:"chat.completion.chunk",created:Math.floor(Date.now()/1000),model:this.model,choices:[{index:0,delta,finish_reason:finish}],...(usage?{usage}:{})});}
  private usageFor(wire:WireProtocol){
    if(this.usage.inputTokens===null||this.usage.outputTokens===null)return undefined;
    return wire==="chat"?{prompt_tokens:this.usage.inputTokens,completion_tokens:this.usage.outputTokens,total_tokens:this.usage.inputTokens+this.usage.outputTokens}:wire==="gemini"?{promptTokenCount:this.usage.inputTokens,candidatesTokenCount:this.usage.outputTokens,totalTokenCount:this.usage.inputTokens+this.usage.outputTokens}:{input_tokens:this.usage.inputTokens,output_tokens:this.usage.outputTokens,total_tokens:wire==="responses"?this.usage.inputTokens+this.usage.outputTokens:undefined};
  }
  private begin(){
    if(this.began)return;this.began=true;
    if(this.to==="messages")this.emit("message_start",{type:"message_start",message:{id:this.id,type:"message",role:"assistant",model:this.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:this.usage.inputTokens??0,output_tokens:0}}});
    else if(this.to==="chat")this.chat({role:"assistant",content:""});
    else if(this.to==="responses")this.emit("response.created",{type:"response.created",response:{id:this.id,object:"response",created_at:Math.floor(Date.now()/1000),model:this.model,status:"in_progress",store:false,output:[]}});
  }
  private block(key:string,type:Block["type"],id?:string,name?:string){
    let block=this.blocks.get(key);
    if(!block){block={key,index:this.blocks.size,type,id:id||`${type==="call"?"call":"msg"}_${this.id}_${this.blocks.size}`,name:name||"",text:"",closed:false,emitted:false,toolIndex:type==="call"?this.nextTool++:-1};this.blocks.set(key,block);}
    if(block.type!==type)throw new ApiError(502,"stream_block_type_changed");
    if(name){if(block.emitted&&block.name!==name)throw new ApiError(502,"stream_tool_name_changed");block.name=name;}
    if(id){if(block.emitted&&block.id!==id)throw new ApiError(502,"stream_tool_id_changed");block.id=id;}
    return block;
  }
  private start(block:Block){
    if(block.emitted)return;
    if(block.type==="call"&&!block.name)throw new ApiError(502,"stream_tool_name_missing");
    this.begin();block.emitted=true;
    if(this.to==="messages")this.emit("content_block_start",{type:"content_block_start",index:block.index,content_block:block.type==="text"?{type:"text",text:""}:{type:"tool_use",id:block.id,name:block.name,input:{}}});
    else if(this.to==="chat"&&block.type==="call")this.chat({tool_calls:[{index:block.toolIndex,id:block.id,type:"function",function:{name:block.name,arguments:""}}]});
    else if(this.to==="responses"){
      this.emit("response.output_item.added",{type:"response.output_item.added",output_index:block.index,item:block.type==="text"?{id:block.id,type:"message",role:"assistant",status:"in_progress",content:[]}:{id:`fc_${block.id}`,type:"function_call",call_id:block.id,name:block.name,arguments:"",status:"in_progress"}});
      if(block.type==="text")this.emit("response.content_part.added",{type:"response.content_part.added",item_id:block.id,output_index:block.index,content_index:0,part:{type:"output_text",text:"",annotations:[]}});
    }
  }
  private delta(block:Block,text:string){
    if(!text)return;
    if(block.closed)throw new ApiError(502,"stream_block_already_closed");
    this.total+=text.length;if(this.total>16*1024*1024)throw new ApiError(502,"conversion_output_limit");
    this.start(block);block.text+=text;
    if(this.to==="messages")this.emit("content_block_delta",{type:"content_block_delta",index:block.index,delta:block.type==="text"?{type:"text_delta",text}:{type:"input_json_delta",partial_json:text}});
    else if(this.to==="chat")this.chat(block.type==="text"?{content:text}:{tool_calls:[{index:block.toolIndex,function:{arguments:text}}]});
    else if(this.to==="responses")this.emit(block.type==="text"?"response.output_text.delta":"response.function_call_arguments.delta",{type:block.type==="text"?"response.output_text.delta":"response.function_call_arguments.delta",item_id:block.type==="text"?block.id:`fc_${block.id}`,output_index:block.index,...(block.type==="text"?{content_index:0}:{}),delta:text});
    else if(block.type==="text")this.emit("message",{candidates:[{index:0,content:{role:"model",parts:[{text}]}}]});
  }
  private reconcile(block:Block,full:string){if(block.closed){if(full!==block.text)throw new ApiError(502,"stream_final_content_mismatch");return;}if(!full.startsWith(block.text))throw new ApiError(502,"stream_final_content_mismatch");this.delta(block,full.slice(block.text.length));}
  private close(block:Block){
    if(block.closed)return;
    let argumentsObject:unknown;
    if(block.type==="call"){
      if(!block.text)this.delta(block,"{}");
      try{argumentsObject=JSON.parse(block.text);}catch{throw new ApiError(502,"invalid_stream_tool_arguments");}
      if(!argumentsObject||typeof argumentsObject!=="object"||Array.isArray(argumentsObject))throw new ApiError(502,"invalid_stream_tool_arguments");
    }
    this.start(block);block.closed=true;
    if(this.to==="messages")this.emit("content_block_stop",{type:"content_block_stop",index:block.index});
    else if(this.to==="responses"){
      if(block.type==="text"){
        this.emit("response.output_text.done",{type:"response.output_text.done",item_id:block.id,output_index:block.index,content_index:0,text:block.text});
        this.emit("response.content_part.done",{type:"response.content_part.done",item_id:block.id,output_index:block.index,content_index:0,part:{type:"output_text",text:block.text,annotations:[]}});
      }else this.emit("response.function_call_arguments.done",{type:"response.function_call_arguments.done",item_id:`fc_${block.id}`,output_index:block.index,arguments:block.text});
      this.emit("response.output_item.done",{type:"response.output_item.done",output_index:block.index,item:this.item(block)});
    }else if(this.to==="gemini"&&block.type==="call")this.emit("message",{candidates:[{index:0,content:{role:"model",parts:[{functionCall:{id:block.id,name:block.name,args:argumentsObject}}]}}]});
  }
  private item(block:Block){return block.type==="text"?{id:block.id,type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:block.text,annotations:[]}]}:{id:`fc_${block.id}`,type:"function_call",call_id:block.id,name:block.name,arguments:block.text,status:"completed"};}
  accept(event:ServerEvent){
    if(this.ended)throw new ApiError(502,"data_after_stream_end");
    if(event.data==="[DONE]"){if(this.from!=="chat")throw new ApiError(502,"unexpected_stream_sentinel");this.complete=true;this.status=this.limited?"incomplete":"completed";return;}
    if(["ping","keepalive"].includes(event.event)&&!event.data.startsWith("{"))return;
    let e:any;try{e=JSON.parse(event.data);}catch{throw new ApiError(502,"invalid_upstream_event");}
    this.usage=mergeUsage(this.usage,e,this.from);
    if(e.error||e.type==="error"||e.type==="response.failed")throw new ApiError(502,"upstream_stream_error");
    if(this.from==="chat"){
      for(const choice of e.choices||[]){
        if(choice.index!==undefined&&choice.index!==0)throw new ApiError(422,"conversion_unsupported:multiple_candidates");
        const delta=choice.delta||{};
        if(delta.audio)throw new ApiError(422,"conversion_unsupported:reasoning_or_audio");
        if(delta.reasoning_content||delta.reasoning){if(!this.sink?.reasoning)throw new ApiError(422,"conversion_unsupported:reasoning_or_audio");this.note("reasoning_content",true);}
        if(delta.content!==null&&delta.content!==undefined&&typeof delta.content!=="string")throw new ApiError(422,"conversion_unsupported:stream_content");
        if(delta.content)this.delta(this.block("text","text"),delta.content);
        if(delta.refusal)this.delta(this.block("refusal","text"),delta.refusal);
        for(const call of delta.tool_calls||[]){const block=this.block(`call:${call.index??0}`,"call",call.id,call.function?.name);if(call.function?.arguments)this.delta(block,call.function.arguments);}
        if(choice.finish_reason==="length")this.limited=true;
        if(choice.finish_reason==="content_filter")throw new ApiError(422,"upstream_content_filtered");
      }
    }else if(this.from==="messages"){
      if(e.type==="message_start")this.begin();
      if(e.type==="content_block_start"){
        const p=e.content_block;
        if(p.type!=="text"&&p.type!=="tool_use"){
          if(!(this.sink?.reasoning&&isReasoningType(p.type)))throw new ApiError(422,`conversion_unsupported:${p.type}`);
          this.ignored.add(e.index);this.note(p.type);return;
        }
        const type=p.type==="text"?"text":"call",key=`block:${e.index}`;this.sourceParts.set(e.index,{key,type});
        const block=this.block(key,type,p.id,p.name);this.start(block);
        if(p.type==="text"&&p.text)this.delta(block,p.text);
        if(p.type==="tool_use"&&p.input&&Object.keys(p.input).length)this.delta(block,JSON.stringify(p.input));
      }else if(e.type==="content_block_delta"){
        const part=this.sourceParts.get(e.index);
        if(!part){if(this.ignored.has(e.index))return;throw new ApiError(502,"stream_block_missing");}
        if(!["text_delta","input_json_delta"].includes(e.delta?.type)){
          if(!(this.sink?.reasoning&&isReasoningType(e.delta?.type)))throw new ApiError(422,`conversion_unsupported:${e.delta?.type}`);
          this.note(e.delta.type);return;
        }
        this.delta(this.block(part.key,part.type),e.delta.text??e.delta.partial_json??"");
      }else if(e.type==="content_block_stop"){const part=this.sourceParts.get(e.index);if(part)this.close(this.block(part.key,part.type));}
      else if(e.type==="message_delta"){this.limited=e.delta?.stop_reason==="max_tokens";if(["pause_turn","refusal"].includes(e.delta?.stop_reason))throw new ApiError(422,`conversion_unsupported:${e.delta.stop_reason}`);}
      else if(e.type==="message_stop"){this.complete=true;this.status=this.limited?"incomplete":"completed";}
    }else if(this.from==="responses"){
      if(typeof e.response?.id==="string")this.upstreamId=e.response.id;
      if(e.type==="response.created")this.begin();
      if(e.type==="response.output_item.added"){
        const item=e.item;if(item.type==="function_call")this.start(this.block(`call:${e.output_index}`,"call",item.call_id,item.name));
        else if(item.type!=="message"){
          const droppable=(this.sink?.reasoning&&isReasoningType(item.type))||(this.sink?.hosted&&isHostedItemType(item.type));
          if(!droppable)throw new ApiError(422,`conversion_unsupported:${item.type}`);
          this.ignoredItems.add(e.output_index);this.note(item.type);
        }
      }else if(e.type==="response.content_part.added"){
        if(e.part?.type!=="output_text"){
          if(this.ignoredItems.has(e.output_index))return;
          if(!(this.sink?.reasoning&&isReasoningType(e.part?.type)))throw new ApiError(422,`conversion_unsupported:${e.part?.type}`);
          this.note(e.part.type);return;
        }
        this.start(this.block(`text:${e.output_index}:${e.content_index}`,"text",e.item_id?`${e.item_id}_${e.content_index}`:undefined));
      }else if(e.type==="response.output_text.delta"){if(this.ignoredItems.has(e.output_index))return;this.delta(this.block(`text:${e.output_index}:${e.content_index}`,"text"),e.delta||"");}
      else if(e.type==="response.function_call_arguments.delta"){if(this.ignoredItems.has(e.output_index))return;this.delta(this.block(`call:${e.output_index}`,"call"),e.delta||"");}
      else if(e.type==="response.output_item.done")this.responseItem(e.item,e.output_index);
      else if(["response.completed","response.incomplete"].includes(e.type)){
        for(const [index,item]of (e.response?.output||[]).entries())this.responseItem(item,index);
        this.complete=true;this.limited=e.type==="response.incomplete";this.status=this.limited?"incomplete":"completed";
      }
    }else{
      if(e.promptFeedback?.blockReason)throw new ApiError(422,"upstream_content_filtered");
      for(const candidate of e.candidates||[]){
        if(candidate.index!==undefined&&candidate.index!==0)throw new ApiError(422,"conversion_unsupported:multiple_candidates");
        for(const part of candidate.content?.parts||[]){
          if(part.thoughtSignature||part.thought){
            if(part.thought===true&&this.sink?.reasoning){this.note("thought",true);continue;}
            if(!this.sink?.reasoning)throw new ApiError(422,"conversion_unsupported:thought_signature");
            this.note("thoughtSignature",true);
          }
          if(typeof part.text==="string")this.delta(this.block("text","text"),part.text);
          else if(part.functionCall){const call=part.functionCall;const key=call.id?`call:${call.id}`:`call:${this.nextTool}`;const block=this.block(key,"call",call.id,call.name);this.reconcile(block,JSON.stringify(call.args||{}));this.close(block);}
          else throw new ApiError(422,"conversion_unsupported:media");
        }
        if(candidate.finishReason){if(!["STOP","MAX_TOKENS"].includes(candidate.finishReason))throw new ApiError(422,`upstream_finish:${candidate.finishReason}`);this.complete=true;this.limited=candidate.finishReason==="MAX_TOKENS";this.status=this.limited?"incomplete":"completed";}
      }
    }
  }
  private responseItem(item:any,index:number){
    if(item.type==="function_call"){const block=this.block(`call:${index}`,"call",item.call_id,item.name);this.reconcile(block,item.arguments||"{}");this.close(block);}
    else if(item.type==="message")for(const [contentIndex,part]of (item.content||[]).entries()){if(part.type!=="output_text"){if(this.sink?.reasoning&&isReasoningType(part.type)){this.note(part.type,true);continue;}throw new ApiError(422,`conversion_unsupported:${part.type}`);}const block=this.block(`text:${index}:${contentIndex}`,"text");this.reconcile(block,part.text||"");this.close(block);}
    else {
      if(this.ignoredItems.has(index))return;
      const droppable=(this.sink?.reasoning&&isReasoningType(item.type))||(this.sink?.hosted&&isHostedItemType(item.type));
      if(!droppable)throw new ApiError(422,`conversion_unsupported:${item.type}`);
      this.ignoredItems.add(index);this.note(item.type);
    }
  }
  finish(){
    if(this.ended)return;
    if(!this.complete)throw new ApiError(502,"stream_incomplete");
    this.begin();for(const block of this.blocks.values())this.close(block);
    const usage=this.usageFor(this.to),calls=[...this.blocks.values()].some(b=>b.type==="call");
    if(this.to==="chat"){this.chat({},calls?"tool_calls":this.limited?"length":"stop",usage);this.write(new TextEncoder().encode("data: [DONE]\n\n"));}
    else if(this.to==="messages"){this.emit("message_delta",{type:"message_delta",delta:{stop_reason:calls?"tool_use":this.limited?"max_tokens":"end_turn",stop_sequence:null},...(usage?{usage}: {})});this.emit("message_stop",{type:"message_stop"});}
    else if(this.to==="responses")this.emit(`response.${this.status}`,{type:`response.${this.status}`,response:{id:this.id,object:"response",created_at:Math.floor(Date.now()/1000),model:this.model,status:this.status,store:false,output:[...this.blocks.values()].map(b=>this.item(b)),...(usage?{usage}:{})}});
    else this.emit("message",{candidates:[{index:0,content:{role:"model",parts:[]},finishReason:this.limited?"MAX_TOKENS":"STOP"}],...(usage?{usageMetadata:usage}:{})});
    this.ended=true;
  }
  fail(code:string){
    if(this.ended)return;this.begin();this.ended=true;
    if(this.to==="messages")this.emit("error",{type:"error",error:{type:"api_error",message:code}});
    else if(this.to==="responses")this.emit("response.failed",{type:"response.failed",response:{id:this.id,status:"failed",error:{code,message:code}}});
    else this.emit("error",{error:{code,message:code}});
  }
}
