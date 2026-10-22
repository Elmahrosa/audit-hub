#!/usr/bin/env node
'use strict';

const fs = require('fs');

function parseArgs(argv) {
  const args = { current: 'docs/data/org-latest.jsonl', previous: null, out: 'tier-changes.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--current') args.current = argv[++i];
    else if (argv[i] === '--previous') args.previous = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

function readRecords(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const currentData = readRecords(args.current);
  const previousData = readRecords(args.previous);

  const previousMap = new Map(previousData.map((repo) => [repo.full_name, repo]));

  const downgrades = [];
  const upgrades = [];
  const newRepos = [];

  for (const repo of currentData) {
    const previous = previousMap.get(repo.full_name);
    if (!previous) {
      newRepos.push(repo);
    } else if (repo.tier > previous.tier) {
      downgrades.push({
        repo,
        previous_tier: previous.tier,
        current_tier: repo.tier,
        change: repo.tier - previous.tier,
        health_score: repo.health_score,
      });
    } else if (repo.tier < previous.tier) {
      upgrades.push({
        repo,
        previous_tier: previous.tier,
        current_tier: repo.tier,
        change: previous.tier - repo.tier,
        health_score: repo.health_score,
      });
    }
  }

  const output = {
    downgrades: downgrades.map((d) => ({
      full_name: d.repo.full_name,
      previous_tier: d.previous_tier,
      current_tier: d.current_tier,
      change: d.change,
      health_score: d.health_score,
    })),
    upgrades: upgrades.map((u) => ({
      full_name: u.repo.full_name,
      previous_tier: u.previous_tier,
      current_tier: u.current_tier,
      change: u.change,
      health_score: u.health_score,
    })),
    new_repos: newRepos.map((r) => ({
      full_name: r.full_name,
      tier: r.tier,
      health_score: r.health_score,
    })),
  };

  fs.writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `downgrades=${output.downgrades.length} upgrades=${output.upgrades.length} new_repos=${output.new_repos.length}`,
  );
}

main();
