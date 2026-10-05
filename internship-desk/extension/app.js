import {$,request,native,notify,on,downloadPdf} from './client.js';
import {element} from './ui.js';
import {jobs,editJob,withStore,mergeJob} from './store.js';
import {assess,canonicalUrl,jobFields} from './core.js';
import {loadPdf} from './documents.js';
import {addEvent,normalizeRecord,recommendTemplate,relatedUpdates,nextAction,latestQueue,visibleApplications,markApplied,needsReview} from './workflow.js';
import {matchApplication,safeLink} from './sheets.js';
import {createReview} from './review.js';
import {initProfile} from './profile-ui.js';
import {initConnections} from './connections.js';
import {initBackup} from './backup.js';
import {progressLabels,timingSummary} from './generation.js';

let data={jobs:{},generationQueue:[],sheetTracker:{}},view='today',activeKey=null,activeTab='opportunity',editKey=null,renderId=0;
const selected=new Set();
const review=createReview({approved:async key=>{notify('Documents approved. Your application packet is ready.');await refresh();fillVersions();showTab('apply');}});
const current=()=>data.jobs[activeKey];
const updates=key=>relatedUpdates(key,data.jobs,data.sheetTracker);
const actionFor=key=>nextAction(data.jobs[key],latestQueue(data.generationQueue,key),updates(key));
function safeAnchor(id,url){const link=$(id),safe=safeLink(url);link.hidden=!safe;if(safe)link.href=safe;else link.removeAttribute('href');}
async function changeView(next){await review.close();activeKey=null;view=next;selected.clear();$('list-screen').hidden=next==='profile';$('detail-screen').hidden=true;$('profile-screen').hidden=next!=='profile';document.querySelectorAll('[data-view]').forEach(button=>button.classList.toggle('active',button.dataset.view===(next==='profile'?'profile':next==='today'?'today':'all')));$('list-title').textContent=next==='today'?'Today':'Applications';$('list-subtitle').textContent=next==='today'?'Documents to review, upcoming deadlines, and updates that need a response.':'Capture first. Shortlist what matters. Keep each application together.';$('view-filter').disabled=next==='today';if(next!=='today' && next!=='profile')$('view-filter').value=next;renderList();}
function showTab(tab){activeTab=tab;document.querySelectorAll('[data-tab]').forEach(button=>{button.classList.toggle('active',button.dataset.tab===tab);button.setAttribute('aria-current',String(button.dataset.tab===tab));});document.querySelectorAll('.detail-tab').forEach(panel=>panel.hidden=panel.id!==`tab-${tab}`);if(tab==='timeline')fillTimeline(true);if(tab==='apply')void fillApply().catch(error=>notify(error.message,true));}
async function openApplication(key,tab){await review.persist();activeKey=key;await refresh();const record=current();if(!record)throw new Error('Application no longer exists.');$('list-screen').hidden=true;$('profile-screen').hidden=true;$('detail-screen').hidden=false;fillOpportunity();fillTimeline(true);await review.open(key);fillVersions();const action=actionFor(key);showTab(tab || ({review:'documents',ready:'apply',updates:'timeline',applied:'timeline'}[action.key] || 'opportunity'));window.scrollTo({top:0,behavior:'instant'});}
function selection(){const count=selected.size;$('selected-count').textContent=`${count} selected`;$('shortlist-selected').disabled=$('archive-selected').disabled=!count;const visible=visibleApplications(data.jobs,data.generationQueue,data.sheetTracker,view,$('search').value);$('select-visible').checked=visible.length>0 && visible.every(item=>selected.has(item.key));}
function renderList(){
  const visible=visibleApplications(data.jobs,data.generationQueue,data.sheetTracker,view,$('search').value);const keys=new Set(visible.map(item=>item.key));for(const key of selected)if(!keys.has(key))selected.delete(key);
  $('list-count').textContent=`${visible.length} application${visible.length===1?'':'s'}`;$('application-list').replaceChildren();
  if(!visible.length)$('application-list').append(element('p','empty',view==='today'?'Nothing needs attention today. Open Applications to review your inbox.':'No matching applications. Save listings with the extension or add one here.'));
  for(const {key,record,action} of visible){
    const row=element('article','application-row'),check=element('input');check.type='checkbox';check.checked=selected.has(key);check.setAttribute('aria-label',`Select ${record.job.title}`);check.onchange=()=>{check.checked?selected.add(key):selected.delete(key);selection();};
    const main=element('div','row-main');main.append(element('p','eyebrow',record.job.company || 'Company not entered'),element('h3','',record.job.title));
    const meta=element('p','muted');const labels={inbox:'Inbox',shortlisted:'Shortlisted',preparing:'Preparing',review:'Needs review',ready:'Ready to apply',applied:'Applied',archived:'Archived',updates:'New update',attention:'Needs attention'};meta.append(element('span',`badge ${action.key}`,labels[action.key]));meta.append(document.createTextNode([record.job.location,record.job.deadline?`Deadline ${record.job.deadline}`:'',record.followUp?`Follow up ${record.followUp}`:''].filter(Boolean).join(' · ')));main.append(meta);
    const button=element('button',['inbox','shortlisted','review','ready'].includes(action.key)?'':'secondary',action.label);button.onclick=()=>openApplication(key).catch(error=>notify(error.message,true));row.append(check,main,button);$('application-list').append(row);
  }
  selection();renderUnmatched();
}
function renderUnmatched(){
  const records=Object.values(data.sheetTracker?.records || {}).filter(record=>!matchApplication(record,data.jobs).key);
  $('unmatched-panel').hidden=!records.length;$('unmatched-list').replaceChildren();
  for(const record of records){
    const row=element('article','unmatched-row');row.append(element('h3','',`${record.company} · ${record.title}`),element('p','muted',`${record.status} · ${record.date || 'Date not provided'}`));
    if(record.notes)row.append(element('p','small',record.notes));
    if(record.nextStep)row.append(element('p','',`Next: ${record.nextStep}`));
    const select=element('select');select.setAttribute('aria-label',`Match ${record.company} ${record.title}`);select.add(new Option('Choose a saved application',''));select.add(new Option('Keep as standalone history','standalone'));Object.entries(data.jobs).forEach(([key,r])=>select.add(new Option(`${r.job.company} · ${r.job.title}`,key)));select.value=record.binding || '';
    const button=element('button','secondary','Save match');button.onclick=async()=>{try{await request({action:'sheet_bind',id:record.id,key:select.value});await refresh();}catch(error){notify(error.message,true);}};
    if(record.binding==='standalone'){const details=element('details');details.append(element('summary','','Standalone history · change match'),select,button);row.append(details);}else row.append(select,button);
    $('unmatched-list').append(row);
  }
}
function renderQueue(){
  const queue=data.generationQueue || [],active=queue.filter(q=>['pending','running','saving'].includes(q.state)),failed=queue.filter(q=>['failed','interrupted'].includes(q.state));$('queue-summary').textContent=`· ${active.length} active · ${failed.length} need attention`;
  $('concurrency').value=String(data.queueSettings?.concurrency || 1);$('queue-paused').checked=Boolean(data.queueSettings?.paused);$('queue-list').replaceChildren();
  for(const item of [...queue].reverse().filter(q=>q.state!=='cancelled').slice(0,30)){
    const row=element('div','queue-row');row.append(element('strong','',`${item.company || 'Application'} · ${item.title}`),element('p','muted',`${progressLabels[item.progress?.stage] || item.state}${item.started?' · '+Math.max(0,Math.round((Date.parse(item.finished || new Date().toISOString())-Date.parse(item.started))/1000))+'s':''}`));
    if(item.timings)row.append(element('p','small muted',timingSummary(item.timings)));if(item.error)row.append(element('p','error',item.error));
    if(['pending','failed','interrupted'].includes(item.state) || item.error){const op=item.state==='pending'?'cancel':'retry';const button=element('button','secondary',op==='cancel'?'Remove from queue':item.timings?.model_ms!==undefined?'Retry PDF preparation':'Retry preparation');button.onclick=()=>request({action:'queue_change',operation:op,id:item.id}).catch(error=>notify(error.message,true));row.append(button);}$('queue-list').append(row);
  }
}
function fillHeading(){const record=current();if(!record)return;$('detail-company').textContent=record.job.company || 'Application';$('detail-title').textContent=record.job.title;const action=actionFor(activeKey);$('detail-status').textContent=action.label;$('detail-primary').textContent=action.label;}
function fillOpportunity(){
  const record=current();if(!record)return;fillHeading();$('job-description').textContent=record.job.description;$('job-meta').textContent=[record.job.location,record.job.deadline?`Deadline ${record.job.deadline}`:''].filter(Boolean).join(' · ');safeAnchor('listing-link',record.job.url);
  $('fit-evidence').replaceChildren();for(const item of assess(record.job,data.profile || {})){const block=element('div','fit-check');block.append(element('h3','',item.label),element('p','',item.value));$('fit-evidence').append(block);}
  const suggested=recommendTemplate(record.job);$('job-template').value=record.template || suggested.template;$('template-reason').textContent=suggested.reason;$('include-letter').checked=record.include_letter===true;$('archive-job').textContent=record.archivedAt?'Restore application':'Archive application';$('prepare-job').textContent=record.shortlistedAt?'Prepare documents':'Shortlist & prepare';
}
function fillVersions(){const record=current();if(!record)return;$('version-picker').replaceChildren();if(record.workingDraft)$('version-picker').add(new Option('Working draft · autosaved',''));for(const version of [...record.versions].reverse())$('version-picker').add(new Option(`${version.approvedAt?'Approved':'Generated'} · ${new Date(version.created).toLocaleString()}${record.submission?.versionId===version.id?' · submitted':''}`,version.id));}
async function fillApply(){
  const record=current();if(!record)return;const approved=record.versions.find(v=>v.id===record.approvedVersion),has=Boolean(approved);safeAnchor('apply-link',record.job.url);
  $('approved-context').textContent=has?`Approved ${new Date(approved.approvedAt || approved.created).toLocaleString()}. ${needsReview(record)?'You have unapproved documents; review them before submitting.':record.submission?`Submitted ${new Date(record.submission.at).toLocaleString()}.`:'Use this exact version for your application.'}`:'Review and approve documents to create your application packet.';
  for(const id of ['download-approved','export-approved','mark-applied'])$(id).disabled=!has || (id==='mark-applied' && Boolean(needsReview(record) || record.submission));
  const packet=record.packet;$('packet-status').textContent=packet?.versionId===record.approvedVersion?[packet.resume_path,packet.letter_path].filter(Boolean).join('\n'):'';
  $('application-notes').value=record.notes || '';$('reusable-answers').replaceChildren();const answers=data.profile?.answers;if(answers){$('reusable-answers').append(element('h3','','Reviewed reusable answers'),element('p','answer',answers));const copy=element('button','secondary','Copy answers');copy.onclick=()=>navigator.clipboard.writeText(answers).then(()=>notify('Answers copied.')).catch(error=>notify(error.message,true));$('reusable-answers').append(copy);}
}
function fillTimeline(loadFields=false){
  const record=current();if(!record)return;const external=updates(activeKey);if(loadFields){$('next-step').value=record.nextStep || '';$('follow-up').value=record.followUp || '';}
  $('observed-status').textContent=external.map(item=>`Sheet: ${item.status} (${item.date || 'date unknown'})${item.dateUncertain?' · date order needs review':''}${!item.present?' · retained history':''}`).join('\n');
  const events=[...(record.timeline || []).map(event=>({...event,sort:event.at,text:event.text,source:'Local action'})),...external.flatMap(item=>item.events.map(event=>({at:event.date || event.seenAt,sort:event.seenAt,text:`${event.status}${event.notes?' — '+event.notes:''}`,next:event.nextStep,url:event.emailUrl,source:'Google Sheets / CSV observation'})))].sort((a,b)=>String(b.sort).localeCompare(String(a.sort)));
  $('timeline').replaceChildren();for(const event of events){const li=element('li');li.append(element('small','',`${event.source} · ${event.at}`),element('p','',event.text));if(event.next)li.append(element('p','',`Next step: ${event.next}`));if(safeLink(event.url)){const link=element('a','','Read source email ↗');link.href=safeLink(event.url);link.target='_blank';link.rel='noopener noreferrer';li.append(link);}$('timeline').append(li);}
  if(!events.length)$('timeline').append(element('li','muted','No recorded activity yet.'));
}
async function shortlist(keys){const result=await request({action:'shortlist',keys,template:activeKey?$('job-template').value:'auto',...(activeKey?{include_letter:$('include-letter').checked}:{})});notify(`${result.added.length} application(s) queued; ${result.skipped.length} already prepared or queued.`);await refresh();}
async function refresh(){const id=++renderId;const stored=await chrome.storage.local.get(['jobs','generationQueue','queueSettings','sheetTracker','profile']);if(id!==renderId)return;data={jobs:{},generationQueue:[],sheetTracker:{},...stored};renderQueue();if(activeKey){fillHeading();if(activeTab==='timeline')fillTimeline();const latest=current()?.versions.at(-1),opened=review.current();if(latest && (!opened || (!opened.draftRevision && latest.id!==opened.id)) && !['pending','running','saving'].includes(latestQueue(data.generationQueue,activeKey)?.state)){await review.open(activeKey);fillVersions();}}else renderList();}
for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>changeView(button.dataset.view).catch(error=>notify(error.message,true));
for(const button of document.querySelectorAll('[data-tab]'))button.onclick=()=>showTab(button.dataset.tab);
on('back',()=>changeView('all'));
$('search').oninput=()=>{selected.clear();renderList();};$('view-filter').onchange=()=>{view=$('view-filter').value;selected.clear();renderList();};
$('select-visible').onchange=()=>{selected.clear();if($('select-visible').checked)visibleApplications(data.jobs,data.generationQueue,data.sheetTracker,view,$('search').value).forEach(item=>selected.add(item.key));renderList();};
on('shortlist-selected',()=>shortlist([...selected]));
on('archive-selected',async()=>{for(const key of selected)await editJob(key,record=>{record.archivedAt=new Date().toISOString();addEvent(record,'archived','Application archived');});selected.clear();await refresh();});
on('prepare-job',()=>shortlist([activeKey]));
on('archive-job',async()=>{await editJob(activeKey,record=>{if(record.archivedAt){delete record.archivedAt;addEvent(record,'restored','Application restored');}else{record.archivedAt=new Date().toISOString();addEvent(record,'archived','Application archived');}});await refresh();fillOpportunity();});
on('detail-primary',async()=>{const action=actionFor(activeKey);if(['inbox','shortlisted'].includes(action.key))await shortlist([activeKey]);else if(action.key==='review')showTab('documents');else if(action.key==='ready')showTab('apply');else if(['updates','applied'].includes(action.key))showTab('timeline');else if(action.key==='archived')$('archive-job').click();else if(action.key==='attention'){const item=latestQueue(data.generationQueue,activeKey);if(item && (['failed','interrupted'].includes(item.state)||item.error))await request({action:'queue_change',operation:'retry',id:item.id});else await shortlist([activeKey]);}else notify('Preparation continues in the background. You can close this workspace.');});
$('version-picker').onchange=()=>review.open(activeKey,$('version-picker').value || undefined).catch(error=>notify(error.message,true));
on('acknowledge-updates',async()=>{await editJob(activeKey,record=>{record.reviewedUpdates=[...new Set([...(record.reviewedUpdates || []),...updates(activeKey).map(item=>item.id+':'+item.currentEvent)])].slice(-300);addEvent(record,'updates_reviewed','Imported updates reviewed');});await refresh();});
on('save-next-step',async()=>{await editJob(activeKey,record=>{record.nextStep=$('next-step').value.trim();record.followUp=$('follow-up').value;addEvent(record,'next_step',record.nextStep || 'Next step cleared',{date:record.followUp});});notify('Next step saved. Due reminders appear in Today.');await refresh();});
$('application-notes').onchange=()=>editJob(activeKey,record=>{record.notes=$('application-notes').value;}).catch(error=>notify(error.message,true));
on('mark-applied',async()=>{await editJob(activeKey,record=>markApplied(record));await refresh();await fillApply();fillTimeline();notify('Submission recorded with the exact approved document version.');});
on('download-approved',async()=>{const version=current().versions.find(v=>v.id===current().approvedVersion);if(!version)throw new Error('Approve documents first.');const loaded=await loadPdf(chrome.storage.local,version);downloadPdf(loaded.pdf_base64,'Resume.pdf');});
on('export-approved',async()=>{const key=activeKey,record=current(),version=record.versions.find(v=>v.id===record.approvedVersion);if(!version)throw new Error('Approve documents first.');const loaded=await loadPdf(chrome.storage.local,version);const result=await native({action:'export_packet',approved:true,application_id:record.id,version_id:version.id,job:version.job,template:version.template,letter:version.letter,pdf_base64:loaded.pdf_base64});await editJob(key,record=>{record.packet={...result,versionId:version.id};addEvent(record,'packet_saved','Approved PDF packet saved',{versionId:version.id});});await refresh();await fillApply();notify('Approved packet saved. Earlier approved versions stay in their own folders.');});
for(const id of ['concurrency','queue-paused'])$(id).onchange=()=>request({action:'queue_change',operation:'settings',value:{concurrency:Number($('concurrency').value),paused:$('queue-paused').checked}}).catch(error=>notify(error.message,true));
function showJobForm(key=null){editKey=key;$('job-form').reset();if(key)for(const field of jobFields)$('job-form').elements[field].value=data.jobs[key].job[field] || '';$('job-form-title').textContent=key?'Edit listing':'Add listing';$('job-form').elements.url.readOnly=Boolean(key);$('job-dialog').showModal();}
on('add-job',()=>showJobForm());on('edit-listing',()=>showJobForm(activeKey));on('close-job-dialog',()=>$('job-dialog').close());
$('job-form').onsubmit=async event=>{event.preventDefault();try{const job=Object.fromEntries(jobFields.map(field=>[field,$('job-form').elements[field].value.trim()]));job.url=canonicalUrl(job.url);await withStore(async()=>{const all=await jobs();const existed=mergeJob(all,job);normalizeRecord(all[job.url]);addEvent(all[job.url],existed?'listing_updated':'captured',existed?'Listing details updated':'Listing saved to inbox');await chrome.storage.local.set({jobs:all});});$('job-dialog').close();await refresh();await openApplication(job.url,'opportunity');}catch(error){notify(error.message,true);}};
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local' && ['jobs','generationQueue','queueSettings','sheetTracker','profile'].some(key=>key in changes))void refresh().catch(error=>notify(error.message,true));});
setInterval(()=>{if(!activeKey && !$('list-screen').hidden)renderQueue();},1000);
async function init(){await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});await request({action:'queue_wake'});await refresh();await changeView(new URL(location.href).searchParams.get('view')==='all'?'all':'today');initConnections();initBackup();await initProfile();notify('Ready.');}
void init().catch(error=>notify(error.message,true));
