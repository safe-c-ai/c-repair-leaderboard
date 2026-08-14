"use strict";

/* CERT-C repair leaderboard UI v2.
 * Inputs (measured, sanitized, read-only):
 *   data/ranking.json  — authority for order, rank, and headline validation-passed.
 *   data/catalog.json  — per-system configuration and detail metrics, joined by system_id.
 * This script never mutates measured values. Derived display values (percentages,
 * cost-per-passed) are computed for presentation only. */

/* Loader contract, two layers:
 *   INVARIANTS — safety properties fixed in code; never relaxed by data.
 *   manifest-driven — variable shape (schema names, System / OFF / HIGH counts)
 *     read from data/artifact_manifest.json so measured-data updates need no code edit.
 * The manifest only declares shape; every declaration is cross-checked against the
 * actual ranking/catalog, so a manifest cannot loosen the invariants. */
const CONTRACT = {
  manifestSchema: "leaderboard-public-artifact-manifest-v1",
  rankingKind: "sanitized_benchmark_ranking",
  catalogKind: "sanitized_benchmark_result",
  rankingSchemaPattern: /^medium-off-high(-[a-z0-9-]+)?-public-ranking-v\d+$/,
  catalogSchemaPattern: /^medium-off-high(-[a-z0-9-]+)?-public-catalog-v\d+$/,
  denominator: 115,
};

const SITE_NAME = "CERT-C Repair Leaderboard";

// Reasoning-mode colors (colorblind-safe blue/orange), shared by the scatter and legend.
const MODE_COLOR = { off: "var(--mode-off)", high: "var(--mode-high)" };
const colorForMode = (reasoning) => MODE_COLOR[reasoning] || "var(--accent)";

// Bidirectional hover link between the scatter and the key chips below it.
// Rebuilt each renderCostViews(); maps system_id -> { g, dot } and -> its chip <li>.
const costFocus = { groups: new Map(), bars: new Map(), items: new Map() };
function focusSystem(id) {
  // Scatter points: dim others, pop the focused dot.
  costFocus.groups.forEach((entry, sid) => {
    const focused = id !== null && sid === id;
    entry.g.style.opacity = (id === null || focused) ? "1" : "0.22";
    entry.dot.setAttribute("r", focused ? "11" : "7");
    entry.dot.setAttribute("stroke-width", focused ? "3" : "2");
    if (entry.ci) entry.ci.style.display = (state.showCI || focused) ? "" : "none";
  });
  // Rank bars: dim others; CI whisker shows on focus or when the CI toggle is on.
  costFocus.bars.forEach((entry, sid) => {
    const focused = id !== null && sid === id;
    entry.g.style.opacity = (id === null || focused) ? "1" : "0.3";
    if (entry.ci) entry.ci.style.display = (state.showCI || focused) ? "" : "none";
  });
  // Key chips.
  costFocus.items.forEach((li, sid) => { li.classList.toggle("focused", id !== null && sid === id); });
}

const state = {
  rows: [],
  query: "",
  modeFilter: "all",
  showCI: false,
  sortKey: "rank",
  sortDir: "asc",
};

const els = {
  body: document.querySelector("#board-body"),
  boardState: document.querySelector("#board-state"),
  search: document.querySelector("#search"),
  modeChips: document.querySelectorAll(".mode-chip"),
  resultSummary: document.querySelector("#result-summary"),
  sortNote: document.querySelector("#sort-note"),
  footnoteGroup: document.querySelector("#footnote-group"),
  brandLink: document.querySelector("#brand-link"),
  brandName: document.querySelector("#brand-name"),
  footerSiteName: document.querySelector("#footer-site-name"),
  runDateChip: document.querySelector("#run-date-chip"),
  barChart: document.querySelector("#rank-chart"),
  chart: document.querySelector("#cost-chart"),
  costList: document.querySelector("#cost-list"),
  toggleCI: document.querySelector("#toggle-ci"),
  dialog: document.querySelector("#system-dialog"),
  dialogRank: document.querySelector("#dialog-rank"),
  dialogTitle: document.querySelector("#dialog-title"),
  dialogContent: document.querySelector("#dialog-content"),
  dialogClose: document.querySelector("#dialog-close"),
};

/* ---------- formatting ---------- */
const pct = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(d)}%`);
const money = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v) ? "—" : `$${v.toFixed(d)}`);
const intOr = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString());

function metric(summary, id) {
  return (summary.metrics || []).find((m) => m.metric_id === id) || null;
}
function metricRate(m) {
  return m && m.denominator ? m.count / m.denominator : null;
}

function wilsonInterval(count, denominator) {
  if (!Number.isFinite(count) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const z = 1.959963984540054;
  const p = count / denominator;
  const z2 = z * z;
  const scale = 1 + z2 / denominator;
  const center = (p + z2 / (2 * denominator)) / scale;
  const half = (z / scale) * Math.sqrt((p * (1 - p) / denominator) + (z2 / (4 * denominator * denominator)));
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}

function ciText(ci) {
  return ci ? `95% CI ${pct(ci.lower)}–${pct(ci.upper)}` : "95% CI —";
}

/* ---------- data loading + validation ---------- */
async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} request failed: ${res.status}`);
  return res.json();
}

function validate(ranking, catalog, manifest) {
  const problems = [];
  if (!ranking || typeof ranking !== "object") problems.push("ranking.json is not an object");
  if (!catalog || typeof catalog !== "object") problems.push("catalog.json is not an object");
  if (!manifest || typeof manifest !== "object") problems.push("artifact_manifest.json is not an object");
  if (problems.length) return problems;

  // ---- INVARIANTS: safety properties fixed in code ----
  if (manifest.manifest_schema_version !== CONTRACT.manifestSchema) problems.push(`unexpected manifest_schema_version: ${manifest.manifest_schema_version}`);
  if (manifest.sanitization !== "passed") problems.push(`manifest sanitization is not "passed": ${manifest.sanitization}`);
  // Public contract: render only publication-approved artifacts. Refuse anything not
  // explicitly marked publication_allowed === true (e.g. draft/unapproved data).
  for (const [label, obj] of [["ranking", ranking], ["catalog", catalog], ["manifest", manifest]]) {
    if (obj.publication_allowed !== true) problems.push(`${label} publication_allowed is not true`);
  }
  if (ranking.data_kind !== CONTRACT.rankingKind) problems.push(`unexpected ranking data_kind: ${ranking.data_kind}`);
  if (catalog.data_kind !== CONTRACT.catalogKind) problems.push(`unexpected catalog data_kind: ${catalog.data_kind}`);
  if (!CONTRACT.rankingSchemaPattern.test(ranking.schema_version || "")) problems.push(`ranking schema_version outside allowed pattern: ${ranking.schema_version}`);
  if (!CONTRACT.catalogSchemaPattern.test(catalog.schema_version || "")) problems.push(`catalog schema_version outside allowed pattern: ${catalog.schema_version}`);
  if (!Array.isArray(ranking.systems)) problems.push("ranking.systems is missing");
  if (!Array.isArray(catalog.entries)) problems.push("catalog.entries is missing");

  // ---- manifest-driven: variable shape declared by the manifest, cross-checked against data ----
  if (ranking.schema_version !== manifest.ranking_schema_version) problems.push(`ranking schema_version does not match manifest: ${ranking.schema_version} vs ${manifest.ranking_schema_version}`);
  if (catalog.schema_version !== manifest.catalog_schema_version) problems.push(`catalog schema_version does not match manifest: ${catalog.schema_version} vs ${manifest.catalog_schema_version}`);
  if (ranking.comparison_group !== manifest.comparison_group || catalog.comparison_group !== manifest.comparison_group) problems.push("comparison_group mismatch across manifest/ranking/catalog");

  if (Array.isArray(ranking.systems) && Array.isArray(catalog.entries)) {
    const rankingIds = ranking.systems.map((row) => row.system_id);
    const catalogIds = catalog.entries.map((entry) => entry.summary && entry.summary.system && entry.summary.system.system_id);
    const entries = manifest.entries;
    if (rankingIds.length !== entries || new Set(rankingIds).size !== entries) problems.push(`ranking must contain ${entries} unique System configurations (manifest.entries)`);
    if (catalogIds.length !== entries || new Set(catalogIds).size !== entries) problems.push(`catalog must contain ${entries} unique System configurations (manifest.entries)`);
    if ([...rankingIds].sort().join("\n") !== [...catalogIds].sort().join("\n")) problems.push("ranking/catalog System join mismatch");
    if (ranking.systems.some((row) => !["off", "high"].includes(row.reasoning) || row.denominator !== CONTRACT.denominator)) problems.push(`ranking scope is not Medium ${CONTRACT.denominator} OFF/HIGH`);
    const offN = ranking.systems.filter((row) => row.reasoning === "off").length;
    const highN = ranking.systems.filter((row) => row.reasoning === "high").length;
    if (offN !== manifest.reasoning_off_entries || highN !== manifest.reasoning_high_entries) problems.push(`OFF/HIGH counts do not match manifest: got ${offN}/${highN}, manifest ${manifest.reasoning_off_entries}/${manifest.reasoning_high_entries}`);
  }
  return problems;
}

function buildRows(ranking, catalog) {
  const byId = new Map();
  for (const entry of catalog.entries) {
    const sid = entry.summary && entry.summary.system && entry.summary.system.system_id;
    if (sid) byId.set(sid, entry);
  }
  return ranking.systems.map((sys) => {
    const entry = byId.get(sys.system_id) || null;
    const summary = entry ? entry.summary : null;
    const compile = summary ? metric(summary, "compile-pass") : null;
    const logic = summary ? metric(summary, "suspicious-logic-deletion") : null;
    const gen = summary ? summary.generation_cost : null;
    const cost = gen ? gen.generation_cost_usd : null;
    const validationRate = sys.denominator ? sys.validation_passed / sys.denominator : null;
    const costPerPass = cost !== null && sys.validation_passed > 0 ? cost / sys.validation_passed : null;
    const s = summary ? summary.system : {};
    return {
      rank: sys.rank,
      systemId: sys.system_id,
      displayName: sys.display_name,
      reasoning: sys.reasoning,
      validationPassed: sys.validation_passed,
      denominator: sys.denominator,
      validationRate,
      validationCI: wilsonInterval(sys.validation_passed, sys.denominator),
      judgeVerdicts: sys.judge_verdict_counts || {},
      judgeEligible: sys.judge_eligible,
      logicDeletionCount: sys.suspicious_logic_deletion,
      compile,
      logic,
      cost,
      costPerPass,
      costCompleteness: gen ? gen.cost_completeness : null,
      summary,
      system: s,
      evaluatedAt: entry ? entry.evaluated_at : null,
      runManifestSha256: summary && summary.provenance ? summary.provenance.run_manifest_sha256 : null,
      searchText: [
        sys.display_name,
        s.declared_model_id,
        s.actual_provider,
        s.expected_provider,
        s.exact_endpoint,
        s.gateway,
        s.quantization,
        s.route_kind,
        sys.reasoning,
      ].filter(Boolean).join(" ").toLowerCase(),
    };
  });
}

/* ---------- sorting ---------- */
const SORT = {
  rank: { get: (r) => r.rank, dir: "asc", label: "rank" },
  name: { get: (r) => r.displayName.toLowerCase(), dir: "asc", label: "system name", text: true },
  validation: { get: (r) => r.validationRate, dir: "desc", label: "validation-passed" },
  compile: { get: (r) => metricRate(r.compile), dir: "desc", label: "compile-pass" },
  logic: { get: (r) => metricRate(r.logic), dir: "asc", label: "suspicious logic deletion" },
  cost: { get: (r) => r.cost, dir: "asc", label: "generation cost" },
  costPerPass: { get: (r) => r.costPerPass, dir: "asc", label: "cost per passed fix" },
};

function sortedRows() {
  const q = state.query.trim().toLowerCase();
  const rows = state.rows.filter((r) =>
    (state.modeFilter === "all" || r.reasoning === state.modeFilter)
    && (!q || r.searchText.includes(q)));
  const spec = SORT[state.sortKey] || SORT.rank;
  const factor = state.sortDir === "asc" ? 1 : -1;
  return rows.sort((a, b) => {
    const av = spec.get(a);
    const bv = spec.get(b);
    let cmp;
    if (spec.text) cmp = String(av).localeCompare(String(bv));
    else if (av === null || av === undefined) cmp = bv === null || bv === undefined ? 0 : 1;
    else if (bv === null || bv === undefined) cmp = -1;
    else cmp = av - bv;
    // stable tie-break by frozen rank so equal values keep a deterministic order.
    if (cmp === 0) return a.rank - b.rank;
    return factor * cmp;
  });
}

/* ---------- rendering: table ---------- */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function rankBadge(rank) {
  const badge = el("span", "rank-badge", String(rank));
  if (rank <= 3) badge.classList.add(`medal-${rank}`);
  badge.setAttribute("aria-label", `Rank ${rank}`);
  return badge;
}

function safeModelUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch (_) {
    return null;
  }
}

function systemCell(row) {
  const td = el("td", "system-cell");
  const url = safeModelUrl(row.system.model_page_url);
  const name = document.createElement(url ? "a" : "span");
  name.className = "system-name";
  name.textContent = row.displayName;
  if (url) {
    name.href = url;
    name.target = "_blank";
    name.rel = "noreferrer noopener";
    const mark = el("span", "ext-mark", "↗");
    mark.setAttribute("aria-hidden", "true");
    name.append(mark);
  }
  const tag = el("span", `mode-tag mode-${row.reasoning || "off"}`, row.reasoning ? row.reasoning.toUpperCase() : "—");
  tag.setAttribute("aria-hidden", "true"); // reasoning is also a labelled column
  const meta = el("span", "system-meta", [
    row.system.actual_provider || row.system.expected_provider,
    row.system.exact_endpoint,
    row.system.quantization && row.system.quantization !== "unknown" ? row.system.quantization : null,
  ].filter(Boolean).join(" · "));
  td.append(name, tag, meta);
  return td;
}

function metricCell(count, denom, rate, opts = {}) {
  const td = el("td", "col-metric");
  if (opts.className) td.classList.add(opts.className);
  const main = el("span", "metric-main", count === null || count === undefined ? "—" : `${count} / ${denom}`);
  td.append(main);
  const sub = el("span", "metric-sub", pct(rate));
  td.append(sub);
  if (opts.ci) td.append(el("span", "metric-ci", ciText(opts.ci)));
  if (opts.bar && rate !== null) {
    const bar = el("div", "rate-bar");
    const fill = el("i");
    fill.style.width = `${Math.round(rate * 100)}%`;
    bar.append(fill);
    bar.setAttribute("aria-hidden", "true");
    td.append(bar);
  }
  return td;
}

function moneyCell(value, digits, sub) {
  const td = el("td", "col-cost");
  td.append(el("span", "money", money(value, digits)));
  if (sub) td.append(el("span", "muted-sub", sub));
  return td;
}

function reasoningCell(row) {
  const td = el("td");
  const badge = el("span", "reason-badge", row.reasoning ? row.reasoning.toUpperCase() : "—");
  const rs = row.system.inference_settings && row.system.inference_settings.reasoning_setting;
  if (rs && rs.verification_status) badge.title = `reasoning ${rs.policy}; ${rs.verification_status.replace(/_/g, " ")}`;
  td.append(badge);
  return td;
}

function renderRow(row) {
  const tr = el("tr");
  tr.id = `system-${row.systemId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const rankTd = el("td", "rank-cell");
  rankTd.append(rankBadge(row.rank));
  tr.append(rankTd);
  tr.append(systemCell(row));
  tr.append(metricCell(row.validationPassed, row.denominator, row.validationRate, {
    bar: true,
    ci: row.validationCI,
    className: "priority-validation",
  }));
  const c = row.compile;
  tr.append(metricCell(c ? c.count : null, c ? c.denominator : null, metricRate(c), { className: "optional-compile" }));
  const l = row.logic;
  const logicRate = metricRate(l);
  tr.append(metricCell(l ? l.count : null, l ? l.denominator : null, logicRate, { className: "optional-logic" }));
  const generationCost = moneyCell(row.cost, 3, row.costCompleteness === "partial" ? "partial telemetry" : null);
  generationCost.classList.add("priority-cost");
  tr.append(generationCost);
  const costPerPass = moneyCell(row.costPerPass, 4, "generation only");
  costPerPass.classList.add("optional-cost-pass");
  tr.append(costPerPass);
  const reasoning = reasoningCell(row);
  reasoning.classList.add("optional-reason");
  tr.append(reasoning);

  const actionTd = el("td", "col-action");
  const btn = el("button", "details-btn", "Details");
  btn.type = "button";
  btn.setAttribute("aria-label", `Details for ${row.displayName}`);
  btn.addEventListener("click", () => openDialog(row));
  actionTd.append(btn);
  tr.append(actionTd);
  return tr;
}

function renderTable() {
  const rows = sortedRows();
  els.boardState.hidden = rows.length !== 0;
  if (rows.length === 0) {
    setState("empty", "No systems match these filters", "Clear the search box or reset the mode filter to All to see every System configuration.");
    els.body.replaceChildren();
  } else {
    els.body.replaceChildren(...rows.map(renderRow));
  }
  const total = state.rows.length;
  els.resultSummary.textContent = rows.length === total
    ? `${total} System configurations · ${state.rows.filter((r) => r.reasoning === "off").length} OFF / ${state.rows.filter((r) => r.reasoning === "high").length} HIGH`
    : `${rows.length} of ${total} systems`;

  const spec = SORT[state.sortKey] || SORT.rank;
  els.sortNote.textContent = state.sortKey === "rank" && state.sortDir === "asc"
    ? "Sorted by rank"
    : `Sorted by ${spec.label} (${state.sortDir}) · rank badges stay fixed`;

  updateSortIndicators();
}

/* ---------- summary + chart ---------- */
function renderRunMetadata() {
  const dates = [...new Set(state.rows.map((r) => r.evaluatedAt).filter(Boolean))].sort();
  const lastRunDate = dates.length ? dates[dates.length - 1] : "Not reported";
  els.runDateChip.textContent = `Last run date: ${lastRunDate}`;
}

const SVGNS = "http://www.w3.org/2000/svg";
function svg(name, attrs, text) {
  const node = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

// Cost-efficiency (Pareto) frontier for "upper-left favorable": keep points that no
// other point weakly dominates (cost <= and rate >=, at least one strict). Sorted by cost.
function paretoFrontier(points) {
  return points
    .filter((p) => !points.some((q) => q !== p
      && q.cost <= p.cost && p.validationRate <= q.validationRate
      && (q.cost < p.cost || q.validationRate > p.validationRate)))
    .sort((a, b) => a.cost - b.cost);
}

// Shared hover tooltip (model, pass rate, CI, cost) for both the scatter and the bar chart.
function createTooltip(target) {
  const tip = el("div", "chart-tip");
  tip.hidden = true;
  const hideTip = () => { tip.hidden = true; };
  const showTip = (p, e) => {
    tip.replaceChildren(
      el("strong", "chart-tip-name", `Rank ${p.rank} · ${p.displayName} · ${p.reasoning.toUpperCase()}`),
      el("span", "chart-tip-row", `Validation-passed ${p.validationPassed} / ${p.denominator} (${pct(p.validationRate)})`),
      el("span", "chart-tip-row", ciText(p.validationCI)),
      el("span", "chart-tip-row", `Generation cost ${money(p.cost)}${p.costCompleteness === "partial" ? " (reported subtotal)" : ""}`),
    );
    tip.hidden = false;
    const rect = target.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const tw = tip.offsetWidth || 200;
    const th = tip.offsetHeight || 78;
    let left = px + 14;
    if (left + tw > rect.width - 4) left = px - tw - 14;
    let top = py - th - 12;
    if (top < 4) top = py + 18;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, top)}px`;
  };
  return { tip, showTip, hideTip };
}

// Rank overview: one bar per System (tie-aware rank order), height = validation-passed
// rate on a 0–100% axis, colored by reasoning mode. Filter + CI toggle apply; hovering a
// bar (or its chip/scatter point) isolates it. Answers "who is strongest, and by how much".
function renderBarChart(target, rows) {
  const pts = rows.filter((r) => r.validationRate !== null).sort((a, b) => a.rank - b.rank);
  target.replaceChildren();
  if (!pts.length) {
    target.append(el("p", "chart-hint", "No systems to plot."));
    return;
  }
  const W = 960, H = 430, m = { top: 18, right: 20, bottom: 108, left: 48 };
  const pw = W - m.left - m.right, ph = H - m.top - m.bottom;
  const y = (v) => m.top + (1 - v) * ph; // honest 0–100% baseline
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
  const axis = "var(--line-strong)", label = "var(--ink-faint)";
  for (let i = 0; i <= 5; i++) {
    const val = i / 5, ly = y(val);
    root.append(svg("line", { x1: m.left, y1: ly, x2: W - m.right, y2: ly, stroke: axis, "stroke-width": 1, opacity: .5 }));
    root.append(svg("text", { x: m.left - 8, y: ly + 4, fill: label, "font-size": 11, "text-anchor": "end" }, pct(val, 0)));
  }
  const slot = pw / pts.length;
  const barW = Math.min(34, slot * 0.66);
  const { tip, showTip, hideTip } = createTooltip(target);
  const baseline = y(0);
  const labelY = H - m.bottom + 14;
  pts.forEach((p, i) => {
    const cx = m.left + slot * (i + 0.5);
    const color = colorForMode(p.reasoning);
    const top = y(p.validationRate);
    const g = svg("g", { class: "bar-group", "data-system-id": p.systemId });
    g.append(svg("rect", { x: cx - barW / 2, y: top, width: barW, height: Math.max(0, baseline - top), fill: color, rx: 3 }));
    let ci = null;
    if (p.validationCI) {
      ci = svg("g", { class: "ci-band" });
      const u = y(p.validationCI.upper), lo = y(p.validationCI.lower);
      ci.append(svg("line", { x1: cx, y1: u, x2: cx, y2: lo, stroke: "var(--ink)", "stroke-width": 1.5, opacity: .5 }));
      ci.append(svg("line", { x1: cx - 4, y1: u, x2: cx + 4, y2: u, stroke: "var(--ink)", "stroke-width": 1.5, opacity: .5 }));
      ci.append(svg("line", { x1: cx - 4, y1: lo, x2: cx + 4, y2: lo, stroke: "var(--ink)", "stroke-width": 1.5, opacity: .5 }));
      g.append(ci);
    }
    // rate label inside the bar, near the top (bars are all >= ~50% tall, so it fits)
    g.append(svg("text", { x: cx, y: top + 14, class: "bar-rate", fill: "#fff", "font-size": 11, "font-weight": 700, "text-anchor": "middle" }, String(Math.round(p.validationRate * 100))));
    root.append(g);
    // rotated System-name label under each bar (name + mode, so ties are not color-only)
    const name = `${shortName(p.displayName)} · ${p.reasoning ? p.reasoning.toUpperCase() : "—"}`;
    root.append(svg("text", { x: cx, y: labelY, class: "bar-label", fill: label, "font-size": 10, "text-anchor": "end", transform: `rotate(-45 ${cx} ${labelY})` }, name));
    const hit = svg("rect", { x: cx - slot / 2, y: m.top, width: slot, height: ph, fill: "transparent", style: "cursor:pointer" });
    hit.addEventListener("mouseenter", (e) => { showTip(p, e); focusSystem(p.systemId); });
    hit.addEventListener("mousemove", (e) => showTip(p, e));
    hit.addEventListener("mouseleave", () => { hideTip(); focusSystem(null); });
    root.append(hit);
    costFocus.bars.set(p.systemId, { g, ci });
  });
  root.append(svg("text", { x: 14, y: m.top + ph / 2, fill: "var(--ink-soft)", "font-size": 12, "text-anchor": "middle", transform: `rotate(-90 14 ${m.top + ph / 2})` }, "Validation-passed rate"));
  target.append(root);
  target.append(tip);
}

function renderChart(target, rows) {
  const pts = rows.filter((r) => r.cost !== null && r.validationRate !== null);
  target.replaceChildren();
  if (!pts.length) {
    target.append(el("p", "chart-hint", "No cost-complete systems to plot."));
    return;
  }
  const W = 960, H = 420;
  const m = { top: 22, right: 28, bottom: 56, left: 62 };
  const pw = W - m.left - m.right, ph = H - m.top - m.bottom;
  // X axis: log10 cost scale. Costs span ~2 orders of magnitude ($0.01–$3), so a
  // linear axis crushes the cheap systems together and stretches the expensive ones.
  // The domain snaps to 1-2-5 tick boundaries enclosing the data so every gridline
  // lands on a round value ($0.01, $0.02, $0.05, $0.1, …) and the range stays tight.
  const costs = pts.map((p) => p.cost);
  const dataMinCost = Math.min(...costs), dataMaxCost = Math.max(...costs);
  const niceLogTicks = (lo, hi) => {
    const ticks = [];
    for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
      for (const mant of [1, 2, 5]) ticks.push(mant * Math.pow(10, e));
    }
    return ticks;
  };
  const allCostTicks = niceLogTicks(dataMinCost, dataMaxCost);
  const domLo = Math.max(...allCostTicks.filter((t) => t <= dataMinCost + 1e-12));
  const domHi = Math.min(...allCostTicks.filter((t) => t >= dataMaxCost - 1e-12));
  const loLog = Math.log10(domLo), hiLog = Math.log10(domHi);
  const costTicks = allCostTicks.filter((t) => t >= domLo - 1e-12 && t <= domHi + 1e-12);
  // Y axis: nice-number validation-passed-rate ticks around the CI-padded data range,
  // so gridlines land on round percentages instead of arbitrary data-derived values.
  const lowerRates = pts.map((p) => p.validationCI ? p.validationCI.lower : p.validationRate);
  const upperRates = pts.map((p) => p.validationCI ? p.validationCI.upper : p.validationRate);
  const rateLo = Math.max(0, Math.min(...lowerRates) - 0.025);
  const rateHi = Math.min(1, Math.max(...upperRates) + 0.025);
  const rateStep = [0.05, 0.1, 0.2].find((s) => (rateHi - rateLo) / s <= 6) || 0.2;
  const minRate = Math.max(0, Math.floor(rateLo / rateStep) * rateStep);
  const maxRate = Math.min(1, Math.ceil(rateHi / rateStep) * rateStep);
  const x = (v) => m.left + ((Math.log10(v) - loLog) / ((hiLog - loLog) || 1)) * pw;
  const y = (v) => m.top + ((maxRate - v) / (maxRate - minRate || 1)) * ph;

  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
  const axis = "var(--line-strong)", label = "var(--ink-faint)";
  // Y gridlines at nice rate ticks (integer step count avoids float drift).
  const rateTickCount = Math.round((maxRate - minRate) / rateStep);
  for (let i = 0; i <= rateTickCount; i++) {
    const val = minRate + i * rateStep;
    const ly = y(val);
    root.append(svg("line", { x1: m.left, y1: ly, x2: W - m.right, y2: ly, stroke: axis, "stroke-width": 1, opacity: .5 }));
    root.append(svg("text", { x: m.left - 10, y: ly + 4, fill: label, "font-size": 12, "text-anchor": "end" }, pct(val, 0)));
  }
  // X gridlines at the snapped 1-2-5 log ticks.
  const costTickLabel = (v) => (v >= 1 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`);
  for (const val of costTicks) {
    const lx = x(val);
    root.append(svg("line", { x1: lx, y1: m.top, x2: lx, y2: H - m.bottom, stroke: axis, "stroke-width": 1, opacity: .3 }));
    root.append(svg("text", { x: lx, y: H - m.bottom + 22, fill: label, "font-size": 12, "text-anchor": "middle" }, costTickLabel(val)));
  }
  root.append(svg("text", { x: m.left + pw / 2, y: H - 12, fill: "var(--ink-soft)", "font-size": 12.5, "text-anchor": "middle" }, "Generation cost for the 115-case run (USD, log scale)"));
  root.append(svg("text", { x: 16, y: m.top + ph / 2, fill: "var(--ink-soft)", "font-size": 12.5, "text-anchor": "middle", transform: `rotate(-90 16 ${m.top + ph / 2})` }, "Validation-passed rate"));

  // Per-mode cost-efficiency frontier (drawn behind the points). Same-mode only: OFF and
  // HIGH use different Judge epochs, so cross-mode dominance is deliberately not asserted.
  const frontierIds = new Set();
  for (const mode of ["off", "high"]) {
    const front = paretoFrontier(pts.filter((p) => p.reasoning === mode));
    front.forEach((p) => frontierIds.add(p.systemId));
    if (front.length < 2) continue;
    // Staircase, not a diagonal: only the discrete Systems exist, so the line reads as
    // "highest observed rate at or below this cost" (horizontal to the next cost, then up).
    const cmds = [`M ${x(front[0].cost).toFixed(1)} ${y(front[0].validationRate).toFixed(1)}`];
    for (let i = 1; i < front.length; i++) {
      const px = x(front[i].cost).toFixed(1);
      cmds.push(`L ${px} ${y(front[i - 1].validationRate).toFixed(1)}`);
      cmds.push(`L ${px} ${y(front[i].validationRate).toFixed(1)}`);
    }
    root.append(svg("path", { d: cmds.join(" "), class: "frontier-line", fill: "none", stroke: colorForMode(mode), "stroke-width": 1.5, "stroke-dasharray": "5 4", opacity: .5, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  }

  // Text labels would collide at 18 points, so in the All view only the cost-efficiency
  // frontier points are labelled (the ones a reader most needs named); a filtered single
  // mode (<=10 points) labels every point. Non-frontier points stay named via chip/hover.
  const labelAll = pts.length <= 10;
  const plotPoints = pts.map((p) => ({ p, cx: x(p.cost), cy: y(p.validationRate), color: colorForMode(p.reasoning) }));
  // Each system's CI band + dot live in one <g> so hovering (here or in the list)
  // can dim the other systems and isolate it. Groups are registered in costFocus.
  plotPoints.forEach(({ p, cx, cy, color }) => {
    const g = svg("g", { class: "point-group", "data-system-id": p.systemId });
    let ci = null;
    if (p.validationCI) {
      ci = svg("g", { class: "ci-band" });
      const top = y(p.validationCI.upper);
      const bottom = y(p.validationCI.lower);
      ci.append(svg("line", { x1: cx, y1: top, x2: cx, y2: bottom, stroke: color, "stroke-width": 6, "stroke-linecap": "round", opacity: .16 }));
      ci.append(svg("line", { x1: cx, y1: top, x2: cx, y2: bottom, stroke: color, "stroke-width": 1.5, "stroke-linecap": "round", opacity: .45 }));
      g.append(ci);
    }
    const dot = svg("circle", { cx, cy, r: 7, fill: color, stroke: "var(--surface)", "stroke-width": 2 });
    g.append(dot);
    root.append(g);
    costFocus.groups.set(p.systemId, { g, dot, ci });
  });

  // Interactive hover tooltip: model, pass rate, CI, cost.
  const { tip, showTip, hideTip } = createTooltip(target);

  const placedLabels = [];
  const hitCircles = [];
  plotPoints.forEach(({ p, cx, cy }) => {
    // larger transparent hit area so the point is easy to hover
    const hit = svg("circle", { cx, cy, r: 15, fill: "transparent", style: "cursor:pointer" });
    hit.addEventListener("mouseenter", (e) => { showTip(p, e); focusSystem(p.systemId); });
    hit.addEventListener("mousemove", (e) => showTip(p, e));
    hit.addEventListener("mouseleave", () => { hideTip(); focusSystem(null); });
    hitCircles.push(hit);
    if (!labelAll && !frontierIds.has(p.systemId)) return;
    const label = shortName(p.displayName);
    const anchor = cx > W - m.right - 155 ? "end" : "start";
    const labelX = cx + (anchor === "end" ? -12 : 12);
    const width = Math.max(42, label.length * 6.2);
    const left = anchor === "end" ? labelX - width : labelX;
    const right = anchor === "end" ? labelX : labelX + width;
    const offsets = [-11, 17, -28, 34, -45, 51, -62, 68];
    let labelY = cy + offsets[0];
    for (const offset of offsets) {
      const candidateY = Math.min(H - m.bottom - 4, Math.max(m.top + 11, cy + offset));
      const overlaps = placedLabels.some((prior) =>
        Math.abs(prior.y - candidateY) < 14 && left < prior.right + 8 && right > prior.left - 8);
      if (!overlaps) {
        labelY = candidateY;
        break;
      }
    }
    placedLabels.push({ left, right, y: labelY });
    root.append(svg("line", {
      x1: cx + (anchor === "end" ? -6 : 6), y1: cy,
      x2: labelX + (anchor === "end" ? 3 : -3), y2: labelY - 3,
      stroke: "var(--line-strong)", "stroke-width": 1,
    }));
    root.append(svg("text", {
      x: labelX, y: labelY, fill: "var(--ink-soft)", "font-size": 11, "text-anchor": anchor,
    }, label));
  });
  hitCircles.forEach((h) => root.append(h)); // on top, so hover always registers
  target.append(root);
  target.append(tip);
}

function shortName(name) {
  return name
    .replace("DeepSeek ", "DS ")
    .replace(" Preview", "")
    .replace("GPT-5.6 ", "")
    .replace("MiniMax ", "")
    .replace("MiMo-", "MiMo ");
}

// Compact key (rank order) mapping each scatter point to a model. Chips carry the mode
// color dot, short name, and rounded validation-passed rate (the rate is the point's
// y-position, so the chip doubles as a vertical anchor). Hovering a chip pops its point
// on the plot (and vice versa). Full name, mode, exact rate, and cost live in the title.
function renderCostList(target, sourceRows) {
  const rows = [...sourceRows].sort((a, b) => a.rank - b.rank);
  target.replaceChildren(...rows.map((r) => {
    const li = el("li", "cost-list-item");
    li.setAttribute("data-system-id", r.systemId);
    li.setAttribute("title", `${r.displayName} · ${(r.reasoning || "").toUpperCase()} · ${pct(r.validationRate)} · ${money(r.cost)}`);
    const dot = el("span", `cost-list-dot mode-${r.reasoning || "off"}`);
    const name = el("span", "cost-list-name", shortName(r.displayName));
    // Mode as text, not color alone (colorblind / print / screenshot safe).
    const mode = el("span", "cost-list-mode", `· ${r.reasoning ? r.reasoning.toUpperCase() : "—"}`);
    const rate = el("span", "cost-list-rate", pct(r.validationRate, 0));
    li.append(dot, name, mode, rate);
    li.addEventListener("mouseenter", () => focusSystem(r.systemId));
    li.addEventListener("mouseleave", () => focusSystem(null));
    costFocus.items.set(r.systemId, li);
    return li;
  }));
}

function renderCostViews() {
  costFocus.groups.clear();
  costFocus.bars.clear();
  costFocus.items.clear();
  const rows = state.rows.filter((r) => state.modeFilter === "all" || r.reasoning === state.modeFilter);
  renderBarChart(els.barChart, rows);
  renderChart(els.chart, rows);
  renderCostList(els.costList, rows);
  focusSystem(null); // apply the current CI-visibility state to every freshly built chart
}

/* ---------- details dialog ---------- */
function detailItem(label, value, code = false) {
  const wrap = el("div", "detail-item");
  wrap.append(el("span", null, label));
  const content = document.createElement(code ? "code" : "strong");
  content.textContent = value === null || value === undefined || value === "" ? "Not reported" : value;
  wrap.append(content);
  return wrap;
}

function buildTable(headers, rows) {
  const table = el("table", "detail-table");
  const thead = el("thead");
  const htr = el("tr");
  headers.forEach((h) => {
    const th = el("th", null, h);
    th.scope = "col";
    htr.append(th);
  });
  thead.append(htr);
  const tbody = el("tbody");
  rows.forEach((cells) => {
    const tr = el("tr");
    cells.forEach((c) => tr.append(el("td", null, c)));
    tbody.append(tr);
  });
  table.append(thead, tbody);
  return table;
}

function openDialog(row) {
  const s = row.summary;
  els.dialogRank.textContent = `Rank ${row.rank} · System configuration`;
  els.dialogTitle.textContent = row.displayName;

  const sys = row.system;
  const inf = sys.inference_settings || {};
  const rs = inf.reasoning_setting || {};
  const ts = inf.temperature_setting || {};
  const retry = inf.retry_setting || {};
  const gen = s ? s.generation_cost : {};

  const grid = el("div", "detail-grid");
  grid.append(
    detailItem("Run date", row.evaluatedAt),
    detailItem("Judge epoch", s.judge && s.judge.epoch, true),
    detailItem("Run manifest SHA-256", row.runManifestSha256, true),
    detailItem("Declared model ID", sys.declared_model_id, true),
    detailItem("Route", `${(sys.route_kind || "").toUpperCase()} · ${sys.gateway || "—"}`),
    detailItem("Provider", sys.actual_provider || sys.expected_provider),
    detailItem("Exact endpoint", sys.exact_endpoint, true),
    detailItem("Quantization", sys.quantization),
    detailItem("Reasoning", `${rs.policy || "—"} · requested ${rs.requested_effort || "—"} · ${(rs.verification_status || "").replace(/_/g, " ")}`),
    detailItem("Temperature", `requested ${ts.requested_value ?? "—"} · ${(ts.verification_status || "").replace(/_/g, " ")}`),
    detailItem("Max output tokens", inf.max_output_tokens ? inf.max_output_tokens.toLocaleString() : "—"),
    detailItem("Retry policy", retry.policy_id || "—"),
    detailItem("Retries", `${gen.retry_count ?? 0} retries across ${gen.retried_case_count ?? 0} cases`),
  );

  // Gate metrics
  const metricRows = (s.metrics || []).map((mt) => [
    mt.metric_id,
    mt.evaluator_type,
    `${mt.count} / ${mt.denominator}`,
    pct(metricRate(mt)),
  ]);
  const metricsSection = el("section", "detail-section");
  metricsSection.append(el("h3", null, "Gate counts"));
  metricsSection.append(buildTable(["Metric", "Evaluator", "Count", "Rate"], metricRows));

  // Judge verdicts
  const jv = row.judgeVerdicts;
  const judgeSection = el("section", "detail-section");
  judgeSection.append(el("h3", null, "Judge verdicts"));
  judgeSection.append(buildTable(
    ["Verdict", "Count"],
    [
      ["pass", String(jv.pass ?? 0)],
      ["fail", String(jv.fail ?? 0)],
      ["uncertain", String(jv.uncertain ?? 0)],
      ["Judge-eligible", String(row.judgeEligible ?? "—")],
    ],
  ));

  // Generation telemetry
  const genSection = el("section", "detail-section");
  genSection.append(el("h3", null, "Generation telemetry"));
  const genGrid = el("div", "detail-grid");
  const costVal = el("strong");
  costVal.textContent = money(gen.generation_cost_usd, 6);
  if (gen.cost_completeness && gen.cost_completeness !== "complete") {
    const flag = el("span", "completeness-flag", gen.cost_completeness);
    costVal.append(flag);
  }
  const costItem = el("div", "detail-item");
  costItem.append(el("span", null, "Generation cost"), costVal);
  genGrid.append(
    costItem,
    detailItem("Currency", gen.currency),
    detailItem("Input tokens", intOr(gen.input_tokens)),
    detailItem("Output tokens", intOr(gen.output_tokens)),
    detailItem("Reasoning tokens", intOr(gen.reasoning_tokens)),
    detailItem("Runtime", gen.runtime_seconds != null ? `${gen.runtime_seconds.toFixed(1)} s` : "—"),
    detailItem("Attempts", `${gen.attempt_count ?? "—"} for ${gen.case_count ?? "—"} cases`),
    detailItem("Cost completeness", gen.cost_completeness),
  );
  genSection.append(genGrid);

  // Top rule-cost rows (measured, read-only preview)
  let rulesSection = null;
  const ruleCosts = (gen.rule_costs || []).slice();
  if (ruleCosts.length) {
    ruleCosts.sort((a, b) => (b.generation_cost_usd || 0) - (a.generation_cost_usd || 0));
    const top = ruleCosts.slice(0, 5).map((rc) => [
      rc.rule_id,
      String(rc.case_count ?? "—"),
      intOr(rc.output_tokens),
      money(rc.generation_cost_usd, 6),
    ]);
    rulesSection = el("section", "detail-section");
    rulesSection.append(el("h3", null, `Highest-cost Rule rows (top 5 of ${ruleCosts.length})`));
    rulesSection.append(buildTable(["Rule", "Cases", "Output tokens", "Gen. cost"], top));
  }

  // Judge + system caveats
  const caveatWrap = el("div");
  const judgeCaveat = el("p", "detail-caveat");
  judgeCaveat.append(el("strong", null, "Judge · "));
  judgeCaveat.append(document.createTextNode(`${(s.judge && s.judge.epoch) || "—"} — ${(s.judge && s.judge.caveat) || ""}`));
  caveatWrap.append(judgeCaveat);
  (s.caveats || []).forEach((c) => {
    const p = el("p", "detail-caveat", c);
    p.style.marginTop = "10px";
    caveatWrap.append(p);
  });

  const parts = [grid, metricsSection, judgeSection, genSection];
  if (rulesSection) parts.push(rulesSection);
  parts.push(caveatWrap);
  els.dialogContent.replaceChildren(...parts);

  if (typeof els.dialog.showModal === "function") els.dialog.showModal();
  else els.dialog.setAttribute("open", "");
  els.dialogClose.focus();
}

/* ---------- state panel ---------- */
function setPanelState(panel, kind, title, detail) {
  panel.className = `state-panel ${kind}`;
  panel.hidden = false;
  panel.replaceChildren();
  panel.append(el("p", "state-title", title));
  if (detail) {
    panel.append(el("p", null, detail));
  }
}

function setState(kind, title, detail) {
  setPanelState(els.boardState, kind, title, detail);
}

/* ---------- sort controls ---------- */
function updateSortIndicators() {
  document.querySelectorAll(".sort-btn").forEach((btn) => {
    const active = btn.dataset.sort === state.sortKey;
    btn.classList.toggle("active", active);
    const ind = btn.querySelector(".sort-ind");
    if (ind) ind.textContent = active ? (state.sortDir === "desc" ? "▼" : "▲") : "";
    const th = btn.closest("th");
    if (th) th.setAttribute("aria-sort", active ? (state.sortDir === "desc" ? "descending" : "ascending") : "none");
  });
}

function bindModeFilter() {
  els.modeChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      state.modeFilter = chip.dataset.mode;
      els.modeChips.forEach((c) => {
        const on = c === chip;
        c.classList.toggle("active", on);
        c.setAttribute("aria-pressed", String(on));
      });
      renderTable();
      renderCostViews();
    });
  });
}

function bindCIToggle() {
  if (!els.toggleCI) return;
  els.toggleCI.addEventListener("click", () => {
    state.showCI = !state.showCI;
    els.toggleCI.setAttribute("aria-pressed", String(state.showCI));
    els.toggleCI.textContent = state.showCI ? "Hide 95% CI" : "Show 95% CI";
    focusSystem(null); // re-apply CI visibility across all points
  });
}

function bindSort() {
  document.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = (SORT[key] || SORT.rank).dir;
      }
      renderTable();
    });
  });
}

/* ---------- init ---------- */
async function init() {
  document.title = `${SITE_NAME} — v0.1`;
  els.brandName.textContent = SITE_NAME;
  els.brandLink.setAttribute("aria-label", `${SITE_NAME} home`);
  els.footerSiteName.textContent = SITE_NAME;
  bindSort();
  bindModeFilter();
  bindCIToggle();
  els.search.addEventListener("input", (e) => {
    state.query = e.target.value;
    renderTable();
  });
  els.dialogClose.addEventListener("click", () => els.dialog.close());
  els.dialog.addEventListener("click", (e) => {
    const box = els.dialog.getBoundingClientRect();
    const inside = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
    if (!inside) els.dialog.close();
  });

  setState("loading", "Loading measured results…", "Reading the sanitized OFF/HIGH ranking and catalog.");

  let ranking, catalog, manifest;
  try {
    [ranking, catalog, manifest] = await Promise.all([
      fetchJson("data/ranking.json"),
      fetchJson("data/catalog.json"),
      fetchJson("data/artifact_manifest.json"),
    ]);
  } catch (err) {
    const detail = `Serve this directory over HTTP and reload. The UI does not fall back to a private or remote source. ${String(err.message || err)}`;
    setState("error", "Could not load the leaderboard data", detail);
    els.resultSummary.textContent = "Data unavailable";
    return;
  }

  const problems = validate(ranking, catalog, manifest);
  if (problems.length) {
    const detail = `The leaderboard refuses to render data outside the frozen Medium OFF/HIGH contract: ${problems.join("; ")}`;
    setState("error", "The data did not pass the expected schema check", detail);
    els.resultSummary.textContent = "Malformed data";
    return;
  }

  state.rows = buildRows(ranking, catalog);
  els.footnoteGroup.textContent = ranking.comparison_group || "";
  els.boardState.hidden = true;
  renderRunMetadata();
  renderTable();
  renderCostViews();
}

init();
