# Third-party code

This fork bundles code from other MIT-licensed projects.  Their licences are
reproduced in full alongside this file; the original copyright notices are kept
in the vendored sources.

## claude-usage — session indexer

* Upstream: https://github.com/phuryn/claude-usage
* Copyright (c) 2026 Pawel Huryn — MIT (`LICENSE.claude-usage`)
* Vendored as `usage_monitor_for_claude/sessions/scanner.py` (from `scanner.py`)

Parses the Claude Code JSONL transcripts under `~/.claude/projects` into a
SQLite database, incrementally (files are skipped when their mtime is
unchanged).  Used here as the data source for the Sessions and Charts panels.
Local edits are marked `# [fork]`.

## Chart.js — charts

* Upstream: https://github.com/chartjs/Chart.js
* Copyright (c) 2014-2025 Chart.js Contributors — MIT (`LICENSE.chartjs`)
* Vendored as `usage_monitor_for_claude/panel/vendor/chart.umd.min.js`

Bundled rather than loaded from a CDN on purpose: this app's privacy promise is
that it talks to `api.anthropic.com` and nothing else, and the panel must work
offline.
