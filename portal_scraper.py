#!/usr/bin/env python3
"""Collect visible job descriptions after an interactive portal login."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlsplit

from job_store import PROJECT_ROOT, Store, atomic_text, project_lock
from scraper import prepare_job, apply_filters
from sources_api import plain_text, walk_json

START = {"linkedin": "https://www.linkedin.com/jobs/", "handshake": "https://app.joinhandshake.com/job-search"}
SELECTORS = {
    "linkedin": {"title": "h1", "company": ".job-details-jobs-unified-top-card__company-name", "location": ".job-details-jobs-unified-top-card__primary-description-container .tvm__text", "description": ".jobs-description__content, .show-more-less-html__markup"},
    "handshake": {
        "title": '[data-hook="right-content"] h1, [data-testid="job-title"]',
        "company": '[data-hook="right-content"] a[href^="/e/"], [data-testid="employer-name"]',
        "location": '[data-testid="job-location"]',
        "description": '[data-testid="job-description"], [data-hook="job-description"]',
    },
}


def job_url(url, portal):
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    domain = "linkedin.com" if portal == "linkedin" else "joinhandshake.com"
    if parsed.scheme != "https" or not (host == domain or host.endswith("." + domain)) or parsed.username:
        return None
    pattern = r"/jobs/view/(?:[^/]*-)?(\d+)/?$" if portal == "linkedin" else r"/(?:stu/)?(?:jobs|postings|job-search)/(\d+)/?$"
    match = re.search(pattern, parsed.path)
    if not match:
        return None
    return (f"https://www.linkedin.com/jobs/view/{match[1]}" if portal == "linkedin"
            else f"https://{host}/stu/jobs/{match[1]}")


def read_visible(page, selector):
    for element in page.locator(selector).all():
        if element.is_visible():
            value = element.inner_text().strip()
            if value:
                return value
    return ""


class PortalAccessError(RuntimeError):
    """Login, challenge, or rate limit requiring a fresh manual session."""


def check_access(page):
    path = urlsplit(page.url).path
    if re.search(r"/(?:login|signin|sign-in|checkpoint|auth|captcha)(?:/|$)", path, re.I):
        raise PortalAccessError("Login or verification required; finish it manually and rerun")
    if page.locator('input[type="password"]:visible, iframe[src*="captcha"]:visible').count():
        raise PortalAccessError("Login or verification required; finish it manually and rerun")


def job_key(url, portal):
    canonical = job_url(url, portal)
    return f"{portal}:{urlsplit(canonical).path.split('/')[-1]}" if canonical else None


def handshake_section(page, name):
    # Observed Handshake markup: heading -> heading wrapper -> section container.
    scope = page.locator('[data-hook="right-content"]')
    if not scope.count():
        scope = page
    headings = scope.get_by_role("heading", name=name, exact=True)
    for heading in headings.all():
        if heading.is_visible():
            return heading.locator("xpath=../..")
    return None


def expand_description(page, portal):
    section = handshake_section(page, "Job description") if portal == "handshake" else None
    scope = section if section is not None else page
    buttons = scope.get_by_role("button", name=re.compile(r"^(?:Show|See) more(?:\s*\(|$)", re.I))
    for button in buttons.all():
        if button.is_visible():
            button.click(timeout=5000)
            # A collapsed description must never be labeled complete.
            try:
                button.wait_for(state="hidden", timeout=5000)
            except Exception as exc:
                raise ValueError("Description stayed collapsed after expansion") from exc


def structured_job(page):
    candidates = []
    for block in page.locator('script[type="application/ld+json"]').all():
        try:
            candidates.extend(walk_json(json.loads(block.text_content())))
        except (ValueError, TypeError):
            continue
    return candidates[0] if len(candidates) == 1 else {}


def extract(page, portal, selectors):
    check_access(page)
    url = job_url(page.url, portal)
    if not url:
        raise ValueError("Not on a job detail page; login or verification may be required")
    data = structured_job(page)
    org = data.get("hiringOrganization") or {}
    description = read_visible(page, selectors["description"]) or plain_text(data.get("description", ""))
    title = read_visible(page, selectors["title"]) or data.get("title", "")
    company = read_visible(page, selectors["company"]) or (org.get("name", "") if isinstance(org, dict) else "")
    location = read_visible(page, selectors["location"])
    extra = {}
    if portal == "handshake":
        section = handshake_section(page, "Job description")
        if section is not None:
            if section.get_by_role("button", name=re.compile(r"^Show more", re.I)).count():
                raise ValueError("Job description is still collapsed")
            if not description:
                description = section.inner_text().strip()
                description = re.sub(r"^Job description\s*", "", description)
                description = re.sub(r"\s*(?:Less|Show less)$", "", description)
        if len(description.strip()) < 100:
            raise ValueError("Full description not found; the portal selectors may need updating")
        glance = handshake_section(page, "At a glance")
        if glance is not None:
            glance_text = glance.inner_text().strip()
            extra["portal_job_details"] = glance_text
            # This section belongs to the posting, unlike profile match widgets.
            description += "\n\n" + glance_text
            if not location:
                match = re.search(r"(?:based in|in) ([^\n]+)", glance_text)
                if match:
                    location = match[1]
            match = re.search(r"From ([A-Z][a-z]+ \d{1,2}, 20\d{2}) to", glance_text)
            if match:
                extra["start_date"] = datetime.strptime(match[1], "%B %d, %Y").date().isoformat()
            if re.search(r"\bInternship\b", glance_text):
                extra["employment_type"] = "Internship"
    if not title or len(description.strip()) < 100:
        raise ValueError("Full description not found; the portal selectors may need updating")
    if not company:
        raise ValueError("Employer name not found; update the company selector")
    summary_only = bool(re.search(r"(?:see|view|read).{0,40}(?:full|complete) job description (?:here|at|below)", description, re.I))
    return {"source": portal, "application_url": url, "title": title, "company": company,
            "location": location, "description": description, "description_is_summary": summary_only, **extra}


def discover_jobs(page, portal):
    # Search/detail split views must use the result list, not the selected job URL
    # or recommendation links in its description pane.
    if portal == "handshake":
        scope = page.locator('[data-hook="left-content"], [role="region"][aria-label="Jobs List"]')
    else:
        scope = page.locator('.jobs-search-results-list, .scaffold-layout__list')
    if scope.count():
        hrefs = scope.first.locator('a[href]').evaluate_all("elements => elements.map(e => e.href)")
    else:
        hrefs = page.locator('a[href]').evaluate_all("elements => elements.map(e => e.href)") if not job_url(page.url, portal) else [page.url]
    jobs = {}
    for href in hrefs:
        key = job_key(href, portal)
        if key:
            jobs.setdefault(key, {"key": key, "url": href})
    return list(jobs.values())


def advance_results(page, portal, previous_keys):
    if portal == "handshake":
        scope = page.locator('[data-hook="job-search-pagination"]')
        if not scope.count():
            return False
    else:
        scope = page
    next_button = scope.get_by_role("button", name=re.compile(r"^(?:go to )?next(?: page)?$", re.I))
    buttons = [button for button in next_button.all() if button.is_visible()]
    if not buttons or not buttons[0].is_enabled():
        return False
    buttons[0].click(timeout=10000)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        check_access(page)
        jobs = discover_jobs(page, portal)
        if jobs and {job["key"] for job in jobs} != set(previous_keys):
            return True
        page.wait_for_timeout(300)
    raise ValueError("Next page did not load new results within 15 seconds")


def load_detail(page, url, portal, selectors):
    response = page.goto(url, wait_until="domcontentloaded", timeout=30000)
    if response is not None and response.status in (401, 403, 429):
        raise PortalAccessError(f"Portal returned HTTP {response.status}; collection stopped")
    check_access(page)
    deadline = time.monotonic() + 15
    while True:
        check_access(page)
        if (read_visible(page, selectors["description"])
                or (portal == "handshake" and handshake_section(page, "Job description") is not None)
                or structured_job(page).get("description")):
            break
        if time.monotonic() >= deadline:
            raise ValueError("Job description section did not load")
        page.wait_for_timeout(300)
    if job_key(page.url, portal) != job_key(url, portal):
        raise ValueError("Portal redirected to a different job; skipped to avoid mismatched details")
    expand_description(page, portal)
    return extract(page, portal, selectors)


def collect_automatically(page, context, portal, selectors, root, filters, *,
                          max_jobs=25, max_pages=20, delay_ms=1500, attempted_keys=None):
    summary = {"saved": 0, "attempted": 0, "pages": 0, "errors": [], "stop_reason": "results_exhausted"}
    attempted = attempted_keys if attempted_keys is not None else set()
    detail = context.new_page()
    try:
        for _ in range(max_pages):
            check_access(page)
            jobs = discover_jobs(page, portal)
            pending = [job for job in jobs if job["key"] not in attempted]
            if not pending:
                summary["stop_reason"] = "results_repeated" if jobs else "no_job_links"
                break
            summary["pages"] += 1
            print(f"Results page {summary['pages']}: {len(pending)} new listings", flush=True)
            for item in pending:
                if summary["attempted"] >= max_jobs:
                    summary["stop_reason"] = "max_jobs"
                    return summary
                attempted.add(item["key"])
                summary["attempted"] += 1
                try:
                    raw = load_detail(detail, item["url"], portal, selectors)
                    job = save_job(raw, root, filters)
                    summary["saved"] += 1
                    print(f"Saved: {job['company']} — {job['title']} ({job['eligibility']['category']})", flush=True)
                except PortalAccessError as exc:
                    summary["errors"].append({"url": item["url"], "error": str(exc)})
                    summary["stop_reason"] = "access_required"
                    return summary
                except Exception as exc:
                    summary["errors"].append({"url": item["url"], "error": str(exc)[:500]})
                    print(f"Skipped {item['url']}: {exc}", flush=True)
                detail.wait_for_timeout(delay_ms)
            if summary["attempted"] >= max_jobs:
                summary["stop_reason"] = "max_jobs"
                break
            if summary["pages"] >= max_pages:
                summary["stop_reason"] = "max_pages"
                break
            if not advance_results(page, portal, {job["key"] for job in jobs}):
                break
    except PortalAccessError as exc:
        summary["errors"].append({"error": str(exc)})
        summary["stop_reason"] = "access_required"
    except KeyboardInterrupt:
        summary["stop_reason"] = "interrupted"
    except Exception as exc:
        summary["errors"].append({"error": str(exc)[:500]})
        summary["stop_reason"] = "navigation_error"
    finally:
        detail.close()
    return summary


def save_job(raw, root, filters):
    job = apply_filters(prepare_job(raw), filters)
    job["last_seen"] = datetime.now(timezone.utc).isoformat()
    with project_lock(root):
        store = Store(root)
        for previous in store.records():
            if job_key(previous.get("application_url", ""), raw["source"]) == job_key(raw["application_url"], raw["source"]):
                job["application_url"] = previous["application_url"]
                job["id"] = previous["id"]
                break
        store.upsert(job)
        store.export_csvs()
    return job


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("portal", choices=START)
    parser.add_argument("--max-jobs", type=int, default=25, help="Maximum distinct listings attempted, including failures")
    parser.add_argument("--max-pages", type=int, default=20, help="Maximum result pages per run")
    parser.add_argument("--manual", action="store_true", help="Prompt between result pages instead of advancing automatically")
    parser.add_argument("--selectors", type=Path, help="JSON overrides for title/company/location/description CSS selectors")
    parser.add_argument("--channel", help="Installed browser channel, e.g. chrome (default: Playwright Chromium)")
    args = parser.parse_args(argv)
    if args.max_jobs < 1 or args.max_pages < 1:
        parser.error("--max-jobs and --max-pages must be positive")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Install dependencies: python3 -m pip install -r requirements-portals.txt\nThen: python3 -m playwright install chromium", file=sys.stderr)
        return 1
    selectors = dict(SELECTORS[args.portal])
    if args.selectors:
        overrides = json.loads(args.selectors.read_text())
        if not isinstance(overrides, dict) or any(k not in selectors or not isinstance(v, str) or not v.strip() for k, v in overrides.items()):
            parser.error("Selectors must be a JSON object with nonempty CSS selectors for title/company/location/description")
        selectors.update(overrides)
    root = PROJECT_ROOT / "portal_jobs" / args.portal
    filters = json.loads((PROJECT_ROOT / "config.json").read_text())["filters"]
    summary = {"saved": 0, "attempted": 0, "pages": 0, "errors": [], "stop_reason": "cancelled"}
    attempted_keys = set()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=False, **({"channel": args.channel} if args.channel else {}))
        context = browser.new_context(accept_downloads=False)
        page = context.new_page()
        try:
            page.goto(START[args.portal], wait_until="domcontentloaded")
            print("Log in in the browser and open your filtered job search. Credentials and cookies are not saved.")
            while summary["attempted"] < args.max_jobs and summary["pages"] < args.max_pages:
                command = input("Press Enter once to start collecting; q to finish: ").strip().lower()
                if command == "q":
                    break
                # Wait for the results page, not merely the initial app shell.
                if args.portal == "handshake":
                    page.locator('[data-hook="left-content"], [data-hook="right-content"]').first.wait_for(state="visible", timeout=15000)
                batch = collect_automatically(page, context, args.portal, selectors, root, filters,
                    max_jobs=args.max_jobs - summary["attempted"],
                    max_pages=1 if args.manual else args.max_pages - summary["pages"],
                    attempted_keys=attempted_keys)
                for key in ("saved", "attempted", "pages"):
                    summary[key] += batch[key]
                summary["errors"].extend(batch["errors"])
                summary["stop_reason"] = batch["stop_reason"]
                if not args.manual or batch["stop_reason"] in {"access_required", "interrupted"}:
                    break
                print("Manual mode: move to the next results page before pressing Enter again.")
        except (EOFError, KeyboardInterrupt):
            summary["stop_reason"] = "interrupted"
        except Exception as exc:
            summary["stop_reason"] = "browser_error"
            summary["errors"].append({"error": str(exc)[:500]})
        finally:
            browser.close()
            with project_lock(root):
                atomic_text(root / "data" / "portal_last_run.json", json.dumps(summary, indent=2))
    print(f"Saved {summary['saved']} of {summary['attempted']} attempted jobs in {root}. Stop: {summary['stop_reason']}")
    if summary["errors"]:
        print(f"{len(summary['errors'])} errors; see data/portal_last_run.json in that folder.")
    return 0 if summary["saved"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
