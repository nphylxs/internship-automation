"""Offline coverage for collecting several portal jobs after a single login."""

from contextlib import ExitStack
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch

import portal_scraper


class AutomaticPortalCollectionTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.page = MagicMock(name="search_page")
        self.detail = MagicMock(name="detail_page")
        self.context = MagicMock(name="browser_context")
        self.context.new_page.return_value = self.detail
        self.root = Path("portal_jobs/handshake")
        self.filters = {"required_terms": ["intern"]}
        self.selectors = {"description": ".job-description"}
        self.discover = self.mock_helper("discover_jobs")
        self.advance = self.mock_helper("advance_results")
        self.access = self.mock_helper("check_access")
        self.load = self.mock_helper("load_detail")
        self.save = self.mock_helper("save_job")
        self.prompt = self.stack.enter_context(
            patch("builtins.input", side_effect=AssertionError("Unexpected manual prompt"))
        )
        self.advance.return_value = False
        self.load.side_effect = self.raw_job
        self.save.side_effect = lambda raw, root, filters: {
            **raw, "eligibility": {"category": "risky"}
        }

    def mock_helper(self, name):
        return self.stack.enter_context(patch.object(portal_scraper, name))

    @staticmethod
    def listing(number, navigation_suffix=""):
        key = f"https://app.joinhandshake.com/stu/jobs/{number}"
        return {"url": key + navigation_suffix, "key": key}

    @staticmethod
    def raw_job(detail, url, portal, selectors):
        return {
            "application_url": url,
            "source": portal,
            "company": "Example Employer",
            "title": "Hardware Intern",
            "location": "Austin, TX",
            "description": "Develop and evaluate hardware prototypes. " * 5,
            "description_is_summary": False,
        }

    def collect(self, **kwargs):
        summary = portal_scraper.collect_automatically(
            self.page, self.context, "handshake", self.selectors,
            self.root, self.filters, delay_ms=0, **kwargs,
        )
        self.prompt.assert_not_called()
        for field in ("saved", "attempted", "errors", "pages", "stop_reason"):
            self.assertIn(field, summary)
        self.assertIsInstance(summary["errors"], list)
        self.assertTrue(summary["stop_reason"])
        return summary

    def loaded_urls(self):
        return [call.args[1] for call in self.load.call_args_list]

    def test_collects_all_visible_jobs_without_further_manual_prompts(self):
        listings = [self.listing(number) for number in (101, 102, 103)]
        self.discover.return_value = listings

        summary = self.collect()

        self.assertEqual(summary["saved"], 3)
        self.assertEqual(summary["attempted"], 3)
        self.assertEqual(summary["pages"], 1)
        self.assertEqual(summary["errors"], [])
        self.assertEqual(self.loaded_urls(), [item["url"] for item in listings])
        self.context.new_page.assert_called_once_with()
        self.detail.close.assert_called_once_with()
        for call in self.save.call_args_list:
            self.assertEqual(call.args[1:], (self.root, self.filters))

    def test_attempt_limit_includes_jobs_that_fail_to_extract(self):
        listings = [self.listing(number) for number in range(101, 106)]
        self.discover.return_value = listings
        self.load.side_effect = [
            ValueError("Job description missing"),
            self.raw_job(self.detail, listings[1]["url"], "handshake", self.selectors),
            self.raw_job(self.detail, listings[2]["url"], "handshake", self.selectors),
        ]

        summary = self.collect(max_jobs=3)

        self.assertEqual(summary["attempted"], 3)
        self.assertEqual(summary["saved"], 2)
        self.assertEqual(len(summary["errors"]), 1)
        self.assertEqual(self.loaded_urls(), [item["url"] for item in listings[:3]])
        self.advance.assert_not_called()
        self.detail.close.assert_called_once_with()

    def test_failed_extraction_does_not_block_following_jobs(self):
        listings = [self.listing(number) for number in (101, 102, 103)]
        self.discover.return_value = listings
        self.load.side_effect = [
            self.raw_job(self.detail, listings[0]["url"], "handshake", self.selectors),
            ValueError("Posting no longer available"),
            self.raw_job(self.detail, listings[2]["url"], "handshake", self.selectors),
        ]

        summary = self.collect()

        self.assertEqual(summary["attempted"], 3)
        self.assertEqual(summary["saved"], 2)
        self.assertEqual(len(summary["errors"]), 1)
        self.assertEqual(self.loaded_urls(), [item["url"] for item in listings])

    def test_automatically_advances_and_deduplicates_canonical_job_keys(self):
        first, duplicate, last = (self.listing(number) for number in (101, 102, 103))
        tracked_duplicate = self.listing(102, "?search_id=second-page")
        self.discover.side_effect = [[first, duplicate], [tracked_duplicate, last]]
        self.advance.side_effect = [True, False]

        summary = self.collect()

        self.assertEqual(summary["saved"], 3)
        self.assertEqual(summary["attempted"], 3)
        self.assertEqual(summary["pages"], 2)
        self.assertEqual(self.loaded_urls(), [first["url"], duplicate["url"], last["url"]])
        self.assertEqual(self.advance.call_count, 2)
        self.detail.close.assert_called_once_with()

    def test_failed_jobs_are_not_retried_on_later_results_pages(self):
        first, second, last = (self.listing(number) for number in (101, 102, 103))
        self.discover.side_effect = [[first, second], [self.listing(101, "?tracking=2"), last]]
        self.advance.side_effect = [True, False]
        self.load.side_effect = [
            ValueError("Description unavailable"),
            self.raw_job(self.detail, second["url"], "handshake", self.selectors),
            self.raw_job(self.detail, last["url"], "handshake", self.selectors),
        ]

        summary = self.collect()

        self.assertEqual(summary["attempted"], 3)
        self.assertEqual(summary["saved"], 2)
        self.assertEqual(len(summary["errors"]), 1)
        self.assertEqual(self.loaded_urls(), [first["url"], second["url"], last["url"]])

    def test_unchanged_results_stop_even_if_next_page_reports_success(self):
        self.discover.return_value = [self.listing(101), self.listing(102)]
        self.advance.return_value = True

        summary = self.collect(max_pages=20)

        self.assertEqual(summary["attempted"], 2)
        self.assertEqual(summary["saved"], 2)
        self.assertEqual(summary["stop_reason"], "results_repeated")
        self.assertEqual(self.discover.call_count, 2)
        self.assertEqual(self.advance.call_count, 1)

    def test_login_challenge_on_search_stops_before_discovery(self):
        self.access.side_effect = portal_scraper.PortalAccessError("Login required")

        summary = self.collect()

        self.assertEqual(summary["attempted"], 0)
        self.assertEqual(summary["saved"], 0)
        self.assertEqual(summary["stop_reason"], "access_required")
        self.discover.assert_not_called()
        self.load.assert_not_called()
        self.save.assert_not_called()
        self.advance.assert_not_called()

    def test_login_challenge_on_detail_stops_before_later_jobs(self):
        self.discover.return_value = [self.listing(101), self.listing(102)]
        self.load.side_effect = portal_scraper.PortalAccessError("Verification required")

        summary = self.collect()

        self.assertEqual(summary["attempted"], 1)
        self.assertEqual(summary["saved"], 0)
        self.assertEqual(summary["stop_reason"], "access_required")
        self.assertEqual(len(summary["errors"]), 1)
        self.assertEqual(self.load.call_count, 1)
        self.save.assert_not_called()
        self.advance.assert_not_called()
        self.detail.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
