"""Optional browser integration using intercepted pages, with no portal traffic.

Run with the optional Playwright environment after installing Chromium.
"""
import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from urllib.parse import urlsplit, parse_qs

from portal_scraper import collect_automatically, discover_jobs, load_detail, SELECTORS
from job_store import Store

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


def fixture(identifier, page_number):
    ids = [101, 102] if page_number == '1' else [102, 103]
    cards = ''.join(f'<a role="button" href="/job-search/{i}?page={page_number}">Job {i}</a>' for i in ids)
    description = 'Build FPGA hardware using RTL and Verilog. International students with CPT are welcome. ' * 5
    return f'''<html><body><h1>Jobs</h1>
    <div data-hook="left-content" role="region" aria-label="Jobs List">{cards}</div>
    <nav data-hook="job-search-pagination"><button aria-label="next page" {'disabled' if page_number == '2' else ''}
      onclick="location.href='/job-search/{identifier}?page=2'">Next</button></nav>
    <div data-hook="right-content"><a href="/e/456"><img alt="logo"></a><a href="/e/456">Example Employer</a>
    <a href="/jobs/{identifier}"><h1>FPGA Intern {identifier}</h1></a>
    <div><div><h3>At a glance</h3></div><div>Onsite, based in Austin, TX</div><div>Internship</div><div>From May 31, 2027 to August 20, 2027</div></div>
    <div><div><h3>Job description</h3></div><div>
    <p id="description">Short excerpt...</p><button aria-label="Show more (What does an Intern do?)"
      onclick="document.getElementById('description').textContent='{description}';this.remove()">More</button></div></div>
    <div><h3>What they're looking for</h3>PRIVATE PROFILE DETAILS</div>
    <div><h3>Similar jobs</h3><a href="/job-search/999">Unrelated posting</a></div>
    </div></body></html>'''


@unittest.skipIf(sync_playwright is None, 'Optional Playwright is not installed')
class PortalBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.context = self.browser.new_context()
        self.addCleanup(self.context.close)
        self.requested = []
        def respond(route):
            url = route.request.url
            self.requested.append(url)
            parsed = urlsplit(url)
            identifier = parsed.path.split('/')[-1]
            page_number = parse_qs(parsed.query).get('page', ['1'])[0]
            route.fulfill(status=200, content_type='text/html', body=fixture(identifier, page_number))
        self.context.route('**/*', respond)
        self.page = self.context.new_page()
        self.page.goto('https://app.joinhandshake.com/job-search/101?page=1')

    def test_split_view_discovery_ignores_selected_url_and_similar_jobs(self):
        jobs = discover_jobs(self.page, 'handshake')
        self.assertEqual([j['key'] for j in jobs], ['handshake:101', 'handshake:102'])

    def test_full_automatic_run_expands_descriptions_and_pages_without_prompts(self):
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
            root = Path(temp)
            result = collect_automatically(self.page, self.context, 'handshake', SELECTORS['handshake'], root, {}, max_jobs=10, delay_ms=0)
            self.assertEqual(result['saved'], 3, result)
            self.assertEqual(result['attempted'], 3)
            self.assertEqual(result['pages'], 2)
            self.assertEqual(result['stop_reason'], 'results_exhausted')
            records = Store(root).records()
            self.assertEqual({r['title'] for r in records}, {'FPGA Intern 101', 'FPGA Intern 102', 'FPGA Intern 103'})
            for record in records:
                self.assertEqual(record['company'], 'Example Employer')
                self.assertEqual(record['location'], 'Austin, TX')
                self.assertEqual(record['start_date'], '2027-05-31')
                self.assertEqual(record['eligibility']['category'], 'cpt_accepted')
                self.assertNotIn('PRIVATE PROFILE DETAILS', record['description'])
                self.assertNotIn('Short excerpt', record['description'])
                self.assertNotIn('Similar jobs', record['description'])
            self.assertFalse(any('/999' in url for url in self.requested))

    def test_glance_metadata_cannot_replace_missing_description(self):
        self.context.unroute('**/*')
        body = fixture('101', '1').replace("document.getElementById('description').textContent=", "document.getElementById('description').textContent='';void ")
        self.context.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body=body))
        with self.assertRaisesRegex(ValueError, 'Full description'):
            load_detail(self.page, 'https://app.joinhandshake.com/job-search/101?page=1', 'handshake', SELECTORS['handshake'])

    def test_custom_description_selector_without_heading(self):
        self.context.unroute('**/*')
        text = 'Build FPGA hardware with RTL and Verilog. ' * 5
        body = '<div data-hook="right-content"><h1>FPGA Intern</h1><a href="/e/123">Example</a></div><div id="custom">' + text + '</div>'
        self.context.route('**/*', lambda route: route.fulfill(status=200, content_type='text/html', body=body))
        selectors = {**SELECTORS['handshake'], 'description': '#custom'}
        raw = load_detail(self.page, 'https://app.joinhandshake.com/job-search/101', 'handshake', selectors)
        self.assertEqual(raw['description'], text.strip())
