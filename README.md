# Internship automation

Collect hardware internships, keep employer work-authorization evidence, and use
Antigravity to draft a tailored resume and cover letter for each matching job.

This working copy replaces the earlier scraper and launcher. Your original synced
attachments are untouched. The three files in `Templates/` are unchanged copies
of your FPGA, Robotics, and Power resumes.

For the interactive login workflow, jump to [Handshake and LinkedIn setup](#interactive-handshake-and-linkedin-collector).

## Start here

Open this entire folder as a project in Antigravity. Use **Python 3.10 or newer**.
The collector has no third-party Python dependencies, no browser driver, and no
Gemini API key requirement. Generation uses your installed, signed-in `agy` CLI
and `pdflatex` on PATH. The CLI must support `--input-format stream-json`,
`--output-format stream-json`, and `--json-schema` as documented in the current
[Antigravity headless guide](https://antigravity.google/docs/cli/headless/).

Run these commands from this folder:

```bash
# Collect from all configured sources, save descriptions, and write the CSVs.
python3 scraper.py

# See which jobs would generate documents, without calling a model.
python3 generate.py --dry-run

# Generate one eligible job's resume PDF and cover-letter draft first.
python3 generate.py --limit 1
```

After checking the first outputs, run `python3 generate.py` to process all ready
jobs. Each job makes one Antigravity request using your account's usage allowance.
The workflow does not submit applications or send messages.

On Linux/macOS, the launcher runs either stage or both:

```bash
bash process_internship.sh scrape
bash process_internship.sh generate --limit 5
bash process_internship.sh all -- --limit 5
```

Arguments before `--` in `all` mode go to the scraper; arguments after it go to
generation. The launcher stops if collection has no successful source. A partial
source failure is reported but does not prevent processing jobs from other sources.
It does not stage files in Git or bypass Antigravity permissions.

If generation reports a missing LaTeX command or package, use your existing TeX
distribution's package manager. The templates require standard pdfLaTeX packages
including `fullpage`, `titlesec`, `marvosym`, `enumitem`, and `fancyhdr`.
Use `python3 generate.py --retry-errors --limit 1` after resolving a failure.

## What changed

- Public Greenhouse and Lever APIs provide individual jobs and full descriptions.
  Lever pagination continues through all pages. Ten employer boards are configured.
- The corrected Simplify feed is `listings.json`; it supplies additional active
  hardware listings and individual job links. It does not supply descriptions.
- Missing descriptions are fetched through recognizable public ATS endpoints or
  a page's explicit `JobPosting` structured data, with 25 attempts per run by
  default. Login, challenge, and unsupported pages remain reviewable errors.
- Each job has a stable ID, saved description, evidence, timestamps, and status.
  Rerunning unchanged jobs preserves generated documents. Changed descriptions or
  filters requeue the job. Fully refreshed sources can retire jobs no longer listed.
- Antigravity receives the full job description and all three approved resumes.
  Its structured response contains a complete resume and a Markdown cover letter.
  Python saves and validates the outputs and compiles the resume. A successful
  CLI exit alone does not mark a job processed.

## Files to use

| File or folder | Purpose |
| --- | --- |
| `config.json` | Sources, filters, request pacing, description-fetch budget |
| `internshiptracker.csv` | Jobs meeting all configured checks; generation status and output paths |
| `review_queue.csv` | Unclear authorization, missing descriptions/dates/location, or weak resume matches |
| `excluded_jobs.csv` | Explicit mismatches, restrictions, expired deadlines, or removed listings |
| `data/jobs/<id>.json` | Full description, exact evidence, and authoritative state for each job |
| `data/last_run.json` | Per-source counts, failures, limits, and latest run totals |
| `Resumes/<id>/resume.tex` and `resume.pdf` | Tailored resume source and PDF |
| `CoverLetters/<id>/cover_letter.md` | Copyable cover-letter draft |
| `data/generation/<id>/<attempt>/` | Input snapshot, model response, compiler logs, and `REVIEW.md` |
| `SKILL.md` | Authoring rules passed to Antigravity; no separate skill installation needed |

CSV files are regenerated views. Editing a CSV does not update job state. Keep
the `data/` folder when moving or backing up this project; otherwise deduplication
and generation history are lost. Job folders and generated drafts are ignored by
Git by default. Empty CSVs are supplied initially; the example job is never loaded
automatically.

## Your confirmed filters

The defaults are **United States, Summer 2027**, hardware internships, and explicit
employer acceptance of CPT/OPT or international students. Modify `config.json`
for another year/season. This version's country rules support the U.S.; another
country needs a corresponding classifier update.

Authorization has three states: `supported`, `excluded`, or `unknown`. Unknown is
never silently accepted. Sponsorship policy is stored separately; “no sponsorship”
alone is not proof that CPT/OPT students are excluded. Contradictory statements or
export-control conditions go to review. Evidence is quoted from the description or
identified by the exact structured source field. This describes employer wording,
not confirmation of an individual student's work authorization.

Rules are deliberately conservative and use explainable keyword/pattern matching,
not an LLM eligibility judgment. Thus the review queue can be much larger than
the eligible tracker. Inspect `Decision Reasons` to understand why. Degree,
graduation-date, actual availability, and any special requirements still need your
review. A blank tracker is preferable to claiming acceptance without evidence.

Resume selection weights the title and description:

| Baseline | Typical evidence |
| --- | --- |
| FPGA | FPGA, RTL, SystemVerilog, VHDL, ASIC, verification |
| Robotics | Embedded systems, firmware, sensors, PCBs, robotics, mechatronics |
| Power | Power systems, power electronics, converters, batteries, BMS, grids |

Weak or tied matches stay in review. The generator preserves your existing facts,
contact header, and LaTeX preamble. Check your baselines before large runs:
`power.tex` dates one project October 2026 and specifies active cell balancing;
confirm those details and the shared battery-range measurement are accurate.
Compilation verifies that a PDF was produced; check its layout and both drafts'
claims before using them.

## Handshake and LinkedIn imports

This version does **not** log into Handshake or LinkedIn, collect passwords, or
bypass bot checks. It accepts individual listings saved from your own browsing,
alerts, or authorized exports. It does not read your email account or parse raw
email messages. Copy the full description and employer's authorization evidence
into the import format below; an alert excerpt is insufficient for tailoring.

Copy `imports/example_jobs.json` to `imports/private_jobs.json`, replace the
demonstration job with real information, and import it:

```bash
python3 scraper.py --import-file imports/private_jobs.json --no-enrich
python3 generate.py --dry-run
```

JSON accepts one job object, a list, or `{"jobs": [...]}`. Required fields are
`title` and `application_url`; supply `company`, `description`, `location`,
`internship_year`, and `internship_season` to make classification useful. Include
the actual authorization wording in `description`. A verified portal field can
also be recorded as `structured_authorization`, for example:

```json
{"accepts_cpt": true, "accepts_opt": null, "sponsorship": false}
```

Use JSON booleans and `null`, not strings. Do not infer these values from missing
text. Add `description_is_summary: true` when importing an excerpt. Imported
`decision` and `status` values cannot skip classification. Reimporting the same
application URL updates that job instead of creating a duplicate. Imported
metadata can be superseded by later employer-source updates; review new conflicts.

CSV imports accept these headers: `Company`, `Role Title`, `Application URL`,
`Description`, `Location`, `Deadline`, plus lowercase JSON field names above.
Multi-line descriptions must be CSV-quoted. `structured_authorization` in a CSV
cell is a JSON object string.

For a persistent Handshake integration, ask USF Career Services for an approved
[school RSS feed](https://support.joinhandshake.com/hc/en-us/articles/222083748-School-Settings-External-Feeds)
or an authorized integration/export through the
[institution-scoped EDU API](https://support.joinhandshake.com/hc/en-us/articles/31061076506391-Getting-Started-with-EDU-API).
No university API credentials or direct EDU API adapter are included. An approved
RSS feed can be added to `config.json`:

```json
{"name": "usf-approved", "type": "rss", "url": "https://YOUR_APPROVED_FEED_URL", "contains_full_descriptions": false}
```

RSS items default to summaries; mark them as full descriptions only after checking
the feed. Handshake feeds may expose only the first 200 results, so use appropriately
filtered feeds and do not assume an RSS feed covers the entire portal. Use native
[Handshake search alerts](https://support.joinhandshake.com/hc/en-us/articles/218693388-Saving-Job-Searches-and-Receiving-Job-Alerts)
or [LinkedIn alerts](https://www.linkedin.com/help/linkedin/answer/a511279/job-alerts-on-linkedin)
for additional discovery. Public employer links can be imported for description
retrieval; protected portal links require the saved description.

## Troubleshooting and checks

```bash
# Work offline with the clearly labeled example; save nothing and call no model.
python3 scraper.py --import-file imports/example_jobs.json --no-enrich --dry-run

# Restrict a live collection run while diagnosing a source.
python3 scraper.py --source mill --source zoox --no-enrich

# Preview one saved eligible job, or retry a failed generation.
python3 generate.py --job-id JOB_ID --dry-run
python3 generate.py --job-id JOB_ID --retry-errors

# Run the offline test suite, with no accounts or model calls.
python3 -m unittest discover -s tests -v
```

`--dry-run` on the scraper can still fetch public sources unless you import a
complete local file with `--no-enrich`. It does not change job records or CSVs.
`--max-jobs` explicitly limits processed records; omit it for normal coverage.
Source 401/403 responses are not bypassed; bounded retries apply to transient errors
and rate limits. One broken board does not discard the results from other boards.
A `.run.lock` prevents overlapping collection/generation runs. Process completion
releases the lock automatically; the empty lock file can remain.

Public interfaces: [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html),
[Lever Postings API](https://github.com/lever/postings-api), and
[Simplify internship feed](https://github.com/SimplifyJobs/Summer2027-Internships).
Employer boards can move or disappear; add or disable sources in `config.json` as needed.

## Managing the review queue

Open `shortlist.csv` first. It contains at most 25 explicitly identified hardware
internships, prioritizing matches with known target dates and location, complete
 descriptions, and fewer unresolved checks. It is a discovery shortlist, not
confirmation of work authorization. Its Eligibility and Decision Reasons columns
retain uncertainty; eligible jobs and suitable risky jobs enter document generation.

Description fetches now prioritize jobs never attempted before older failures,
so reruns make progress through the backlog. Increase the per-run budget with:

```bash
python3 scraper.py --max-detail-fetches 100
```

The strict authorization setting still requires explicit acceptance. Missing
acceptance wording is not a rejection, but cannot establish eligibility.

## Authorization categories

Collection also writes `cpt_accepted.csv` for explicit CPT acceptance,
`risky_postings.csv` for complete descriptions with no stated acceptance or
rejection of international students, and `international_accepted.csv` for explicit
OPT/international-student acceptance that does not specifically confirm CPT.
These views exclude discarded jobs and retain other unresolved checks in Decision
Reasons. Missing descriptions and conditional or export-control language stay in
review. A lack of sponsorship alone does not establish rejection of international
students. Explicit rejection or citizenship restrictions take precedence over
positive language and are discarded into `excluded_jobs.csv` for audit history.

Generation includes risky postings automatically when they pass the remaining
checks (full description, target term/location, hardware internship, and resume
match). Authorization stays unknown. Run `python3 generate.py --dry-run` to
preview, then `python3 generate.py --limit 1` or `python3 generate.py` to generate.
Processed jobs are skipped; failed jobs require `--retry-errors`. Missing details
and explicit restrictions still block generation.

## Generated document folders

Outputs use `Company - Role - short ID` folder names under `Resumes/` and
`CoverLetters/`. Each resume folder contains `resume.pdf`, `resume.tex`, and
`cover_letter.md`. Cover letters are Markdown text drafts, not PDFs. Normal
generation runs also rename legacy ID-only folders and update saved paths.
Dry runs leave files unchanged. Completed jobs are not regenerated just to rename
folders or copy an existing cover letter.

## Selecting projects across resumes

Each generation request includes all three resumes from Templates. The selected
baseline controls layout and contact details; projects and supported skills may
come from any of the three. The model is instructed to replace less relevant
projects, avoid duplicates, retain the baseline project count limit, and flag
conflicting facts. Review notes identify the selected projects and their sources.
The exact source texts and hashes are saved in each attempt's input.json.
Previously processed jobs are skipped as before; this change applies to new
requests. Project choice and factual consistency still require human review.

## Interactive Handshake and LinkedIn collector

On branch `feature/portal-job-collector`, `portal_scraper.py` opens a visible
browser and waits for you to log in each session. It reads job descriptions from
your filtered search and advances through available result
pages automatically. It saves each successful job immediately and applies the
existing filters. It never submits applications. The session is temporary;
passwords, cookies, browser profiles, and page HTML are not saved.

### 1. Open the project and install the browser tools

Run all commands below from the project folder in an Ubuntu desktop terminal:

```bash
cd ~/Documents/internship_automation
git switch feature/portal-job-collector
```

Install the optional browser dependency once:

```bash
python3 -m venv .venv-portals
.venv-portals/bin/python -m pip install -r requirements-portals.txt
.venv-portals/bin/python -m playwright install chromium
```

If Ubuntu reports that `venv` or `ensurepip` is unavailable, install
`python3-venv` with `sudo apt install python3-venv`, then repeat setup. If browser
launch reports missing system libraries, run
`.venv-portals/bin/python -m playwright install-deps chromium` and follow its prompts.

You do not need to activate the environment: the commands below use it directly.

### 2. Start one portal collector

Choose one command:

```bash
.venv-portals/bin/python portal_scraper.py linkedin --max-jobs 25
.venv-portals/bin/python portal_scraper.py handshake --max-jobs 25
```

### 3. Log in and collect listings

1. Leave the terminal open. A browser window will appear.
2. Log in normally, completing any verification or school SSO yourself. For
   Handshake, select your school if requested.
3. Open the jobs search and choose your filters, such as United States,
   internships, and your hardware interests. Leave the results list open; you do
   not need to open each job yourself.
4. Return to the terminal and press **Enter once**. The script collects job links,
   visits their descriptions in a separate tab, expands descriptions when needed,
   and moves to the next results page automatically. It prints each saved job.
5. Collection ends when it reaches a limit or runs out of results. To stop early,
   press **Ctrl+C** in the terminal. Jobs already saved remain on disk.

`--max-jobs` limits the number of distinct jobs attempted per session, including
failed reads; the default is 25. `--max-pages` limits the number of result pages
visited; the default is 20. To collect a larger batch:

```bash
.venv-portals/bin/python portal_scraper.py handshake --max-jobs 100 --max-pages 20
```

Reruns update existing records without duplicating them, and each new session
requires login. You can also open an individual job in the original tab and
press Enter to collect it. An unreadable posting is logged and skipped so later
jobs can still be collected. Login or verification challenges require you to
complete the browser step manually.

For the previous workflow, where you choose each results page or individual job
and press Enter to collect its loaded links, add `--manual`:

```bash
.venv-portals/bin/python portal_scraper.py handshake --manual --max-jobs 25
```

In manual mode, navigate the original browser tab between batches and press
Enter again, or type **q** and Enter to finish.

To use installed Chrome instead of Playwright Chromium:

```bash
.venv-portals/bin/python portal_scraper.py linkedin --channel chrome
```

### 4. Find your collected jobs

Each portal has its own directory:

```text
portal_jobs/
  linkedin/
    cpt_accepted.csv
    risky_postings.csv
    review_queue.csv
    excluded_jobs.csv
    data/jobs/
  handshake/
    ...same files...
```

CSV files appear after the first successful collection. Open them in LibreOffice
Calc. `cpt_accepted.csv` lists explicit CPT acceptance; `risky_postings.csv` lists
postings with no stated international-student acceptance or rejection.
**Decision Reasons** shows other unresolved checks. Explicit restrictions are
excluded. Editing CSVs does not change the saved job records.

### 5. Generate resumes and cover letters

Generation requires your signed-in `agy` CLI and `pdflatex` on PATH, as described
in [Start here](#start-here). Run these commands from the project folder so
`--assets-root .` uses your current three resume templates and writing rules.

For LinkedIn:

```bash
python3 generate.py --root portal_jobs/linkedin --assets-root . --dry-run
python3 generate.py --root portal_jobs/linkedin --assets-root . --limit 1
# After reviewing the first documents, generate the remaining ready jobs:
python3 generate.py --root portal_jobs/linkedin --assets-root .
```

For Handshake:

```bash
python3 generate.py --root portal_jobs/handshake --assets-root . --dry-run
python3 generate.py --root portal_jobs/handshake --assets-root . --limit 1
python3 generate.py --root portal_jobs/handshake --assets-root .
```

The preview makes no model calls. Actual generation uses your Antigravity account.
Suitable risky postings are included automatically. Already processed jobs are
skipped; add `--retry-errors` to retry failures after fixing their cause.

Documents appear inside the selected portal directory:

```text
Resumes/Company - Role - short ID/
  resume.pdf
  resume.tex
  cover_letter.md
CoverLetters/Company - Role - short ID/
  cover_letter.md
```

Cover letters are Markdown text drafts, not PDFs. The main project's public-feed
jobs and generated documents stay in their original directories.

### Troubleshooting and current limitations

- **No job links found:** Open job search results or an individual job in the
  original tab and allow the page to load before starting collection. In
  Handshake, keep the left results list visible even when a job is selected.
- **Login or verification required:** Complete it manually in the original tab,
  then retry. The script does not bypass challenges.
- **Employer or full description not found:** The site's page layout may differ
  from the configured selectors. The posting is logged and skipped; see the
  selector option below.
- **Collection ends before the requested number:** The job limit counts attempted
  jobs, including failed reads. The results may also be exhausted, the page limit
  may have been reached, or pagination may not match the supported layout. Check
  `data/portal_last_run.json` in the portal's directory. Use `--manual` to collect
  another results page while diagnosing a changed layout.
- **Nothing ready to generate:** Inspect the portal's `review_queue.csv` and
  Decision Reasons. Being in `risky_postings.csv` does not waive the other checks.
- **Missing `agy` or `pdflatex`:** Resolve the dependency using the setup notes
  above before running generation again.

Unknown dates/location and other job-fit checks still apply. Search filters alone
are not treated as employer evidence of a job's internship dates. Portal jobs are
not merged into the public-feed dataset. Private outputs are Git-ignored.

The current Handshake results list, job details, description expansion, and
pagination were checked in an authenticated browser session, including following
a job link and moving to the next results page. The collector also passed a
browser test that saved jobs across two simulated result pages, expanded their
descriptions, and skipped duplicates. A full authenticated Python collector run
has not been performed; LinkedIn's live
extraction also remains unverified. Site markup varies and can change. Pass
`--selectors selectors.json` with CSS selector overrides (keys: title, company,
location, description) if the detail layout differs. Missing employer names or
descriptions cause a visible error instead of importing a full page as a job
description. Login challenges are not bypassed. Run details are saved in the
dataset's `data/portal_last_run.json`.

LinkedIn prohibits automated scraping, and Handshake prohibits bulk automated
collection. Logging in does not remove those restrictions; access may be limited.
See [LinkedIn's automated activity policy](https://www.linkedin.com/help/linkedin/answer/a1340567/automated-activity-on-linkedin)
and [Handshake's terms](https://joinhandshake.com/legal/tos/).
