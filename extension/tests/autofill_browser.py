"""Real extension + React popup on isolated ATS fixtures; model responses are mocked."""
import asyncio
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from playwright.async_api import async_playwright

ROOT=Path(__file__).resolve().parents[1]
HTML='''<!doctype html><html><head><title>Example Labs — application</title><style>body{font:16px system-ui;max-width:700px;margin:25px auto}label{display:block;margin:16px 0}input,select,textarea{display:block;padding:10px;width:95%;min-height:24px}input[type=checkbox]{display:inline;width:auto}textarea{height:90px}</style></head><body>
<h1>FPGA Intern</h1><p>Application for Example Labs</p><form id="application" onsubmit="event.preventDefault();window.submitted=true">
<div id="react"></div><label>Last name<input name="lastName" id="last"></label>
<label>Email address<input id="email" type="email" autocomplete="email"></label><label>Phone<input id="phone" type="tel" value="KEEP THIS NUMBER"></label>
<label>University<input id="university"></label><label>Country<select id="country"><option value="" selected>Select one</option><option value="US">United States</option><option value="CA">Canada</option></select></label>
<label>LinkedIn profile URL<input id="linkedin"></label><label>Desired salary<input id="salary"></label>
<label><input type="checkbox" id="consent">I agree to the terms</label><label>Why are you interested in this role?<textarea id="essay" maxlength="600"></textarea></label>
<label>Resume<input id="resume" type="file" accept=".pdf"></label>
<input id="hidden" type="hidden" name="firstName"><label style="display:none">Name<input id="honeypot" name="name"></label>
<fieldset><legend>Emergency contact</legend><label>Name<input id="emergency" autocomplete="name"></label></fieldset>
<button type="submit" id="submit">Submit application</button></form>
<form id="account"><label>Email address<input id="login-email" autocomplete="email"></label><label>Password<input id="password" type="password"></label><button>Create account</button></form>
<div id="dynamic"></div><script src="/fixture-react.js"></script></body></html>'''
REACT='''import React,{useState} from 'react';import {createRoot} from 'react-dom/client';function Form(){const [value,set]=useState('');return <label>First name<input id="react-first" value={value} onChange={e=>set(e.target.value)}/><output id="react-state">{value}</output></label>}createRoot(document.getElementById('react')).render(<Form/>);'''

async def until(page,expression):
    for _ in range(400):
        if await page.evaluate(expression):return
        await asyncio.sleep(.05)
    raise AssertionError(expression)

async def main():
    async with async_playwright() as playwright:
        with tempfile.TemporaryDirectory(prefix='internship-autofill-') as folder:
            folder=Path(folder);extension=folder/'extension'
            shutil.copytree(ROOT,extension,ignore=shutil.ignore_patterns('node_modules','__pycache__','.test-output'))
            fixture_js=folder/'fixture.js'
            subprocess.run(['node','--input-type=module','-e',"import {build} from 'esbuild';await build({stdin:{contents:process.argv[1],resolveDir:process.cwd(),loader:'jsx'},bundle:true,minify:true,outfile:process.argv[2],define:{'process.env.NODE_ENV':'\"production\"'}});",REACT,str(fixture_js)],cwd=ROOT,check=True)
            context=await playwright.chromium.launch_persistent_context(str(folder/'browser'),channel='chromium',headless=True,args=[f'--disable-extensions-except={extension}',f'--load-extension={extension}','--no-sandbox'])
            await context.route('https://**/*',lambda route:route.fulfill(body=fixture_js.read_text() if route.request.url.endswith('/fixture-react.js') else HTML,content_type='application/javascript' if route.request.url.endswith('/fixture-react.js') else 'text/html'))
            worker=context.service_workers[0] if context.service_workers else await context.wait_for_event('serviceworker')
            extension_id=worker.url.split('/')[2]
            key='https://example.test/jobs/1'
            profile={'firstName':'Ada','lastName':'Lovelace','email':'ada@example.test','phone':'12345678','university':'Example University','country':'United States','linkedin':'https://linkedin.com/in/example','city':'Tampa'}
            job={'title':'FPGA Intern','company':'Example Labs','url':key,'description':'Design and test digital systems with verified FPGA skills. '*10,'location':'Tampa','deadline':''}
            version={'id':'version-1','created':'2026-10-05T12:00:00Z','template':'fpga','resume':'source','letter':'','job':job,'profile':{'facts':'Verified FPGA experience. '*10},'pdf_base64':'JVBERi0xLjQK'}
            await worker.evaluate('''async data=>{await chrome.storage.local.set(data);globalThis.answerCalls=[];globalThis.answerDelay=0;chrome.runtime.connectNative=()=>{let callback;return {onMessage:{addListener:f=>callback=f},onDisconnect:{addListener:()=>{}},disconnect:()=>{},postMessage:request=>{answerCalls.push(request);setTimeout(()=>callback({answer:'I enjoy applying my verified FPGA experience to reproducible hardware tests.',review_notes:['Check the wording before submitting.']}),answerDelay);}};};}''',{'jobs':{key:{'job':job,'versions':[version],'status':'Saved','updated':version['created']}},'autofillProfile':profile,'profile':version['profile'],'autofillSelection':{'key':key,'versionId':version['id']}})
            errors=[]
            page=await context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
            url='https://example.wd5.myworkdayjobs.com/en-US/jobs/job/123/apply'
            await page.goto(url);await page.wait_for_selector('#react-first');await page.get_by_role('button',name='Generate answer',exact=True).wait_for()
            assert await page.locator('#email').input_value()==''
            tab_id=await worker.evaluate('''async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id''',url)
            # Opening popup.html as a test page doesn't create a browser action popup;
            # supply the same active website tab it would receive in that surface.
            original=(extension/'popup.js').read_text()
            (extension/'popup.js').write_text(f"const query=chrome.tabs.query.bind(chrome.tabs);chrome.tabs.query=options=>options.active?chrome.tabs.get({tab_id}).then(tab=>[tab]):query(options);\n"+original)
            popup=await context.new_page();popup.on('pageerror',lambda error:errors.append(str(error)))
            await popup.set_viewport_size({'width':600,'height':600});await popup.goto(f'chrome-extension://{extension_id}/popup.html');await popup.locator('#fill-page').wait_for()
            await popup.locator('#fill-page').click();await until(page,"()=>document.querySelector('#email').value==='ada@example.test'")
            assert await page.locator('#react-first').input_value()=='Ada';assert await page.locator('#react-state').inner_text()=='Ada'
            assert await page.locator('#last').input_value()=='Lovelace';assert await page.locator('#phone').input_value()=='KEEP THIS NUMBER';assert await page.locator('#country').input_value()=='US'
            assert await page.locator('#salary').get_attribute('data-internship-autofill')=='manual'
            assert await page.locator('#consent').get_attribute('data-internship-autofill')=='manual'
            for selector in ['#emergency','#login-email','#password','#hidden','#honeypot']:assert await page.locator(selector).input_value()==''
            await page.evaluate("document.querySelector('#dynamic').innerHTML='<label>City<input id=city></label>'")
            await until(page,"()=>document.querySelector('#city').value==='Tampa'")
            # A user-cleared field must stay empty when unrelated DOM updates arrive.
            await page.locator('#city').fill('')
            await page.evaluate("document.querySelector('#dynamic').append(document.createElement('p'))")
            await until(page,"()=>document.querySelector('#city').dataset.internshipAutofill==='manual'")
            assert await page.locator('#city').input_value()==''
            await page.get_by_role('button',name='Generate answer',exact=True).click();await page.get_by_role('button',name='Use this answer',exact=True).wait_for()
            assert await page.locator('#essay').input_value()==''
            await page.get_by_role('button',name='Use this answer',exact=True).click();assert 'verified FPGA' in await page.locator('#essay').input_value()
            await worker.evaluate('answerDelay=400');await page.get_by_role('button',name='Generate answer',exact=True).click();await page.locator('#essay').fill('My own answer, typed while generation was running.')
            await page.get_by_role('button',name='Use this answer',exact=True).click();assert await page.locator('#essay').input_value()=='My own answer, typed while generation was running.'
            await worker.evaluate('answerDelay=0')
            async with page.expect_download() as download:await page.get_by_role('button',name='Download selected resume',exact=True).click()
            assert (await download.value).suggested_filename=='Example_Labs_Resume.pdf'
            assert not await page.evaluate('Boolean(window.submitted)');assert not await page.locator('#consent').is_checked()
            await popup.screenshot(path='/tmp/internship-autofill-apply.png')
            await popup.get_by_role('tab',name='Capture & tracking').click();await popup.locator('#save-current').wait_for();await popup.screenshot(path='/tmp/internship-autofill-capture.png')
            assert await popup.evaluate('document.documentElement.scrollWidth')==600
            await popup.get_by_label('Color theme').select_option('light');await until(popup,"()=>document.documentElement.dataset.theme==='light'");await popup.screenshot(path='/tmp/internship-autofill-light.png')
            await popup.get_by_role('tab',name='Apply & autofill').click();await popup.locator('details.profile-editor > summary').click()
            await popup.get_by_label('First name',exact=True).fill('Unsaved contact edit')
            await worker.evaluate("chrome.storage.local.set({queueSettings:{paused:true}})")
            await popup.get_by_text('Queue paused',exact=True).wait_for()
            assert await popup.get_by_label('First name',exact=True).input_value()=='Unsaved contact edit'
            await popup.get_by_role('button',name='Edit JSON',exact=True).click();await popup.get_by_label('Profile JSON').fill('{bad json');await popup.get_by_role('button',name='Save autofill profile').click();await popup.locator('#popup-notice.error').wait_for()
            # Reloading or moving to another application cannot reuse a prior document grant.
            await page.reload();await page.get_by_role('button',name='Generate answer',exact=True).wait_for();await page.get_by_role('button',name='Generate answer',exact=True).click();assert await page.locator('#email').input_value()==''
            for ats_url in ['https://job-boards.greenhouse.io/example/jobs/123','https://jobs.lever.co/example/123']:
                await page.goto(ats_url);await page.get_by_role('button',name='Generate answer',exact=True).wait_for()
                await popup.reload();await popup.locator('#fill-page').wait_for();await popup.locator('#fill-page').click();await until(page,"()=>document.querySelector('#email').value==='ada@example.test'")
            await popup.locator('#autofill-version').select_option('')
            await until(page,"()=>!document.querySelector('[data-internship-autofill]')")
            await popup.locator('#autofill-version').select_option(version['id'])
            await popup.locator('#fill-page').click()
            await until(page,"()=>Boolean(document.querySelector('[data-internship-autofill]'))")
            await popup.reload();await popup.locator('#fill-page').wait_for()
            await popup.get_by_role('button',name='Pause autofill & clear highlights').click();await until(page,"()=>!document.querySelector('[data-internship-autofill]')")
            calls=await worker.evaluate('answerCalls');assert all(call['job']==job and call['profile']==version['profile'] for call in calls)
            assert not errors,errors
            print(json.dumps({'checks':['three ATS hosts','React controlled fields','preserve user values and cleared fields','unknown and consent highlights','hidden/login fields ignored','dynamic fields','review before answer insertion','concurrent edits preserved','resume download','no submissions','600px tabbed popup','light theme','JSON error handling','unsaved profile edits survive queue updates','reload isolation','selection changes pause autofill','pause available after popup reopens'],'model_calls':len(calls),'browser_errors':errors}))
            await context.close()

asyncio.run(main())
