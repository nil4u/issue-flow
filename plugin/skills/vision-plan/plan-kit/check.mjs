#!/usr/bin/env node
// plan-kit/check.mjs — mechanical data-consistency gate for visual plan artifacts.
//
// Usage: node <skill-dir>/plan-kit/check.mjs <issue-dir>/plan
//
// Zero dependencies. Verifies, with the same resolution semantics as the review
// engine (.agentrix/vision/engine/src/lib/anchors.ts resolvePlanDataRef):
//   a. index.html contains a <script type="application/json" id="plan-data"> island
//   b. island content (trimmed) is identical to data/plan-data.json (trimmed)
//   c. every unique data-ref in the HTML resolves in the plan data
//   d. id-bearing entries never referenced by any data-ref -> WARNING (not FAIL)
//   e. branching/merging/looping topology should use real diagram edges -> WARNING
//   f. lane/grid layout combinations that can break anchors -> WARNING
//   g. bare SVG edge labels without label boxes -> WARNING
//   h. CSS text/background contrast and dim opacity remain readable -> FAIL
//   i. data/visual-brief.md exists and carries the plan-first required fields
//   j. major sections and reviewable objects expose valid data-comment-scope hooks
//   k. validation closes the loop: each validation entry's refs resolve, and
//      every risk is covered by at least one validation ref -> WARNING
// The gate checks presence, consistency, and mechanical legibility only; whether
// the solution and trade-offs are right is human judgment, not a mechanical check.
// Last output line is the single-line verdict: "PASS: ..." or "FAIL: ...".
// Exit code 0 on PASS, 1 on FAIL.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const planDir = process.argv[2];
if (!planDir) {
  console.error("Usage: node check.mjs <issue-dir>/plan");
  console.log("FAIL: missing <issue-dir>/plan argument");
  process.exit(1);
}

const failures = [];
const warnings = [];

const htmlPath = resolve(planDir, "index.html");
const jsonPath = resolve(join(planDir, "data", "plan-data.json"));

let html = "";
if (!existsSync(htmlPath)) failures.push(`missing ${htmlPath}`);
else html = readFileSync(htmlPath, "utf8");

let jsonText = "";
if (!existsSync(jsonPath)) failures.push(`missing ${jsonPath}`);
else jsonText = readFileSync(jsonPath, "utf8");

// --- a. island exists -------------------------------------------------------
let islandText;
if (html) {
  const match = html.match(/<script\b([^>]*\bid=["']plan-data["'][^>]*)>([\s\S]*?)<\/script>/i);
  if (!match) {
    failures.push('index.html has no <script id="plan-data"> island');
  } else if (!/\btype=["']application\/json["']/i.test(match[1])) {
    failures.push('the #plan-data script island must declare type="application/json"');
  } else {
    islandText = match[2];
  }
}

// --- b. island is a byte copy of data/plan-data.json ------------------------
if (islandText !== undefined && jsonText) {
  if (islandText.trim() !== jsonText.trim()) {
    failures.push(
      "island content differs from data/plan-data.json — the island must be a " +
      "verbatim copy of the file; after editing the data, re-embed it by copying " +
      "the file contents (never hand-write or hand-edit the island)"
    );
  }
}

let planData;
if (jsonText) {
  try {
    planData = JSON.parse(jsonText);
  } catch (error) {
    failures.push(`data/plan-data.json is not valid JSON: ${error.message}`);
  }
}

// --- c. every data-ref in the HTML resolves ----------------------------------
// Mirrors resolvePlanDataRef: a segment is an object key, an array index, or —
// for arrays of objects — a match on the entry's `id` field.
function resolveRef(data, ref) {
  const segments = ref.split(".").map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return undefined;
  let current = data;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = /^\d+$/.test(segment) ? Number(segment) : -1;
      current = index >= 0
        ? current[index]
        : current.find((entry) => typeof entry === "object" && entry !== null && entry.id === segment);
    } else if (typeof current === "object" && current !== null) {
      current = current[segment];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

const refs = new Set();
if (html) {
  for (const m of html.matchAll(/data-ref\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const value = (m[2] ?? m[3] ?? "").trim();
    if (value) refs.add(value);
  }
}

let resolvedCount = 0;
if (planData !== undefined) {
  const unresolved = [];
  for (const ref of refs) {
    if (resolveRef(planData, ref) === undefined) unresolved.push(ref);
    else resolvedCount += 1;
  }
  if (unresolved.length) {
    failures.push(
      `${unresolved.length}/${refs.size} data-ref values do not resolve in plan-data: ` +
      unresolved.sort().join(", ")
    );
  }
}

// --- d. reverse check: id-bearing entries never referenced -> WARNING --------
if (planData !== undefined) {
  const refSegments = new Set();
  for (const ref of refs) for (const seg of ref.split(".")) refSegments.add(seg.trim());
  const unreferenced = [];
  (function walk(value, path) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (entry && typeof entry === "object" && typeof entry.id === "string") {
          if (!refSegments.has(entry.id)) unreferenced.push(`${path}.${entry.id}`);
        }
        walk(entry, `${path}.${index}`);
      });
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
    }
  })(planData, "");
  if (unreferenced.length) {
    warnings.push(
      `${unreferenced.length} plan-data entr${unreferenced.length === 1 ? "y is" : "ies are"} ` +
      `never referenced by any data-ref: ${unreferenced.join(", ")}`
    );
  }
}

// --- e. topology hint: branching/merging/looping edge data needs real edges ---
// Mirrors the skill rule: linear sequences may use .pk-rail, but topology that
// branches (one `from` used twice), merges (one `to` used twice), or loops
// (from === to) MUST be compiled to an SVG diagram via diagram.mjs.
if (planData !== undefined && html) {
  const branchingArrays = [];
  (function walk(value, path) {
    if (Array.isArray(value)) {
      const edges = value.filter((entry) =>
        entry && typeof entry === "object" &&
        typeof entry.from === "string" &&
        typeof entry.to === "string"
      );
      if (edges.length) {
        const fromCounts = new Map();
        const toCounts = new Map();
        let loops = false;
        for (const edge of edges) {
          fromCounts.set(edge.from, (fromCounts.get(edge.from) ?? 0) + 1);
          toCounts.set(edge.to, (toCounts.get(edge.to) ?? 0) + 1);
          if (edge.from === edge.to) loops = true;
        }
        const branches = [...fromCounts.values()].some((count) => count > 1);
        const merges = [...toCounts.values()].some((count) => count > 1);
        if (branches || merges || loops) branchingArrays.push(path || "<root>");
      }
      value.forEach((entry, index) => walk(entry, `${path}.${index}`));
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
    }
  })(planData, "");

  if (branchingArrays.length && !/\bclass\s*=\s*["'][^"']*\bpk-edge\b/i.test(html)) {
    warnings.push(
      `plan-data edge arrays (${branchingArrays.join(", ")}) branch, merge, or loop, ` +
      "but HTML has no .pk-edge; compile the topology with diagram.mjs instead of " +
      "collapsing it into prose/cards"
    );
  }
}

// --- f. layout hint: pk-lanes should not be mixed with custom grid systems ---
if (html) {
  const riskyLaneClasses = [];
  for (const m of html.matchAll(/class\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const classValue = (m[2] ?? m[3] ?? "").trim();
    const classes = classValue.split(/\s+/).filter(Boolean);
    const hasPkLanes = classes.includes("pk-lanes");
    const hasCustomGrid = classes.some((name) => /grid/i.test(name) && !name.startsWith("pk-"));
    if (hasPkLanes && hasCustomGrid) riskyLaneClasses.push(classValue);
  }
  if (riskyLaneClasses.length) {
    warnings.push(
      `.pk-lanes is combined with custom grid class${riskyLaneClasses.length === 1 ? "" : "es"} ` +
      `(${riskyLaneClasses.join(", ")}); this can push lane cards out of their review anchors`
    );
  }
}

// --- g. diagram label hint: bare SVG text labels overlap dense diagrams ------
if (html && /\bclass\s*=\s*["'][^"']*\bpk-edge-label\b/i.test(html) &&
    !/\bclass\s*=\s*["'][^"']*\bpk-edge-label-box\b/i.test(html)) {
  warnings.push(
    "HTML has .pk-edge-label text without .pk-edge-label-box wrappers; regenerate topology with diagram.mjs so labels avoid nodes and other labels"
  );
}

// --- h. readable contrast gate ----------------------------------------------
// Mechanical approximation: parse linked CSS in document order, resolve simple
// hex CSS variables, and fail when a selector's final text/background pair or a
// background-only surface inheriting body text falls below WCAG AA normal text
// contrast. This intentionally catches common artifact failures such as changing
// body to a light background while keeping the dark-kit light text variables.
function parseDeclarations(body) {
  const declarations = new Map();
  for (const part of body.split(";")) {
    const index = part.indexOf(":");
    if (index < 0) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    const value = part.slice(index + 1).trim();
    if (key && value) declarations.set(key, value);
  }
  return declarations;
}

function parseCssRules(cssText) {
  const rules = [];
  const clean = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of clean.matchAll(/([^{}@][^{}]*)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((selector) => selector.trim()).filter(Boolean);
    const declarations = parseDeclarations(match[2]);
    for (const selector of selectors) rules.push({ selector, declarations });
  }
  return rules;
}

function hexToRgb(value) {
  const normalized = value.trim().toLowerCase();
  const named = { white: "#ffffff", black: "#000000", transparent: "transparent" }[normalized] ?? normalized;
  if (named === "transparent") return undefined;
  const hex = named.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (!hex) return undefined;
  const full = hex.length === 3 ? hex.split("").map((char) => char + char).join("") : hex;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  };
}

function resolveCssValue(value, variables) {
  let current = value.trim();
  for (let i = 0; i < 6; i += 1) {
    const next = current.replace(/var\((--[A-Za-z0-9_-]+)\)/g, (_match, name) => variables.get(name) ?? "");
    if (next === current) break;
    current = next.trim();
  }
  const colorMix = current.match(/color-mix\([^,]+,\s*(#[0-9a-fA-F]{3,6}|var\(--[A-Za-z0-9_-]+\)|[A-Za-z]+)\s+\d+%/);
  if (colorMix) return resolveCssValue(colorMix[1], variables);
  return current;
}

function colorFromDeclaration(value, variables) {
  const resolved = resolveCssValue(value, variables);
  return hexToRgb(resolved);
}

function luminance(channel) {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(foreground, background) {
  const l1 = 0.2126 * luminance(foreground.r) + 0.7152 * luminance(foreground.g) + 0.0722 * luminance(foreground.b);
  const l2 = 0.2126 * luminance(background.r) + 0.7152 * luminance(background.g) + 0.0722 * luminance(background.b);
  const light = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (light + 0.05) / (dark + 0.05);
}

function formatRatio(value) {
  return Math.round(value * 100) / 100;
}

if (html) {
  const cssTexts = [];
  for (const match of html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const href = match[1];
    if (/^(?:https?:)?\/\//i.test(href)) continue;
    const cssPath = resolve(dirname(htmlPath), href);
    if (existsSync(cssPath)) cssTexts.push(readFileSync(cssPath, "utf8"));
  }
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) cssTexts.push(match[1]);

  const rules = cssTexts.flatMap(parseCssRules);
  const variables = new Map();
  for (const rule of rules) {
    if (rule.selector !== ":root") continue;
    for (const [property, value] of rule.declarations) {
      if (property.startsWith("--")) variables.set(property, value);
    }
  }

  const selectorDecls = new Map();
  for (const rule of rules) {
    const existing = selectorDecls.get(rule.selector) ?? new Map();
    for (const [property, value] of rule.declarations) existing.set(property, value);
    selectorDecls.set(rule.selector, existing);
  }

  const bodyDecls = selectorDecls.get("body.pk") ?? selectorDecls.get("body") ?? new Map();
  const bodyColor = bodyDecls.has("color") ? colorFromDeclaration(bodyDecls.get("color"), variables) : undefined;
  const bodyBackgroundValue = bodyDecls.get("background-color") ?? bodyDecls.get("background");
  const bodyBackground = bodyBackgroundValue ? colorFromDeclaration(bodyBackgroundValue, variables) : undefined;

  if (bodyColor && bodyBackground) {
    const ratio = contrastRatio(bodyColor, bodyBackground);
    if (ratio < 4.5) {
      failures.push(
        `body text/background contrast is ${formatRatio(ratio)}:1 (< 4.5:1); ` +
        "do not put light text on a light artifact background or dark text on a dark background"
      );
    }
  }

  for (const [selector, declarations] of selectorDecls) {
    const colorValue = declarations.get("color");
    const backgroundValue = declarations.get("background-color") ?? declarations.get("background");
    const foreground = colorValue ? colorFromDeclaration(colorValue, variables) : bodyColor;
    const background = backgroundValue ? colorFromDeclaration(backgroundValue, variables) : undefined;
    if (foreground && background) {
      const ratio = contrastRatio(foreground, background);
      if (ratio < 4.5) {
        failures.push(
          `CSS selector "${selector}" has text/background contrast ${formatRatio(ratio)}:1 (< 4.5:1); ` +
          "set an explicit readable text color for that background"
        );
      }
    }

    if (declarations.has("opacity")) {
      const opacity = Number(declarations.get("opacity"));
      if (Number.isFinite(opacity) && opacity > 0 && opacity < 0.55) {
        failures.push(
          `CSS selector "${selector}" uses opacity ${opacity}; dimmed review content must stay readable, use >= 0.55 or a non-opacity treatment`
        );
      }
    }
  }
}

// --- i. visual brief carries the plan-first required fields -------------------
// Presence-only gate: the brief must exist and contain each required field
// label with non-empty content. Quality of the answers is human judgment.
const briefPath = resolve(join(planDir, "data", "visual-brief.md"));
if (!existsSync(briefPath)) {
  failures.push(
    "missing data/visual-brief.md — write the brief before the HTML: " +
    "core outcome, main contradiction, " +
    "primary visual model, model justification"
  );
} else {
  const brief = readFileSync(briefPath, "utf8");
  const requiredFields = [
    ["Core outcome", /\*\*core outcome\*\*/i],
    ["Main contradiction", /\*\*main contradiction\*\*/i],
    ["Primary visual model", /\*\*primary visual model\*\*/i],
    ["Model justification", /\*\*model justification\*\*/i],
  ];
  for (const [label, pattern] of requiredFields) {
    const match = brief.match(pattern);
    if (!match) {
      failures.push(
        `visual-brief.md is missing the required field \"**${label}**\" — ` +
        "state the resulting plan and main contradiction before drawing"
      );
      continue;
    }
    const after = brief
      .slice(match.index + match[0].length, match.index + match[0].length + 400)
      .split(/\n\s*[-*]?\s*\*\*/)[0]
      .replace(/^[\s:*_()\u2014\u2013-]+|required|\(required\)/gi, "")
      .trim();
    if (!after) failures.push(`visual-brief.md field \"**${label}**\" is empty`);
  }
}

// --- j. structured comment hooks ---------------------------------------------
if (html) {
  const sectionTags = [...html.matchAll(/<(section|header)\b([^>]*)>/gi)];
  const scopedSections = sectionTags.filter((match) => /\bdata-comment-scope=["']section["']/i.test(match[2]));
  if (!scopedSections.length) {
    failures.push('index.html has no data-comment-scope="section" anchors for the engine directory and section comments');
  }
  const unscopedSections = sectionTags.filter((match) => match[1].toLowerCase() === "section" && !/\bdata-comment-scope=["']section["']/i.test(match[2]));
  if (unscopedSections.length) {
    failures.push(`${unscopedSections.length} section element(s) are missing data-comment-scope="section"`);
  }

  const invalidScopes = [...html.matchAll(/\bdata-comment-scope\s*=\s*("([^"]*)"|'([^']*)')/gi)]
    .map((match) => (match[2] ?? match[3] ?? "").trim())
    .filter((scope) => !["section", "item", "cell", "node"].includes(scope));
  if (invalidScopes.length) {
    failures.push(`invalid data-comment-scope value(s): ${[...new Set(invalidScopes)].join(", ")}`);
  }

  const reviewableObjectCount = (html.match(/<(?:article|tr|li|g)\b/gi) ?? []).length;
  const scopedObjectCount = (html.match(/\bdata-comment-scope=["'](?:item|cell|node)["']/gi) ?? []).length;
  if (reviewableObjectCount > 0 && scopedObjectCount === 0) {
    failures.push("index.html contains reviewable objects but no item/cell/node comment scopes");
  }
}

// --- k. validation closes the loop over risks ---------------------------------
// Existence/coverage only: a risk that no validation scenario
// references is flagged as a WARNING; whether the scenario is convincing is
// human judgment.
if (planData !== undefined) {
  const validation = Array.isArray(planData.validation) ? planData.validation : [];
  const riskIds = Array.isArray(planData.risks)
    ? planData.risks
        .filter((r) => r && typeof r === "object" && typeof r.id === "string" && r.id.trim())
        .map((r) => r.id.trim())
    : [];
  if (!validation.length) {
    if (riskIds.length) {
      warnings.push(
        "plan-data has no `validation` collection — risks have no " +
        "linked validation scenarios ([{ id, scenario, expected, refs }])"
      );
    }
  } else {
    const covered = new Set();
    for (const [index, entry] of validation.entries()) {
      const label = entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.trim()
        ? `validation.${entry.id.trim()}`
        : `validation[${index}]`;
      const entryRefs = entry && typeof entry === "object" && Array.isArray(entry.refs) ? entry.refs : [];
      if (!entryRefs.length) {
        warnings.push(
          `${label} lists no refs — link the risks/paths/invariants it gives evidence for`
        );
        continue;
      }
      for (const ref of entryRefs) {
        if (typeof ref !== "string" || !ref.trim()) continue;
        if (resolveRef(planData, ref) === undefined) {
          failures.push(`${label} ref \"${ref}\" does not resolve in plan-data`);
        } else {
          covered.add(ref.trim());
        }
      }
    }
    const uncoveredRisks = riskIds.filter((id) => !covered.has(`risks.${id}`));
    if (uncoveredRisks.length) {
      warnings.push(
        `${uncoveredRisks.map((id) => `risks.${id}`).join(", ")} ` +
        `${uncoveredRisks.length === 1 ? "is" : "are"} referenced by no validation entry`
      );
    }
  }
}

for (const warning of warnings) console.log(`WARNING: ${warning}`);
if (failures.length) {
  for (const failure of failures) console.log(`- ${failure}`);
  console.log(`FAIL: ${failures.length} check${failures.length === 1 ? "" : "s"} failed (see above)`);
  process.exit(1);
}
console.log(`PASS: ${resolvedCount} refs resolved, island consistent`);
