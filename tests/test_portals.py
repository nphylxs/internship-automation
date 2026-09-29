import tempfile
import unittest
from pathlib import Path
from portal_scraper import job_url, save_job
from job_store import Store


class PortalTests(unittest.TestCase):
    def test_job_links_and_host_boundaries(self):
        self.assertEqual(job_url('https://www.linkedin.com/jobs/view/engineer-123/?trackingId=x', 'linkedin'), 'https://www.linkedin.com/jobs/view/123')
        self.assertEqual(job_url('https://usf.joinhandshake.com/stu/jobs/123?x=2', 'handshake'), 'https://usf.joinhandshake.com/stu/jobs/123')
        for url in ('https://linkedin.com.evil.org/jobs/view/123', 'https://www.linkedin.com/jobs/search/', 'http://www.linkedin.com/jobs/view/123'):
            self.assertIsNone(job_url(url, 'linkedin'))

    def test_isolated_records_preserve_generation_on_duplicate(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'portal_jobs' / 'linkedin'
            raw = dict(source='linkedin', company='Example', title='FPGA Intern Summer 2027', location='Austin, TX', application_url='https://www.linkedin.com/jobs/view/123', description='Design FPGA hardware with Verilog. ' * 5)
            first = save_job(raw, root, {})
            self.assertEqual(first['eligibility']['category'], 'risky')
            saved = Store(root).records()[0]
            saved['status'] = 'processed'
            Store(root).save(saved)
            save_job(raw, root, {})
            self.assertEqual(len(Store(root).records()), 1)
            self.assertEqual(Store(root).records()[0]['status'], 'processed')
            self.assertFalse((Path(temp) / 'data').exists())
            self.assertTrue((root / 'risky_postings.csv').exists())
