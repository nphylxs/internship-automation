"""Atomic per-job records; CSV files are regenerated views, not the database."""
from __future__ import annotations

import contextlib
import csv
import hashlib
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


PROJECT_ROOT = Path(__file__).resolve().parent
FIELDS = [
    "Status", "Company", "Role Title", "Application URL", "Deadline",
    "Core Technologies", "Job ID", "Location", "Eligibility", "Eligibility Evidence",
    "Selected Resume", "Decision Reasons", "Description File", "Resume PDF",
    "Cover Letter", "Last Seen", "Last Error", "Authorization Category",
]


def canonical_url(url: str) -> str:
    parts = urlsplit(str(url).strip())
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise ValueError("Application URL must be an http(s) job URL")
    if parts.username or parts.password:
        raise ValueError("URLs containing credentials are not supported")
    # Retain job identifiers and all unknown parameters; remove only known tracking.
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not k.lower().startswith("utm_") and k.lower() not in {"gclid", "fbclid"}]
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/") or "/",
                       urlencode(sorted(query)), ""))


def job_id(url: str) -> str:
    return hashlib.sha256(canonical_url(url).encode()).hexdigest()[:24]


def content_hash(record: dict) -> str:
    fields = ("company", "title", "description", "location", "deadline", "employment_type",
              "structured_authorization", "internship_year", "internship_season", "start_date",
              "eligibility", "decision", "template", "filter_settings", "source_terms", "country", "country_code",
              "description_is_summary", "authorization_conflicts")
    value = {key: record.get(key) for key in fields}
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def atomic_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


@contextlib.contextmanager
def project_lock(root: Path):
    """Fail clearly instead of overlapping scheduled collection/generation runs."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    path = root / ".run.lock"
    handle = path.open("a+")
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            handle.write("0")
            handle.flush()
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise RuntimeError("Another collection/generation run is active") from exc
        else:
            import fcntl
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError("Another collection/generation run is active") from exc
        yield
    finally:
        handle.close()


def csv_safe(value) -> str:
    """Prevent external job text becoming a spreadsheet formula on CSV open."""
    text = str(value or "")
    if text.lstrip().startswith(("=", "+", "-", "@")) or text.startswith(("\t", "\r")):
        return "'" + text
    return text


class Store:
    def __init__(self, root: Path = PROJECT_ROOT):
        self.root = Path(root)
        self.directory = self.root / "data" / "jobs"

    def records(self) -> list[dict]:
        if not self.directory.exists():
            return []
        return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(self.directory.glob("*.json"))]

    def save(self, record: dict) -> None:
        identifier = record["id"]
        if not isinstance(identifier, str) or len(identifier) != 24 or any(c not in "0123456789abcdef" for c in identifier):
            raise ValueError("Invalid job ID")
        atomic_text(self.directory / f"{identifier}.json", json.dumps(record, indent=2, ensure_ascii=False) + "\n")

    def upsert(self, record: dict) -> str:
        path = self.directory / f"{record['id']}.json"
        old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
        record["source_names"] = sorted(set(record.get("source_names", [record.get("source", "")]) +
                                             (old.get("source_names", [old.get("source", "")]) if old else [])))
        record["content_hash"] = content_hash(record)
        record["first_seen"] = old.get("first_seen", record["last_seen"]) if old else record["last_seen"]
        record["status"] = {"eligible": "ready", "review": "pending_review", "excluded": "excluded"}[record["decision"]]
        # Identical input must never reset completion or generate duplicate resumes.
        if old and old.get("content_hash") == record["content_hash"]:
            merged = dict(old)
            merged.update(record)
            merged["status"] = old.get("status", record["status"])
            self.save(merged)
            return "unchanged"
        if old:
            history = list(old.get("previous_artifacts", []))
            if old.get("resume_path") or old.get("cover_letter_path"):
                history.append({key: old.get(key) for key in ("content_hash", "resume_path", "cover_letter_path", "generated_at")})
            record["previous_artifacts"] = history
        self.save(record)
        return "updated" if old else "new"

    def export_csvs(self) -> None:
        import io
        records = self.records()
        # A bounded discovery view; uncertainty remains explicit and does not
        # grant eligibility or enable document generation.
        candidates = [r for r in records if r.get("decision") != "excluded"
                      and r.get("is_internship") is True and r.get("is_hardware") is True]
        candidates.sort(key=lambda r: (
            r.get("decision") != "eligible",
            sum("year" in x or "season" in x or "location" in x for x in r.get("reasons", [])),
            not bool(r.get("description")), len(r.get("reasons", [])),
            r.get("company", ""), r["id"]))
        shortlist_ids = {r["id"] for r in candidates[:25]}
        shortlist_rank = {r["id"]: i for i, r in enumerate(candidates)}
        for decision, filename in (("cpt_accepted", "cpt_accepted.csv"), ("risky", "risky_postings.csv"), ("international_accepted", "international_accepted.csv"), ("shortlist", "shortlist.csv"), ("eligible", "internshiptracker.csv"), ("review", "review_queue.csv"), ("excluded", "excluded_jobs.csv")):
            output = io.StringIO(newline="")
            writer = csv.DictWriter(output, fieldnames=FIELDS)
            writer.writeheader()
            for record in sorted(records, key=lambda r: (shortlist_rank.get(r["id"], 999999),) if decision == "shortlist" else (r.get("company", ""), r.get("title", ""), r["id"])):
                if decision in {"cpt_accepted", "risky", "international_accepted"}:
                    if record.get("decision") == "excluded" or record.get("eligibility", {}).get("category") != decision:
                        continue
                elif (record["id"] not in shortlist_ids if decision == "shortlist" else record.get("decision") != decision):
                    continue
                eligibility = record.get("eligibility", {})
                row = dict(zip(FIELDS, [
                    record.get("status"), record.get("company"), record.get("title"), record.get("application_url"),
                    record.get("deadline"), "; ".join(record.get("technologies", [])), record["id"], record.get("location"),
                    eligibility.get("status"), " | ".join(eligibility.get("evidence", [])), record.get("template"),
                    " | ".join(record.get("reasons", [])), f"data/jobs/{record['id']}.json", record.get("resume_path"),
                    record.get("cover_letter_path"), record.get("last_seen"), record.get("last_error"), eligibility.get("category"),
                ]))
                writer.writerow({key: csv_safe(value) for key, value in row.items()})
            atomic_text(self.root / filename, output.getvalue())
