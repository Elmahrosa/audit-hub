const TIER_LABELS = { 1: "Ready", 2: "Stable", 3: "Needs Work", 4: "Critical" };

let META = null;
let RECORDS = [];
let activeTier = null;
let chart = null;
let WEEKS = 12;
let view = "inventory";

const $ = (id) => document.getElementById(id);

function currentRecords() {
  return view === "active" ? RECORDS.filter((r) => !r.archived) : RECORDS;
}

async function fetchData() {
  try {
    const [metaRes, jsonlRes] = await Promise.all([
      fetch("data/meta.json"),
      fetch("data/org-latest.jsonl"),
    ]);
    if (!metaRes.ok && !jsonlRes.ok) throw new Error("data files not found (run the aggregation workflow)");
    META = metaRes.ok ? await metaRes.json() : null;
    if (META && META.weeks) WEEKS = META.weeks;
    const raw = await jsonlRes.text();
    RECORDS = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
    render();
  } catch (err) {
    const el = $("error");
    el.style.display = "block";
    el.textContent = "⚠ " + (err.message || "Failed to load audit data");
  }
}

function fmtAgo(epochSec) {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - epochSec);
  if (diff < 60) return "just now";
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function tickUpdated() {
  const el = $("updated-text");
  if (!META) { el.textContent = "loading…"; return; }
  const when = new Date(META.generated_epoch * 1000).toLocaleString();
  el.textContent = `Updated ${fmtAgo(META.generated_epoch)} · ${when}`;
}

function renderStats() {
  const avg = RECORDS.length
    ? Math.round(RECORDS.reduce((a, r) => a + r.health_score, 0) / RECORDS.length)
    : 0;
  const audited = META ? (META.audited_repos ?? META.repos_audited ?? RECORDS.length) : RECORDS.length;
  const orgTotal = META ? (META.organization_total ?? META.repos_total ?? audited + 1) : RECORDS.length + 1;
  const archived = META
    ? (META.archived_repos ?? RECORDS.filter((r) => r.archived).length)
    : RECORDS.filter((r) => r.archived).length;
  const active = META
    ? (META.active_repos ?? RECORDS.filter((r) => !r.archived).length)
    : RECORDS.filter((r) => !r.archived).length;
  const items = [
    ["Organization total", orgTotal, ""],
    ["Active repos", active, "var(--ok)"],
    ["Archived", archived, "var(--muted)"],
    ["Audited", audited, ""],
    ["Failed / skipped", META ? META.failed : 0, "var(--danger)"],
    ["Avg health", avg, "var(--accent)"],
  ];
  $("stats").innerHTML = items
    .map(([l, n, c]) => `<div class="stat"><div class="num" style="color:${c}">${n}</div><div class="lbl">${l}</div></div>`)
    .join("");
}

function renderCards() {
  const recs = currentRecords();
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  recs.forEach((r) => { counts[r.tier] = (counts[r.tier] || 0) + 1; });
  $("tier-cards").innerHTML = [1, 2, 3, 4]
    .map((t) => {
      const n = counts[t] || 0;
      const pct = recs.length ? Math.round((n / recs.length) * 100) : 0;
      const active = activeTier === t ? " active" : "";
      return `<div class="card tier-${t}${active}" data-tier="${t}">
        <h3>Tier ${t}</h3>
        <div class="count">${n}</div>
        <div class="desc">${TIER_LABELS[t]} · ${pct}%</div>
      </div>`;
    })
    .join("");
  document.querySelectorAll(".card").forEach((c) =>
    c.addEventListener("click", () => {
      const t = Number(c.dataset.tier);
      activeTier = activeTier === t ? null : t;
      $("tier-filter").value = activeTier ? String(activeTier) : "all";
      renderCards();
      renderRows();
    })
  );
}

function weekLabels() {
  const out = [];
  for (let w = WEEKS - 1; w >= 0; w--) {
    const d = new Date(Date.now() - w * 7 * 86400000);
    out.push(d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  }
  return out;
}

function renderChart() {
  const ctx = $("chart");
  if (chart) chart.destroy();
  const colors = { 1: "var(--t1)", 2: "var(--t2)", 3: "var(--t3)", 4: "var(--t4)" };
  const tickColor = getComputedStyle(document.documentElement).getPropertyValue("--chart-tick").trim();
  const gridColor = getComputedStyle(document.documentElement).getPropertyValue("--chart-grid").trim();
  const labels = weekLabels();
  const traj = view === "active"
    ? (META?.active_trajectory_by_tier || META?.trajectory_by_tier || {})
    : (META?.trajectory_by_tier || {});
  const title = $("chart-title");
  if (title) title.textContent = `Trajectories — avg weekly commits by tier (${view === "active" ? "active remediation" : "inventory"})`;
  const datasets = [1, 2, 3, 4]
    .map((t) => {
      const series = traj[String(t)] || [];
      if (!series.length) return null;
      return {
        label: `Tier ${t} — ${TIER_LABELS[t]}`,
        data: series,
        borderColor: getComputedStyle(document.documentElement).getPropertyValue(colors[t]).trim(),
        backgroundColor: "transparent",
        fill: false,
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 2,
      };
    })
    .filter(Boolean);
  chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 11 } } },
        y: {
          beginAtZero: true,
          grid: { color: gridColor },
          ticks: { color: tickColor },
          title: { display: true, text: "avg commits / week", color: tickColor },
        },
      },
      plugins: {
        legend: { labels: { color: getComputedStyle(document.documentElement).getPropertyValue("--text").trim() } },
      },
    },
  });
}

function scoreColor(s) {
  if (s >= 85) return "var(--t1)";
  if (s >= 70) return "var(--t2)";
  if (s >= 50) return "var(--t3)";
  return "var(--t4)";
}

function renderRows() {
  const q = $("search").value.toLowerCase();
  const tf = $("tier-filter").value;
  const rows = currentRecords().filter((r) => {
    const okTier = tf === "all" || String(r.tier) === tf;
    const okQ = !q || r.full_name.toLowerCase().includes(q) || (r.language || "").toLowerCase().includes(q);
    return okTier && okQ;
  });
  $("rows").innerHTML = rows.length
    ? rows.map((r) => {
        const p = r.pushed_at ? fmtAgo(Math.floor(new Date(r.pushed_at).getTime() / 1000)) : "—";
        const priv = r.private ? ' <span class="priv">private</span>' : "";
        const arch = r.archived ? ' <span class="arch" title="Archived repository">archived</span>' : "";
        const status = r.archived
          ? '<span class="pill arch-pill">ARCHIVED</span><div class="arch-note">remediation eligible: no · action required: no</div>'
          : '<span class="pill act-pill">ACTIVE</span><div class="arch-note">remediation eligible: yes</div>';
        return `<tr>
          <td><a href="${r.url}" target="_blank" rel="noopener">${r.full_name}</a>${arch}${priv}</td>
          <td><span class="pill t${r.tier}">T${r.tier} ${TIER_LABELS[r.tier]}</span></td>
          <td><div class="score-bar"><span class="bar"><i style="width:${r.health_score}%;background:${scoreColor(r.health_score)}"></i></span><span class="score-num">${r.health_score}</span></div></td>
          <td class="muted">${r.language || "—"}</td>
          <td>${r.commits_90d}</td>
          <td>${r.open_issues}</td>
          <td class="muted">${p}</td>
          <td>${status}</td>
        </tr>`;
      }).join("")
    : '<tr><td colspan="8" class="muted" style="text-align:center">No matching repositories</td></tr>';
}

function setView(v) {
  view = v;
  document.querySelectorAll(".seg").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  renderCards();
  renderChart();
  renderRows();
}

function render() {
  tickUpdated();
  renderStats();
  renderCards();
  renderChart();
  renderRows();
}

function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved === "light") document.documentElement.setAttribute("data-theme", "light");
  else if (saved === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.setAttribute("data-theme", "dark");
  syncThemeBtn();
}

function syncThemeBtn() {
  const cur = document.documentElement.getAttribute("data-theme");
  $("theme-btn").textContent = cur === "dark" ? "☾ Dark" : "☀ Light";
}

$("theme-btn").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  syncThemeBtn();
  if (chart) renderChart();
});

$("refresh-btn").addEventListener("click", fetchData);
$("search").addEventListener("input", renderRows);
$("tier-filter").addEventListener("change", () => {
  const v = $("tier-filter").value;
  activeTier = v === "all" ? null : Number(v);
  renderCards();
  renderRows();
});
$("view-inventory").addEventListener("click", () => setView("inventory"));
$("view-active").addEventListener("click", () => setView("active"));

initTheme();
fetchData();
setInterval(tickUpdated, 30000);
