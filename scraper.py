#!/usr/bin/env python3
"""Collect jobs, retain evidence, and export eligible/review/excluded CSV views."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import sys

from job_logic import classify_job
from job_store import PROJECT_ROOT, Store, atomic_text, canonical_url, content_hash, job_id, project_lock
from sources_api import Client, collect_source, enrich_job, import_records, plain_text


def prepare_job(raw: dict) -> dict:
    job = dict(raw)
    for required in ("title", "application_url"):
        if not isinstance(job.get(required), str) or not job[required].strip():
            raise ValueError(f"Missing required job field: {required}")
    job["application_url"] = canonical_url(job["application_url"])
    job["id"] = job_id(job["application_url"])
    for key in ("title", "company", "description", "location", "deadline", "employment_type"):
        value = job.get(key, "")
        if isinstance(value, list):
            value = "; ".join(map(str, value))
        if value is None:
            value = ""
        if not isinstance(value, str):
            raise ValueError(f"{key} must be text")
        job[key] = plain_text(value) if key == "description" else value.strip()
    if not isinstance(job.get("structured_authorization", {}), dict):
        raise ValueError("structured_authorization must be an object of booleans")
    if any(value is not None and not isinstance(value, bool) for value in job.get("structured_authorization", {}).values()):
        raise ValueError("Authorization flags must be true, false, or null, never strings")
    if not isinstance(job.get("description_is_summary", False), bool):
        raise ValueError("description_is_summary must be a boolean")
    job["source_names"] = [job.get("source", "unknown")]
    return job


def apply_filters(job: dict, filters: dict) -> dict:
    result = dict(job)
    result.update(classify_job(job, filters))
    result["filter_settings"] = filters
    reasons = list(result.get("reasons", []))
    if job.get("authorization_conflicts"):
        result["eligibility"]["status"] = "unknown"
        result["eligibility"]["category"] = "discarded"
        result["decision"] = "excluded"
        result["eligibility"]["evidence"].extend(job["authorization_conflicts"])
        if result["decision"] == "eligible":
            result["decision"] = "review"
        reasons.append("Sources disagree about work authorization; verify with the employer")
    if not result.get("company") and result.get("decision") == "eligible":
        result["decision"] = "review"
        reasons.append("Employer name is missing")
    deadline = result.get("deadline", "")
    if deadline:
        try:
            expired = datetime.fromisoformat(deadline[:10]).date() < datetime.now(timezone.utc).date()
        except ValueError:
            expired = False
        if expired:
            result["decision"] = "excluded"
            reasons.append("Application deadline has passed")
    result["reasons"] = list(dict.fromkeys(reasons))
    return result


def collect(config: dict, root: Path, sources: list[dict], imports: list[Path], *,
            dry_run=False, max_jobs=None, no_enrich=False, client=None) -> dict:
    client = client or Client(interval=config.get("request_interval_seconds", 0.6))
    store = Store(root)
    existing = {record["id"]: record for record in store.records()}
    started = datetime.now(timezone.utc).isoformat()
    summary = {"started_at": started, "dry_run": dry_run, "sources": {}, "errors": [],
               "new": 0, "updated": 0, "unchanged": 0, "eligible": 0, "review": 0, "excluded": 0,
               "detail_requests": 0, "duplicates": 0, "limited": False}
    raw_jobs = []
    with ThreadPoolExecutor(max_workers=min(4, max(1, len(sources)))) as executor:
        futures = {executor.submit(collect_source, source, client): source for source in sources}
        for future in as_completed(futures):
            source = futures[future]
            try:
                jobs = future.result()
                raw_jobs.extend(jobs)
                summary["sources"][source["name"]] = {"status": "ok", "jobs": len(jobs)}
                print(f"{source['name']}: {len(jobs)} jobs", flush=True)
            except Exception as exc:
                message = str(exc)
                summary["sources"][source["name"]] = {"status": "error", "error": message}
                summary["errors"].append({"source": source["name"], "error": message})
                print(f"{source['name']}: {message}", file=sys.stderr, flush=True)
    for path in imports:
        try:
            jobs = import_records(path)
            raw_jobs.extend(jobs)
            summary["sources"][f"import:{path.name}"] = {"status": "ok", "jobs": len(jobs)}
        except Exception as exc:
            summary["errors"].append({"source": str(path), "error": str(exc)})
            summary["sources"][f"import:{path.name}"] = {"status": "error", "error": str(exc)}
    # Resolve overlapping feeds before filtering; prefer the full description.
    by_id = {}
    for raw in raw_jobs:
        try:
            job = prepare_job(raw)
        except (ValueError, TypeError) as exc:
            summary["errors"].append({"source": raw.get("source", "unknown"), "error": str(exc)})
            continue
        old = by_id.get(job["id"])
        if old:
            summary["duplicates"] += 1
            old_complete = bool(old.get("description")) and not old.get("description_is_summary")
            new_complete = bool(job.get("description")) and not job.get("description_is_summary")
            best, other = (job, old) if new_complete and not old_complete or len(job["description"]) > len(old["description"]) and new_complete else (old, job)
            combined = dict(other)
            combined.update({key: value for key, value in best.items() if value not in ("", None, [])})
            # Never discard a conflicting structured restriction when sources overlap.
            combined["structured_authorization"] = {**other.get("structured_authorization", {}), **best.get("structured_authorization", {})}
            conflicts = list(old.get("authorization_conflicts", [])) + list(job.get("authorization_conflicts", []))
            for field in combined["structured_authorization"]:
                values = [candidate.get("structured_authorization", {}).get(field) for candidate in (old, job)]
                if True in values and False in values:
                    conflicts.append(f"Conflicting structured_authorization.{field}: true versus false")
                    combined["structured_authorization"][field] = None
            if any(candidate.get("structured_authorization", {}).get("requires_citizenship") is True for candidate in (old, job)):
                combined["structured_authorization"]["requires_citizenship"] = True
            combined["authorization_conflicts"] = list(dict.fromkeys(conflicts))
            combined["source_names"] = sorted(set(old["source_names"] + job["source_names"]))
            by_id[job["id"]] = combined
        else:
            by_id[job["id"]] = job
    ordered = sorted(by_id.values(), key=lambda job: (str(job.get("date_updated", "")), job["id"]), reverse=True)
    if max_jobs is not None and len(ordered) > max_jobs:
        summary["limited"] = True
        ordered = ordered[:max_jobs]
    filters = config.get("filters", {})
    detail_budget = 0 if no_enrich else int(config.get("max_detail_fetches", 25))
    # Give never-attempted listings a turn before retrying failed detail pages.
    ordered.sort(key=lambda job: existing.get(job["id"], {}).get("detail_attempted_at", ""))
    for job in ordered:
        previous = existing.get(job["id"], {})
        # Reuse recently saved detail text only while the listing identity remains unchanged.
        if not job.get("description") and previous.get("description") and not previous.get("description_is_summary"):
            try:
                age = datetime.now(timezone.utc) - datetime.fromisoformat(previous.get("description_fetched_at", ""))
            except (TypeError, ValueError):
                age = timedelta(days=999)
            if age < timedelta(days=config.get("description_cache_days", 3)) and all(job.get(key) == previous.get(key) for key in ("title", "company", "location")):
                job["description"] = previous["description"]
                job["description_fetched_at"] = previous["description_fetched_at"]
        if previous.get("detail_attempted_at"):
            job["detail_attempted_at"] = previous["detail_attempted_at"]
        preliminary = apply_filters(job, filters)
        incomplete = not job.get("description") or job.get("description_is_summary")
        if incomplete and preliminary["decision"] != "excluded" and summary["detail_requests"] < detail_budget:
            summary["detail_requests"] += 1
            job["detail_attempted_at"] = started
            try:
                job = enrich_job(job, client)
            except Exception as exc:
                job["collection_error"] = str(exc)
                summary["errors"].append({"job_id": job["id"], "url": job["application_url"], "error": str(exc)})
        if job.get("description") and not job.get("description_fetched_at"):
            job["description_fetched_at"] = started
        job = apply_filters(job, filters)
        job["last_seen"] = started
        summary[job["decision"]] += 1
        if not dry_run:
            outcome = store.upsert(job)
            summary[outcome] += 1
    summary["finished_at"] = datetime.now(timezone.utc).isoformat()
    if not dry_run:
        # Only exhaustive successful board/feed polls can retire missing jobs.
        # Imports, partial runs, and failed sources never imply that a job closed.
        successful = {source["name"] for source in sources
                      if summary["sources"].get(source["name"], {}).get("status") == "ok"}
        failed_normalization = {error.get("source") for error in summary["errors"] if error.get("source")}
        successful -= failed_normalization
        summary["no_longer_listed"] = 0
        if not summary["limited"]:
            for identifier, prior in existing.items():
                owners = set(prior.get("source_names", [prior.get("source", "")]))
                if identifier not in by_id and owners and owners <= successful and prior.get("status") != "excluded":
                    prior.update({"decision": "excluded", "status": "excluded",
                                  "reasons": ["No longer present in any successfully refreshed source"],
                                  "closed_checked_at": started})
                    prior["content_hash"] = content_hash(prior)
                    store.save(prior)
                    summary["no_longer_listed"] += 1
        store.export_csvs()
        atomic_text(root / "data" / "last_run.json", json.dumps(summary, indent=2) + "\n")
    print(f"This run: {summary['eligible']} eligible, {summary['review']} need review, {summary['excluded']} excluded; {len(summary['errors'])} collection errors.")
    if summary["limited"]:
        print("Job limit reached. Rerun without --max-jobs for complete configured-source coverage.")
    return summary


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=PROJECT_ROOT / "config.json")
    parser.add_argument("--source", action="append", help="Collect only this configured source name (repeatable)")
    parser.add_argument("--import-file", type=Path, action="append", default=[], help="Import saved JSON/CSV jobs; skips network source discovery unless --source is also set")
    parser.add_argument("--max-jobs", type=int, help="Limit processed unique records (omits additional jobs explicitly)")
    parser.add_argument("--max-detail-fetches", type=int, help="Override the description-fetch budget")
    parser.add_argument("--no-enrich", action="store_true", help="Do not fetch missing descriptions")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and classify without changing jobs or CSVs")
    parser.add_argument("--output-dir", type=Path, default=PROJECT_ROOT, help="Job data/CSV output directory")
    args = parser.parse_args(argv)
    if args.max_jobs is not None and args.max_jobs < 1:
        parser.error("--max-jobs must be positive")
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        if args.max_detail_fetches is not None:
            if args.max_detail_fetches < 0:
                parser.error("--max-detail-fetches must be nonnegative")
            config["max_detail_fetches"] = args.max_detail_fetches
        sources = [source for source in config.get("sources", []) if source.get("enabled", True)]
        if args.source:
            unknown = set(args.source) - {source["name"] for source in sources}
            if unknown:
                parser.error("Unknown/disabled source: " + ", ".join(sorted(unknown)))
            sources = [source for source in sources if source["name"] in args.source]
        elif args.import_file:
            sources = []
        with project_lock(args.output_dir):
            summary = collect(config, args.output_dir, sources, args.import_file, dry_run=args.dry_run,
                              max_jobs=args.max_jobs, no_enrich=args.no_enrich)
        succeeded = any(source["status"] == "ok" for source in summary["sources"].values())
        if not succeeded:
            print("No sources/imports completed successfully; inspect data/last_run.json.", file=sys.stderr)
            return 1
        return 0
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"Collection failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
