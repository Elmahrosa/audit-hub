#!/usr/bin/env node
// Rolls out the per-repo self-audit workflow + dashboard to public org repos.
// Skips repos that already have the files; enables GitHub Pages (main/docs).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = join(ROOT, "templates", "per-repo");
const ORG = process.env.AUDIT_HUB_ORG || "Elmahrosa";
const TOKEN = process.env.GH_TOKEN || "";
const EXCLUDE = new Set([".github", "Elmahrosa.github.io", "audit-hub"]);
const API = "https://api.github.com";

const HDRS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "audit-hub-rollout",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(path, { method = "GET", body, okOnly = false } = {}) {
  const url = /^https?:/.test(path) ? path : API + path;
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      res = await fetch(url, {
        method,
        headers: body ? { ...HDRS, "Content-Type": "application/json" } : HDRS,
        body: body ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (err) {
      if (attempt === 4) throw err;
      await sleep(3000 * (attempt + 1));
    }
  }
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    await sleep(Math.max(5000, reset - Date.now() + 1000));
    return gh(path, { method, body, okOnly });
  }
  if (okOnly && !res.ok) return res;
  return res;
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

async function listPublicRepos() {
  const out = [];
  for (let page = 1; ; page++) {
    const res = await gh(`/orgs/${ORG}/repos?per_page=100&page=${page}&type=public`);
    if (!res.ok) throw new Error(`list public repos failed: HTTP ${res.status}`);
    const arr = await res.json();
    out.push(...arr);
    if (arr.length < 100) break;
  }
  return out.filter((r) => !EXCLUDE.has(r.name));
}

async function fileExists(repo, path) {
  const res = await gh(`/repos/${repo}/contents/${path}`);
  return res.status === 200;
}

async function createFile(repo, path, content) {
  const branch = repo.default_branch;
  if (await fileExists(repo.full_name, path)) return "exists";
  const res = await gh(`/repos/${repo.full_name}/contents/${path}`, {
    method: "PUT",
    body: {
      message: "chore: add audit-hub per-repo self-audit files",
      content: b64(content),
      branch,
    },
  });
  if (res.status === 201) return "created";
  const detail = (await res.text()).slice(0, 160);
  return `error(${res.status}): ${detail}`;
}

async function enablePages(repo) {
  const res = await gh(`/repos/${repo.full_name}/pages`, {
    method: "POST",
    body: { build_type: "legacy", source: { branch: repo.default_branch, path: "/docs" } },
  });
  if (res.status === 201) return "enabled";
  const detail = (await res.text()).slice(0, 160);
  return `skip(${res.status}): ${detail}`;
}

async function main() {
  if (!TOKEN) throw new Error("GH_TOKEN env var is required (use: gh auth token)");

  const files = ["audit.yml", "index.html", "style.css", "script.js"];
  const template = (f) => readFileSync(join(TEMPLATES, f), "utf8");
  const workflowPath = ".github/workflows/audit.yml";
  const dashboardPaths = ["docs/index.html", "docs/style.css", "docs/script.js"];

  const repos = await listPublicRepos();
  console.log(`Public repos to process (${ORG}): ${repos.length}`);
  const summary = { created: 0, exists: 0, errored: [] };

  for (const repo of repos) {
    const line = [];
    line.push(`\n== ${repo.full_name} (branch: ${repo.default_branch}) ==`);
    const wf = await createFile(repo, workflowPath, template("audit.yml"));
    line.push(`  workflow: ${wf}`);
    for (const p of dashboardPaths) {
      const name = p.split("/").pop();
      const result = await createFile(repo, p, template(name));
      line.push(`  ${p}: ${result}`);
    }
    if (wf === "exists") {
      line.push("  pages: skipped (workflow already present)");
    } else {
      const pg = await enablePages(repo);
      line.push(`  pages: ${pg}`);
    }
    console.log(line.join("\n"));
    if (wf.startsWith("created")) summary.created++;
    if (wf.startsWith("exists")) summary.exists++;
    if (wf.startsWith("error")) summary.errored.push(`${repo.full_name} (${wf})`);
    await sleep(300);
  }

  console.log(`\n=== Rollout summary ===`);
  console.log(`workflow created: ${summary.created} | already present: ${summary.exists}`);
  if (summary.errored.length) {
    console.log(`errored:`);
    summary.errored.forEach((e) => console.log(`  - ${e}`));
  }
}

main().catch((err) => {
  console.error(`FATAL: ${err.message || err}`);
  process.exit(1);
});
