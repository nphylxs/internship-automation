# Internship Desk

A standalone desktop extension for capturing internships, preparing reviewed documents, and tracking applications. No build step, web server, JavaScript packages, or runtime Python packages are required.

## Files

```text
extension/     Browser UI, capture, background queue, and local storage
native_host/   Python native-messaging bridge, model runner, PDF renderer, exports
templates/     Three trusted LaTeX resume templates
tests/         Regression tests and an isolated browser workflow check
package.json   Development test commands only
```

The extension runs independently of the old project. Scrapers, legacy trackers, generated documents, virtual environments, unrelated assets, and old workspace pages are omitted. The old directory is left intact for migration.

## Install or migrate

Requires Python 3.10+, an installed and signed-in Antigravity CLI (`agy`), and `pdflatex` with the packages used in `templates/`. On Debian/Ubuntu the TeX packages are available through `texlive-latex-extra` and `texlive-fonts-recommended`. Helper registration supports Linux and macOS, with Brave, Chrome, or Chromium.

1. If switching from the old extension, **export its full backup first** and finish queued work. Extension storage belongs to its extension ID; loading this new path does not automatically transfer data.
2. Open `brave://extensions` (or `chrome://extensions`), enable Developer mode, choose **Load unpacked**, and select this project's **`extension/`** directory.
3. Copy the new extension ID and run from this project's root:

   ```bash
   python3 native_host/install.py YOUR_EXTENSION_ID --browser brave
   ```

   Use `--browser chrome` or `--browser chromium` as appropriate. This updates the browser's `com.internship.desk` helper registration to this project and the new extension ID. Reinstall after moving this folder. Disable the old extension after exporting its backup.

4. Open **Profile & settings → Check local helper**. The check confirms discovery; actual generation also requires an active CLI account.
5. Restore your old backup under **Backup & migration**, then reload the workspace. Applications, profiles, document versions, PDFs, and Sheet history are preserved. Matching applications are replaced; other applications remain. Old generation requests are not replayed. Reconnect Sheets explicitly and select your approved-packet destination folder.
6. Import and review the **Experience library**, reconcile any overlapping projects or dates, and save. Every source record needs confirmation. Existing documents retain their original profile snapshots. Legacy free-text profiles also remain supported.

The template contact header remains in `templates/*.tex`. Update it there if necessary. Experience headings, dates, and bullets come from the reviewed library for new documents; the templates require at least one education, experience, and project record.

## Workflow

1. **Capture:** save a listing using the popup or `Alt+Shift+S`. Selected-tab and Handshake batch collection save to the inbox. Expand the full description before capture.
2. **Shortlist:** choose promising roles and select **Shortlist & prepare**. A simple keyword match suggests FPGA, robotics/embedded, or power focus; you can change it. Resume-only generation is the default. Request a letter alongside the resume or generate one later.
3. **Review:** edit bullets alongside the saved source facts. Edits autosave and trigger a local PDF preview. Advanced LaTeX editing is available. A working draft stays separate from approved versions.
4. **Apply:** approve the documents, download the resume or save the approved PDF packet, and open the employer application. After submitting there, click **I submitted this application** to record the exact approved version. New edits require approval again; earlier versions remain in history.
5. **Follow up:** use the same application's timeline for notes, next steps, reminders, and imported Sheet/CSV updates. External observations retain their source and do not silently change the manually recorded submission. **Today** collects documents to review, applications ready to send, new updates, due follow-ups, and approaching deadlines.

Packets contain `Resume.pdf` and an optional `Cover_Letter.pdf`, under company/application/approved-version folders. Re-exporting a version reuses that packet; approving changed documents creates a separate version. Ordinary edits do not create files in Downloads.

## Architecture and speed

- The browser owns application records and version history. Application identity, lifecycle decisions, capture, queue, review, profile, and Sheet syncing live in separate modules. There is no second tracker database to reconcile.
- The background worker owns queued generation, using immutable job/profile/settings snapshots. One worker is the default; two are available in Background preparation. Closing the workspace leaves queued generation running while the browser is open.
- Generation requests contain compact plain facts and a schema for selected entries and skills. The model produces content; trusted local templates provide LaTeX formatting and fixed headers. Shared library facts are sent once in the outline.
- Fast, Balanced, and Careful modes explicitly select the CLI model and effort. Capture, matching, template recommendations, edits, and PDF rendering do not use model calls. Letters are optional.
- Successful model output is saved before PDF compilation. Failed rendering can retry without another generation request. Identical queued or completed inputs are deduplicated. Restarted unfinished requests require an explicit retry to avoid duplicate model usage.
- PDF bytes live under separate content-addressed storage keys, keeping frequently updated application metadata small. Backups include the PDF bytes and working drafts.
- Native messaging launches a local Python process. The helper runs the existing CLI and `pdflatex` with bounded operations and validated inputs. There is no localhost HTTP service or new hosted backend.

Model time still depends on the CLI provider and account. Per-stage timing and progress are displayed. Keep the workspace open for on-demand letter generation and editing/preview operations; background resume preparation uses the durable queue. A browser shutdown can interrupt active work.

## Development checks

Run from this directory:

```bash
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
```

The browser workflow check requires Playwright and Chromium as development-only dependencies:

```bash
python3 -m venv .venv
.venv/bin/pip install playwright
.venv/bin/playwright install chromium
.venv/bin/python tests/browser_workflow.py
```

It uses a temporary browser profile and mocked model responses with real PDF compilation. It exercises capture-before-generation, reviewed sources, autosave/reload, optional letters, immutable approval, packet exports, submission version tracking, Sheet matching, reminders, backup/restore, and responsive layout. It does not submit applications or access a live Google account. Unit tests additionally cover native framing, bounded processes, queue recovery, escaping, and template preservation.

Profile, documents, and application history are stored locally in the browser. Model requests send the selected job and profile to the configured CLI provider. Back up before removing the extension; local data is not automatically synced. Capture failures can be corrected by editing the saved listing. Helper errors usually require registering the current extension ID, checking `agy` sign-in, or installing the missing TeX packages.
