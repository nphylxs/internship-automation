"""Isolated UI regression: fixture Sheets responses, real extension storage, no live accounts."""
import asyncio
import json
from pathlib import Path
import shutil
import tempfile
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
CSV = '''Company,Role,Status,Updated,Job URL,Email URL,Notes,Next step,Application ID
Northstar Energy,Electrical Engineering Intern,Applied,2026-09-21,https://app.joinhandshake.com/jobs/1,,Application received.,,north1
Northstar Energy,Electrical Engineering Intern,Interview scheduled,2026-10-02,https://app.joinhandshake.com/jobs/1,https://mail.google.com/mail/u/0/#inbox/test,The team would love to meet you.,Prepare two projects to discuss.,north1
Orbit Robotics,Embedded Systems Intern,Under review,2026-10-01,https://example.com/jobs/2,,Your experience is being reviewed by the team.,,orbit1
Fieldwork Studio,Hardware Design Intern,Offer extended,2026-10-03,https://example.com/jobs/3,,An exciting next step. Your offer is ready to review.,Read through the offer details.,field1
Cedar Systems,FPGA Engineering Intern,Assessment,2026-09-30,,,A technical challenge to show how you think.,Complete the take-home assessment.,cedar1
Lumen Labs,Power Electronics Intern,On hold,2026-09-29,,,The hiring timeline is being updated.,Check back next week.,lumen1
Solace Electric,Controls Intern,Rejected,2026-09-28,,,The team has moved ahead with another candidate.,,solace1
'''

async def main():
    async with async_playwright() as p:
        with tempfile.TemporaryDirectory(prefix='tracker-extension-test-') as folder:
            copied = Path(folder) / 'extension'
            shutil.copytree(ROOT, copied)
            mf = copied / 'manifest.json'
            manifest = json.loads(mf.read_text())
            manifest['host_permissions'] = ['https://docs.google.com/*', 'https://*.googleusercontent.com/*']
            mf.write_text(json.dumps(manifest))
            context = await p.chromium.launch_persistent_context(folder, channel='chromium', headless=True, args=[f'--disable-extensions-except={copied}', f'--load-extension={copied}', '--no-sandbox'], viewport={'width':1440,'height':1050}, color_scheme='light')
            worker = context.service_workers[0] if context.service_workers else await context.wait_for_event('serviceworker')
            extension_id = worker.url.split('/')[2]
            errors = []
            page = await context.new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))
            await page.goto(f'chrome-extension://{extension_id}/workspace.html?panel=tracking')
            await page.wait_for_selector('#sheet-url')
            await worker.evaluate('''async csv => {
              globalThis.sheetCsv = csv; globalThis.sheetMode = 'ok';
              globalThis.fetch = async url => new Response(globalThis.sheetMode === 'html' ? '<html>Sign in</html>' : globalThis.sheetCsv, {headers: {'content-type': globalThis.sheetMode === 'html' ? 'text/html' : 'text/csv'}});
              const jobs = {};
              for (const [url, company, title] of [['https://app.joinhandshake.com/jobs/1', 'Northstar Energy', 'Electrical Engineering Intern'], ['https://example.com/jobs/2','Orbit Robotics','Embedded Systems Intern'],['https://example.com/jobs/3','Fieldwork Studio','Hardware Design Intern']]) {
                jobs[url] = {job: {url, company, title, description:'Verified job description. '.repeat(10), location:'Boston, MA', deadline:''}, versions:[], status:'Saved', updated:new Date().toISOString()};
              }
              await chrome.storage.local.set({jobs});
            }''', CSV)
            await page.locator('#sheet-url').fill('https://docs.google.com/spreadsheets/d/fixture_sheet/edit#gid=7')
            await page.locator('#sheet-preview').click()
            await page.wait_for_selector('#sheet-mapping:not([hidden])')
            assert await page.get_by_label('Company column', exact=True).input_value() == '0'
            await page.locator('#sheet-connect').click()
            await page.wait_for_function("() => document.querySelectorAll('.journey-card').length === 6")
            assert await page.locator('#tracking-active').inner_text() == '3'
            assert await page.locator('#tracking-interviews').inner_text() == '1'
            assert await page.locator('#tracking-offers').inner_text() == '1'
            assert await page.locator('#tracking-review').inner_text() == '3'
            alarm = await worker.evaluate("() => chrome.alarms.get('sheet-tracker')")
            assert alarm['periodInMinutes'] == 15
            await page.evaluate("window.scrollTo({top:0,behavior:'instant'})")
            await page.screenshot(path='/tmp/internship-desk-tracker-light.png', full_page=True, animations='disabled')
            await page.get_by_role('button', name='View journey for Electrical Engineering Intern at Northstar Energy').click()
            assert await page.locator('.journey-timeline li').count() == 2
            assert await page.locator('#detail-content').get_by_role('link', name='Source email').get_attribute('href') == 'https://mail.google.com/mail/u/0/#inbox/test'
            await page.locator('#detail-content').get_by_role('button', name='Open saved application').click()
            assert await page.locator('#title').input_value() == 'Electrical Engineering Intern'
            await page.get_by_role('button', name='04 / Progress tracker', exact=True).click()
            await page.get_by_role('button', name='View journey for FPGA Engineering Intern at Cedar Systems').click()
            await page.locator('#detail-match').select_option('standalone')
            await page.get_by_role('button', name='Save match', exact=True).click()
            await page.wait_for_function("() => document.querySelector('#tracking-review').textContent === '2'")
            await page.keyboard.press('Escape')
            assert not await page.locator('#tracking-detail').is_visible()
            await page.locator('#tracking-query').fill('Orbit')
            assert await page.locator('.journey-card').count() == 1
            await page.locator('#tracking-reset').click()
            await page.get_by_role('button', name='Board view', exact=True).click()
            assert await page.locator('.journey-column').count() == 6
            await page.get_by_label('Color theme', exact=True).select_option('dark')
            await page.screenshot(path='/tmp/internship-desk-tracker-dark-board.png', full_page=True, animations='disabled')
            popup = await context.new_page()
            popup.on('pageerror', lambda e: errors.append(str(e)))
            await popup.goto(f'chrome-extension://{extension_id}/popup.html')
            await popup.wait_for_function("() => document.documentElement.dataset.theme === 'dark'")
            await popup.set_viewport_size({'width':408,'height':600})
            await popup.screenshot(path='/tmp/internship-desk-popup-dark.png', full_page=True, animations='disabled')
            await page.reload()
            await page.wait_for_selector('.journey-column')
            assert await page.get_by_label('Color theme', exact=True).input_value() == 'dark'
            for theme in ['light','dark']:
                await page.get_by_label('Color theme', exact=True).select_option(theme)
                for width in [1440,1024,768,390,320]:
                    await page.set_viewport_size({'width':width,'height':844})
                    for name in ['03 / Applications','01 / Application','02 / Your profile','04 / Progress tracker']:
                        await page.get_by_role('button', name=name, exact=True).click()
                        assert await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), (theme,width,name)
                    if width == 390 and theme == 'dark':
                        await page.get_by_role('button', name='List view', exact=True).click()
                        await page.evaluate("window.scrollTo({top:0,behavior:'instant'})")
                        await page.screenshot(path='/tmp/internship-desk-tracker-mobile.png', full_page=True, animations='disabled')
                        await page.get_by_role('button', name='View journey for Electrical Engineering Intern at Northstar Energy').click()
                        assert await page.evaluate("document.querySelector('#tracking-detail').scrollWidth <= document.querySelector('#tracking-detail').clientWidth")
                        await page.screenshot(path='/tmp/internship-desk-tracker-mobile-detail.png', animations='disabled')
                        await page.keyboard.press('Escape')
            await page.set_viewport_size({'width':1440,'height':1000})
            # Failed sync preserves application history and displays the sign-in error.
            await worker.evaluate("globalThis.sheetMode = 'html'")
            await page.locator('#sheet-sync').click()
            await page.wait_for_function("() => document.querySelector('#sheet-feedback').textContent.includes('sign-in')")
            assert await page.locator('.journey-card').count() == 6
            await worker.evaluate("globalThis.sheetMode = 'ok'; globalThis.sheetCsv += 'Northstar Energy,Electrical Engineering Intern,Offer,2026-10-03,https://app.joinhandshake.com/jobs/1,,Offer details received,Review documents,north1\\n'")
            await page.locator('#sheet-sync').click()
            await page.wait_for_function("() => document.querySelector('#tracking-offers').textContent === '2'")
            await page.locator('#sheet-settings').click()
            await page.locator('#sheet-disconnect').click()
            await page.wait_for_function("() => document.querySelector('#sheet-title').textContent.includes('disconnected')")
            assert await worker.evaluate("async () => !(await chrome.alarms.get('sheet-tracker'))")
            assert await page.locator('.journey-card').count() == 6
            # CSV fallback follows the same preview/mapping path and never creates a sync alarm.
            await page.locator('#sheet-file').set_input_files({'name':'applications.csv','mimeType':'text/csv','buffer':CSV.encode()})
            await page.wait_for_selector('#sheet-mapping:not([hidden])')
            await page.locator('#sheet-connect').click()
            await page.wait_for_function("() => document.querySelector('#sheet-title').textContent.includes('CSV')")
            assert await page.locator('.journey-card').count() == 6
            assert await page.locator('#sheet-sync').is_hidden()
            # Workspace backup/restore includes tracking events and keeps the restored source offline.
            await page.get_by_role('button', name='03 / Applications', exact=True).click()
            await page.locator('.backup-tools summary').click()
            async with page.expect_download() as download_info:
                await page.locator('#backup').click()
            download = await download_info.value
            backup_path = await download.path()
            backup = json.loads(Path(backup_path).read_text())
            assert len(backup['sheetTracker']['records']) == 12
            page.on('dialog', lambda dialog: dialog.accept())
            await page.locator('#restore').set_input_files(backup_path)
            await page.wait_for_function("() => document.querySelector('#notice').textContent === 'Backup restored.'")
            assert not await worker.evaluate("async () => (await chrome.storage.local.get('sheetTracker')).sheetTracker.source.enabled")
            # Dark mode changes print chrome, while the actual document remains white.
            printed = await context.new_page()
            await printed.goto(f'chrome-extension://{extension_id}/print.html')
            await printed.wait_for_function("() => document.documentElement.dataset.theme === 'dark'")
            assert await printed.locator('body').evaluate("el => getComputedStyle(el).backgroundColor") == 'rgb(16, 26, 22)'
            assert await printed.locator('main').evaluate("el => getComputedStyle(el).backgroundColor") == 'rgb(255, 255, 255)'
            await printed.emulate_media(media='print')
            assert await printed.locator('body').evaluate("el => getComputedStyle(el).backgroundColor") == 'rgb(255, 255, 255)'
            await page.get_by_role('button', name='01 / Application', exact=True).click()
            await page.evaluate("window.scrollTo({top:0,behavior:'instant'})")
            await page.screenshot(path='/tmp/internship-desk-studio-dark.png', full_page=True, animations='disabled')
            await page.get_by_role('button', name='02 / Your profile', exact=True).click()
            await page.screenshot(path='/tmp/internship-desk-profile-dark.png', full_page=True, animations='disabled')
            await page.get_by_role('button', name='04 / Progress tracker', exact=True).click()
            await page.locator('#sheet-settings').click()
            await page.set_viewport_size({'width':320,'height':844})
            await page.locator('#sheet-file').set_input_files({'name':'applications.csv','mimeType':'text/csv','buffer':CSV.encode()})
            await page.wait_for_selector('#sheet-mapping:not([hidden])')
            await page.locator('.sheet-sample summary').click()
            assert await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            await page.screenshot(path='/tmp/internship-desk-mapping-mobile.png', full_page=True, animations='disabled')
            await page.emulate_media(reduced_motion='reduce', color_scheme='light')
            await page.get_by_label('Color theme', exact=True).select_option('system')
            assert await page.evaluate("document.documentElement.dataset.theme") == 'light'
            assert await page.locator('#tracking').evaluate("el => getComputedStyle(el).animationName") == 'none'
            await page.emulate_media(color_scheme='dark')
            await page.wait_for_function("() => document.documentElement.dataset.theme === 'dark'")
            await popup.set_viewport_size({'width':320,'height':600})
            assert await popup.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            assert await popup.evaluate("document.querySelector('#workspace').getBoundingClientRect().bottom <= window.innerHeight")
            assert not errors, errors
            print(json.dumps({'checks':['Sheet preview and column mapping','CSV fallback','repeat sync and preserved error state','15-minute alarm and disconnect','history and job matching','source links','filters and board','light/dark/system propagation','all panels at 320–1440px','popup footer','keyboard dialog close','reduced motion','tracker backup/restore','white print pages in dark mode','column mapping at 320px'], 'errors': errors}))
            await context.close()

asyncio.run(main())
