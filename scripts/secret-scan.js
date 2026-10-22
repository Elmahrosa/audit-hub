#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_PATTERNS = [
  { id: 'S01', name: 'AWS_ACCESS_KEY', severity: 'critical', pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/g },
  { id: 'S02', name: 'AWS_SECRET_KEY', severity: 'critical', pattern: /aws.{0,20}(?:secret|access).{0,20}['"][A-Za-z0-9/+]{40}['"]/gi },
  { id: 'S03', name: 'GITHUB_TOKEN', severity: 'critical', pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g },
  { id: 'S04', name: 'GITLAB_TOKEN', severity: 'critical', pattern: /glpat-[A-Za-z0-9\-_]{20,}/g },
  { id: 'S05', name: 'SLACK_TOKEN', severity: 'high', pattern: /xox[baprs]-[A-Za-z0-9\-]{10,}/g },
  { id: 'S06', name: 'JWT_TOKEN', severity: 'high', pattern: /eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g },
  { id: 'S07', name: 'PRIVATE_KEY', severity: 'critical', pattern: /-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH|PGP)\s+PRIVATE\s+KEY-----/g },
  { id: 'S08', name: 'CONNECTION_STRING', severity: 'high', pattern: /(?:mongodb|postgresql|mysql|redis):\/\/[^\s'"]{8,}@/gi },
  { id: 'S09', name: 'PASSWORD_IN_CODE', severity: 'high', pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{6,}['"]/gi },
  { id: 'S10', name: 'API_KEY_IN_CODE', severity: 'high', pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/gi },
  { id: 'S11', name: 'SECRET_IN_ENV', severity: 'medium', pattern: /(?:SECRET|TOKEN|PASSWORD|CREDENTIALS)\s*=\s*(?!process\.env|\$\{|\$\(|\{)[^'"\s]{6,}/g },
  { id: 'S12', name: 'NPM_TOKEN', severity: 'critical', pattern: /\/\/registry\.npmjs\.org\/:_authToken=[A-Za-z0-9\-]{36,}/g },
  { id: 'S13', name: 'HEROKU_API_KEY', severity: 'high', pattern: /heroku.{0,10}[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}/gi },
  { id: 'S14', name: 'GOOGLE_SERVICE_JSON', severity: 'high', pattern: /"type":\s*"service_account"/g },
  { id: 'S15', name: 'DOCKER_CONFIG_AUTH', severity: 'high', pattern: /"auth":\s*"[A-Za-z0-9+/=]{20,}"/g },
  { id: 'S16', name: 'STRIPE_API_KEY', severity: 'critical', pattern: /(?:sk_live|pk_live|sk_test|pk_test)_[A-Za-z0-9]{24,}/g },
  { id: 'S17', name: 'TELEGRAM_BOT_TOKEN', severity: 'critical', pattern: /[1-9]\d{8,10}:AA[A-Za-z0-9_\-]{33,35}/g },
  { id: 'S18', name: 'SLACK_WEBHOOK', severity: 'high', pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{40,}/g },
  { id: 'S19', name: 'GENERIC_BEARER', severity: 'medium', pattern: /(?:bearer|token)\s+[A-Za-z0-9_\-.]{20,}/gi },
];

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt',
  'vendor', '__pycache__', '.venv', 'venv', '.cache', '.turbo', 'out',
]);

const DEFAULT_IGNORED_PATHS = [
  'docs/',
  'documentation/',
  'playground/',
  'samples/',
  'examples/',
  'demo/',
  'README.md',
];

const PLACEHOLDER_RE = /(?:example|demo|sample|placeholder|changeme|dummy|fake|redacted|your[_-]?(?:key|token|secret|password)?|insert[_-]?|replace[_-]?me|xxxx+|<[^>]{1,40}>|\$\{[^}]+\}|%\w+%|not[_-]?a[_-]?real)/i;

function loadIgnorePatterns(root) {
  const ignoreFile = path.join(root, '.secret-scan-ignore');
  if (!fs.existsSync(ignoreFile)) return [];
  return fs
    .readFileSync(ignoreFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(escaped, 'i');
}

function isIgnoredPath(relPath, patterns) {
  const normalized = relPath.replace(/\\/g, '/');
  for (const pattern of DEFAULT_IGNORED_PATHS) {
    if (pattern.endsWith('/')) {
      if (normalized.startsWith(pattern) || normalized.includes('/' + pattern)) return true;
    } else if (normalized === pattern || normalized.endsWith('/' + pattern)) {
      return true;
    }
  }
  const base = normalized.split('/').pop();
  for (const pattern of patterns) {
    const re = globToRegExp(pattern);
    if (re.test(normalized) || re.test(base)) return true;
  }
  return false;
}

function mask(value) {
  const digest = crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
  const head = value.slice(0, 4).replace(/\*/g, 'x');
  return `${head}***[redacted:${value.length} chars sha256:${digest}]`;
}

function isBinary(content) {
  return content.includes('\u0000');
}

function collectFiles(root) {
  const files = [];
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return files;
  }
  if (stat.isFile()) return [root];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  };
  walk(root);
  return files;
}

function scanFile(fullPath, root, ignorePatterns) {
  const relPath = path.relative(root, fullPath).replace(/\\/g, '/') || path.basename(fullPath);
  if (isIgnoredPath(relPath, ignorePatterns)) return [];

  let content;
  try {
    const stat = fs.statSync(fullPath);
    if (stat.size > 2 * 1024 * 1024) return [];
    content = fs.readFileSync(fullPath, 'utf8');
  } catch {
    return [];
  }
  if (isBinary(content)) return [];

  const lines = content.split('\n');
  const findings = [];

  for (const rule of SECRET_PATTERNS) {
    const matches = content.match(rule.pattern);
    if (!matches) continue;

    const details = [];
    for (const match of matches) {
      const lineIndex = lines.findIndex((line) => line.includes(match));
      if (lineIndex === -1) continue;
      const lineText = lines[lineIndex];
      if (PLACEHOLDER_RE.test(lineText)) continue;
      details.push({
        line: lineIndex + 1,
        snippet: mask(match),
      });
    }

    if (details.length > 0) {
      findings.push({
        rule: rule.id,
        name: rule.name,
        severity: rule.severity,
        count: details.length,
        matches: details,
      });
    }
  }

  return findings.length > 0 ? [{ file: relPath, secrets: findings }] : [];
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const failOnWarn = args.includes('--fail-on-warn');
  const targetArg = args.find((a) => !a.startsWith('--'));
  const target = path.resolve(targetArg || '.');

  if (!fs.existsSync(target)) {
    console.error(`Error: path "${targetArg}" does not exist`);
    process.exit(1);
  }

  const ignorePatterns = loadIgnorePatterns(target);
  const files = collectFiles(target);

  const allFindings = [];
  const severityOrder = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
  let maxSeverity = 'none';

  for (const file of files) {
    const findings = scanFile(file, target, ignorePatterns);
    if (findings.length === 0) continue;
    allFindings.push(...findings);
    for (const finding of findings) {
      for (const secret of finding.secrets) {
        if (severityOrder[secret.severity] > severityOrder[maxSeverity]) {
          maxSeverity = secret.severity;
        }
      }
    }
  }

  const verdict =
    maxSeverity === 'critical' ? 'BLOCK' : maxSeverity === 'high' ? 'WARN' : 'ALLOW';

  const report = {
    verdict,
    maxSeverity,
    filesScanned: files.length,
    secretsFound: allFindings.length,
    findings: allFindings,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n=== Secret Scan Results ===');
    console.log(`Files scanned: ${files.length}`);
    console.log(`Secrets found: ${allFindings.length}`);
    for (const entry of allFindings) {
      console.log(`\n${entry.file}`);
      for (const secret of entry.secrets) {
        console.log(`  ${secret.rule} (${secret.name}) - ${secret.severity}`);
        for (const match of secret.matches.slice(0, 3)) {
          console.log(`     Line ${match.line}: ${match.snippet}`);
        }
        if (secret.matches.length > 3) {
          console.log(`     ... and ${secret.matches.length - 3} more`);
        }
      }
    }
    console.log(`\n=== Summary ===`);
    console.log(`Max severity: ${maxSeverity}`);
    console.log(`Verdict: ${verdict}`);
  }

  if (maxSeverity === 'critical') process.exit(2);
  if (maxSeverity === 'high' && failOnWarn) process.exit(1);
  process.exit(0);
}

main();
