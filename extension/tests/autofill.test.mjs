import test from 'node:test';
import assert from 'node:assert/strict';
import {validateProfile,supportedATS,matchField,valueFor,matchingOption} from '../autofill/profile.js';
import {createAutofillService} from '../autofill/service.js';

test('maps contact and education fields, preserving ambiguity and sensitive questions for manual review',()=>{
  for(const [label,key] of [['First name *','firstName'],['Last Name (required)','lastName'],['Email Address','email'],['University','university'],['LinkedIn Profile URL','linkedin'],['Field of study','major'],['Expected graduation year','graduationYear']])assert.equal(matchField({label}),key,label);
  for(const label of ['Sponsorship required?','Gender','How did you hear about us?','Reference name','Employer name','Password'])assert.equal(matchField({label}),null,label);
  assert.equal(matchField({label:'Name',context:'Emergency contact',autocomplete:'name'}),null);
  assert.equal(matchField({hints:['firstName']}),'firstName');
  assert.equal(valueFor('fullName',{firstName:'Ada',lastName:'Lovelace'}),'Ada Lovelace');
  assert.throws(()=>validateProfile({email:'not an email'}),/email/);
  assert.throws(()=>validateProfile({website:'javascript:alert(1)'}),/HTTP/);
  assert.throws(()=>validateProfile({salary:100}),/Unknown/);
});
test('ATS allowlist excludes lookalikes, HTTP and unrelated account sites',()=>{
  for(const url of ['https://company.wd5.myworkdayjobs.com/en-US/job/1','https://wd1.myworkdaysite.com/recruiting/co/jobs','https://job-boards.greenhouse.io/company/jobs/1','https://jobs.eu.lever.co/company/1'])assert.ok(supportedATS(url));
  for(const url of ['http://jobs.lever.co/company/1','https://jobs.lever.co.evil.test/','https://login.workday.com/','https://example.com/','javascript:alert(1)'])assert.equal(supportedATS(url),null);
});
test('native dropdowns require one exact value or label match',()=>{
  assert.equal(matchingOption([{text:'United States',value:'US'}],'United States of America'),'US');
  assert.equal(matchingOption([{text:'Engineering',value:'1'},{text:'Electrical Engineering',value:'2'}],'Engineering'),'1');
  assert.equal(matchingOption([{text:'Engineering',value:'1'},{text:'Engineering',value:'2'}],'Engineering'),null);
  assert.equal(matchingOption([{text:'California',value:'CA'}],'New York'),null);
});
function storage(initial={}){let data=structuredClone(initial);return {get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in data).map(k=>[k,structuredClone(data[k])])),set:async values=>{Object.assign(data,structuredClone(values));},remove:async key=>{delete data[key];}};}
function fixture(handler=async()=>({answer:'My reviewed answer.',review_notes:[]})){
  const key='https://example.com/jobs/1',url='https://jobs.lever.co/example/123',version={id:'v1',job:{title:'Intern',description:'Saved JD '.repeat(20)},profile:{facts:'Saved facts '.repeat(20)},pdf_base64:'JVBERi0='};
  const local=storage({jobs:{[key]:{job:version.job,versions:[version]}},autofillProfile:{firstName:'Ada'},profile:{facts:'Different current facts '.repeat(20)}}),session=storage(),calls=[];
  const native=async request=>{calls.push(request);return handler(request);};
  const service=createAutofillService({local,session,native,tabs:{get:async()=>({url}),sendMessage:async()=>({filled:1,manual:2,preserved:1})},scripting:{executeScript:async()=>[{documentId:'doc1',result:url}]}});
  const sender={tab:{id:7},documentId:'doc1',url};
  return {service,key,url,version,sender,calls,local};
}
test('answers and PDFs require a popup-started session and exact browser document',async()=>{
  const f=fixture(),question={question:'Why this role?',maxLength:200};
  await assert.rejects(()=>f.service.answer(question,f.sender),/Choose/);
  assert.equal((await f.service.start({tabId:7,key:f.key,versionId:'v1'})).filled,1);
  await assert.rejects(()=>f.service.answer(question,{...f.sender,documentId:'other'}),/Choose/);
  await assert.rejects(()=>f.service.answer(question,{...f.sender,url:f.url+'/other'}),/Choose/);
  await f.service.answer({...question,profile:{facts:'untrusted'},job:{title:'untrusted'}},f.sender);
  assert.deepEqual(f.calls[0].profile,f.version.profile);assert.deepEqual(f.calls[0].job,f.version.job);
  assert.equal((await f.service.contentResume(f.sender)).versionId,'v1');
  await f.service.stop(7);await assert.rejects(()=>f.service.contentResume(f.sender),/Choose/);
});
test('missing PDFs and oversized questions fail without generation',async()=>{
  const f=fixture();await f.service.start({tabId:7,key:f.key});
  await assert.rejects(()=>f.service.contentResume(f.sender),/Select a compiled/);
  await assert.rejects(()=>f.service.answer({question:'x'.repeat(2001),maxLength:200},f.sender),/too long/);
  assert.equal(f.calls.length,0);
});
test('simultaneous answer requests start only one model and release the slot afterwards',async()=>{
  const f=fixture(),question={question:'Why this role?',maxLength:200};
  await f.service.start({tabId:7,key:f.key,versionId:'v1'});
  const results=await Promise.allSettled([f.service.answer(question,f.sender),f.service.answer(question,f.sender)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/already generating/);
  assert.equal(f.calls.length,1);
  await f.service.answer(question,f.sender);assert.equal(f.calls.length,2);
});
test('stopping or replacing an application grant discards an in-flight answer',async()=>{
  for(const operation of ['stop','replace']){
    let finish,entered;
    const started=new Promise(resolve=>{entered=resolve;});
    const f=fixture(()=>new Promise(resolve=>{finish=resolve;entered();}));
    await f.service.start({tabId:7,key:f.key,versionId:'v1'});
    const pending=f.service.answer({question:'Why this role?',maxLength:200},f.sender);
    const rejected=assert.rejects(pending,operation==='stop'?/Choose/:/selected application changed/);
    await started;
    if(operation==='stop')await f.service.stop(7);
    else await f.service.start({tabId:7,key:f.key,versionId:'v1'});
    finish({answer:'Old application answer.',review_notes:[]});
    await rejected;
  }
});
test('model failures free the tab for a retry and old helpers give setup instructions',async()=>{
  let fail=true;
  const f=fixture(async()=>{if(fail)throw new Error('Unsupported action');return {answer:'Retry succeeded.',review_notes:[]};});
  await f.service.start({tabId:7,key:f.key,versionId:'v1'});
  const question={question:'Why this role?',maxLength:200};
  await assert.rejects(()=>f.service.answer(question,f.sender),/install_helper.py/);
  fail=false;assert.equal((await f.service.answer(question,f.sender)).answer,'Retry succeeded.');
});
