"""Offline contract tests for collection, source adapters, and persistent state."""
import contextlib
import copy
import csv
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from job_store import Store, canonical_url, job_id
from scraper import collect, prepare_job
from sources_api import SourceError, collect_source, enrich_job, import_records


class FakeClient:
    def __init__(self, responses):
        self.responses = responses
        self.requested = []

    def _value(self, url):
        self.requested.append(url)
        value = self.responses[url]
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value)

    def json(self, url):
        return self._value(url)

    def get(self, url):
        return self._value(url)


def job(**changes):
    result = {
        "source": "test", "source_job_id": "123", "company": "Example Hardware",
        "title": "Summer 2027 FPGA Internship", "application_url": "https://example.com/jobs/123",
        "location": "Austin, TX", "description": (
            "This summer 2027 internship involves FPGA hardware design, Verilog and RTL verification. "
            "International students are welcome to apply. Build digital logic and validate timing."
        ),
    }
    result.update(changes)
    return result


def lever_item(identifier):
    return {"id": str(identifier), "text": "Summer 2027 FPGA Intern", "hostedUrl": f"https://jobs.lever.co/example/{identifier}",
            "descriptionPlain": "Design FPGA hardware. International students are welcome to apply.",
            "categories": {"location": "Austin, TX", "commitment": "Internship"},
            "lists": [{"text": "Requirements", "content": "<li>Verilog</li><li>RTL</li>"}]}


class SourceAdapterTests(unittest.TestCase):
    def test_greenhouse_preserves_full_description_and_individual_url(self):
        url = "https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true"
        client = FakeClient({url: {"jobs": [{"id": 123, "title": "FPGA Intern", "absolute_url": "https://job-boards.greenhouse.io/example/jobs/123",
                    "content": "&lt;p&gt;International students welcome.&lt;/p&gt;&lt;p&gt;Verilog&lt;/p&gt;", "location": {"name": "Austin, TX"}}]}})
        records = collect_source({"name": "example", "type": "greenhouse", "board": "example", "company": "Example"}, client)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["description"], "International students welcome.\nVerilog")
        self.assertTrue(records[0]["application_url"].endswith("/jobs/123"))

    def test_lever_fetches_all_pages_and_requirement_sections(self):
        base = "https://api.lever.co/v0/postings/example?mode=json&limit=100&skip="
        client = FakeClient({base + "0": [lever_item(n) for n in range(100)], base + "100": [lever_item(100)]})
        records = collect_source({"name": "example", "type": "lever", "site": "example"}, client)
        self.assertEqual(len(records), 101)
        self.assertEqual(client.requested, [base + "0", base + "100"])
        self.assertIn("Verilog", records[-1]["description"])
        self.assertIn("RTL", records[-1]["description"])

    def test_lever_repeated_page_reports_incomplete_coverage(self):
        base = "https://api.lever.co/v0/postings/example?mode=json&limit=100&skip="
        page = [lever_item(n) for n in range(100)]
        client = FakeClient({base + "0": page, base + "100": page})
        with self.assertRaises(SourceError):
            collect_source({"name": "example", "type": "lever", "site": "example"}, client)

    def test_lever_page_limit_does_not_silently_claim_completion(self):
        url = "https://api.lever.co/v0/postings/example?mode=json&limit=100&skip=0"
        with self.assertRaises(SourceError):
            collect_source({"name": "example", "type": "lever", "site": "example", "max_pages": 1},
                           FakeClient({url: [lever_item(n) for n in range(100)]}))

    def test_simplify_filters_inactive_and_nonhardware_and_retains_restriction(self):
        active = {"id": "one", "active": True, "category": "Hardware", "company_name": "Example",
                  "title": "FPGA Intern", "url": "https://example.com/1", "locations": ["Austin, TX"],
                  "terms": ["Summer 2027"], "sponsorship": "U.S. Citizenship is Required"}
        rows = [active, dict(active, id="two", active=False), dict(active, id="three", category="Software")]
        records = collect_source({"name": "simplify", "type": "simplify", "category": "Hardware", "url": "https://example.com/feed.json"},
                                 FakeClient({"https://example.com/feed.json": rows}))
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["internship_year"], 2027)
        self.assertEqual(records[0]["internship_season"], "summer")
        self.assertEqual(records[0]["structured_authorization"], {"requires_citizenship": True})
        self.assertEqual(records[0]["description"], "")

    def test_public_jobposting_enrichment_extracts_evidence(self):
        data = {"@context": "https://schema.org", "@type": "JobPosting", "title": "Summer 2027 FPGA Intern",
                "description": "<p>FPGA design. International students are welcome to apply.</p>",
                "hiringOrganization": {"name": "Example Hardware"},
                "jobLocation": {"address": {"addressLocality": "Austin", "addressRegion": "TX", "addressCountry": "US"}},
                "validThrough": "2027-04-01", "employmentType": "INTERN"}
        listing = job(description="")
        html = '<script type="application/ld+json">' + json.dumps({"@graph": [data]}) + '</script>'
        result = enrich_job(listing, FakeClient({listing["application_url"]: html}))
        self.assertIn("International students", result["description"])
        self.assertEqual(result["location"], "Austin, TX, US")
        self.assertEqual(result["deadline"], "2027-04-01")
        self.assertFalse(result["description_is_summary"])

    def test_enrichment_rejects_ambiguous_or_missing_jobposting(self):
        listing = job(description="")
        for html in ("<html>A search page</html>", '<script type="application/ld+json">[{"@type":"JobPosting"},{"@type":"JobPosting"}]</script>'):
            with self.subTest(html=html), self.assertRaises(SourceError):
                enrich_job(listing, FakeClient({listing["application_url"]: html}))

    def test_portal_enrichment_requests_no_protected_page(self):
        client = FakeClient({})
        for url in ("https://www.linkedin.com/jobs/view/123", "https://app.joinhandshake.com/jobs/123"):
            with self.subTest(url=url), self.assertRaises(SourceError):
                enrich_job(job(application_url=url, description=""), client)
        self.assertEqual(client.requested, [])


class CollectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {"filters": {"target_country": "US", "target_year": 2027, "target_season": "summer", "require_explicit_authorization": True}, "max_detail_fetches": 0}

    def import_file(self, rows):
        path = self.root / "incoming.json"
        path.write_text(json.dumps(rows), encoding="utf-8")
        return path

    def run_collect(self, rows=None, **kwargs):
        imports = [self.import_file(rows)] if rows is not None else []
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return collect(self.config, self.root, kwargs.pop("sources", []), imports, client=kwargs.pop("client", FakeClient({})), **kwargs)

    def test_failed_details_do_not_starve_unattempted_jobs(self):
        self.config["max_detail_fetches"] = 1
        rows = [job(application_url=f"https://example.com/jobs/{i}", description="") for i in range(3)]
        client = FakeClient({r["application_url"]: "<html></html>" for r in rows})
        for _ in range(3):
            self.run_collect(rows, client=client)
        self.assertEqual(len(set(client.requested)), 3)

    def test_shortlist_is_bounded_and_preserves_unknown_authorization(self):
        rows = [job(application_url=f"https://example.com/jobs/{i}", description="FPGA RTL hardware internship") for i in range(30)]
        self.run_collect(rows)
        with (self.root / "shortlist.csv").open() as handle:
            shortlist = list(csv.DictReader(handle))
        self.assertEqual(len(shortlist), 25)
        self.assertTrue(all(r["Eligibility"] == "unknown" for r in shortlist))
        self.assertTrue(all(r["Status"] == "pending_review" for r in shortlist))

    def test_explicit_positive_full_description_is_eligible(self):
        summary = self.run_collect([job()])
        self.assertEqual(summary["eligible"], 1)
        records = Store(self.root).records()
        self.assertEqual(records[0]["status"], "ready")
        with (self.root / "internshiptracker.csv").open(newline="") as handle:
            self.assertEqual(len(list(csv.DictReader(handle))), 1)

    def test_unknown_authorization_stays_in_review(self):
        summary = self.run_collect([job(description="This summer 2027 internship involves FPGA hardware design, Verilog and RTL verification.")])
        self.assertEqual(summary["eligible"], 0)
        self.assertEqual(summary["review"], 1)

    def test_missing_description_cannot_be_ready_from_structured_acceptance(self):
        summary = self.run_collect([job(description="", structured_authorization={"accepts_cpt": True})])
        self.assertEqual(summary["eligible"], 0)
        self.assertEqual(summary["review"], 1)

    def test_imported_summary_is_not_promoted_to_full_description(self):
        summary = self.run_collect([job(description_is_summary=True)])
        self.assertEqual(summary["eligible"], 0)
        self.assertEqual(summary["review"], 1)

    def test_explicit_negative_is_excluded(self):
        summary = self.run_collect([job(description="This summer 2027 FPGA hardware internship requires Verilog and RTL. International students are not eligible.")])
        self.assertEqual(summary["excluded"], 1)
        self.assertEqual(summary["eligible"], 0)

    def test_tracking_url_variants_deduplicate_and_keep_job_identity(self):
        summary = self.run_collect([job(application_url="https://example.com/jobs/123?utm_source=feed"), job()])
        self.assertEqual(summary["duplicates"], 1)
        self.assertEqual(len(Store(self.root).records()), 1)
        self.assertNotEqual(job_id("https://example.com/job?id=1"), job_id("https://example.com/job?id=2"))

    def test_conflicting_crosssource_authorization_never_becomes_eligible(self):
        short = job(source="portal", description="FPGA hardware internship.", structured_authorization={"accepts_cpt": False})
        long = job(source="other", structured_authorization={"accepts_cpt": True})
        for records in ([short, long], [long, short]):
            with self.subTest(first=records[0]["source"]):
                summary = self.run_collect(records)
                self.assertEqual(summary["eligible"], 0)

    def test_imported_status_and_decision_do_not_bypass_classification(self):
        summary = self.run_collect([job(description="FPGA hardware internship.", status="generated", decision="eligible")])
        self.assertEqual(summary["eligible"], 0)
        self.assertEqual(Store(self.root).records()[0]["status"], "pending_review")

    def test_unchanged_rerun_preserves_completed_artifacts(self):
        self.run_collect([job()])
        store = Store(self.root)
        record = store.records()[0]
        record.update(status="generated", resume_path="Resumes/resume.pdf", cover_letter_path="Resumes/letter.md", generated_at="2026-09-28T00:00:00+00:00")
        store.save(record)
        summary = self.run_collect([job()])
        result = store.records()[0]
        self.assertEqual(summary["unchanged"], 1)
        self.assertEqual(result["status"], "generated")
        self.assertEqual(result["resume_path"], "Resumes/resume.pdf")
        self.assertEqual(result["first_seen"], record["first_seen"])

    def test_changed_description_requeues_but_preserves_artifact_history(self):
        self.run_collect([job()])
        store = Store(self.root)
        record = store.records()[0]
        record.update(status="generated", resume_path="Resumes/resume.pdf", cover_letter_path="Resumes/letter.md")
        store.save(record)
        summary = self.run_collect([job(description=job()["description"] + " Experience with VHDL is preferred.")])
        result = store.records()[0]
        self.assertEqual(summary["updated"], 1)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["previous_artifacts"][-1]["resume_path"], "Resumes/resume.pdf")
        self.assertNotIn("resume_path", result)

    def test_source_failure_is_recorded_without_losing_successful_source(self):
        bad = {"name": "broken", "type": "greenhouse", "board": "broken"}
        good = {"name": "working", "type": "lever", "site": "working", "company": "Example"}
        client = FakeClient({"https://boards-api.greenhouse.io/v1/boards/broken/jobs?content=true": SourceError("HTTP 403"),
                            "https://api.lever.co/v0/postings/working?mode=json&limit=100&skip=0": [lever_item("one")]})
        summary = self.run_collect(sources=[bad, good], client=client)
        self.assertEqual(summary["sources"]["broken"]["status"], "error")
        self.assertEqual(summary["sources"]["working"]["status"], "ok")
        self.assertEqual(len(Store(self.root).records()), 1)
        self.assertTrue(summary["errors"])

    def test_closed_listing_is_retired_and_reappearance_requeues(self):
        source = {"name": "working", "type": "lever", "site": "working", "company": "Example"}
        url = "https://api.lever.co/v0/postings/working?mode=json&limit=100&skip=0"
        item = lever_item("one")
        self.run_collect(sources=[source], client=FakeClient({url: [item]}))
        self.assertEqual(Store(self.root).records()[0]["status"], "ready")
        summary = self.run_collect(sources=[source], client=FakeClient({url: []}))
        self.assertEqual(summary["no_longer_listed"], 1)
        self.assertEqual(Store(self.root).records()[0]["status"], "excluded")
        self.run_collect(sources=[source], client=FakeClient({url: [item]}))
        self.assertEqual(Store(self.root).records()[0]["status"], "ready")

    def test_cached_summary_does_not_become_a_complete_description(self):
        self.run_collect([job(description_is_summary=True)])
        result = self.run_collect([job(description="", structured_authorization={"accepts_cpt": True})])
        self.assertEqual(result["eligible"], 0)
        self.assertEqual(result["review"], 1)

    def test_dry_run_and_explicit_limit_report_scope(self):
        summary = self.run_collect([job(), job(application_url="https://example.com/jobs/456")], dry_run=True, max_jobs=1)
        self.assertTrue(summary["limited"])
        self.assertEqual(summary["eligible"], 1)
        self.assertFalse((self.root / "data").exists())
        self.assertFalse((self.root / "internshiptracker.csv").exists())

    def test_import_csv_handles_multiline_description_and_rejects_string_bools(self):
        path = self.root / "incoming.csv"
        with path.open("w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.DictWriter(handle, fieldnames=["Company", "Role Title", "Application URL", "Description"])
            writer.writeheader()
            writer.writerow({"Company": "Example", "Role Title": "FPGA Intern", "Application URL": "https://example.com/1", "Description": "FPGA design\nVerilog, RTL"})
        imported = import_records(path)
        self.assertEqual(imported[0]["description"], "FPGA design\nVerilog, RTL")
        with self.assertRaises(ValueError):
            prepare_job(job(structured_authorization={"accepts_cpt": "false"}))


if __name__ == "__main__":
    unittest.main()
