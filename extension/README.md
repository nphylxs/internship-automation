# Internship Desk for Brave

A Manifest V3 extension for desktop Brave, Chrome, and Chromium. Click it on an
internship listing to save it without leaving the page, or collect selected open job tabs and prepare applications in a background queue.

## Install on this Linux computer

1. Open `brave://extensions`, turn on **Developer mode**, and choose **Load unpacked**.
2. Select this repository's `extension` folder:
   `/home/divyamshu/Documents/internship_automation/extension`
3. Copy the extension's 32-letter ID from that page.
4. In a terminal in the repository, register the local helper:

   ```bash
   python3 native_host/install.py YOUR_EXTENSION_ID
   ```

5. Pin **Internship Desk** from Brave's extensions menu. Open a listing and click it.
6. Click **Check local helper**. The helper requires Python 3.10+ and your installed,
   signed-in `agy` CLI. It requires `pdflatex` and the packages used by your original LaTeX templates. It does not require a server or separate API key.
7. Open **Your profile → Import existing resume sources**, review the imported
   FPGA, Robotics, and Power resume facts, add skills and eligibility notes, and
   **Save profile**. You can also paste a resume as plain text.

The installer registers only this extension ID. Run it again if you move the
repository or reload the unpacked extension under a different ID. For Chrome or
Chromium, add `--browser chrome` or `--browser chromium`. Linux and macOS host
registration are supported; Windows registration is not implemented. Flatpak/Snap
browser sandbox packages may require native messaging integration outside this installer.

## Progress tracker, themes, and responsive workspace (version 0.8)

Open **Progress tracker** to bring Gemini Spark's Google Sheets updates into the
workspace. The tracker has list and board views, company/role search, status and
review filters, application timelines, next steps, source email links, and links
back to saved applications and their document versions.

1. Sign in to Google and open the Sheet in the **same browser profile** as the
   extension. Select the worksheet Gemini Spark updates and copy its full URL
   (the `gid` identifies that tab).
2. Paste the URL into **Progress tracker → Connection settings → Google Sheets
   URL**. Click **Preview sheet** and grant the requested Google site access.
3. Review the column mapping. **Company**, **Role**, and **Status** are required;
   date, job URL, email URL, notes, next step, and application ID are optional.
   Common header names are recognized automatically. The first five rows can be
   previewed before connecting; all values render as plain text.
4. Choose whether to sync every 15 minutes, then **Connect & sync**. **Sync now**
   refreshes immediately. Scheduled sync runs while the browser is open; browser
   sleep can delay an alarm. Last successful sync and errors stay visible.

Version 0.8.1 also reads formatted tracker sheets with a title and summary dashboard
above the table. It searches the first 50 worksheet rows for **Company**, a role
column, and **Status** together. The preview identifies the detected header row;
earlier title, summary, and blank rows are excluded from imported applications.
For the **Internship Applications Tracker** layout, the table starts on row 8:
**Company**, **Position / Role**, **Status**, **Date / Term**, and **Notes**. These
columns map automatically, including the blank leading column. Summary counts
above the table may change without breaking subsequent syncs.

**Applied / Under Review** maps to **In review**, and **Interview Invited** maps to
**Interview**; the original status text remains in the application details.
Dates such as `Sep 18 2026` can be ordered chronologically. Year-only values such
as `2024` and `2025`, and terms such as `Summer 2027`, remain as written instead of
becoming invented exact dates. They do not cause a date warning for a single
application row. Multiple updates without exact dates still use Sheet row order.

The connection reads Google's CSV export with the browser's existing Google
session. It does not ask you to publish the Sheet, store an access token, read your
inbox, or edit the Sheet. Private access depends on the account, browser cookie
settings, and the owner's download policy. If Google returns a sign-in/access
page, open the Sheet in the same profile and retry. Alternatively, download the
worksheet with **File → Download → Comma-separated values (.csv)** and choose
**Import a CSV**. CSV imports use the same mapping and tracker but require a new
file to refresh; they do not enable automatic sync. A user's live private Sheet
connection must be verified with their actual link and session.

Rows represent either current applications or successive email updates. A stable
**Application ID** is the best grouping key; otherwise the tracker uses job URL,
then exact company and role. Keep identifiers consistent across updates. Distinct
applications for the same company/role need different IDs or URLs. When all dates
for an application are usable, the newest date determines its status; otherwise
the last matching Sheet row wins and the tracker shows a date warning. Prefer ISO
dates (`YYYY-MM-DD`, optionally with time/timezone); numeric slash dates are
treated as ambiguous. Unrecognized statuses stay **Unknown**, preserving the
original text for review. Rows missing company or role are skipped and counted.

Matching to saved opportunities uses an exact canonical job URL or a unique exact
company/role pair. Review unmatched or ambiguous entries in **View journey**, then
choose a saved application or **Keep as a separate application**. This links
documents without changing the original opportunity's manual status or drafts.
The latest 100 distinct updates per application are retained. Repeated syncs do
not duplicate events. Applications removed from the source remain labeled as
retained history. Changing Sheets keeps previous source histories locally; they
reappear when that source is reconnected. CSV imports share one local CSV source.

The importer accepts up to 2 MB, 5,000 data rows, and 100 columns. Failed reads or
changed column headers preserve the last successful data; changed headers require
a new preview/mapping. **Disconnect · keep history** stops scheduled reads. Site
permissions can separately be revoked in the browser's extension settings.
**Applications → Backup & restore** includes tracker history and manual matches.
Restoring validates imported records and leaves Sheets sync disconnected.

Choose **System**, **Light**, or **Dark** in the workspace top bar or popup. The
choice is remembered across views. Narrow screens have stacked forms, roomier
controls, and a two-column navigation menu. Panel transitions, card interactions,
and sync indicators honor the operating system's reduced-motion setting. Resume
PDFs and printed cover letters keep their white document pages.

Reload the unpacked extension at `brave://extensions` and reopen its workspace
after updating. No native helper reinstall is needed.

## Search and document review (version 0.7)

Applications now supports company/role search, readiness views, status,
discipline mentions, location, deadline filters, and sorting. Filters are remembered
locally. **Select visible** selects only matching rows; changing a filter clears
selection so hidden jobs cannot be prepared accidentally. Summary counts cover
all saved opportunities.

Open an application to review its compiled resume PDF next to the editable cover
letter. **Advanced editing** reveals the LaTeX source. After source changes,
**Refresh preview** compiles the updated PDF; **Save edited drafts** keeps a new
version. The preview never calls the model. **Open template PDF** remains available
if embedded PDF viewing is disabled in your browser.

## Workspace refresh (version 0.6)

The popup and workspace share a new cream-and-green design, with sidebar
navigation, live application summaries, clearer job cards and queue statuses,
and layouts for smaller windows. The popup keeps the workspace button available
while you scroll. All styles and icons are bundled locally; no external fonts
or assets are downloaded. Reload the extension and reopen its workspace to see
the update. Your existing profile, listings, drafts, and collection settings remain.

## Handshake collection and preparation (version 0.5)

Reload **Internship Desk** at `brave://extensions` after updating. Close and reopen
old extension workspace tabs. No helper reinstallation or new permissions are needed.

The popup now defaults to **Prepare applications when saving**. Choose your
FPGA, Robotics, or Power template, then **Save & prepare this listing**. It saves
the listing first and queues a resume and cover letter using your saved profile.
Uncheck preparation to collect listings only. The shortcut uses the same saved
preference. Missing profiles and helper failures appear in the popup and workspace;
saved listings remain available for retry. A paused application queue must be
resumed in Applications.

On Handshake job search, select the job to start with, set a maximum (1–100,
default 10), and click **Start automatic collection**. The extension expands the
selected job's full description, saves it using its job ID, clicks the next job
card, and continues onto the next results page until the limit or end of results.
Only jobs from the current position onward are collected. It uses your current
search filters. It does not click Handshake's Save or Apply buttons or submit any
application. Automatic navigation currently supports Handshake only; other sites
can still use single-listing or selected-tab capture.

You can close the popup while collection runs. Keep the job tab open and avoid
changing its selection or filters. Reopen the popup to see progress or **Stop
collection**. An in-flight page operation may finish after Stop; no further jobs
are started. Saved jobs and queued applications remain. Browser/extension restart
marks collection interrupted; start again from the selected job to continue.
Repeated captures preserve document history, including older Handshake search URLs.

## Batch application workflow

1. Open individual job listings and expand their full descriptions. Click the
   extension and **Save this listing**, or press **Alt+Shift+S** to save without
   leaving the page. Change a conflicting shortcut at `brave://extensions/shortcuts`.
2. To collect several already-open jobs, choose **Choose open job tabs…**, select
   the job pages, and **Save selected tabs**. Tab-list permission is optional;
   the browser then requests access to the selected sites. A failure on one tab
   does not discard the other captures. Search-result snippets still need full
   descriptions. Handshake automatic collection is available separately above.
3. Open **Applications & queue**. Review captured descriptions and choose the
   FPGA, Robotics, or Power template on each row. Check the jobs you want and
   click **Prepare selected applications**. The editor also has **Queue resume
   & letter** for a single listing. Save your verified profile before queueing.
4. Keep browsing or close the workspace. Generation runs in the extension's
   background worker while the browser remains open. One application runs at a
   time by default; select **2 — parallel** to try two simultaneous requests.
   Live Antigravity concurrency and throughput have not been benchmarked. If
   account limits cause failures, use one worker and retry failed jobs later.
5. Watch the persistent queue: waiting, running, saving, ready, failed, or
   interrupted. Pause stops new starts, not active jobs. Remove waiting jobs or
   retry individual failures. Other jobs continue after a failure. Closing the
   whole browser can interrupt active work; on restart, waiting jobs resume and
   interrupted jobs require an explicit retry to avoid duplicate model usage.
6. Open a saved application to review drafts and the compiled template PDF.
   PDFs export automatically to your configured folder. Model results are saved
   **before** export, so a folder problem does not discard your drafts or require
   regeneration. Open the draft and use **Save PDFs to folder now** to retry.
7. Use the exported PDFs to apply. Manual status controls are hidden by default
   and optional. **Progress tracker** separately reads your Google Sheet updates.

Queueing captures a snapshot of the listing, saved profile, template, and approved
planned projects. Changes made while a request runs do not alter that snapshot.
Duplicate active applications are skipped; identical inputs with an existing
saved draft are also skipped. Changed inputs can produce a new version. Model
latency per request is unchanged; the queue removes the wait from your browsing
workflow and optional parallelism can increase throughput.

URL deduplication preserves document history. Saving an existing URL updates the
listing without resetting its old versions. The draft editor remains associated
with its original application if you edit the listing fields above it. Use
**Save edited drafts** before closing; editor changes are not autosaved. Background
queue completion never overwrites unsaved text in the editor. Suggestions and
manual compilation still run in their workspace tab; keep it open for those.

### Updating from version 0.3

Reload at `brave://extensions` and close old workspace tabs. The local helper does
not need reinstallation. `alarms` resumes waiting work after worker suspension;
`unlimitedStorage` accommodates batches of saved PDF versions. Access to tab
metadata and websites is optional and requested by the tab-picker workflow.
Existing profiles, applications, document versions, and export settings remain.

## Automatic PDF saving

Version 0.3 automatically saves **both the template resume PDF and a cover-letter
PDF** after generation, saved edits, and approved-project changes. You can upload
these files directly from your file manager without using browser downloads.
They remain drafts for your review; automatic saving does not submit applications.

The default destination is `~/Downloads/Internship Applications`. Change it under
**Your profile → Automatically save application PDFs**: paste the full folder path
and click **Save folder settings**. `~` expands to your home folder. The helper
creates the folder and checks that it is writable. Turn off the checkbox there
to disable automatic exports. Settings are local to this project/helper and are
not overwritten when restoring an extension backup.

Files are grouped in a company subfolder and named with your name (from the
original template), company, role, document type, local timestamp, and a unique
suffix. For example:

```text
Internship Applications/Example_Labs/
  Divyamshu_Shrestha_Example_Labs_Hardware_Intern_Resume_2026-09-30_143000_a1b2c3d4.pdf
  Divyamshu_Shrestha_Example_Labs_Hardware_Intern_Cover_Letter_2026-09-30_143000_a1b2c3d4.pdf
```

Every export gets new filenames; previous files are never overwritten. Company
and role names are sanitized and shortened for filesystem compatibility. The
workspace shows the exact saved paths. If saving fails, drafts still remain in
the workspace and the app attempts to save them to the tracker; an explicit
folder error appears with a retry button. **Save PDFs to folder now** also exports
an existing draft, even when automatic saving is disabled. It saves the current
editor contents; use **Save edited drafts** to also retain a tracker version.

For updates, reload at `brave://extensions` and close old workspace tabs.
See the version 0.4 update notes above for new permissions; helper reinstallation is not required. Existing drafts are not
retroactively exported; open them and use **Save PDFs to folder now**. Older
plain-text resumes must be regenerated as template resumes first.

Long operations now display elapsed time. Opening an unchanged compiled resume
reuses its existing PDF rather than recompiling. Project suggestions and fresh
resume drafts still require Antigravity model requests and can take several
minutes; automatic exports remove the separate download step, not model latency.

## Project suggestions and approval

Click **Suggest projects** on the current listing. Antigravity proposes up to three
role-specific projects with a rationale, proposed scope, build plan, estimated
effort/prerequisites, and measurable targets. These are proposals, not claims that
you have built something, and they do not guarantee better hiring outcomes.

**Approve & add as planned** adds the proposal to a clearly labeled **Planned
Projects** section using your template's styles. If this listing already has a
new-format draft open, the helper recompiles immediately and saves a new version.
Otherwise, the selection is saved for the next generation. No model call is needed
for insertion or removal. Approve at most three projects; completed experience
is generally stronger evidence than multiple plans. **Remove planned project**
recompiles without the entry. Previously submitted versions remain unchanged.

The base LaTeX editor contains your existing experience. Planned entries are
inserted separately at compilation, so removal is deterministic and cannot delete
an existing experience bullet. The final PDF and downloaded LaTeX contain the
approved entries. Suggestions and approvals belong to the exact listing text;
changing roles or editing the description requires new suggestions. Refreshing
suggestions retains approved choices. Proposals are not added to your skills or
cover letter as accomplished work. Once you build a project, add its verified
results to your saved profile and remove its planned entry before regenerating.

To update from version 0.1, reload the extension in `brave://extensions`, close
old workspace tabs, and capture the listing again. Existing plain-text drafts
remain in history; regenerate them to get your original template. The native
helper uses the same installation path, so reinstalling is unnecessary unless
you moved the repository or changed the extension ID.

## Storage and privacy

The extension reads pages on your capture action or during a collection you start,
using `activeTab` for the current page or optional site access for selected tabs. Granted site access remains
until you revoke it in browser extension settings. There are no content scripts
running on websites in the background. Internal browser pages and inaccessible frames require manual
pasting. It does not collect cookies or form values or submit applications.

Profile, jobs, project proposals, Sheet updates, and document versions (including compiled PDFs) live in `chrome.storage.local`, separate from
the old project's CSV tracker. They are not encrypted or synced. **Export backup**
creates a private JSON file including all saved application documents and profile
information and tracker history. **Restore a backup** merges applications by URL
and tracker records by their source identity after confirmation; matching records
are replaced and restored Sheet sync stays disconnected. Uninstalling the extension removes local data.
Restore is blocked while jobs are queued or running. Restoring documents does not
replay old generation requests from the backup.
The extension requests unlimited local storage for batch PDF histories; backups are still recommended.

Native messaging connects directly to a local Python process, not an HTTP port.
Only the registered extension origin may connect. The helper accepts health checks,
fixed resume-source imports, and bounded generation requests, never executable
commands or file paths from a page. Generation uses private temporary files removed
on normal completion. Antigravity may retain its own account/session history under
its existing settings. Cover letters and project suggestions are rendered as text, never HTML. Resume LaTeX is checked against the original template before compilation; shell escape and unrestricted file access are disabled.
The prompt prohibits invented facts, but you still need to check each document.

## Troubleshooting

- **Local helper unavailable:** verify the ID in `brave://extensions`, rerun the
  installer for that ID, then reload the extension. For custom browser packaging,
  verify its native messaging host directory.
- **Antigravity not found:** install/sign into `agy`. The helper checks PATH and
  `~/.local/bin/agy`. A helper health check proves discovery, not account sign-in.
- **Generation fails/times out:** check `agy` from a terminal and retry. Previously
  saved drafts stay intact. Closing the workspace does not interrupt queued generation. Closing the browser may interrupt active work; retry interrupted jobs from the queue.
- **Wrong or short description:** open the individual listing, expand it, or select
  only its description before clicking the extension. You can always paste manually.
- **Missing requirements:** checks only inspect captured text. They do not browse
  employer policies or infer unstated eligibility criteria.

## Development and verification

No build step or JavaScript dependencies are needed. Reload at `brave://extensions`
after edits. Python uses only the standard library.

```bash
python3 -m unittest discover -s tests -q
npm --prefix extension test
# Optional browser smoke check; requires Playwright and its Chromium browser:
# Run from the repository root:
venv/bin/python tests/browser_extension_smoke.py
venv/bin/python extension/tests/handshake_browser.py
venv/bin/python extension/tests/tracker_browser.py
```

The smoke check uses a temporary browser profile and simulated model responses; it compiles the actual local templates with `pdflatex`. It covers persistence, fit snippets, duplicate
jobs, editable documents, print preview, version history, and helper errors. It also checks parallel batch preparation and completion after the workspace closes. It does
not use your Antigravity quota or establish live model quality or throughput. Native protocol,
installer, input validation, template preservation, project escaping/approval, and generation command wiring have separate unit tests.

The tracker browser test uses fixture CSV responses in an isolated profile. It
covers mapping, sync/history, authentication failures, disconnect, CSV fallback,
job matching, source links, both tracker views, theme persistence across pages,
reduced motion, keyboard dialog dismissal, and layouts from 320 to 1440 pixels.
It does not access a live Google account. Its anonymized formatted-tracker fixture
also covers row-8 headers, summary exclusion, date/term mapping, and subsequent
sync. Sheets parsing, schema validation,
deduplication, conservative matching, and backup validation have unit coverage.

References: [Brave extension support](https://support.brave.com/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave),
[activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab),
[native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
[extension network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests),
[extension SameSite behavior](https://www.chromium.org/updates/same-site/faq/),
[Google file downloads](https://support.google.com/docs/answer/49114),
[Antigravity headless mode](https://antigravity.google/docs/cli/headless/).
