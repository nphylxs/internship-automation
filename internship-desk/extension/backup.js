import {$,download,notify,on,request} from './client.js';
import {portableBackup,storePdf} from './documents.js';
import {jobs,withStore} from './store.js';
import {canonicalUrl,jobFields} from './core.js';
import {normalizeRecord} from './workflow.js';
import {restoreSheetBackup} from './sheets.js';
export function validateBackup(data) {
  if(data?.format!==1 || !data.jobs || typeof data.jobs!=='object' || Array.isArray(data.jobs))throw new Error('Invalid backup format.');
  for(const [key,record] of Object.entries(data.jobs)) {
    if(!record?.job || canonicalUrl(record.job.url)!==key || !Array.isArray(record.versions) || typeof record.updated!=='string')throw new Error('Invalid application in backup.');
    for(const field of jobFields)if(typeof record.job[field]!=='string')throw new Error('Invalid job fields in backup.');
    for(const version of [...record.versions,...(record.workingDraft?[record.workingDraft]:[])]) {
      if(!version || typeof version.resume!=='string' || typeof version.letter!=='string' || !version.profile || !version.job)throw new Error('Invalid document in backup.');
      if(version.pdf_base64!==undefined && (typeof version.pdf_base64!=='string' || version.pdf_base64.length>650000))throw new Error('Invalid PDF in backup.');
    }
  }
  if(data.profile && (!['facts','skills','constraints'].every(k=>typeof data.profile[k]==='string') || (data.profile.library!==undefined && !Array.isArray(data.profile.library))))throw new Error('Invalid profile in backup.');
  if(data.sheetTracker)restoreSheetBackup(data.sheetTracker);
  return data;
}
export function initBackup() {
  on('backup',async()=>{download(JSON.stringify(await portableBackup(chrome.storage.local),null,2),'internship-desk-backup.json','application/json');notify('Backup exported with your profile, drafts, PDFs, and timelines.');});
  $('restore').onchange=async event=>{
    try {
      const file=event.target.files[0];if(!file)return;if(file.size>50000000)throw new Error('Backup exceeds 50 MB.');
      const data=validateBackup(JSON.parse(await file.text()));
      if(!confirm('Restore this backup? Matching applications and your profile will be replaced. Other applications stay intact. Sheets remains disconnected.'))return;
      await withStore(async()=>{
        const {generationQueue=[]}=await chrome.storage.local.get('generationQueue');if(generationQueue.some(q=>['pending','running','saving'].includes(q.state)))throw new Error('Finish or remove queued work before restoring.');
        const all=await jobs();
        for(const [key,record] of Object.entries(data.jobs)) {
          normalizeRecord(record);
          for(let i=0;i<record.versions.length;i++){delete record.versions[i].pdf_key;record.versions[i]=await storePdf(chrome.storage.local,record.versions[i]);}
          if(record.workingDraft){delete record.workingDraft.pdf_key;record.workingDraft=await storePdf(chrome.storage.local,record.workingDraft);}
          all[key]=record;
        }
        await chrome.storage.local.set({jobs:all,...(data.profile?{profile:data.profile}:{}),...(data.generationSettings?{generationSettings:data.generationSettings}:{})});
      });
      if(data.sheetTracker)await request({action:'sheet_restore',tracker:data.sheetTracker});
      notify('Backup restored. Reload this workspace to load the restored profile.');
    }catch(error){notify(error.message,true);}finally{event.target.value='';}
  };
}
