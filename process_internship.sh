#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -x "$PROJECT_DIR/.venv/bin/python" ]]; then
  PYTHON_BIN="$PROJECT_DIR/.venv/bin/python"
else
  PYTHON_BIN="${PYTHON_BIN:-python3}"
fi
cd -- "$PROJECT_DIR"

usage() {
  cat <<'USAGE'
Usage:
  ./process_internship.sh scrape [scraper.py options]
  ./process_internship.sh generate [generate.py options]
  ./process_internship.sh all [scraper.py options] -- [generate.py options]

Examples:
  ./process_internship.sh scrape --import-file imports/example_jobs.json --no-enrich --dry-run
  ./process_internship.sh generate --dry-run
  ./process_internship.sh all --max-jobs 200 -- --limit 5

With no arguments, show this help. Options after -- in all mode go only to
generation. To preview without generating documents, use generate --dry-run.
USAGE
}

mode="${1:---help}"
if [[ $# -gt 0 ]]; then shift; fi
case "$mode" in
  scrape) exec "$PYTHON_BIN" "$PROJECT_DIR/scraper.py" "$@" ;;
  generate) exec "$PYTHON_BIN" "$PROJECT_DIR/generate.py" "$@" ;;
  all)
    scrape_args=()
    generate_args=()
    split=false
    for arg in "$@"; do
      if [[ "$arg" == "--" && "$split" == false ]]; then
        split=true
      elif [[ "$split" == true ]]; then
        generate_args+=("$arg")
      else
        scrape_args+=("$arg")
      fi
    done
    "$PYTHON_BIN" "$PROJECT_DIR/scraper.py" "${scrape_args[@]}"
    exec "$PYTHON_BIN" "$PROJECT_DIR/generate.py" "${generate_args[@]}"
    ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
