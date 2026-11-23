#!/usr/bin/env bash
# Generates the 9 required submission reports (3 PRs x JSON/MD/HTML).
# Usage (from project/starter):  bash scripts/review-all-prs.sh
set -uo pipefail
cd "$(dirname "$0")/.."

OWNER="udacity"
REPO="cd14715-simple-todo-app"
failed=()

for pr in 1 2 3; do
  echo ""
  echo "=================  Reviewing ${OWNER}/${REPO}#${pr}  ================="
  if ! npm run dev -- "$OWNER" "$REPO" "$pr"; then
    failed+=("$pr")
  fi
done

echo ""
echo "Reports in reports/:"
ls -la reports/ 2>/dev/null | grep "${REPO}" || echo "  (none found)"

if [ ${#failed[@]} -gt 0 ]; then
  echo ""
  echo "These PRs failed and need a re-run: ${failed[*]}"
  echo "  npm run dev -- ${OWNER} ${REPO} <pr-number>"
  exit 1
fi

echo ""
echo "All 3 PRs reviewed. Verify with:  CHECK_DELIVERABLES=1 npm test"
