"""Isolated Chromium regression: real extension + Handshake DOM fixture, no live model calls."""
import asyncio
import json
from pathlib import Path
import shutil
import tempfile
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = r'''<!doctype html><title>Jobs | Handshake</title><h1>Jobs</h1>
<div data-hook="left-content" aria-label="Jobs List"><div id="cards"></div>
<div data-hook="job-search-pagination"><button aria-label="next page">Next</button></div></div>
<div data-hook="right-content"></div><script>
let selected = 1, page = 1;
window.badClicks = 0;
function cards() {
  document.querySelector('#cards').innerHTML = [page * 2 - 1, page * 2].map(n =>
    `<div data-hook="job-result-card | ${n}" data-is-active="${selected === n}"><a role="button" href="/job-search/${n}?page=${page}" aria-label="Role ${n}">Role ${n}</a><div data-hook="job-result-card-footer"><span>Tampa, FL</span></div><button class="unsafe">Save Role ${n}</button></div>`).join('');
  document.querySelectorAll('#cards a').forEach(a => a.onclick = e => { e.preventDefault(); select(Number(new URL(a.href).pathname.split('/').pop())); });
  document.querySelector('button[aria-label="next page"]').disabled = page === 2;
}
function select(n) {
  selected = n; history.pushState({}, '', `/job-search/${n}?page=${page}`); cards();
  // Route changes first; the old detail pane remains visible during loading.
  setTimeout(() => {
    const pane = document.querySelector('[data-hook="right-content"]');
    pane.innerHTML = `<a href="/e/${n}" aria-label="Company ${n}">Company ${n}</a><a href="/jobs/${n}?searchId=tracking"><h1>Engineering Intern ${n}</h1></a><button class="unsafe">Apply externally</button><div><div><h3>At a glance</h3></div><div>Internship. US work authorization required.</div></div><div><div><h3>Job description</h3></div><div id="description">Short description…<button aria-label="Show more (What does this intern do?)">More</button></div></div><h3>Similar Jobs</h3><p>Unrelated jobs must never be captured.</p>`;
    pane.querySelector('[aria-label^="Show more"]').onclick = () => {
      document.querySelector('#description').textContent = `Description for job ${n}. ` + 'Design circuits, verify hardware, and document measurements. '.repeat(20);
    };
  }, 800);
}
document.addEventListener('click', e => { if (e.target.classList.contains('unsafe')) window.badClicks++; });
document.querySelector('button[aria-label="next page"]').onclick = () => {setTimeout(() => {page++; cards();}, 500);};
cards(); select(1);
</script>'''

async def main():
  async with async_playwright() as p:
    with tempfile.TemporaryDirectory(prefix='handshake-extension-test-') as folder:
      copied = Path(folder) / 'extension'
      shutil.copytree(ROOT, copied)
      manifest_file = copied / 'manifest.json'
      manifest = json.loads(manifest_file.read_text())
      manifest['permissions'].append('tabs')
      manifest['host_permissions'] = ['https://app.joinhandshake.com/*']
      manifest_file.write_text(json.dumps(manifest))
      context = await p.chromium.launch_persistent_context(folder, channel='chromium', headless=True, args=[f'--disable-extensions-except={copied}', f'--load-extension={copied}', '--no-sandbox'])
      await context.route('https://app.joinhandshake.com/**', lambda route: route.fulfill(content_type='text/html', body=HTML))
      worker = context.service_workers[0] if context.service_workers else await context.wait_for_event('serviceworker')
      extension_id = worker.url.split('/')[2]
      listing = await context.new_page()
      await listing.goto('https://app.joinhandshake.com/job-search/1?page=1')
      page = await context.new_page()
      errors = []
      page.on('pageerror', lambda error: errors.append(str(error)))
      await page.goto(f'chrome-extension://{extension_id}/workspace.html?panel=tracker')
      await page.wait_for_function("() => document.querySelector('#notice').textContent === 'Ready.'")
      await worker.evaluate('''async () => {
        await chrome.storage.local.set({profile: {facts: 'Verified engineering resume facts. '.repeat(20), skills: 'FPGA', constraints: ''}});
        chrome.runtime.connectNative = () => {
          let callback;
          return {onMessage: {addListener: f => callback = f}, onDisconnect: {addListener: () => {}}, disconnect: () => {}, postMessage: request => {
            setTimeout(() => callback(request.action === 'generate' ? {resume: 'Fixture resume', letter: 'Fixture letter', template: request.template, pdf_base64: 'Zml4dHVyZQ==', changes: [], review_notes: []} : {skipped: true}), 20);
          }};
        };
      }''')
      tab_id = await worker.evaluate("async () => (await chrome.tabs.query({})).find(t => t.url?.includes('app.joinhandshake.com')).id")
      result = await page.evaluate("id => chrome.runtime.sendMessage({action: 'collect_start', tabId: id, options: {limit: 4, prepare: true, template: 'power'}})", tab_id)
      assert result.get('ok'), result
      await page.close()  # Collection and generation must outlive the initiating UI.
      state = None
      for _ in range(150):
        state = await worker.evaluate("async () => (await chrome.storage.local.get('collection')).collection")
        if state['state'] != 'running': break
        await asyncio.sleep(0.1)
      assert state['state'] == 'completed', state
      assert len(state['results']) == 4, state
      for _ in range(100):
        data = await worker.evaluate("async () => chrome.storage.local.get(['jobs', 'generationQueue'])")
        if all(q['state'] == 'completed' for q in data['generationQueue']): break
        await asyncio.sleep(0.05)
      assert len(data['jobs']) == len(data['generationQueue']) == 4, data
      for n in range(1, 5):
        record = data['jobs'][f'https://app.joinhandshake.com/jobs/{n}']
        assert record['job']['title'] == f'Engineering Intern {n}', record
        assert record['job']['company'] == f'Company {n}', record
        assert f'Description for job {n}.' in record['job']['description'], record
        assert 'Unrelated jobs' not in record['job']['description'], record
        assert 'authorization required' in record['job']['description'], record
        assert len(record['versions']) == 1, record
        assert record['versions'][0]['template'] == 'power'
      assert await listing.evaluate('window.badClicks') == 0
      popup = await context.new_page()
      popup.on('pageerror', lambda error: errors.append(str(error)))
      await popup.goto(f'chrome-extension://{extension_id}/popup.html')
      await popup.wait_for_function("() => document.querySelector('#collection-status').textContent.includes('4 listing(s) saved')")
      assert '4 ready' in await popup.locator('#preparation-status').inner_text()
      assert await popup.locator('#collect-stop').is_hidden()
      await popup.set_viewport_size({'width': 408, 'height': 600})
      assert await popup.evaluate("document.querySelector('#workspace').getBoundingClientRect().bottom <= window.innerHeight")
      await popup.screenshot(path='/tmp/internship-desk-collection.png', full_page=True, animations='disabled')
      assert await popup.locator('#popup-ready-count').inner_text() == '4'
      # The secondary tab picker must remain reachable inside the compact popup.
      await popup.locator('#choose-tabs').click()
      assert await popup.locator('#batch').is_visible()
      workspace = await context.new_page()
      await workspace.set_viewport_size({'width': 1440, 'height': 1000})
      await workspace.goto(f'chrome-extension://{extension_id}/workspace.html?panel=tracker')
      await workspace.wait_for_function("() => document.querySelector('#stat-saved').textContent === '4'")
      assert await workspace.locator('#stat-ready').inner_text() == '4'
      await workspace.locator('#filter-query').fill('Engineering Intern 2')
      await workspace.wait_for_function("() => document.querySelectorAll('#jobs .job').length === 1")
      await workspace.locator('#select-all').click()
      await workspace.wait_for_function("() => document.querySelector('#selection-count').textContent === '1 selected'")
      await workspace.locator('#reset-filters').click()
      await workspace.wait_for_function("() => document.querySelectorAll('#jobs .job').length === 4")
      assert await workspace.locator('#selection-count').inner_text() == '0 selected'
      await workspace.locator('[data-view="attention"]').click()
      await workspace.wait_for_function("() => document.querySelector('#jobs').textContent.includes('No opportunities match')")
      await workspace.locator('#reset-filters').click()
      await workspace.wait_for_function("() => document.querySelectorAll('#jobs .job').length === 4")
      assert await workspace.locator('#queue-selected').is_disabled()
      await workspace.locator('#select-all').click()
      await workspace.wait_for_function("() => document.querySelector('#selection-count').textContent === '4 selected'")
      assert await workspace.locator('#jobs .selected').count() == 4
      await workspace.locator('#clear-selection').click()
      await workspace.wait_for_function("() => document.querySelector('#selection-count').textContent === '0 selected'")
      await workspace.screenshot(path='/tmp/internship-desk-design-applications.png', full_page=True, animations='disabled')
      await workspace.get_by_role('button', name='01 / Application', exact=True).click()
      await workspace.screenshot(path='/tmp/internship-desk-design-studio.png', full_page=True, animations='disabled')
      await workspace.get_by_role('button', name='02 / Your profile', exact=True).click()
      await workspace.screenshot(path='/tmp/internship-desk-design-profile.png', full_page=True, animations='disabled')
      for width in [768, 390, 320]:
        await workspace.set_viewport_size({'width': width, 'height': 844})
        for name in ['03 / Applications', '01 / Application', '02 / Your profile']:
          await workspace.get_by_role('button', name=name, exact=True).click()
          assert await workspace.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), (width, name)
        if width == 390:
          await workspace.get_by_role('button', name='03 / Applications', exact=True).click()
          await workspace.screenshot(path='/tmp/internship-desk-design-mobile.png', full_page=True, animations='disabled')
      # A repeated save leaves history and queue unchanged; missing profile remains visible.
      result = await popup.evaluate("id => chrome.runtime.sendMessage({action: 'capture_tabs', tabIds: [id], options: {prepare: true, template: 'power'}})", tab_id)
      assert result['results'][0]['preparation'] == 'existing', result
      await worker.evaluate("() => chrome.storage.local.remove('profile')")
      result = await popup.evaluate("id => chrome.runtime.sendMessage({action: 'capture_tabs', tabIds: [id], options: {prepare: true}})", tab_id)
      assert 'profile' in result['results'][0]['preparationError'], result
      saved = await worker.evaluate("async () => (await chrome.storage.local.get('jobs')).jobs")
      assert len(saved) == 4
      assert len(saved['https://app.joinhandshake.com/jobs/4']['versions']) == 1
      assert not errors, errors
      print(json.dumps({'checks': ['selected Handshake title and company', 'automatic description expansion', 'stale detail rejected', 'four separate saved jobs', 'next card and next page navigation', 'four application drafts generated', 'survives workspace close', 'no Save or Apply clicks', 'popup progress', 'deduplication preserves drafts', 'missing profile error preserves jobs'], 'errors': errors}))
      await context.close()

asyncio.run(main())
