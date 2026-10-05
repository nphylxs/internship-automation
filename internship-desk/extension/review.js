import {$, native, notify, on} from './client.js';
import {editJob, jobs} from './store.js';
import {loadPdf, storePdf} from './documents.js';
import {element} from './ui.js';
import {approveDraft} from './workflow.js';
import {createPdfPreview} from './preview.js';
import {timingSummary} from './generation.js';

export function createReview({approved}) {
  const preview = createPdfPreview({frame:$('resume-preview'),empty:$('resume-preview-empty'),note:$('preview-note')});
  let key = null, draft = null, revision = 0, epoch = 0, saveTimer, renderTimer, saving = Promise.resolve(), rendering = null;
  function status(text, error = false) { $('draft-save-status').textContent = text; $('draft-save-status').className = error ? 'error' : 'muted'; }
  async function persist() {
    clearTimeout(saveTimer);
    if (!key || !draft?.draftRevision) return saving;
    const currentKey = key, snapshot = structuredClone(draft);
    saving = saving.catch(() => {}).then(async () => {
      const stored = await storePdf(chrome.storage.local, snapshot);
      await editJob(currentKey, record => { record.workingDraft = stored; });
      if (key === currentKey && draft?.draftRevision === snapshot.draftRevision) status('Working draft saved automatically.');
    });
    return saving;
  }
  function edit(needsPdf = false) {
    if (!draft) return;
    revision++; draft.draftRevision = crypto.randomUUID();
    delete draft.approvedAt;
    if (needsPdf) {
      delete draft.pdf_base64; delete draft.pdf_key; draft.render_pending = true;
      preview.dirty(true); $('preview-message').textContent = 'Updating preview…';
      clearTimeout(renderTimer); renderTimer = setTimeout(() => refresh().catch(error => status(error.message, true)), 900);
    }
    status('Saving…'); clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persist().catch(error => status(`Could not save: ${error.message}`, true)), 250);
  }
  function fields() {
    $('content-editor').replaceChildren(); $('resume-source').value = draft?.resume || ''; $('letter').value = draft?.letter || '';
    $('generate-letter').disabled = !draft;
    $('approve-documents').disabled = !draft;
    $('advanced-editor').open = Boolean(draft?.manual_source || (draft && !draft.source_outline));
    $('review-notes').replaceChildren();
    if (!draft) { preview.clear(); status('Shortlist this application to prepare a draft.'); return; }
    $('draft-timings').textContent = timingSummary(draft.timings);
    for (const note of [...(draft.changes || []), ...(draft.review_notes || [])]) $('review-notes').append(element('p','small',note));
    for (const entry of draft.manual_source ? [] : (draft.entries || [])) {
      const source = draft.source_outline?.entries.find(item => item.id === entry.id);
      if (!source) continue;
      const card = element('article','card review-entry'); card.append(element('h3','',source.heading[0]), element('p','muted',source.heading.slice(1).filter(Boolean).join(' · ')));
      entry.bullets.forEach((text,index) => {
        const label = element('label','bullet-editor',`Bullet ${index+1}`); const input = element('textarea'); input.rows = 3; input.maxLength = 700; input.value = text;
        label.classList.toggle('changed', !source.bullets.includes(text));
        input.oninput = () => { entry.bullets[index] = input.value; label.classList.toggle('changed', !source.bullets.includes(input.value)); edit(true); };
        label.append(input); card.append(label);
      });
      const sources = element('details','source-facts'); sources.append(element('summary','','Reference facts for this experience'));
      const list = element('ul'); source.bullets.forEach(text => list.append(element('li','',text))); sources.append(list); card.append(sources);
      $('content-editor').append(card);
    }
    if (!draft.manual_source && draft.source_outline && draft.skills) {
      const card = element('article','card'); card.append(element('h3','','Selected skills'));
      for (const row of draft.skills) {
        const source = draft.source_outline.skills.find(s => s.id === row.id); const label = element('label','',source?.label || 'Skills');
        const input = element('textarea'); input.rows=2; input.maxLength=600; input.value=row.text;
        input.oninput=()=>{row.text=input.value;edit(true);}; label.append(input);card.append(label);
      }
      $('content-editor').append(card);
    }
    preview.show(draft); preview.dirty(Boolean(draft.render_pending));
    $('preview-message').textContent = draft.render_error || (draft.pdf_pages ? `${draft.pdf_pages} page${draft.pdf_pages === 1 ? '' : 's'}${draft.pdf_pages > 1 ? ' — review length before approving.' : ''}` : '');
    status(draft.draftRevision ? 'Recovered your saved working draft.' : draft.approvedAt ? 'Approved version. Edits create a separate working draft.' : 'Review the wording against its source facts, then approve.');
  }
  async function open(applicationKey, versionId) {
    await persist(); clearTimeout(renderTimer); epoch++; revision=0; key=applicationKey;
    const record=(await jobs())[key];
    const version = versionId ? record.versions.find(v=>v.id===versionId) : record.workingDraft || record.versions.at(-1);
    draft = version ? structuredClone(await loadPdf(chrome.storage.local,version)) : null;
    fields();
    if (draft?.render_pending) void refresh().catch(error => status(error.message,true));
  }
  async function refresh() {
    clearTimeout(renderTimer);
    if (!draft || !key) return;
    if (!draft.render_pending && draft.pdf_base64) return draft;
    if (rendering) { await rendering; if (!draft || !key || (!draft.render_pending && draft.pdf_base64)) return draft; }
    const currentEpoch=epoch, currentRevision=revision, snapshot=structuredClone(draft);
    $('preview-message').textContent='Compiling preview…';
    rendering=(async()=>{
      const content = snapshot.source_outline && !snapshot.manual_source ? {source_outline:snapshot.source_outline,entries:snapshot.entries,skills:snapshot.skills} : {resume:snapshot.resume};
      const result=await native({action:'render',template:snapshot.template,approved_projects:snapshot.approved_projects || [],...content});
      if (currentEpoch!==epoch || currentRevision!==revision) return;
      Object.assign(draft,result,{render_pending:false,render_error:'',timings:{...draft.timings,...result.timings}});
      $('resume-source').value=draft.resume; preview.show(draft); preview.dirty(false);
      $('preview-message').textContent=`${result.pdf_pages || '?'} page(s)${result.pdf_pages > 1 ? ' — review length before approving.' : ''}`;
      await persist();
    })();
    try { await rendering; }
    catch(error) { if(currentEpoch===epoch && currentRevision===revision){draft.render_error=error.message;await persist();$('preview-message').textContent=error.message;} throw error; }
    finally {rendering=null;}
    return draft;
  }
  $('resume-source').oninput=()=>{if(draft){draft.resume=$('resume-source').value;draft.manual_source=true;$('content-editor').replaceChildren(element('p','muted','This working draft uses your edited LaTeX source.'));edit(true);}};
  $('letter').oninput=()=>{if(draft){draft.letter=$('letter').value;edit(false);}};
  on('refresh-preview',async()=>{if(draft){draft.render_pending=true;await refresh();}});
  on('generate-letter',async()=>{
    if(!draft)throw new Error('Prepare a resume first.');
    const currentEpoch=epoch, previousLetter=draft.letter || '';
    $('letter-status').textContent='Generating from this application’s saved profile…';
    try {
      const result=await native({action:'generate_letter',job:draft.job,profile:draft.profile});
      if(epoch!==currentEpoch || draft.letter!==previousLetter)throw new Error('The draft changed during generation. Your edits were preserved.');
      draft.letter=result.letter;draft.review_notes=[...(draft.review_notes||[]),...result.review_notes];$('letter').value=result.letter;edit();await persist();
      $('letter-status').textContent='Letter saved. Review it before approving your documents.';
    }catch(error){$('letter-status').textContent=error.message;throw error;}
  });
  on('approve-documents',async()=>{
    if(!draft)throw new Error('Prepare documents first.');
    const currentKey=key,currentEpoch=epoch,currentRevision=revision;
    await persist();await refresh();
    if(epoch!==currentEpoch || revision!==currentRevision)throw new Error('The draft changed. Review the updated preview and approve again.');
    if(draft.letter && draft.letter.trim().length<100)throw new Error('Use a complete cover letter (at least 100 characters) or leave it empty.');
    const stored=await storePdf(chrome.storage.local,draft);
    if(epoch!==currentEpoch || revision!==currentRevision)throw new Error('The draft changed. Review it and approve again.');
    const version=await editJob(currentKey,record=>{
      if(record.workingDraft && record.workingDraft.draftRevision!==draft.draftRevision)throw new Error('Another window changed this draft. Reopen it before approval.');
      return approveDraft(record,stored);
    });
    if(epoch!==currentEpoch)return;
    draft=await loadPdf(chrome.storage.local,version);fields(); await approved(currentKey,version);
  });
  window.addEventListener('pagehide',()=>{void persist();preview.clear();});
  return {open,persist,refresh,close:async()=>{await persist();clearTimeout(renderTimer);epoch++;key=null;draft=null;preview.clear();},current:()=>draft};
}
