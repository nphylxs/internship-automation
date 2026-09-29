#!/usr/bin/env python3
"""Collect visible job descriptions after an interactive portal login."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

from job_store import PROJECT_ROOT, Store, atomic_text, project_lock
from scraper import prepare_job, apply_filters
from sources_api import plain_text, walk_json

START = {"linkedin": "https://www.linkedin.com/jobs/", "handshake": "https://app.joinhandshake.com/stu/postings"}
SELECTORS = {
    "linkedin": {"title": "h1", "company": ".job-details-jobs-unified-top-card__company-name", "location": ".job-details-jobs-unified-top-card__primary-description-container .tvm__text", "description": ".jobs-description__content, .show-more-less-html__markup"},
    "handshake": {"title": "h1", "company": '[data-testid="employer-name"]', "location": '[data-testid="job-location"]', "description": '[data-testid="job-description"], [data-hook="job-description"]'},
}


def job_url(url, portal):
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    domain = "linkedin.com" if portal == "linkedin" else "joinhandshake.com"
    if parsed.scheme != "https" or not (host == domain or host.endswith("." + domain)) or parsed.username:
        return None
    pattern = r"/jobs/view/(?:[^/]*-)?(\d+)/?$" if portal == "linkedin" else r"/(?:stu/)?(?:jobs|postings)/(\d+)/?$"
    match = re.search(pattern, parsed.path)
    if not match:
        return None
    return (f"https://www.linkedin.com/jobs/view/{match[1]}" if portal == "linkedin"
            else f"https://{host}{parsed.path.rstrip(chr(47))}")


def read_visible(page, selector):
    for element in page.locator(selector).all():
        if element.is_visible():
            value = element.inner_text().strip()
            if value:
                return value
    return ""


def extract(page, portal, selectors):
    url = job_url(page.url, portal)
    if not url:
        raise ValueError("Not on a job detail page; login or verification may be required")
    if page.locator('input[type="password"]:visible, iframe[src*="captcha"]:visible').count():
        raise ValueError("Login or verification required; finish it manually and rerun")
    data = None
    for block in page.locator('script[type="application/ld+json"]').all():
        try:
            candidates = list(walk_json(json.loads(block.text_content())))
        except (ValueError, TypeError):
            continue
        if len(candidates) == 1:
            data = candidates[0]
            break
    data = data or {}
    org = data.get("hiringOrganization") or {}
    description = read_visible(page, selectors["description"]) or plain_text(data.get("description", ""))
    title = read_visible(page, selectors["title"]) or data.get("title", "")
    company = read_visible(page, selectors["company"]) or (org.get("name", "") if isinstance(org, dict) else "")
    location = read_visible(page, selectors["location"])
    if not title or len(description) < 100:
        raise ValueError("Full description not found. Expand it in the browser or update the selector configuration")
    if not company:
        raise ValueError("Employer name not found; update the company selector")
    return {"source": portal, "application_url": url, "title": title, "company": company,
            "location": location, "description": description, "description_is_summary": False}


def save_job(raw, root, filters):
    job = apply_filters(prepare_job(raw), filters)
    job["last_seen"] = datetime.now(timezone.utc).isoformat()
    with project_lock(root):
        store = Store(root)
        store.upsert(job)
        store.export_csvs()
    return job


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("portal", choices=START)
    parser.add_argument("--max-jobs", type=int, default=25)
    parser.add_argument("--selectors", type=Path, help="JSON overrides for title/company/location/description CSS selectors")
    parser.add_argument("--channel", help="Installed browser channel, e.g. chrome (default: Playwright Chromium)")
    args = parser.parse_args(argv)
    if args.max_jobs < 1:
        parser.error("--max-jobs must be positive")
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
    seen, errors, saved = set(), [], 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=False, **({"channel": args.channel} if args.channel else {}))
        context = browser.new_context(accept_downloads=False)
        page = context.new_page()
        page.goto(START[args.portal], wait_until="domcontentloaded")
        print("Log in in the browser and open your filtered job search. Credentials and cookies are not saved.")
        try:
            while saved < args.max_jobs:
                command = input("Enter to collect the loaded search results (or current job); q to finish: ").strip().lower()
                if command == "q":
                    break
                urls = []
                current = job_url(page.url, args.portal)
                if current:
                    urls.append(current)
                else:
                    for href in page.locator("a[href]").evaluate_all("elements => elements.map(e => e.href)"):
                        url = job_url(href, args.portal)
                        if url and url not in urls:
                            urls.append(url)
                if not urls:
                    print("No job links found. Open search results or a job detail page, then retry.")
                    continue
                detail = context.new_page()
                try:
                    for url in urls:
                        if url in seen or saved >= args.max_jobs:
                            continue
                        try:
                            detail.goto(url, wait_until="domcontentloaded", timeout=30000)
                            try:
                                detail.locator(selectors["description"]).first.wait_for(state="visible", timeout=10000)
                            except Exception:
                                pass  # extract can still use explicit JobPosting structured data.
                            for label in ("Show more", "See more"):
                                button = detail.get_by_role("button", name=label, exact=True)
                                if button.count() == 1 and button.is_visible():
                                    button.click()
                            job = save_job(extract(detail, args.portal, selectors), root, filters)
                            seen.add(url)
                            saved += 1
                            print(f"Saved: {job['company']} — {job['title']} ({job['eligibility']['category']})")
                        except Exception as exc:
                            errors.append({"url": url, "error": str(exc)[:500]})
                            print(f"Stopped on {url}: {exc}\nCheck login, expand the description, or adjust selectors before retrying.")
                            break
                        detail.wait_for_timeout(1500)
                finally:
                    detail.close()
                print("Navigate the original tab to the next results page to collect more.")
        except (EOFError, KeyboardInterrupt):
            print("\nEnding session; saved jobs are retained.")
        finally:
            browser.close()
            with project_lock(root):
                atomic_text(root / "data" / "portal_last_run.json", json.dumps({"saved": saved, "errors": errors}, indent=2))
    print(f"Saved {saved} jobs in {root}")
    return 0 if saved else 1


if __name__ == "__main__":
    raise SystemExit(main())
