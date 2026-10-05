import React, {useEffect,useState} from 'react';
import {AnimatePresence,motion,useReducedMotion} from 'framer-motion';
import {profileFields,validateProfile,supportedATS} from '../autofill/profile.js';

const storageKeys = ['jobs','collection','generationQueue','queueSettings','autofillProfile','themePreference'];
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result || result.error) throw new Error(result?.error || 'The extension did not respond. Reload it and try again.');
  return result;
}
function downloadPdf(result) {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(result.pdf_base64),c=>c.charCodeAt(0))],{type:'application/pdf'}));
  const link = document.createElement('a'); link.href=url;link.download=result.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
const Panel = ({children,className=''}) => <section className={`surface rounded-2xl border p-5 ${className}`}>{children}</section>;
function ProfileEditor({saved,onSave,busy}) {
  const [values,setValues]=useState(saved || {}),[json,setJson]=useState(null);
  const savedJson=JSON.stringify(saved || {});
  // Queue progress reloads storage; preserve unsaved edits when profile values agree.
  useEffect(()=>{setValues(JSON.parse(savedJson));},[savedJson]);
  function fields(keys) { return <div className="grid grid-cols-2 gap-x-4 gap-y-3">{keys.map(key=><label key={key}>{profileFields[key]}<input value={values[key] || ''} type={key==='email'?'email':'text'} maxLength={500} onChange={e=>setValues({...values,[key]:e.target.value})}/></label>)}</div>; }
  return <details className="profile-editor surface rounded-2xl border p-5">
    <summary className="cursor-pointer font-semibold">Your autofill profile <span className="muted ml-2 text-xs font-normal">{Object.values(saved||{}).filter(Boolean).length} fields saved</span></summary>
    <p className="muted mt-3 mb-4 text-sm">These exact values fill standard fields. Missing values stay blank.</p>
    {json===null?<>
      {fields(['firstName','lastName','email','phone'])}
      <details className="mt-4"><summary className="muted cursor-pointer text-sm">Education & links</summary><div className="mt-3">{fields(['university','degree','major','graduationYear','linkedin','github','website'])}</div></details>
      <details className="mt-4"><summary className="muted cursor-pointer text-sm">Address & preferred name</summary><div className="mt-3">{fields(['preferredName','addressLine1','addressLine2','city','state','postalCode','country'])}</div></details>
    </>:<label>Profile JSON<textarea rows={12} spellCheck={false} value={json} onChange={e=>setJson(e.target.value)} className="font-mono text-xs"/></label>}
    <div className="mt-5 flex items-center gap-3"><button className="primary" disabled={busy} onClick={()=>onSave(json===null?values:json)}>Save autofill profile</button><button className="quiet" onClick={()=>setJson(json===null?JSON.stringify(values,null,2):null)}>{json===null?'Edit JSON':'Back to fields'}</button></div>
  </details>;
}

export default function App() {
  const [view,setView]=useState('capture'),[data,setData]=useState({jobs:{},generationQueue:[]}),[activeTab,setActiveTab]=useState(null),[ready,setReady]=useState(false);
  const [prefs,setPrefs]=useState({prepare:false,template:'fpga'}),[notice,setNotice]=useState(null),[busy,setBusy]=useState(false);
  const [candidates,setCandidates]=useState(null),[selectedTabs,setSelectedTabs]=useState([]),[limit,setLimit]=useState(10);
  const [application,setApplication]=useState(''),[versionId,setVersionId]=useState('');
  const reduced=useReducedMotion();
  useEffect(()=>{
    let alive=true;
    const refresh=async()=>{const stored=await chrome.storage.local.get(storageKeys);if(alive)setData({jobs:{},generationQueue:[],...stored});};
    const changed=(values,area)=>{if(area==='local' && storageKeys.some(key=>key in values))void refresh();};
    chrome.storage.onChanged.addListener(changed);
    Promise.all([refresh(),chrome.storage.local.get(['captureSettings','autofillSelection']),chrome.tabs.query({active:true,currentWindow:true})]).then(([,saved,tabs])=>{
      if(!alive)return;
      setPrefs(saved.captureSettings || {prepare:false,template:'fpga'});setApplication(saved.autofillSelection?.key || '');setVersionId(saved.autofillSelection?.versionId || '');
      setActiveTab(tabs[0] || null);if(supportedATS(tabs[0]?.url))setView('apply');setReady(true);
    }).catch(error=>{setNotice({text:error.message,error:true});setReady(true);});
    return()=>{alive=false;chrome.storage.onChanged.removeListener(changed);};
  },[]);
  useEffect(()=>{
    const preference=data.themePreference || 'dark',media=matchMedia('(prefers-color-scheme: dark)');
    const apply=()=>{document.documentElement.dataset.theme=preference==='system'?(media.matches?'dark':'light'):preference;};apply();media.addEventListener('change',apply);return()=>media.removeEventListener('change',apply);
  },[data.themePreference]);
  async function run(fn) {
    if(busy)return;setBusy(true);setNotice(null);
    try{await fn();}catch(error){setNotice({text:error.message,error:true});}finally{setBusy(false);}
  }
  function notify(text){setNotice({text,error:false});}
  async function preferences(next){setPrefs(next);await chrome.storage.local.set({captureSettings:next});}
  async function capture(tabIds){
    const {results}=await send({action:'capture_tabs',tabIds,options:prefs});
    const failed=results.filter(r=>r.error || r.preparationError);
    setNotice({text:`${results.filter(r=>!r.error).length} listing(s) saved. ${results.filter(r=>r.preparation==='queued').length} queued.${failed.length?' '+failed.map(r=>r.error || r.preparationError).join(' '):''}`,error:Boolean(failed.length)});
  }
  async function chooseTabs(){
    if(!await chrome.permissions.request({permissions:['tabs']}))throw new Error('Tab access was declined. Save each listing individually instead.');
    const tabs=(await chrome.tabs.query({currentWindow:true})).filter(tab=>/^https?:\/\//.test(tab.url || ''));
    setCandidates(tabs);setSelectedTabs(tabs.filter(tab=>tab.highlighted).map(tab=>tab.id));
  }
  async function saveTabs(){
    const origins=[...new Set(candidates.filter(tab=>selectedTabs.includes(tab.id)).map(tab=>new URL(tab.url).origin+'/*'))];
    if(!await chrome.permissions.request({origins}))throw new Error('Site access was declined.');
    await capture(selectedTabs);
  }
  const jobs=Object.entries(data.jobs).sort(([,a],[,b])=>String(b.updated).localeCompare(String(a.updated)));
  const record=data.jobs[application],versions=record?.versions || [],version=versions.find(v=>v.id===versionId);
  const queue=data.generationQueue || [],running=queue.filter(q=>['pending','running','saving'].includes(q.state)).length,failed=queue.filter(q=>['failed','interrupted'].includes(q.state) || q.error);
  const completed=queue.filter(q=>q.state==='completed' && !q.error).length,collecting=data.collection?.state==='running',ats=supportedATS(activeTab?.url);
  async function chooseApplication(key){
    if(ats)await send({action:'autofill_stop',tabId:activeTab.id});
    setApplication(key);setVersionId('');
    await chrome.storage.local.set({autofillSelection:{key,versionId:''}});
  }
  async function chooseVersion(id){
    if(ats)await send({action:'autofill_stop',tabId:activeTab.id});
    setVersionId(id);
    await chrome.storage.local.set({autofillSelection:{key:application,versionId:id}});
  }
  const onTabKey=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?'capture':e.key==='End'?'apply':view==='capture'?'apply':'capture';setView(next);document.getElementById(`tab-${next}`)?.focus();}};
  return <div className="flex h-full flex-col">
    <header className="flex shrink-0 items-center justify-between border-b px-7 py-5">
      <div className="flex items-center gap-3"><span className="brand-mark" aria-hidden="true">↗</span><div><p className="text-base font-semibold tracking-tight">Internship Desk</p><p className="muted text-xs">Your application companion</p></div></div>
      <select className="theme-select" aria-label="Color theme" value={data.themePreference || 'dark'} onChange={e=>void chrome.storage.local.set({themePreference:e.target.value})}><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option></select>
    </header>
    <div className="shrink-0 px-7 pt-5"><div className="tab-bar grid grid-cols-2 gap-2 rounded-xl p-1" role="tablist" aria-label="Extension tools">{[['capture','Capture & tracking'],['apply','Apply & autofill']].map(([id,label])=><button key={id} id={`tab-${id}`} role="tab" aria-selected={view===id} aria-controls={`panel-${id}`} tabIndex={view===id?0:-1} onKeyDown={onTabKey} onClick={()=>setView(id)} className={`tab rounded-lg px-4 py-3 text-sm font-medium ${view===id?'active':''}`}>{label}</button>)}</div></div>
    <main className="min-h-0 flex-1 overflow-y-auto px-7 pt-5 pb-6">
      {!ready?<p className="muted">Loading your workspace…</p>:<AnimatePresence mode="wait" initial={false}>
        <motion.div key={view} id={`panel-${view}`} role="tabpanel" aria-labelledby={`tab-${view}`} initial={{opacity:0,y:reduced?0:5}} animate={{opacity:1,y:0}} exit={{opacity:0,y:reduced?0:-4}} transition={{duration:reduced?0:.14}} className="space-y-4">
          {view==='capture'?<>
            <div><h1 className="text-2xl font-semibold tracking-tight">Save a promising role.</h1><p className="muted mt-1 text-sm">Capture the details now. Keep preparation in the background.</p></div>
            <Panel><p className="eyebrow">CURRENT PAGE</p><p className="mt-2 truncate font-medium" title={activeTab?.title}>{activeTab?.title || 'Open a job listing'}</p>
              <label className="check mt-5"><input type="checkbox" id="prepare-on-save" checked={prefs.prepare} onChange={e=>void run(()=>preferences({...prefs,prepare:e.target.checked}))}/><span>Prepare resume & cover letter after saving</span></label>
              {prefs.prepare&&<label className="mt-4">Resume focus<select id="capture-template" value={prefs.template} onChange={e=>void run(()=>preferences({...prefs,template:e.target.value}))}><option value="fpga">FPGA</option><option value="robotics">Robotics / embedded</option><option value="power">Power</option></select></label>}
              <button id="save-current" className="primary mt-5 w-full" disabled={busy || !/^https?:/.test(activeTab?.url || '')} onClick={()=>void run(()=>capture([activeTab.id]))}>{prefs.prepare?'Save & prepare this listing':'Save this listing'}</button>
              <p className="muted mt-3 text-xs">Keyboard shortcut <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>S</kbd></p>
            </Panel>
            <details className="surface rounded-2xl border p-5"><summary className="cursor-pointer font-medium">Collect multiple listings</summary>
              <p className="muted mt-3 text-sm">Collect from your open Handshake search, or select job tabs.</p>
              <div className="mt-4 flex items-end gap-3"><label className="w-24">Maximum<input id="collect-limit" type="number" min="1" max="100" value={limit} onChange={e=>setLimit(Number(e.target.value))}/></label><button id={collecting?'collect-stop':'collect-start'} className="secondary flex-1" disabled={busy} onClick={()=>void run(async()=>{await send(collecting?{action:'collect_stop'}:{action:'collect_start',tabId:activeTab?.id,options:{...prefs,limit}});notify(collecting?'Collection stopped.':'Collection started. Keep the job tab open.');})}>{collecting?'Stop collection':'Start Handshake collection'}</button></div>
              {data.collection&&<p className="muted mt-3 text-xs">{data.collection.results.length} saved · {data.collection.state} · {data.collection.message}</p>}
              <button id="choose-tabs" className="quiet mt-4" disabled={busy} onClick={()=>void run(chooseTabs)}>Choose open job tabs…</button>
              {candidates&&<div className="mt-3"><div className="max-h-40 overflow-auto">{candidates.map(tab=><label className="check mb-3" key={tab.id}><input type="checkbox" checked={selectedTabs.includes(tab.id)} onChange={e=>setSelectedTabs(e.target.checked?[...selectedTabs,tab.id]:selectedTabs.filter(id=>id!==tab.id))}/><span className="truncate">{tab.title || tab.url}</span></label>)}</div><button id="save-selected" className="secondary w-full" disabled={busy || !selectedTabs.length} onClick={()=>void run(saveTabs)}>Save selected tabs</button></div>}
            </details>
          </>:<>
            <div><h1 className="text-2xl font-semibold tracking-tight">Make the form easier.</h1><p className="muted mt-1 text-sm">{ats?`${ats} application detected.`:'Open a Workday, Greenhouse, or Lever application.'} You review and submit.</p></div>
            <Panel>
              <label>Saved application<select id="autofill-application" value={record?application:''} disabled={busy} onChange={e=>{const key=e.target.value;void run(()=>chooseApplication(key));}}><option value="">Choose the role you are applying for</option>{jobs.map(([key,job])=><option key={key} value={key}>{job.job.company || 'Company'} · {job.job.title}</option>)}</select></label>
              <p className="muted mt-2 text-xs">Answer drafts use this role’s saved job description and profile.</p>
              {record&&<label className="mt-4">Tailored resume<select id="autofill-version" value={version?versionId:''} disabled={busy} onChange={e=>{const id=e.target.value;void run(()=>chooseVersion(id));}}><option value="">Choose a reviewed PDF version</option>{[...versions].reverse().map(v=><option key={v.id} value={v.id} disabled={!(v.pdf_key || v.pdf_base64) || v.render_pending || Boolean(v.render_error)}>{v.approvedAt?'Approved':'Saved'} · {new Date(v.created).toLocaleString()}{!(v.pdf_key || v.pdf_base64)?' · PDF not ready':''}</option>)}</select></label>}
              <div className="mt-5 flex gap-3"><button id="fill-page" className="primary flex-1" disabled={busy || !ats || !record} onClick={()=>void run(async()=>{const result=await send({action:'autofill_start',tabId:activeTab.id,key:application,versionId});notify(`${result.filled} fields filled. ${result.manual} need manual attention. Existing values were preserved.`);})}>Fill this page</button><button id="download-resume" className="secondary" disabled={busy || !version} onClick={()=>void run(async()=>{downloadPdf(await send({action:'autofill_pdf',key:application,versionId}));notify('Resume downloaded. Choose it in the employer’s upload field.');})}>Download PDF</button></div>
              <p className="muted mt-4 text-xs"><span className="manual-dot"/>Yellow outlines mark manual fields. Use “Generate answer” beside an essay field to preview a draft.</p>
              {ats&&<button disabled={busy} className="quiet mt-3" onClick={()=>void run(async()=>{await send({action:'autofill_stop',tabId:activeTab.id});notify('Autofill paused and highlights cleared. Your entered values remain.');})}>Pause autofill & clear highlights</button>}
            </Panel>
            <ProfileEditor saved={data.autofillProfile} busy={busy} onSave={value=>void run(async()=>{await chrome.storage.local.set({autofillProfile:validateProfile(typeof value==='string'?JSON.parse(value):value)});notify('Autofill profile saved on this device.');})}/>
          </>}
        </motion.div>
      </AnimatePresence>}
      {notice&&<p id="popup-notice" className={`notice mt-4 ${notice.error?'error':''}`} role="status" aria-live="polite">{notice.text}</p>}
    </main>
    <footer className="shrink-0 border-t px-7 py-4">
      <div className="mb-3 flex items-center gap-5 text-xs"><span className="muted"><strong className="ink" id="popup-ready-count">{completed}</strong> ready to review</span><span className="muted"><strong className="ink" id="popup-working-count">{running}</strong> preparing</span>{failed.length>0&&<span className="error ml-auto">{failed.length} need attention</span>}{data.queueSettings?.paused&&<span className="muted">Queue paused</span>}</div>
      <button id="workspace" className="secondary flex w-full items-center justify-between" onClick={()=>void run(()=>send({action:'open_workspace'}))}><span>Open applications & queue</span><span aria-hidden="true">↗</span></button>
    </footer>
  </div>;
}
