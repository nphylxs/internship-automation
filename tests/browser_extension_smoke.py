import asyncio, tempfile, json, sys, shutil
from pathlib import Path
from playwright.async_api import async_playwright

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from native_host.host import handle
from native_host import exports
async def main():
  async with async_playwright() as p:
    with tempfile.TemporaryDirectory(prefix='extension-test-') as profile:
      exports.SETTINGS_PATH = Path(profile) / 'export-settings.json'
      exports.configure({'directory': str(Path(profile) / 'application-pdfs'), 'enabled': True})
      # Pregrant only fixture-site access in a temporary copy; production permissions are unchanged.
      test_extension = Path(profile) / 'extension'
      shutil.copytree(ROOT / 'extension', test_extension)
      manifest_path = test_extension / 'manifest.json'
      manifest = json.loads(manifest_path.read_text())
      manifest['permissions'].append('tabs')
      manifest['host_permissions'] = ['https://jobs.fixture.test/*']
      manifest_path.write_text(json.dumps(manifest))
      context=await p.chromium.launch_persistent_context(profile, channel='chromium', headless=True, args=[f'--disable-extensions-except={test_extension}',f'--load-extension={test_extension}', '--no-sandbox'])
      worker=context.service_workers[0] if context.service_workers else await context.wait_for_event('serviceworker')
      ext=worker.url.split('/')[2]
      fixture=await context.new_page()
      extract=(ROOT/'extension/extract.js').read_text().replace('export function', 'function')
      await fixture.set_content('<h1>Fallback title</h1><script type="application/ld+json">'+json.dumps({'@graph':[{'@type':'JobPosting','title':'Structured Intern','hiringOrganization':{'name':'Fixture Inc'},'description':'<p>Use FPGA.</p><p>Enrolled students required.</p>','validThrough':'2027-01-01'}]})+'</script>')
      captured=await fixture.evaluate('('+extract[extract.index('function extractJob'):]+')()')
      assert captured['title']=='Structured Intern'
      assert 'Use FPGA.' in captured['description']
      assert captured['deadline']=='2027-01-01'
      await fixture.set_content('<main>Selected internship description with full requirements.</main>')
      await fixture.evaluate('() => { const r=document.createRange(); r.selectNodeContents(document.querySelector("main")); window.getSelection().addRange(r); }')
      captured=await fixture.evaluate('('+extract[extract.index('function extractJob'):]+')()')
      assert captured['captureNote'].startswith('Captured your selected text')
      await fixture.close()
      page=await context.new_page()
      errors=[]
      page.on('pageerror', lambda e:errors.append(str(e)))
      await page.goto(f'chrome-extension://{ext}/workspace.html')
      await page.get_by_role('button', name='02 / Your profile').click()
      await page.locator('#facts').fill('Alex Example\nalex@example.com\nBS Electrical Engineering, graduation May 2027. Built an FPGA UART project using SystemVerilog. Verified timing and wrote Python tests. ' * 2)
      await page.locator('#skills').fill('FPGA, SystemVerilog, Python')
      await page.locator('#constraints').fill('Available summer 2027; employer authorization needs review.')
      await page.locator('#save-profile').click()
      await page.get_by_role('button', name='01 / Application').click()
      await page.locator('#title').fill('FPGA Intern')
      await page.locator('#company').fill('Example Labs')
      await page.locator('#url').fill('https://example.com/jobs?id=42&utm_source=test')
      await page.locator('#description').fill('Summer 2027 FPGA internship. SystemVerilog and Python experience required. Must be enrolled in an electrical engineering degree. No sponsorship available. ' * 2)
      await page.locator('#check').click()
      assert 'No sponsorship' in await page.locator('#checks').inner_text()
      await page.locator('#save-job').click()
      await page.wait_for_function("() => document.querySelector('#notice').textContent.includes('saved to your inbox')")
      await page.locator('#save-job').click()
      await page.wait_for_function("() => document.querySelector('#notice').textContent.includes('Already saved')")
      # Simulate only model calls; render responses use the real template compiler.
      def stub_native(request):
        if request['action'] == 'suggest_projects':
          return {'projects':[{'title':'AXI Stream DSP Verification Platform', 'scope':'Develop a DSP pipeline with randomized verification and a hardware demo.', 'relevance':'AXI and FPGA verification in the role', 'build_plan':'Implement RTL, scoreboards, then a reproducible demo.', 'success_targets':'Target throughput and coverage; measure after implementation.', 'effort':'Four weeks; FPGA board and simulator.'}]}
        if request['action'] == 'generate':
          baseline=(ROOT/'Templates'/f"{request['template']}.tex").read_text()
          return {**handle({**request, 'action':'render', 'resume':baseline}), 'letter':'Dear Hiring Team, '+ 'Relevant verified experience. '*50, 'changes':['Preserved template.'], 'review_notes':['Verify employer authorization.']}
        return handle(request)
      # Bridge background native messages to the Python fixture, independently of workspace lifetime.
      await worker.evaluate("""() => {
        globalThis.pendingNative = new Map(); globalThis.nativeSequence = 0;
        chrome.runtime.connectNative = () => {
          const callbacks = []; let disconnected = false;
          return {onMessage: {addListener: f => callbacks.push(f)}, onDisconnect: {addListener: () => {}}, disconnect: () => { disconnected = true; }, postMessage: request => {
            pendingNative.set(++nativeSequence, {request, deliver: result => { if (!disconnected) callbacks.forEach(f => f(result)); }});
          }};
        };
      }""")
      bridge_tasks = set()
      async def deliver_native(item):
        try:
          if item['request']['action'] == 'generate':
            await asyncio.sleep(0.5)
          response = await asyncio.to_thread(stub_native, item['request'])
        except Exception as error:
          response = {'error': str(error)}
        await worker.evaluate("([id, result]) => { const call = pendingNative.get(id); if (call) { call.deliver(result); pendingNative.delete(id); } }", [item['id'], response])
      async def bridge_native():
        while True:
          pending = await worker.evaluate("() => [...pendingNative.entries()].filter(([id, call]) => !call.processing).map(([id, call]) => { call.processing = true; return {id, request: call.request}; })")
          for item in pending:
            task = asyncio.create_task(deliver_native(item)); bridge_tasks.add(task); task.add_done_callback(bridge_tasks.discard)
          await asyncio.sleep(0.05)
      bridge = asyncio.create_task(bridge_native())
      await page.expose_function('stubNative', stub_native)
      await page.evaluate('''() => { chrome.runtime.connectNative = () => {
        const callbacks = []; return {onMessage: {addListener: f => callbacks.push(f)}, onDisconnect: {addListener: () => {}}, disconnect: () => {}, postMessage: async request => {try { const result=await window.stubNative(request); callbacks.forEach(f => f(result)); } catch(error) { callbacks.forEach(f => f({error:error.message})); }}}; }; }''')
      await page.locator('#generate').click()
      await page.wait_for_function("() => document.querySelector('#queue-status').textContent.includes('1 ready')")
      await page.get_by_role('button', name='Open saved application').click()
      await page.wait_for_function("() => document.querySelector('#export-status').textContent.length > 0")
      export_status = await page.locator('#export-status').inner_text()
      assert 'PDFs saved automatically' in export_status, export_status
      assert len(list((Path(profile) / 'application-pdfs').rglob('*.pdf'))) == 2
      assert (await page.locator('#resume-preview').get_attribute('src')).startswith('blob:')
      assert await page.locator('#resume').is_hidden()
      await page.set_viewport_size({'width':1440,'height':1100})
      await page.locator('.documents').scroll_into_view_if_needed()
      await page.screenshot(path='/tmp/internship-desk-pdf-preview.png', animations='disabled')
      await page.locator('#resume-source summary').click()
      await page.locator('#resume').fill((await page.locator('#resume').input_value()).replace(r'\end{document}', '% Edited version\n'+r'\end{document}'))
      await page.locator('#save-drafts').click()
      await page.wait_for_function("() => document.querySelector('#notice').textContent.includes('Edited drafts saved')")
      async with context.expect_page() as new:
        await page.locator('#print-resume').click()
      printed=await new.value
      assert printed.url.startswith('blob:')
      await page.locator('#suggest-projects').click()
      await page.wait_for_function("() => document.querySelector('#notice').textContent.includes('Project ideas ready')")
      await page.get_by_role('button', name='Approve & add as planned').click()
      await page.wait_for_function("() => document.querySelector('#notice').textContent.includes('Planned projects updated')")
      saved=await page.evaluate("async () => (await chrome.storage.local.get('jobs')).jobs")
      latest=list(saved.values())[0]['versions'][-1]
      assert 'Planned Projects' in latest['resume_tex']
      assert latest['approved_projects'][0]['approved'] is True
      await page.get_by_role('button', name='Remove planned project').click()
      await page.wait_for_function("() => document.querySelector('#project-ideas button').textContent.includes('Approve & add')")
      saved=await page.evaluate("async () => (await chrome.storage.local.get('jobs')).jobs")
      latest=list(saved.values())[0]['versions'][-1]
      assert 'Planned Projects' not in latest['resume_tex']
      await page.get_by_role('button', name='03 / Applications', exact=False).click()
      assert await page.locator('#jobs .job').count()==1
      assert '4 saved document' in await page.locator('#jobs .job').inner_text()
      await page.locator('#show-tracking').check()
      await page.get_by_role('button', name='Mark version submitted').click()
      await page.wait_for_function("() => document.querySelector('#notice').textContent.includes('Submitted version recorded')")
      await page.reload()
      await page.get_by_role('button', name='03 / Applications', exact=False).click()
      await page.locator('#show-tracking').check()
      assert await page.get_by_label('Status for FPGA Intern').input_value()=='Applied'
      await page.get_by_role('button', name='Open saved application').click()
      # Opening a saved application awaits storage; a click can return before the editor fills.
      await page.wait_for_function("() => document.querySelector('#resume').value.includes('Edited version')")
      assert 'Edited version' in await page.locator('#resume').input_value()
      await page.set_viewport_size({'width':1440,'height':1200})
      await page.screenshot(path='/tmp/internship-desk-workspace.png',full_page=True)
      await page.locator('#connection').click()
      await page.wait_for_function("() => document.querySelector('#notice').textContent.includes('Local helper unavailable')")
      # Batch generation continues after the workspace is closed.
      await page.evaluate("""async () => {
        const all = (await chrome.storage.local.get('jobs')).jobs;
        const base = Object.values(all)[0].job;
        for (let i = 1; i <= 3; i++) {
          const job = {...base, title: `Batch role ${i}`, url: `https://example.com/batch/${i}`};
          all[job.url] = {job, status: 'Saved', updated: new Date().toISOString(), versions: []};
        }
        await chrome.storage.local.set({jobs: all});
      }""")
      await page.get_by_role('button', name='03 / Applications', exact=False).click()
      await page.locator('#queue-concurrency').select_option('2')
      for i in range(1, 4):
        await page.get_by_label(f'Select Batch role {i}', exact=True).check()
      await page.locator('#queue-selected').click()
      await page.wait_for_function("() => document.querySelector('#notice').textContent.startsWith('3 application(s) queued')")
      await page.close()
      for _ in range(300):
        states = await worker.evaluate("async () => (await chrome.storage.local.get('generationQueue')).generationQueue.map(q => q.state)")
        if all(state == 'completed' for state in states): break
        await asyncio.sleep(0.1)
      assert states == ['completed'] * 4, states
      page = await context.new_page()
      await page.goto(f'chrome-extension://{ext}/workspace.html?panel=tracker')
      await page.wait_for_function("() => document.querySelectorAll('#jobs .job').length === 4")
      assert '4 ready' in await page.locator('#queue-status').inner_text()
      assert len(list((Path(profile) / 'application-pdfs').rglob('*.pdf'))) >= 8
      await page.set_viewport_size({'width':1440,'height':1200})
      await page.screenshot(path='/tmp/internship-desk-queue.png', full_page=True)
      # Actual tab extraction and the popup picker, with isolated fixture-site permissions.
      async def serve_listing(route):
        number = route.request.url.rsplit('/', 1)[-1]
        posting = {'@type': 'JobPosting', 'title': f'Capture role {number}', 'hiringOrganization': {'name': 'Capture Labs'}, 'description': '<p>' + 'FPGA design and verification internship. ' * 10 + '</p>'}
        await route.fulfill(content_type='text/html', body='<title>Fixture ' + number + '</title><script type="application/ld+json">' + json.dumps(posting) + '</script>')
      await context.route('https://jobs.fixture.test/**', serve_listing)
      fixture_tabs = []
      for i in range(1, 4):
        listing = await context.new_page(); await listing.goto(f'https://jobs.fixture.test/{i}'); fixture_tabs.append(listing)
      popup = await context.new_page(); await popup.goto(f'chrome-extension://{ext}/popup.html')
      await popup.locator('#choose-tabs').click()
      for i in (1, 2):
        await popup.get_by_label(f'Fixture {i}', exact=True).check()
      await popup.locator('#save-selected').click()
      await popup.wait_for_function("() => document.querySelector('#popup-notice').textContent.startsWith('2 listing(s) saved')")
      captured = await worker.evaluate("async () => (await chrome.storage.local.get('jobs')).jobs")
      assert captured['https://jobs.fixture.test/1']['job']['title'] == 'Capture role 1'
      assert captured['https://jobs.fixture.test/2']['job']['company'] == 'Capture Labs'
      assert 'https://jobs.fixture.test/3' not in captured
      await popup.locator('#save-selected').click()
      await popup.wait_for_function("() => document.querySelector('#popup-notice').textContent.startsWith('2 listing(s) saved')")
      captured = await worker.evaluate("async () => (await chrome.storage.local.get('jobs')).jobs")
      assert len(captured) == 6
      assert not errors, errors
      bridge.cancel()
      await asyncio.gather(bridge, *bridge_tasks, return_exceptions=True)
      print(json.dumps({'extension_id':ext,'browser_errors':errors,'checks':['profile persistence','fit evidence','URL deduplication','mocked generation','version history','real template PDF','automatic company-named resume and letter PDFs','project suggestions','approve and remove planned projects','submission tracking','reload persistence','missing helper error','parallel batch generation','generation survives workspace close','queue persistence','selected-tab popup capture','batch capture deduplication','unselected tabs untouched']}))
      await context.close()
asyncio.run(main())
