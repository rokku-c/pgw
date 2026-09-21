import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import zh from "./locales/zh-CN";
import en from "./locales/en-US";

export type Locale = "zh-CN" | "en-US";
export type I18nKey = keyof typeof zh;
const catalogs = { "zh-CN": zh, "en-US": en };
function detectLocale(): Locale {
  try { const saved=localStorage.getItem("pgw.locale"); if(saved==="zh-CN"||saved==="en-US")return saved; } catch {}
  if(typeof navigator!=="undefined") for(const language of navigator.languages||[navigator.language]) {
    if(language.toLowerCase().startsWith("zh"))return "zh-CN";
    if(language.toLowerCase().startsWith("en"))return "en-US";
  }
  return "zh-CN";
}
let activeLocale:Locale=detectLocale();
export function jobLabel(job:{kind:string;label:string}) {
  const keys:Record<string,I18nKey>={"trajectory.snapshot":"trajectory.snapshot.save","trajectory.cleanup":"trajectory.snapshot.cleanup","registry.scan":"job.label.registry","sessions.scan":"job.label.sessions","sessions.search":"job.label.search","sessions.timeline":"job.label.sessionRead","model.debug":"job.label.model","assets.scan":"job.label.assetScan","assets.search":"job.label.assetSearch","assets.inspect":"job.label.assetRead","assets.snapshot":"job.label.assetSnapshot","assets.preview":"job.label.assetPreview","assets.apply":"job.label.assetApply","assets.restore":"job.label.assetRestore"};
  return keys[job.kind]?tr(keys[job.kind]):job.label;
}
export function getLocale(){return activeLocale;}
export function isMessageKey(value:string):value is I18nKey{return Object.hasOwn(zh,value);}
export function trError(value:string|undefined){return value&&isMessageKey(value)?tr(value):value||"";}
export function tr(key:I18nKey,params:Record<string,string|number|undefined>={}) {
  const template=catalogs[activeLocale][key];
  if(template===undefined)return key;
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g,(placeholder,name)=>params[name]===undefined?placeholder:String(params[name]));
}
export function formatNumber(value:number){return new Intl.NumberFormat(activeLocale,{notation:value>=10000?"compact":"standard",maximumFractionDigits:1}).format(value);}
export function formatMoney(micros:number){return new Intl.NumberFormat(activeLocale,{style:"currency",currency:"USD",minimumFractionDigits:2,maximumFractionDigits:4}).format(micros/1_000_000);}
export function formatDate(timestamp:number){return new Intl.DateTimeFormat(activeLocale,{dateStyle:"medium",timeStyle:"short"}).format(timestamp);}
export function formatTime(timestamp:number){return new Intl.DateTimeFormat(activeLocale,{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(timestamp);}
export function formatRelative(timestamp:number){
  const seconds=Math.floor((Date.now()-timestamp)/1000);
  if(Math.abs(seconds)<60)return tr("common.time.now");
  const [value,unit]=Math.abs(seconds)<3600?[Math.trunc(-seconds/60),"minute"] as const:Math.abs(seconds)<86400?[Math.trunc(-seconds/3600),"hour"] as const:[Math.trunc(-seconds/86400),"day"] as const;
  return new Intl.RelativeTimeFormat(activeLocale,{numeric:"auto",style:"short"}).format(value,unit);
}
const Context=createContext({locale:activeLocale,setLocale:(_locale:Locale)=>{},t:tr,number:formatNumber,money:formatMoney,date:formatDate});
export function I18nProvider({children}:{children:ReactNode}) {
  const [locale,setValue]=useState<Locale>(activeLocale);
  const setLocale=(value:Locale)=>{
    activeLocale=value;setValue(value);
    try{localStorage.setItem("pgw.locale",value);}catch{}
    document.documentElement.lang=value;
  };
  useEffect(()=>{
    document.documentElement.lang=activeLocale;
    const sync=(event:StorageEvent)=>{if(event.key==="pgw.locale"&&(event.newValue==="zh-CN"||event.newValue==="en-US")){activeLocale=event.newValue;setValue(event.newValue);document.documentElement.lang=event.newValue;}};
    window.addEventListener("storage",sync);return()=>window.removeEventListener("storage",sync);
  },[]);
  const context=useMemo(()=>({locale,setLocale,t:tr,number:formatNumber,money:formatMoney,date:formatDate}),[locale]);
  return <Context.Provider value={context}>{children}</Context.Provider>;
}
export const useI18n=()=>useContext(Context);
export function LanguageSwitch(){const{locale,setLocale,t}=useI18n();return <button className="language-switch" onClick={()=>setLocale(locale==="zh-CN"?"en-US":"zh-CN")} aria-label={t("language.switch")} title={locale==="zh-CN"?t("language.en"):t("language.zh")}><span>{locale==="zh-CN"?"中":"EN"}</span></button>;}
