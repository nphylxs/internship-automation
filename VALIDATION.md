# Validation — September 28, 2026

- 60 offline unit/integration checks passed, covering source pagination, import
  parsing, authorization evidence and contradictions, routing, deduplication,
  state preservation, retired/relisted jobs, and generation failure handling.
- Live collector smoke test: Astera Labs returned 5 jobs and Mill returned 29;
  no collection errors. Under the confirmed filters, 0 were eligible, 12 needed
  review, and 22 were excluded. Results were kept in a temporary test directory,
  not the delivered tracker.
- The local demonstration import classified as 1 eligible job in dry-run mode.
- All three unchanged baseline resumes compiled with pdfLaTeX using shell escape
  disabled. This does not assess factual accuracy or guarantee future draft layout.
- The installed Antigravity CLI and current headless documentation were checked.
  No live model generation or authenticated Handshake/LinkedIn access was performed.

Generation integration is tested using controlled responses; the first real
Antigravity run still needs validation with the user's account and chosen job.
