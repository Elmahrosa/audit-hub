# Audit Hub

Org-wide readiness cockpit for the **Elmahrosa** org.

- **Aggregation** — `.github/workflows/audit.yml` (manual / daily) runs `scripts/aggregate.mjs`,
  which pulls each repo's `audit-data/latest.jsonl` self-audit file where it exists and derives
  records from GitHub API metadata otherwise, then writes:
  - `docs/data/org-latest.jsonl` — one JSON object per repo (score, tier, checks, 12-week trajectory)
  - `docs/data/meta.json` — generation time, tier counts, per-tier trajectories
- **Dashboard** — static site at `docs/`, served by GitHub Pages from the `main` branch `/docs` folder:
  tier cards, Chart.js trajectory chart, sortable/filterable repo table, light/dark mode.
- **Auth** — `AUDIT_HUB_PAT` (repo + read:org scopes) stored as an Actions secret.

## Tiers

| Tier | Label       | Score |
|------|-------------|-------|
| 1    | Ready       | ≥ 85  |
| 2    | Stable      | 70–84 |
| 3    | Needs Work  | 50–69 |
| 4    | Critical    | < 50  |

## Local run

```bash
export AUDIT_HUB_PAT=<token with repo + read:org>
node scripts/aggregate.mjs
```

## Manual refresh

1. Repo → Actions → **audit-aggregate** → **Run workflow** → **Run workflow**
2. Wait for the run to finish (data is committed back to `main`)
3. Visit `https://elmahrosa.github.io/audit-hub/`
