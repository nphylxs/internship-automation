"""Documented public job interfaces and local imports; no browser evasion."""
from __future__ import annotations

import csv
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from html.parser import HTMLParser
import ipaddress
import json
from pathlib import Path
import re
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
import xml.etree.ElementTree as ET

from job_store import canonical_url


class SourceError(RuntimeError):
    pass


class TextParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        elif tag in ("p", "div", "li", "br", "h1", "h2", "h3"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
        elif tag in ("p", "div", "li"):
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def plain_text(value) -> str:
    if value is None:
        return ""
    text = str(value)
    # Greenhouse can encode the HTML itself, not just its text content.
    for _ in range(2):
        text = unescape(text)
    parser = TextParser()
    parser.feed(text)
    return "\n".join(line.strip() for line in "".join(parser.parts).splitlines() if line.strip())


def public_url(url: str) -> str:
    url = canonical_url(url)
    host = urlsplit(url).hostname or ""
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise SourceError("Only public job URLs are supported")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if not address.is_global:
            raise SourceError("Private network URLs are not supported")
    return url


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Client:
    def __init__(self, interval=0.6, timeout=20, retries=2):
        self.interval, self.timeout, self.retries = interval, timeout, retries
        self.lock = threading.Lock()
        self.last = {}

    def get(self, url: str) -> str:
        url = public_url(url)
        for attempt in range(self.retries + 1):
            host = urlsplit(url).netloc
            with self.lock:
                wait = max(0.0, self.last.get(host, 0) + self.interval - time.monotonic())
                if wait:
                    time.sleep(wait)
                self.last[host] = time.monotonic()
            request = Request(url, headers={"User-Agent": "InternshipResearch/1.0 (personal job research)",
                                            "Accept": "application/json, application/rss+xml, text/html;q=0.8"})
            try:
                with build_opener(SafeRedirect()).open(request, timeout=self.timeout) as response:
                    payload = response.read(25_000_001)
                    if len(payload) > 25_000_000:
                        raise SourceError("Response exceeds 25 MB; narrow this source")
                    text = payload.decode(response.headers.get_content_charset() or "utf-8", errors="replace")
                    content_type = response.headers.get("Content-Type", "")
                    if "html" in content_type and re.search(r"<title[^>]*>[^<]*(just a moment|access denied|captcha|sign in)", text, re.I):
                        raise SourceError("Blocked or authentication page; import an authorized saved description")
                    return text
            except HTTPError as exc:
                if exc.code in (401, 403):
                    raise SourceError(f"HTTP {exc.code}: access restricted; no bypass attempted") from exc
                if exc.code in (429, 500, 502, 503, 504) and attempt < self.retries:
                    delay = min(10, 2 ** attempt)
                    retry_after = exc.headers.get("Retry-After", "")
                    if retry_after:
                        try:
                            requested = float(retry_after)
                        except ValueError:
                            try:
                                requested = (parsedate_to_datetime(retry_after) - datetime.now(timezone.utc)).total_seconds()
                            except (ValueError, TypeError):
                                requested = delay
                        if requested > 30:
                            raise SourceError(f"HTTP {exc.code}: Retry-After exceeds run wait budget; try later") from exc
                        delay = max(delay, requested)
                    time.sleep(max(0, delay))
                    continue
                raise SourceError(f"HTTP {exc.code} for {url}") from exc
            except (URLError, TimeoutError) as exc:
                if attempt < self.retries:
                    time.sleep(2 ** attempt)
                    continue
                raise SourceError(f"Network failure for {url}: {exc}") from exc
        raise SourceError("Request failed")

    def json(self, url):
        try:
            return json.loads(self.get(url))
        except json.JSONDecodeError as exc:
            raise SourceError("Expected JSON; the source may have changed or returned a blocked page") from exc


def greenhouse_job(item: dict, source: dict) -> dict:
    return {"source": source["name"], "source_job_id": str(item["id"]),
            "company": item.get("company_name") or source.get("company", source.get("board", "")),
            "title": item["title"], "application_url": item["absolute_url"],
            "description": plain_text(item.get("content", "")),
            "location": item.get("location", {}).get("name", ""),
            "deadline": item.get("application_deadline", ""), "date_updated": item.get("updated_at", "")}


def lever_job(item: dict, source: dict) -> dict:
    parts = []
    for name in ("opening", "description", "descriptionBody", "additional"):
        value = item.get(name + "Plain") or item.get(name) or ""
        text = plain_text(value)
        if text and text not in parts:
            parts.append(text)
    for section in item.get("lists", []):
        parts.append(plain_text(section.get("text", "") + "\n" + section.get("content", "")))
    categories = item.get("categories") or {}
    return {"source": source["name"], "source_job_id": str(item["id"]),
            "company": source.get("company", source.get("site", "")), "title": item["text"],
            "application_url": item.get("hostedUrl") or item["applyUrl"],
            "description": "\n\n".join(parts), "location": categories.get("location", ""),
            "employment_type": categories.get("commitment", ""), "country": item.get("country", ""), "deadline": ""}


def simplify_jobs(items: list, source: dict) -> list[dict]:
    jobs = []
    for item in items:
        if item.get("active") is not True or item.get("is_visible") is False:
            continue
        if source.get("category") and item.get("category") != source["category"]:
            continue
        terms = item.get("terms") or []
        terms = terms if isinstance(terms, list) else [str(terms)]
        years = set(re.findall(r"\b20\d{2}\b", " ".join(terms)))
        seasons = set(re.findall(r"\b(summer|fall|spring|winter)\b", " ".join(terms).lower()))
        job = {"source": source["name"], "source_job_id": str(item.get("id", "")),
               "company": item["company_name"], "title": item["title"], "application_url": item["url"],
               "description": "", "location": "; ".join(item.get("locations") or []),
               "employment_type": "Internship", "source_terms": terms,
               "source_sponsorship": item.get("sponsorship", ""), "deadline": "",
               "date_updated": item.get("date_updated", "")}
        if len(years) == 1:
            job["internship_year"] = int(next(iter(years)))
        if len(seasons) == 1:
            job["internship_season"] = next(iter(seasons))
        if item.get("sponsorship") == "U.S. Citizenship is Required":
            job["structured_authorization"] = {"requires_citizenship": True}
        elif item.get("sponsorship") == "Offers Sponsorship":
            job["structured_authorization"] = {"sponsorship": True}
        elif item.get("sponsorship") == "Does Not Offer Sponsorship":
            job["structured_authorization"] = {"sponsorship": False}
        jobs.append(job)
    return sorted(jobs, key=lambda job: str(job.get("date_updated", "")), reverse=True)


def import_records(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        if path.suffix.lower() == ".csv":
            items = list(csv.DictReader(handle))
        else:
            value = json.load(handle)
            items = value.get("jobs", [value]) if isinstance(value, dict) else value
    if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
        raise ValueError("Import must contain a JSON job object/list, {jobs: [...]}, or a CSV with headers")
    aliases = {"Company": "company", "Role Title": "title", "Application URL": "application_url",
               "Description": "description", "Location": "location", "Deadline": "deadline"}
    results = []
    for item in items:
        job = {aliases.get(key, key): value for key, value in item.items()}
        if not job.get("application_url") and job.get("url"):
            job["application_url"] = job["url"]
        # Imported decisions/statuses never bypass classification.
        allowed = {"source", "source_job_id", "company", "title", "application_url", "description", "location",
                   "deadline", "employment_type", "structured_authorization", "internship_year", "internship_season", "start_date",
                   "country", "country_code", "structured_term", "internship_term", "source_terms", "description_is_summary"}
        job = {key: value for key, value in job.items() if key in allowed}
        if isinstance(job.get("structured_authorization"), str):
            job["structured_authorization"] = json.loads(job["structured_authorization"] or "{}")
        if isinstance(job.get("description_is_summary"), str):
            value = job["description_is_summary"].strip().lower()
            if value not in {"true", "false", ""}:
                raise ValueError("description_is_summary must be true or false")
            job["description_is_summary"] = value == "true"
        job["source"] = job.get("source") or f"import:{path.name}"
        job["description"] = plain_text(job.get("description", ""))
        results.append(job)
    return results


def rss_jobs(text: str, source: dict) -> list[dict]:
    root = ET.fromstring(text)
    jobs = []
    atom = "{http://www.w3.org/2005/Atom}"
    entries = root.findall(".//item") or root.findall(f"{atom}entry")
    for entry in entries:
        link = entry.findtext("link")
        if not link:
            element = entry.find(f"{atom}link")
            link = element.get("href", "") if element is not None else ""
        if not link:
            continue
        description = entry.findtext("{http://purl.org/rss/1.0/modules/content/}encoded") or entry.findtext("description") or entry.findtext(f"{atom}content") or entry.findtext(f"{atom}summary") or ""
        jobs.append({"source": source["name"], "source_job_id": entry.findtext("guid") or link,
                     "company": source.get("company", ""), "title": entry.findtext("title") or entry.findtext(f"{atom}title") or "",
                     "application_url": link, "description": plain_text(description), "location": "", "deadline": "",
                     "description_is_summary": not source.get("contains_full_descriptions", False)})
    return jobs


def collect_source(source: dict, client: Client) -> list[dict]:
    kind = source["type"]
    if kind == "greenhouse":
        token = quote(source["board"], safe="")
        data = client.json(f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true")
        return [greenhouse_job(item, source) for item in data["jobs"]]
    if kind == "lever":
        jobs, seen = [], set()
        limit = 100
        for page in range(source.get("max_pages", 100)):
            items = client.json(f"https://api.lever.co/v0/postings/{quote(source['site'], safe='')}?mode=json&limit={limit}&skip={page * limit}")
            if not isinstance(items, list):
                raise SourceError("Lever returned an unexpected response")
            for item in items:
                if item["id"] in seen:
                    raise SourceError("Lever pagination repeated a job ID; source response needs inspection")
                seen.add(item["id"])
                jobs.append(lever_job(item, source))
            if len(items) < limit:
                return jobs
        raise SourceError("Lever page limit reached; increase max_pages to avoid incomplete coverage")
    if kind == "simplify":
        items = client.json(source["url"])
        if not isinstance(items, list):
            raise SourceError("Simplify must return a list of listings")
        return simplify_jobs(items, source)
    if kind == "rss":
        return rss_jobs(client.get(source["url"]), source)
    raise ValueError(f"Unsupported source type: {kind}")


class JobLDParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.current = []
        self.blocks = []

    def handle_starttag(self, tag, attrs):
        if tag == "script" and dict(attrs).get("type", "").lower() == "application/ld+json":
            self.active = True
            self.current = []

    def handle_data(self, data):
        if self.active:
            self.current.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.active:
            self.blocks.append("".join(self.current))
            self.active = False


def walk_json(value):
    if isinstance(value, dict):
        types = value.get("@type", [])
        if types == "JobPosting" or isinstance(types, list) and "JobPosting" in types:
            yield value
        for item in value.values():
            yield from walk_json(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk_json(item)


def enrich_job(job: dict, client: Client) -> dict:
    """Only public ATS detail APIs or explicit JobPosting structured data."""
    url = public_url(job["application_url"])
    parsed = urlsplit(url)
    host, parts = parsed.hostname, parsed.path.strip("/").split("/")
    if host in {"www.linkedin.com", "linkedin.com"} or host and host.endswith("joinhandshake.com"):
        raise SourceError("Portal listing requires an approved feed or imported description")
    if host in {"boards.greenhouse.io", "job-boards.greenhouse.io"} and len(parts) >= 3 and parts[1] == "jobs" and parts[2].isdigit():
        data = client.json(f"https://boards-api.greenhouse.io/v1/boards/{quote(parts[0], safe='')}/jobs/{parts[2]}")
        result = greenhouse_job(data, {"name": job["source"], "company": job.get("company", "")})
    elif host == "jobs.lever.co" and len(parts) >= 2:
        data = client.json(f"https://api.lever.co/v0/postings/{quote(parts[0], safe='')}/{quote(parts[1], safe='')}?mode=json")
        result = lever_job(data, {"name": job["source"], "company": job.get("company", "")})
    else:
        parser = JobLDParser()
        parser.feed(client.get(url))
        candidates = []
        for block in parser.blocks:
            try:
                candidates.extend(walk_json(json.loads(block)))
            except json.JSONDecodeError:
                continue
        if len(candidates) != 1:
            raise SourceError("No single JobPosting description found; import the full description manually")
        data = candidates[0]
        locations = data.get("jobLocation") or []
        locations = locations if isinstance(locations, list) else [locations]
        places = []
        for location in locations:
            address = location.get("address", {}) if isinstance(location, dict) else {}
            if isinstance(address, str):
                places.append(address)
            else:
                country = address.get("addressCountry", "")
                if isinstance(country, dict):
                    country = country.get("name", "")
                places.append(", ".join(str(address.get(key, "")) for key in ("addressLocality", "addressRegion") if address.get(key)) + (", " + country if country else ""))
        company = data.get("hiringOrganization", {})
        result = {"description": plain_text(data.get("description", "")), "title": data.get("title") or job["title"],
                  "company": company.get("name") if isinstance(company, dict) else job.get("company"),
                  "location": "; ".join(places), "deadline": data.get("validThrough", ""),
                  "employment_type": data.get("employmentType", "")}
    if not result.get("description"):
        raise SourceError("The detail response did not contain a description")
    merged = dict(job)
    merged.update({key: value for key, value in result.items() if value})
    merged["application_url"] = job["application_url"]
    merged["description_is_summary"] = False
    merged["description_fetched_at"] = datetime.now(timezone.utc).isoformat()
    return merged
