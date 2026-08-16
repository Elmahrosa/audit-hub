#!/usr/bin/env bash
#
# codex_audit.sh — single source of truth for repo readiness checks (Elmahrosa org).
#
# Usage:
#   ./codex_audit.sh                        # auto target: GITHUB_REPOSITORY, else git origin
#   ./codex_audit.sh owner/repo             # explicit target
#   TARGET_REPO=owner/repo ./codex_audit.sh # via env
#
# Runs inside a checked-out repo and writes:
#   audit-data/latest.jsonl                (current snapshot, one JSON record)
#   audit-data/archive/YYYY-MM-DD.jsonl    (same record, dated for history)
#   docs/data/latest.jsonl                 (copy for GitHub Pages dashboard)
#
# Output record schema is aligned with the audit-hub aggregator so per-repo
# records merge cleanly into the org-wide docs/data/org-latest.jsonl.
#
# Requires: bash, git, curl, jq (jq is preinstalled on ubuntu-latest runners).
set -euo pipefail

NOW=$(date +%s)
TODAY=$(date +%F)

# ---- resolve target repo ------------------------------------------------
if [ "$#" -ge 1 ] && [ -n "$1" ]; then
  TARGET_REPO="$1"
elif [ -z "${TARGET_REPO:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ]; then
  TARGET_REPO="$GITHUB_REPOSITORY"
fi
if [ -z "${TARGET_REPO:-}" ]; then
  ORIGIN=$(git remote get-url origin 2>/dev/null || true)
  TARGET_REPO=$(printf '%s' "$ORIGIN" | sed -E 's#^(https?://[^/]+/|git@[^:]+:)##; s/\.git$//')
fi
if [ -z "${TARGET_REPO:-}" ]; then
  echo "codex_audit: cannot determine target repo (pass owner/repo, or set TARGET_REPO / GITHUB_REPOSITORY)" >&2
  exit 1
fi
REPO_NAME="${TARGET_REPO##*/}"

command -v jq >/dev/null 2>&1 || { echo "codex_audit: jq is required" >&2; exit 2; }

# ---- local file checks --------------------------------------------------
has_readme()      { [ -n "$(ls README* 2>/dev/null | head -1)" ]; }
has_license()     { [ -n "$(ls LICENSE* COPYING* UNLICENSE 2>/dev/null | head -1)" ]; }
has_ci()          { [ -n "$(ls .github/workflows/*.yml .github/workflows/*.yaml 2>/dev/null | head -1)" ]; }
has_gitignore()   { [ -f .gitignore ]; }
has_lockfile()    {
  for f in package-lock.json yarn.lock pnpm-lock.yaml go.sum Cargo.lock \
           pom.xml gradle.lockfile composer.lock Gemfile.lock \
           requirements.txt requirements-dev.txt; do
    [ -e "$f" ] && return 0
  done
  return 1
}
has_security()    { [ -f SECURITY.md ] || [ -f SECURITY.txt ]; }
has_contributing(){ [ -f CONTRIBUTING.md ]; }

# ---- git-derived metrics ------------------------------------------------
COMMITS_90D=0
PUSHED_DAYS_AGO=999
TRAJ_CSV=""
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  COMMITS_90D=$(git rev-list --count --since="90 days ago" HEAD 2>/dev/null || echo 0)
  LAST_TS=$(git log -1 --pretty=format:%ct 2>/dev/null || true)
  if [ -n "$LAST_TS" ]; then
    PUSHED_DAYS_AGO=$(( (NOW - LAST_TS) / 86400 ))
    [ "$PUSHED_DAYS_AGO" -lt 0 ] && PUSHED_DAYS_AGO=0
  fi
  TRAJ_CSV=$(git log --since="90 days ago" --pretty=format:%ct 2>/dev/null |
    awk -v now="$NOW" '
      BEGIN { for (i = 0; i < 12; i++) b[i] = 0 }
      { idx = int((now - $1) / 604800); if (idx < 0) idx = 0; if (idx > 11) idx = 11; b[idx]++ }
      END { out = ""; for (i = 11; i >= 0; i--) { if (out != "") out = out ","; out = out (b[i] + 0) } print out }' || true)
fi

# ---- API metadata ---------------------------------------------------------
API="https://api.github.com"
AUTH=""
[ -n "${GITHUB_TOKEN:-}" ] && AUTH="Authorization: Bearer $GITHUB_TOKEN"
META=$(curl -fsSL -H "Accept: application/vnd.github+json" ${AUTH:+-H "$AUTH"} "$API/repos/$TARGET_REPO" 2>/dev/null || true)

DESCRIPTION=""; LANGUAGE=""; LICENSE=""; STARS=0; FORKS=0; ISSUES=0
PRIVATE=false; ARCHIVED=false; TOPICS="[]"; PUSHED_AT=""; DEFAULT_BRANCH=""
if [ -n "$META" ]; then
  DESCRIPTION=$(printf '%s' "$META" | jq -r '.description // ""')
  LANGUAGE=$(printf '%s' "$META" | jq -r '.language // ""')
  LICENSE=$(printf '%s' "$META" | jq -r '(.license.spdx_id // "")' | grep -v '^NOASSERTION$' || true)
  STARS=$(printf '%s' "$META" | jq -r '.stargazers_count // 0')
  FORKS=$(printf '%s' "$META" | jq -r '.forks_count // 0')
  ISSUES=$(printf '%s' "$META" | jq -r '.open_issues_count // 0')
  PRIVATE=$(printf '%s' "$META" | jq -r '.private // false')
  ARCHIVED=$(printf '%s' "$META" | jq -r '.archived // false')
  TOPICS=$(printf '%s' "$META" | jq -c '.topics // []')
  PUSHED_AT=$(printf '%s' "$META" | jq -r '.pushed_at // ""')
  DEFAULT_BRANCH=$(printf '%s' "$META" | jq -r '.default_branch // ""')
fi
if [ "$PUSHED_DAYS_AGO" -gt 90 ] && [ -n "$PUSHED_AT" ]; then
  PUSHED_DAYS_AGO=$(printf '%s' "$PUSHED_AT" | jq -r '(. as $d | (now - ($d | fromdateiso8601)) / 86400 | floor)' 2>/dev/null || echo "$PUSHED_DAYS_AGO")
fi

# ---- readiness checks + score (mirrors audit-hub aggregator points) --------
C_has_description=0; [ -n "$DESCRIPTION" ] && C_has_description=10
C_has_readme=0;      has_readme && C_has_readme=10
C_has_license=0;     has_license && C_has_license=10
C_has_ci=0;          has_ci && C_has_ci=15
C_not_archived=0;    [ "$ARCHIVED" != "true" ] && C_not_archived=10
C_recent_push=0;     [ "$PUSHED_DAYS_AGO" -le 90 ] && C_recent_push=15
C_clean_issues=0;    [ "$ISSUES" -le 5 ] && C_clean_issues=10
C_active_commits=0;  [ "$COMMITS_90D" -ge 10 ] && C_active_commits=10
C_rich_metadata=0;   [ "$(printf '%s' "$TOPICS" | jq 'length' 2>/dev/null || echo 0)" -ge 3 ] && C_rich_metadata=5
C_has_stars=0;       [ "$STARS" -ge 1 ] && C_has_stars=5

SCORE=$(( C_has_description + C_has_readme + C_has_license + C_has_ci + C_not_archived \
        + C_recent_push + C_clean_issues + C_active_commits + C_rich_metadata + C_has_stars ))

if   [ "$SCORE" -ge 85 ]; then TIER=1
elif [ "$SCORE" -ge 70 ]; then TIER=2
elif [ "$SCORE" -ge 50 ]; then TIER=3
else TIER=4; fi

# ---- build JSON record ----------------------------------------------------
TRAJ_JSON='[0,0,0,0,0,0,0,0,0,0,0,0]'
if [ -n "$TRAJ_CSV" ]; then
  TRAJ_JSON=$(printf '%s' "$TRAJ_CSV" | jq -Rc 'split(",") | map(tonumber)' 2>/dev/null || echo "$TRAJ_JSON")
fi

B() { [ "$1" -eq "$2" ] && echo true || echo false; }

CHECKS_JSON=$(jq -nc \
  --argjson has_description "$(B "$C_has_description" 10)" \
  --argjson has_readme "$(B "$C_has_readme" 10)" \
  --argjson has_license "$(B "$C_has_license" 10)" \
  --argjson has_ci "$(B "$C_has_ci" 15)" \
  --argjson not_archived "$(B "$C_not_archived" 10)" \
  --argjson recent_push "$(B "$C_recent_push" 15)" \
  --argjson clean_issues "$(B "$C_clean_issues" 10)" \
  --argjson active_commits "$(B "$C_active_commits" 10)" \
  --argjson rich_metadata "$(B "$C_rich_metadata" 5)" \
  --argjson has_stars "$(B "$C_has_stars" 5)" \
  '{has_description:$has_description, has_readme:$has_readme, has_license:$has_license,
    has_ci:$has_ci, not_archived:$not_archived, recent_push:$recent_push,
    clean_issues:$clean_issues, active_commits:$active_commits,
    rich_metadata:$rich_metadata, has_stars:$has_stars}')

RECORD=$(jq -nc \
  --arg repo "$REPO_NAME" \
  --arg full_name "$TARGET_REPO" \
  --arg url "https://github.com/$TARGET_REPO" \
  --argjson private "$PRIVATE" \
  --arg description "$DESCRIPTION" \
  --arg language "$LANGUAGE" \
  --arg license "$LICENSE" \
  --argjson topics "$(printf '%s' "$TOPICS" | jq -c 'if type=="array" then . else [] end' 2>/dev/null || echo '[]')" \
  --argjson archived "$ARCHIVED" \
  --arg default_branch "$DEFAULT_BRANCH" \
  --arg pushed_at "$PUSHED_AT" \
  --argjson pushed_days_ago "$PUSHED_DAYS_AGO" \
  --argjson open_issues "$ISSUES" \
  --argjson stars "$STARS" \
  --argjson forks "$FORKS" \
  --argjson commits_90d "$COMMITS_90D" \
  --argjson health_score "$SCORE" \
  --argjson tier "$TIER" \
  --argjson trajectory "$TRAJ_JSON" \
  --argjson checks "$CHECKS_JSON" \
  '{repo:$repo, full_name:$full_name, url:$url, private:$private, description:$description,
    language:$language, license:$license, topics:$topics, archived:$archived,
    default_branch:$default_branch, pushed_at:$pushed_at, pushed_days_ago:$pushed_days_ago,
    open_issues:$open_issues, stars:$stars, forks:$forks, commits_90d:$commits_90d,
    health_score:$health_score, tier:$tier, source:"codex_audit",
    checks:$checks, trajectory:$trajectory}')

# ---- write outputs ---------------------------------------------------------
mkdir -p audit-data/archive docs/data
printf '%s\n' "$RECORD" > audit-data/latest.jsonl
printf '%s\n' "$RECORD" > "audit-data/archive/$TODAY.jsonl"
printf '%s\n' "$RECORD" > docs/data/latest.jsonl

echo "codex_audit: $TARGET_REPO tier=$TIER score=$SCORE commits90d=$COMMITS_90D"
echo "codex_audit: wrote audit-data/latest.jsonl, audit-data/archive/$TODAY.jsonl, docs/data/latest.jsonl"
