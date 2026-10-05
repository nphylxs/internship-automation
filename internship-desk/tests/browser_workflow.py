"""Isolated workflow smoke test. Model calls are mocked; PDFs use real pdflatex."""
import asyncio
import json
from pathlib import Path
import shutil
import sys
import tempfile
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from native_host.host import handle,baseline_for,tex_escape
from native_host.profile import library_content
from native_host.content import template_content,outline,assemble
from native_host import exports

async def until(page, expression):
 for _ in range(600):
  if await page.evaluate(expression):return
  await asyncio.sleep(.05)
 raise AssertionError(await page.locator('#notice').inner_text() + ' | ' + expression)

async def main():
 async with async_playwright() as p:
  with tempfile.TemporaryDirectory(prefix='internship-workflow-') as folder:
   root=Path(folder);extension=root/'extension';shutil.copytree(ROOT/'extension',extension)
   exports.SETTINGS_PATH=root/'export-settings.json';exports.configure({'directory':str(root/'packets'),'enabled':False})
   context=await p.chromium.launch_persistent_context(str(root/'browser'),channel='chromium',headless=True,args=[f'--disable-extensions-except={extension}',f'--load-extension={extension}','--no-sandbox'])
   worker=context.service_workers[0] if context.service_workers else await context.wait_for_event('serviceworker');ext=worker.url.split('/')[2]
   calls=[]
   def native(request):
    calls.append(request['action'])
    if request['action']=='generate':
     assert request['include_letter'] is False
     name,base=baseline_for(request);source=library_content(base,request['profile'],name,tex_escape) if request['profile'].get('library') else template_content(base)
     entries=[next(e for e in source['entries'] if e['section']==section) for section in ('Education','Experience','Projects')]
     payload={'entries':[{'id':e['id'],'bullets':e['bullets'][:2]} for e in entries],'skills':[{'id':source['skills'][0]['id'],'text':'SystemVerilog, Python'}],'letter':'','changes':['Selected relevant verified experience.'],'review_notes':['Review all claims.']}
     return {**payload,'resume':assemble(base,source,payload,tex_escape),'source_outline':outline(source),'template':name,'render_pending':True,'approved_projects':[],'timings':{'model_ms':100}}
    if request['action']=='generate_letter':return {'letter':'Dear Hiring Team,\n\n'+'I would welcome the opportunity to apply my verified engineering experience to this internship. '*15,'changes':[],'review_notes':[]}
    return handle(request)
   await worker.evaluate('''() => {globalThis.pendingNative=new Map();globalThis.sequence=0;chrome.runtime.connectNative=()=>{let callback;return {onMessage:{addListener:f=>callback=f},onDisconnect:{addListener:()=>{}},disconnect:()=>{},postMessage:request=>pendingNative.set(++sequence,{request,deliver:result=>callback(result)})};};}''')
   async def bridge():
    while True:
     items=await worker.evaluate('''() => [...pendingNative].filter(([,c])=>!c.started).map(([id,c])=>{c.started=true;return {id,request:c.request};})''')
     for item in items:
      try:result=await asyncio.to_thread(native,item['request'])
      except Exception as error:result={'error':str(error)}
      await worker.evaluate('''([id,result])=>{const c=pendingNative.get(id);if(c){c.deliver({event:'progress',stage:'model_working'});c.deliver(result);pendingNative.delete(id);}}''',[item['id'],result])
     await asyncio.sleep(.03)
   task=asyncio.create_task(bridge())
   page=await context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   await page.expose_function('stubNative',native)
   async def stub_page():
    await page.evaluate('''() => {chrome.runtime.connectNative=()=>{let callback;return {onMessage:{addListener:f=>callback=f},onDisconnect:{addListener:()=>{}},disconnect:()=>{},postMessage:async request=>{try{callback({event:'progress',stage:'model_working'});callback(await window.stubNative(request));}catch(error){callback({error:error.message});}}};};}''')
   await page.goto(f'chrome-extension://{ext}/workspace.html');await until(page, "()=>document.querySelector('#notice').textContent==='Ready.'");await stub_page()
   await page.get_by_role('button',name='Profile & settings',exact=True).click();await page.locator('#import-library').click();await page.wait_for_selector('.experience')
   await page.get_by_label('I have reviewed all experience records below').check();await page.locator('#save-profile').click();await until(page, "()=>document.querySelector('#profile-status').textContent.startsWith('Reviewed profile saved')")
   await page.get_by_role('button',name='Applications',exact=True).click();await page.locator('#add-job').click()
   job={'title':'FPGA Intern','company':'Example Labs','url':'https://example.test/jobs/fpga','location':'Tampa','deadline':'','description':'FPGA and SystemVerilog verification internship. Work with Python test tooling, RTL design, and clock-domain crossing. Must be an enrolled engineering student. '*3}
   for field,value in job.items():await page.locator(f'#job-form [name="{field}"]').fill(value)
   await page.locator('#job-form button[type=submit]').click();await page.wait_for_selector('#detail-screen:not([hidden])')
   assert await page.locator('#job-template').input_value()=='fpga';assert calls.count('generate')==0
   await page.locator('#prepare-job').click();await until(page, "async()=>{const {generationQueue=[]}=await chrome.storage.local.get('generationQueue');return generationQueue.length && generationQueue.every(q=>q.state==='completed');}")
   await page.get_by_role('button',name='Documents',exact=True).click();await page.wait_for_selector('#content-editor textarea');assert calls.count('generate')==1
   assert not list((root/'packets').rglob('*.pdf'))
   editor=page.locator('#content-editor textarea').first;await editor.fill('Reviewed engineering experience with reproducible verification results.')
   await until(page, "async()=>{const {jobs}=await chrome.storage.local.get('jobs');const d=Object.values(jobs)[0].workingDraft;return d?.pdf_key && !d.render_pending && d.resume.includes('Reviewed engineering');}")
   await page.reload();await until(page, "()=>document.querySelector('#notice').textContent==='Ready.'");await stub_page()
   await page.get_by_role('button',name='Review documents',exact=True).click();await page.wait_for_selector('#content-editor textarea');assert 'Reviewed engineering' in await page.locator('#content-editor textarea').first.input_value(), await page.evaluate("async()=>({d:Object.values((await chrome.storage.local.get('jobs')).jobs)[0].workingDraft,editor:document.querySelector('#content-editor textarea')?.value})")
   await page.locator('#generate-letter').click();await until(page, "()=>document.querySelector('#letter').value.startsWith('Dear Hiring Team')")
   await page.locator('#approve-documents').click();await until(page, "async()=>{const {jobs}=await chrome.storage.local.get('jobs');return Boolean(Object.values(jobs)[0].approvedVersion);}")
   await page.locator('#export-approved').click();await until(page, "()=>document.querySelector('#packet-status').textContent.includes('Resume.pdf')")
   assert len(list((root/'packets').rglob('*.pdf')))==2
   await page.locator('#mark-applied').click();await until(page, "async()=>{const {jobs}=await chrome.storage.local.get('jobs');return Boolean(Object.values(jobs)[0].submission);}")
   saved=await page.evaluate("async()=>Object.values((await chrome.storage.local.get('jobs')).jobs)[0]");assert saved['submission']['versionId']==saved['approvedVersion'];assert not saved.get('workingDraft');assert calls.count('generate')==1
   await page.get_by_role('button',name='Profile & settings',exact=True).click()
   csv=f"Company,Role,Status,Date,Notes,Next step,Application ID\nExample Labs,FPGA Intern,Interview Invited,2026-10-04,Interview invitation,Choose a time,{saved['id']}\n"
   await page.locator('#sheet-csv').set_input_files({'name':'updates.csv','mimeType':'text/csv','buffer':csv.encode()});await page.locator('#sheet-connect').click();await until(page, "async()=>Boolean((await chrome.storage.local.get('sheetTracker')).sheetTracker?.lastSync)")
   await page.get_by_role('button',name='Today',exact=True).click();await page.get_by_role('button',name='Review update',exact=True).click();await page.wait_for_selector('#tab-timeline:not([hidden])');assert 'Interview' in await page.locator('#timeline').inner_text()
   await page.locator('#acknowledge-updates').click();await page.locator('#next-step').fill('Choose an interview time');await page.locator('#follow-up').fill('2026-10-04');await page.locator('#save-next-step').click();await until(page, "async()=>Object.values((await chrome.storage.local.get('jobs')).jobs)[0].nextStep==='Choose an interview time'")
   await page.get_by_role('button',name='Profile & settings',exact=True).click()
   async with page.expect_download() as download:await page.locator('#backup').click()
   backup=await download.value;backup_path=root/'backup.json';await backup.save_as(backup_path);data=json.loads(backup_path.read_text());assert all(v.get('pdf_base64') for v in next(iter(data['jobs'].values()))['versions'])
   page.on('dialog',lambda dialog:asyncio.create_task(dialog.accept()))
   await page.locator('#restore').set_input_files(str(backup_path));await until(page, "()=>document.querySelector('#notice').textContent.startsWith('Backup restored')")
   await page.set_viewport_size({'width':360,'height':900});assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth');await page.screenshot(path='/tmp/internship-desk-profile-mobile.png',full_page=True)
   await page.get_by_role('button',name='Applications',exact=True).click();await page.set_viewport_size({'width':1440,'height':1000});await page.screenshot(path='/tmp/internship-desk-applications-v1.png',full_page=True)
   await page.get_by_role('button',name='Choose an interview time',exact=True).click();await page.get_by_role('button',name='Documents',exact=True).click();await page.screenshot(path='/tmp/internship-desk-review-v1.png',full_page=True)
   # Older backups used URL identities and submittedVersion, without workflow fields.
   legacy=json.loads(backup_path.read_text());legacy_record=next(iter(legacy['jobs'].values()))
   for field in ('id','timeline','shortlistedAt','submission','approvedVersion'):legacy_record.pop(field,None)
   legacy['profile'].pop('library',None)
   legacy_path=root/'legacy-backup.json';legacy_path.write_text(json.dumps(legacy))
   await page.get_by_role('button',name='Profile & settings',exact=True).click()
   await page.locator('#restore').set_input_files(str(legacy_path))
   await until(page, "async()=>Object.values((await chrome.storage.local.get('jobs')).jobs)[0].submission?.imported===true")
   migrated=await page.evaluate("async()=>Object.values((await chrome.storage.local.get('jobs')).jobs)[0]")
   assert migrated['id'] and migrated['submission']['versionId']==saved['submittedVersion']
   assert len(migrated['versions'])==len(saved['versions']) and all(v.get('pdf_key') for v in migrated['versions'])
   assert not errors,errors
   print(json.dumps({'checks':['reviewed library','inbox before preparation','recommended focus','resume-only generation','autosave and automatic preview','reload recovery','letter on demand','immutable approval','approved packet export','exact submitted version','Sheets updates in same timeline','next-step reminders','portable backup and restore','legacy backup migration','responsive layout'],'model_calls':calls.count('generate'),'browser_errors':errors}))
   task.cancel();await asyncio.gather(task,return_exceptions=True);await context.close()
asyncio.run(main())
