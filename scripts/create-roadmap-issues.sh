#!/usr/bin/env bash
# Files the v1 out-of-scope items as GitHub issues. Requires `gh auth login` and a GitHub remote.
set -euo pipefail
gh label create roadmap --color 5319e7 --description "Planned after v1" 2>/dev/null || true
gh issue create --label roadmap --title "Whole-repo architecture map" \
  --body "Generate a Agentic Whiteboard board of the existing codebase (modules and their dependencies) that agents can plan against."
gh issue create --label roadmap --title "Code ↔ diagram drift detection" \
  --body "Detect when code no longer matches a completed plan (linked files deleted or moved, nodes without code) and flag it on the board."
gh issue create --label roadmap --title "Multi-agent boards" \
  --body "Let several agents plan on one board: lanes per agent, step ownership, and conflict hints."
gh issue create --label roadmap --title "PR comment images" \
  --body "GitHub Action that renders changed .plan.json files to PNG/SVG and comments them on the pull request."
gh issue create --label roadmap --title "Real-time multi-user collaboration" \
  --body "Live cursors and concurrent editing of a board by several people (Live Share or a CRDT)."
