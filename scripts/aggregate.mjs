#!/usr/bin/env node
// audit-hub aggregator
// 1. For every Elmahrosa repo, fetches its self-audit file audit-data/latest.jsonl (if present).
// 2. Repos without that file get a record derived from GitHub API metadata.
// 3. Merges all into docs/data/org-latest.jsonl (one JSON object per repo) + docs/data/meta.json.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "docs", "data");

const ORG = process.env.AUDIT_HUB_ORG || "Elmahrosa";
const TOKEN = process.env.AUDIT_HUB_PAT || process.env.GH_TOKEN || "";
const API = "https://api.github.com";
const SELF_REPO = "audit-hub";
const WEEKS = 12;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const NOW = Date.now();
const SINCE = new Date(NOW - WEEKS * WEEK_MS).toISOString();
const CONCURRENCY = 8;

const HDRS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "audit-hub-aggregator",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(path, { method = "GET", headers = {} } = {}) {
  const url = /^https?:/.test(path) ? path : API + path;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { method, headers: { ...HDRS, ...headers } });
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      const wait = Math.max(5000, reset - Date.now() + 1000);
      console.warn(`rate limited, sleeping ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    if (res.status === 401) throw new Error("authentication failed (check AUDIT_HUB_PAT)");
    return res;
  }
  throw new Error("rate limited after retries");
}

async function listRepos() {
  const out = [];
  for (let page = 1; ; page++) {
    const res = await gh(`/orgs/${ORG}/repos?per_page=100&page=${page}&type=all`);
    if (!res.ok) throw new Error(`list org repos failed: HTTP ${res.status}`);
    const arr = await res.json();
    out.push(...arr);
    if (arr.length < 100) break;
  }
  return out;
}

async function fetchAuditFile(repo) {
  const res = await gh(`/repos/${repo}/contents/audit-data/latest.jsonl`, {
    headers: { Accept: "application/vnd.github.raw+json" },
  });
  if (res.status !== 200) return null;
  const text = await res.text();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

async function getCommits(repo) {
  const dates = [];
  for (let page = 1; page <= 5; page++) {
    const res = await gh(`/repos/${repo}/commits?per_page=100&page=${page}&since=${encodeURIComponent(SINCE)}`);
    if (res.status === 409 || res.status === 422 || res.status === 404) return [];
    if (!res.ok) return [];
    const arr = await res.json();
    for (const c of arr) {
      const d = c?.commit?.author?.date;
      if (d) dates.push(d);
    }
    if (arr.length < 100) break;
  }
  return dates;
}

async function hasReadme(repo) {
  const res = await gh(`/repos/${repo}/readme`);
  return res.status === 200;
}

async function hasWorkflows(repo) {
  const res = await gh(`/repos/${repo}/contents/.github/workflows`);
  if (res.status !== 200) return false;
  try {
    const arr = await res.json();
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
}

function daysAgo(iso) {
  const t = new Date(iso).getTime();
  if (!t) return Infinity;
  return Math.max(0, Math.floor((NOW - t) / 86400000));
}

function scoreChecks(checks) {
  const points = {
    has_description: 10,
    has_readme: 10,
    has_license: 10,
    has_ci: 15,
    not_archived: 10,
    recent_push: 15,
    clean_issues: 10,
    active_commits: 10,
    rich_metadata: 5,
    has_stars: 5,
  };
  let score = 0;
  const passed = {};
  for (const [k, ok] of Object.entries(checks)) {
    passed[k] = !!ok;
    if (ok) score += points[k];
  }
  return { score, passed };
}

function tierOf(score) {
  if (score >= 85) return 1;
  if (score >= 70) return 2;
  if (score >= 50) return 3;
  return 4;
}

const TIER_LABELS = { 1: "Ready", 2: "Stable", 3: "Needs Work", 4: "Critical" };

async function deriveRecord(r) {
  const repo = r.full_name;
  const commits = await getCommits(repo);

  const buckets = new Array(WEEKS).fill(0);
  for (const d of commits) {
    const idx = Math.min(WEEKS - 1, Math.max(0, Math.floor((NOW - new Date(d).getTime()) / WEEK_MS)));
    buckets[idx]++;
  }
  const trajectory = buckets.slice().reverse();
  const commits90d = buckets.reduce((a, b) => a + b, 0);

  const [readme, ci] = await Promise.all([hasReadme(repo), hasWorkflows(repo)]);

  const desc = (r.description || "").trim();
  const license = r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : "";
  const topics = r.topics || [];
  const pushedDays = daysAgo(r.pushed_at);
  const openIssues = r.open_issues_count || 0;
  const stars = r.stargazers_count || 0;

  const checks = {
    has_description: desc.length > 0,
    has_readme: readme,
    has_license: license.length > 0,
    has_ci: ci,
    not_archived: !r.archived,
    recent_push: pushedDays <= 90,
    clean_issues: openIssues <= 5,
    active_commits: commits90d >= 10,
    rich_metadata: topics.length >= 3,
    has_stars: stars >= 1,
  };
  const { score, passed } = scoreChecks(checks);

  return {
    repo: r.name,
    full_name: repo,
    url: r.html_url,
    private: r.private,
    description: desc,
    language: r.language || "",
    license,
    topics,
    archived: r.archived,
    default_branch: r.default_branch || "",
    pushed_at: r.pushed_at || "",
    pushed_days_ago: pushedDays,
    open_issues: openIssues,
    stars,
    forks: r.forks_count || 0,
    commits_90d: commits90d,
    health_score: score,
    tier: tierOf(score),
    checks: passed,
    trajectory,
    source: "derived",
  };
}

async function auditRepo(r) {
  const base = await deriveRecord(r);
  const fileRecords = await fetchAuditFile(r.full_name);
  if (!fileRecords || fileRecords.length === 0) {
    return base;
  }
  const rec = fileRecords[fileRecords.length - 1];
  const merged = { ...base, source: "repo-file" };
  for (const k of [
    "health_score", "tier", "commits_90d", "open_issues", "stars", "forks",
    "pushed_at", "pushed_days_ago", "trajectory", "checks", "description",
    "language", "license", "topics", "default_branch",
  ]) {
    if (rec[k] !== undefined && rec[k] !== null) merged[k] = rec[k];
  }
  if (rec.score !== undefined && rec.score !== null && merged.health_score === undefined) {
    merged.health_score = rec.score;
  }
  if (merged.health_score === undefined || merged.health_score === null) {
    merged.health_score = 0;
  }
  if (!merged.tier) merged.tier = tierOf(merged.health_score);
  if (!merged.checks) merged.checks = base.checks;
  if (!merged.trajectory) merged.trajectory = base.trajectory;
  return merged;
}

async function pool(items, worker) {
  const results = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
  return results;
}

async function main() {
  if (!TOKEN) throw new Error("AUDIT_HUB_PAT env var is required");

  console.log(`Listing org repos for ${ORG}...`);
  const repos = await listRepos();
  const targets = repos.filter((r) => r.name !== SELF_REPO);
  console.log(`${repos.length} repos found, auditing ${targets.length} (excluding ${SELF_REPO})`);

  const records = [];
  const failed = [];
  const sources = { repo_files: 0, derived: 0 };

  await pool(targets, async (r) => {
    try {
      const rec = await auditRepo(r);
      records.push(rec);
      sources[rec.source] = (sources[rec.source] || 0) + 1;
      console.log(
        `[ok] ${rec.full_name} tier=${rec.tier} score=${rec.health_score} commits90d=${rec.commits_90d} src=${rec.source}`
      );
    } catch (err) {
      failed.push({ repo: r.full_name, reason: String(err.message || err) });
      console.error(`[fail] ${r.full_name}: ${err.message || err}`);
    }
  });

  records.sort((a, b) => b.health_score - a.health_score);

  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const rec of records) counts[rec.tier]++;

  const trajByTier = {};
  for (const t of [1, 2, 3, 4]) {
    const rows = records.filter((r) => r.tier === t);
    trajByTier[String(t)] = new Array(WEEKS).fill(0);
    if (rows.length) {
      for (let w = 0; w < WEEKS; w++) {
        trajByTier[String(t)][w] = Math.round(
          rows.reduce((a, r) => a + (r.trajectory[w] || 0), 0) / rows.length
        );
      }
    }
  }

  const meta = {
    org: ORG,
    generated_at: new Date().toISOString(),
    generated_epoch: Math.floor(Date.now() / 1000),
    weeks: WEEKS,
    repos_total: repos.length,
    repos_audited: records.length,
    successful: records.length,
    failed: failed.length,
    failed_repos: failed,
    counts_by_tier: counts,
    labels: TIER_LABELS,
    trajectory_by_tier: trajByTier,
    sources,
  };

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, "org-latest.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(DATA_DIR, "meta.json"), JSON.stringify(meta, null, 2));

  console.log(`Aggregation complete: Successful repos: ${records.length}, Failed/skipped: ${failed.length}`);
  console.log(
    `Tiers: ` +
      Object.entries(counts)
        .map(([t, n]) => `Tier ${t} (${TIER_LABELS[t]}): ${n}`)
        .join(" | ")
  );
  console.log(`Sources: ${sources.repo_files} repo-file, ${sources.derived} derived`);
  console.log(`Wrote ${join(DATA_DIR, "org-latest.jsonl")} (${records.length} records) and meta.json`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message || err}`);
  process.exit(1);
});
