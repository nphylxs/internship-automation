import {supportedATS,validateProfile} from './profile.js';
import {loadPdf} from '../documents.js';
import {generationOptions} from '../generation.js';

const sessionKey = tabId => `autofill:${tabId}`;
export function createAutofillService({local,session,tabs,scripting,native}) {
  const inProgress = new Set();
  async function selected(key,versionId) {
    const {jobs={}} = await local.get('jobs');
    const record = jobs[key];
    if (!record) throw new Error('Choose a saved application first.');
    const version = versionId ? (record.versions || []).find(v => v.id === versionId) : null;
    if (versionId && !version) throw new Error('That document version is no longer available.');
    return {record,version};
  }
  async function frames(tabId) {
    const tab = await tabs.get(tabId);
    if (!supportedATS(tab.url)) throw new Error('Open a Workday, Greenhouse, or Lever application page.');
    const values = await scripting.executeScript({target:{tabId,allFrames:true},func:() => location.href});
    return values.filter(frame => frame.documentId && supportedATS(frame.result));
  }
  async function start({tabId,key,versionId}) {
    if (!Number.isInteger(tabId)) throw new Error('Open an application tab first.');
    const {record,version} = await selected(key,versionId);
    const {autofillProfile} = await local.get('autofillProfile');
    const profile = validateProfile(autofillProfile || {});
    if (!Object.values(profile).some(Boolean)) throw new Error('Save your autofill contact and education profile first.');
    const targets = await frames(tabId);
    if (!targets.length) throw new Error('No supported application frame found. Reload this page after updating the extension.');
    // Bind requests to these actual browser documents, not a page-supplied URL.
    await session.set({[sessionKey(tabId)]:{key,versionId:version?.id || '',frames:targets.map(f => ({documentId:f.documentId,url:f.result})),started:Date.now(),id:crypto.randomUUID()}});
    const results = await Promise.all(targets.map(async target => {
      try {
        return await tabs.sendMessage(tabId,{action:'autofill_apply',profile,context:{title:record.job.title,company:record.job.company,versionId:version?.id || ''}},{documentId:target.documentId});
      } catch { return {error:'Reload the application page to activate the updated extension.'}; }
    }));
    const valid = results.filter(r => r && !r.error);
    if (!valid.length) { await session.remove(sessionKey(tabId)); throw new Error(results[0]?.error || 'Could not reach the application page.'); }
    return {filled:valid.reduce((n,r) => n+r.filled,0),manual:valid.reduce((n,r) => n+r.manual,0),preserved:valid.reduce((n,r) => n+r.preserved,0),frames:valid.length};
  }
  async function stop(tabId) {
    const saved = (await session.get(sessionKey(tabId)))[sessionKey(tabId)];
    await session.remove(sessionKey(tabId));
    if (saved) await Promise.allSettled(saved.frames.map(frame => tabs.sendMessage(tabId,{action:'autofill_stop'},{documentId:frame.documentId})));
    return {};
  }
  async function authorize(sender) {
    if (!sender.tab || !supportedATS(sender.url) || !sender.documentId) throw new Error('This page is not authorized for autofill.');
    const saved = (await session.get(sessionKey(sender.tab.id)))[sessionKey(sender.tab.id)];
    if (!saved || Date.now()-saved.started > 2*60*60*1000 || !saved.frames.some(f => f.documentId===sender.documentId && f.url===sender.url)) throw new Error('Choose this application and click Fill this page in Internship Desk again.');
    return saved;
  }
  async function resume(key,versionId) {
    const {record,version} = await selected(key,versionId);
    if (!version) throw new Error('Select a compiled resume version in the popup.');
    const loaded = await loadPdf(local,version);
    if (!loaded.pdf_base64 || loaded.render_pending || loaded.render_error) throw new Error('Compile and review this resume in Applications first.');
    const name = `${record.job.company || 'Application'}_Resume`.replace(/[^a-zA-Z0-9_-]+/g,'_').slice(0,80);
    return {pdf_base64:loaded.pdf_base64,filename:`${name}.pdf`,versionId:version.id};
  }
  async function answer(message,sender) {
    const saved = await authorize(sender);
    if (typeof message.question !== 'string' || !message.question.trim() || message.question.length>2000) throw new Error('The application question is missing or too long.');
    if (!Number.isInteger(message.maxLength) || message.maxLength<1 || message.maxLength>4000) throw new Error('Invalid answer length.');
    if (inProgress.has(sender.tab.id)) throw new Error('An answer is already generating for this tab. Wait for it to finish.');
    // Acquire before the next await so simultaneous clicks cannot start two models.
    inProgress.add(sender.tab.id);
    try {
      const {record,version} = await selected(saved.key,saved.versionId);
      const {profile={},generationSettings} = await local.get(['profile','generationSettings']);
      const facts = version?.profile || profile, job = version?.job || record.job;
      const result = await native({action:'generate_answer',question:message.question,max_length:message.maxLength,job,profile:facts,generation:generationOptions(generationSettings)});
      const latest = await authorize(sender); // Navigation or Stop invalidates an in-flight result.
      if (latest.id!==saved.id) throw new Error('The selected application changed. Generate a new answer for this application.');
      if (typeof result.answer!=='string' || result.answer.length>message.maxLength || !Array.isArray(result.review_notes) || !result.review_notes.every(note => typeof note==='string')) throw new Error('The helper returned an invalid answer.');
      return result;
    } catch (error) {
      if (error.message==='Unsupported action') throw new Error('Update the local helper for answer generation: python3 install_helper.py YOUR_EXTENSION_ID --browser brave (from the extension folder).');
      throw error;
    } finally { inProgress.delete(sender.tab.id); }
  }
  return {start,stop,resume,answer,async contentResume(sender) {const saved=await authorize(sender);return resume(saved.key,saved.versionId);}};
}
