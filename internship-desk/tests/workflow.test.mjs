import test from 'node:test';
import assert from 'node:assert/strict';
import {nextAction,approveDraft,markApplied,recommendTemplate,visibleApplications,normalizeRecord} from '../extension/workflow.js';
import {ingestSheet,parseCSV,guessMapping,matchApplication} from '../extension/sheets.js';
const job={title:'RTL FPGA Intern',company:'Example',url:'https://example.com/job',description:'SystemVerilog, UVM and FPGA verification',location:'',deadline:''};
const record=()=>({job,versions:[],status:'Saved',updated:'2026-10-04T00:00:00Z'});
test('application decisions distinguish inbox, review, approval, submission and imported updates',()=>{
 const r=normalizeRecord(record());assert.equal(nextAction(r).key,'inbox');r.shortlistedAt=r.updated;assert.equal(nextAction(r).key,'shortlisted');
 const draft={resume:'latex',letter:'',pdf_key:'pdf:'+'a'.repeat(64),created:r.updated};r.versions.push({...draft,id:'generated'});assert.equal(nextAction(r).key,'review');
 const approved=approveDraft(r,draft);assert.equal(nextAction(r).key,'ready');markApplied(r);assert.equal(r.submission.versionId,approved.id);assert.equal(nextAction(r).key,'applied');
 r.workingDraft={...draft,resume:'new edits'};assert.throws(()=>markApplied(r),/Approve/);assert.equal(r.versions.find(v=>v.id===approved.id).resume,'latex');
 const update={id:'external',currentEvent:'interview'};assert.equal(nextAction(r,null,[update]).key,'updates');r.reviewedUpdates=['external:interview'];assert.equal(nextAction(r,null,[update]).key,'applied');
});
test('new approvals preserve previously submitted versions',()=>{const r=normalizeRecord(record());const first=approveDraft(r,{resume:'one',pdf_base64:'pdf'});markApplied(r);approveDraft(r,{resume:'two',pdf_base64:'pdf'});assert.equal(r.submission.versionId,first.id);assert.equal(r.versions[0].resume,'one');});
test('Today includes due reminders and upcoming deadlines, excluding archived records',()=>{const r=normalizeRecord(record());r.followUp='2026-10-03';const all={[job.url]:r};assert.equal(visibleApplications(all,[],{},'today','','2026-10-04').length,1);r.archivedAt=r.updated;assert.equal(visibleApplications(all,[],{},'today','','2026-10-04').length,0);});
test('template focus is recommended per job',()=>{assert.equal(recommendTemplate(job).template,'fpga');assert.equal(recommendTemplate({...job,title:'Power electronics',description:'Battery BMS converters and grid energy'}).template,'power');});
test('Sheet application IDs resolve to stable local identities without replacing manual state',()=>{const r=normalizeRecord(record());const table=parseCSV(`Company,Role,Status,Application ID\nExample,Renamed role,Interview,${r.id}\n`);const tracker=ingestSheet(null,table,{kind:'csv',key:'csv:local',mapping:guessMapping(table.headers)});const external=Object.values(tracker.records)[0];assert.equal(matchApplication(external,{[job.url]:r}).key,job.url);assert.equal(r.status,'Saved');});

test('a regenerated resume needs fresh approval before submission',()=>{const r=normalizeRecord(record());approveDraft(r,{resume:'one',pdf_base64:'pdf'});r.versions.push({id:'new-generation',resume:'two'});assert.equal(nextAction(r).key,'review');assert.throws(()=>markApplied(r),/Approve/);});
