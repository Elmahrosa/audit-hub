import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const content = readFileSync(join(ROOT, "templates", "per-repo", "audit.yml"), "utf8");
const b64 = Buffer.from(content, "utf8").toString("base64");

const repos = [
  "teos-ai-auditor", "teos-civic-mixer", "teos-international-civic-blockchain-constitution",
  "teos-ai-guard", "teos-compliance-kit", "teosmcp-ci-example", "teos-ai-engine",
  "teos-auth-library", "teos-sovereign-security-stack", "UnityCare-Platform",
  "elmahrosa-org", "EGDFESTIVAL", "elmahrosa-official-website", "EGDMENA",
];

for (const r of repos) {
  const full = `Elmahrosa/${r}`;
  try {
    const br = execSync(`gh api repos/${full} --jq .default_branch`, { encoding: "utf8" }).trim();
    const sha = execSync(`gh api repos/${full}/contents/.github/workflows/audit.yml --jq .sha`, { encoding: "utf8" }).trim();
    const body = JSON.stringify({ message: "chore: harden audit script fetch with retries", content: b64, sha, branch: br });
    execSync(`gh api -X PUT repos/${full}/contents/.github/workflows/audit.yml --input -`, { input: body });
    console.log(`updated ${full} (branch ${br})`);
  } catch (err) {
    console.log(`FAIL ${full}: ${(err.stderr || err.message || "").toString().slice(0, 200)}`);
  }
}
