#!/usr/bin/env node
// plan-kit/diagram.mjs — compile plan-data topology into a static SVG diagram.
//
// Usage:
//   node diagram.mjs <planDir> --edges transitions [--nodes entities] [--out snippet.html]
//
// Edge contract: --edges resolves to an array of objects. Each edge must have
// string `from` and `to` endpoint ids. Optional fields: `id`, `label`, `title`,
// `trigger`, `kind` (`ok`, `fail`, `async`, or common aliases such as `happy`
// / `failure`), `async` (boolean), and `path` / `paths` for data-path output.
// Existing transition-shaped data with `trigger`, `guard`, and `effects` is
// supported; the label falls back to trigger, then id, then "from -> to".
//
// Node contract: nodes are inferred from every from/to endpoint. If --nodes is
// supplied, it may resolve to an array or object and supplements matching ids
// with title/name/label, status/category/kind (`ok|active|warn|fail`), meaning
// / notes, owner -> data-owner, and a direct data-ref. Inferred-only endpoint
// nodes still receive a resolvable data-ref by pointing at the first edge that
// mentions them.
//
// Zero dependencies. Data-ref resolution mirrors check.mjs and the review
// engine: object key, array index, or array element id.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const planDir = args[0];

if (!planDir || args.includes("-h") || args.includes("--help")) {
  usage(planDir ? 0 : 1);
}

const flags = parseFlags(args.slice(1));
const edgesRef = flags.edges;
const nodesRef = flags.nodes;

if (!edgesRef) {
  console.error("ERROR: missing --edges <data-ref>");
  usage(1);
}

const jsonPath = resolve(join(planDir, "data", "plan-data.json"));
if (!existsSync(jsonPath)) {
  console.error(`ERROR: missing ${jsonPath}`);
  process.exit(1);
}

let planData;
try {
  planData = JSON.parse(readFileSync(jsonPath, "utf8"));
} catch (error) {
  console.error(`ERROR: invalid JSON in ${jsonPath}: ${error.message}`);
  process.exit(1);
}

const edgesValue = resolveRef(planData, edgesRef);
if (!Array.isArray(edgesValue)) {
  console.error(`ERROR: --edges ${edgesRef} did not resolve to an array`);
  process.exit(1);
}

const edgeEntries = edgesValue
  .map((edge, index) => normalizeEdge(edge, index, edgesRef))
  .filter(Boolean);

if (!edgeEntries.length) {
  console.error(`ERROR: --edges ${edgesRef} contains no valid from/to edge objects`);
  process.exit(1);
}

const nodesValue = nodesRef ? resolveRef(planData, nodesRef) : undefined;
if (nodesRef && (nodesValue === undefined || nodesValue === null || typeof nodesValue !== "object")) {
  console.error(`ERROR: --nodes ${nodesRef} did not resolve to an array or object`);
  process.exit(1);
}

const nodeEntries = buildNodes(edgeEntries, nodesValue, nodesRef);
const layout = layoutGraph(nodeEntries, edgeEntries);
const html = renderDiagram(edgesRef, nodeEntries, edgeEntries, layout);

if (flags.out) writeFileSync(resolve(flags.out), html);
else process.stdout.write(html);

function usage(code) {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(
    "Usage: node diagram.mjs <planDir> --edges <data-ref> [--nodes <data-ref>] [--out snippet.html]\n"
  );
  process.exit(code);
}

function parseFlags(values) {
  const result = {};
  for (let i = 0; i < values.length; i += 1) {
    const arg = values[i];
    if (arg === "--edges" || arg === "--nodes" || arg === "--out") {
      const value = values[i + 1];
      if (!value || value.startsWith("--")) {
        console.error(`ERROR: ${arg} requires a value`);
        usage(1);
      }
      result[arg.slice(2)] = value;
      i += 1;
    } else {
      console.error(`ERROR: unknown argument ${arg}`);
      usage(1);
    }
  }
  return result;
}

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

function childRef(rootRef, value, index, key) {
  if (value && typeof value === "object" && typeof value.id === "string" && value.id) {
    return `${rootRef}.${value.id}`;
  }
  return `${rootRef}.${key ?? index}`;
}

function normalizeEdge(value, index, rootRef) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.from !== "string" || typeof value.to !== "string") return null;
  const id = typeof value.id === "string" && value.id ? value.id : `edge-${index + 1}`;
  return {
    raw: value,
    id,
    from: value.from,
    to: value.to,
    ref: childRef(rootRef, value, index),
    label: edgeLabel(value, id),
    className: edgeClassName(value),
    path: edgePathValue(value),
  };
}

function edgeLabel(edge, id) {
  if (typeof edge.label === "string" && edge.label) return edge.label;
  if (typeof edge.title === "string" && edge.title) return edge.title;
  if (typeof edge.trigger === "string" && edge.trigger) return `${id}: ${edge.trigger}`;
  return edge.id ? String(edge.id) : `${edge.from} -> ${edge.to}`;
}

function edgeClassName(edge) {
  const words = new Set(String(edge.kind ?? "").toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean));
  const classes = ["pk-edge"];
  if (edge.async === true || words.has("async") || words.has("asynchronous")) classes.push("async");
  if (words.has("ok") || words.has("happy") || words.has("success")) classes.push("ok");
  if (words.has("fail") || words.has("failure") || words.has("error") || words.has("rejected")) classes.push("fail");
  return classes.join(" ");
}

function edgePathValue(edge) {
  if (Array.isArray(edge.paths)) return edge.paths.filter(Boolean).join(" ");
  if (typeof edge.paths === "string") return edge.paths;
  if (typeof edge.path === "string") return edge.path;
  return "";
}

function buildNodes(edges, nodesValue, nodesRootRef) {
  const nodes = new Map();
  const ownerPalette = new Map();

  for (const edge of edges) {
    ensureNode(edge.from, edge.ref);
    ensureNode(edge.to, edge.ref);
  }

  if (Array.isArray(nodesValue)) {
    nodesValue.forEach((node, index) => mergeNode(node, childRef(nodesRootRef, node, index)));
  } else if (nodesValue && typeof nodesValue === "object") {
    Object.entries(nodesValue).forEach(([key, node]) => mergeNode(node, childRef(nodesRootRef, node, undefined, key), key));
  }

  let ownerIndex = 0;
  for (const node of nodes.values()) {
    if (!node.owner) continue;
    if (!ownerPalette.has(node.owner)) {
      ownerPalette.set(node.owner, ["a", "b", "c", "d"][ownerIndex % 4]);
      ownerIndex += 1;
    }
    node.ownerTone = ownerPalette.get(node.owner);
  }

  return Array.from(nodes.values());

  function ensureNode(id, fallbackRef) {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        ref: fallbackRef,
        title: id,
        subtitle: "",
        status: "",
        owner: "",
        ownerTone: "",
        order: nodes.size,
      });
    }
    return nodes.get(id);
  }

  function mergeNode(value, ref, objectKey) {
    if (!value || typeof value !== "object") return;
    const id = typeof value.id === "string" && value.id ? value.id : objectKey;
    if (!id) return;
    if (!nodes.has(id)) return;
    const node = ensureNode(id, ref);
    node.ref = ref;
    node.title = firstString(value.name, value.title, value.label, value.id) ?? id;
    node.subtitle = firstString(value.meaning, value.notes, value.description, value.summary) ?? "";
    node.status = normalizeStatus(firstString(value.status, value.category, value.kind, value.state));
    node.owner = firstString(value.owner, value.dataOwner, value["data-owner"]) ?? "";
  }
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim();
}

function normalizeStatus(value) {
  const status = String(value ?? "").toLowerCase();
  if (["ok", "active", "warn", "fail"].includes(status)) return status;
  if (["happy", "success", "passed", "settled"].includes(status)) return "ok";
  if (["warning", "degraded", "pending"].includes(status)) return "warn";
  if (["failure", "error", "failed", "invalid"].includes(status)) return "fail";
  return "";
}

function layoutGraph(nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) adjacency.get(edge.from)?.push(edge);

  const backEdges = findBackEdges(nodes, adjacency);
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (backEdges.has(edge.id)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const queue = nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .sort((a, b) => a.order - b.order);
  const topo = [];
  while (queue.length) {
    const node = queue.shift();
    topo.push(node);
    for (const edge of adjacency.get(node.id) ?? []) {
      if (backEdges.has(edge.id)) continue;
      const next = nodeById.get(edge.to);
      if (!next) continue;
      indegree.set(next.id, (indegree.get(next.id) ?? 0) - 1);
      if ((indegree.get(next.id) ?? 0) === 0) {
        queue.push(next);
        queue.sort((a, b) => a.order - b.order);
      }
    }
  }
  for (const node of nodes) if (!topo.includes(node)) topo.push(node);

  const layer = new Map(nodes.map((node) => [node.id, 0]));
  for (const node of topo) {
    for (const edge of adjacency.get(node.id) ?? []) {
      if (backEdges.has(edge.id)) continue;
      layer.set(edge.to, Math.max(layer.get(edge.to) ?? 0, (layer.get(edge.from) ?? 0) + 1));
    }
  }

  const layers = [];
  for (const node of nodes) {
    const index = layer.get(node.id) ?? 0;
    if (!layers[index]) layers[index] = [];
    layers[index].push(node);
  }

  sortLayers(layers, edges);

  const width = 1120;
  const marginX = 46;
  const labelPressure = Math.max(0, edges.length - nodes.length);
  const marginY = 36 + Math.min(80, labelPressure * 10);
  const nodeW = layers.length > 5 ? 156 : 184;
  const nodeH = 90;
  const usableW = width - marginX * 2 - nodeW;
  const gapX = layers.length <= 1 ? 0 : usableW / (layers.length - 1);
  const gapY = 30 + Math.min(28, labelPressure * 3);
  const maxRows = Math.max(...layers.map((items) => items.length), 1);
  let height = marginY * 2 + maxRows * nodeH + (maxRows - 1) * gapY;
  const positions = new Map();
  assignParallelOffsets(edges);

  layers.forEach((items, layerIndex) => {
    const usedH = items.length * nodeH + (items.length - 1) * gapY;
    const startY = marginY + Math.max(0, (height - marginY * 2 - usedH) / 2);
    items.forEach((node, rowIndex) => {
      positions.set(node.id, {
        x: marginX + layerIndex * gapX,
        y: startY + rowIndex * (nodeH + gapY),
        w: nodeW,
        h: nodeH,
      });
    });
  });

  const labels = assignEdgeLabels(edges, { width, height, positions, backEdges, marginX });
  height = Math.max(height, labels.height);

  return { width, height, positions, backEdges, labels: labels.byId };
}

function assignParallelOffsets(edges) {
  const groups = new Map();
  for (const edge of edges) {
    const key = `${edge.from}\u0000${edge.to}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
  }
  for (const group of groups.values()) {
    group.forEach((edge, index) => {
      edge.parallelIndex = index;
      edge.parallelTotal = group.length;
      edge.parallelOffset = index - (group.length - 1) / 2;
    });
  }
}

function findBackEdges(nodes, adjacency) {
  const state = new Map();
  const backEdges = new Set();

  for (const node of nodes) visit(node.id);
  return backEdges;

  function visit(id) {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") return;
    state.set(id, "visiting");
    for (const edge of adjacency.get(id) ?? []) {
      if (edge.from === edge.to || state.get(edge.to) === "visiting") {
        backEdges.add(edge.id);
        continue;
      }
      visit(edge.to);
    }
    state.set(id, "done");
  }
}

function sortLayers(layers, edges) {
  const byId = () => {
    const positions = new Map();
    layers.forEach((items) => items.forEach((node, index) => positions.set(node.id, index)));
    return positions;
  };
  for (let pass = 0; pass < 2; pass += 1) {
    let positions = byId();
    for (let i = 1; i < layers.length; i += 1) {
      layers[i].sort(compareByBarycenter(edges, positions, "from", "to"));
    }
    positions = byId();
    for (let i = layers.length - 2; i >= 0; i -= 1) {
      layers[i].sort(compareByBarycenter(edges, positions, "to", "from"));
    }
  }
}

function compareByBarycenter(edges, positions, neighborKey, ownKey) {
  return (a, b) => {
    const av = barycenter(a.id);
    const bv = barycenter(b.id);
    if (av !== bv) return av - bv;
    return a.order - b.order;
  };

  function barycenter(id) {
    const values = edges
      .filter((edge) => edge[ownKey] === id && positions.has(edge[neighborKey]))
      .map((edge) => positions.get(edge[neighborKey]));
    if (!values.length) return Number.MAX_SAFE_INTEGER;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
}

function renderDiagram(edgesRef, nodes, edges, layout) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const chunks = [];
  chunks.push(`<div class="pk-canvas" data-ref="${attr(edgesRef)}">`);
  chunks.push(`<svg viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="${attr(edgesRef)} topology">`);
  chunks.push("  <defs><marker id=\"pk-arrow\" viewBox=\"0 0 8 8\" refX=\"7\" refY=\"4\" markerWidth=\"7\" markerHeight=\"7\" orient=\"auto\"><path d=\"M0 0L8 4L0 8z\" fill=\"currentColor\"/></marker></defs>");
  chunks.push("  <g class=\"pk-diagram-edges\">");
  for (const edge of edges) chunks.push(renderEdge(edge, layout));
  chunks.push("  </g>");
  chunks.push("  <g class=\"pk-diagram-nodes\">");
  for (const node of nodes) chunks.push(renderNode(node, layout.positions.get(node.id), nodeById));
  chunks.push("  </g>");
  chunks.push("</svg>");
  chunks.push("</div>");
  return `${chunks.join("\n")}\n`;
}

function renderNode(node, pos) {
  const classes = ["pk-svg-node", node.status].filter(Boolean).join(" ");
  const ownerAttr = node.owner ? ` data-owner="${attr(node.owner)}"` : "";
  const ownerTone = node.ownerTone ? ` data-owner-tone="${attr(node.ownerTone)}"` : "";
  const stripe = node.ownerTone
    ? `<rect class="pk-svg-owner-stripe owner-${node.ownerTone}" x="${round(pos.x)}" y="${round(pos.y)}" width="5" height="${round(pos.h)}" rx="8"/>`
    : "";
  const titleLines = wrap(node.title, pos.w > 170 ? 22 : 18, 2);
  const subtitleLines = wrap(node.subtitle || node.id, pos.w > 170 ? 28 : 23, 2);
  const textLines = [];
  titleLines.forEach((line, index) => {
    textLines.push(`<text class="pk-svg-node-title" x="${round(pos.x + 14)}" y="${round(pos.y + 26 + index * 16)}">${text(line)}</text>`);
  });
  const subStart = pos.y + 50 + Math.max(0, titleLines.length - 1) * 16;
  subtitleLines.forEach((line, index) => {
    textLines.push(`<text class="pk-svg-node-subtitle" x="${round(pos.x + 14)}" y="${round(subStart + index * 14)}">${text(line)}</text>`);
  });

  return [
    `    <g class="${attr(classes)}" data-ref="${attr(node.ref)}" data-node="${attr(node.id)}"${ownerAttr}${ownerTone}>`,
    `      <title>${text(`${node.title}: ${node.subtitle || node.id}`)}</title>`,
    `      <rect x="${round(pos.x)}" y="${round(pos.y)}" width="${round(pos.w)}" height="${round(pos.h)}" rx="10"/>`,
    stripe ? `      ${stripe}` : "",
    ...textLines.map((line) => `      ${line}`),
    "    </g>",
  ].filter(Boolean).join("\n");
}

function renderEdge(edge, layout) {
  const from = layout.positions.get(edge.from);
  const to = layout.positions.get(edge.to);
  const isBack = layout.backEdges.has(edge.id);
  const path = edgePathD(from, to, isBack, edge.parallelOffset || 0);
  const labelBox = layout.labels.get(edge.id);
  const pathAttr = edge.path ? ` data-path="${attr(edge.path)}"` : "";
  const tspans = labelBox.lines.map((line, index) => {
    const y = labelBox.y + 16 + index * 13;
    return `<tspan x="${round(labelBox.x + 8)}" y="${round(y)}">${text(line)}</tspan>`;
  }).join("");

  return [
    `    <path class="${attr(edge.className)}" data-ref="${attr(edge.ref)}" data-transition="${attr(edge.id)}"${pathAttr} data-edge-role="${isBack ? "back" : "forward"}" d="${attr(path)}"/>`,
    `    <g class="pk-edge-label-box" data-ref="${attr(edge.ref)}" data-transition="${attr(edge.id)}"${pathAttr}>`,
    `      <rect x="${round(labelBox.x)}" y="${round(labelBox.y)}" width="${round(labelBox.w)}" height="${round(labelBox.h)}" rx="5"/>`,
    `      <text class="pk-edge-label">${tspans}</text>`,
    "    </g>",
  ].join("\n");
}

function assignEdgeLabels(edges, layout) {
  const nodeBoxes = Array.from(layout.positions.values()).map((pos) => padBox(pos, 2));
  const placed = [];
  const byId = new Map();

  const specs = edges.map((edge) => {
    const from = layout.positions.get(edge.from);
    const to = layout.positions.get(edge.to);
    const isBack = layout.backEdges.has(edge.id);
    const maxWidth = labelMaxWidth(from, to, layout.width);
    const lines = wrap(edge.label, Math.max(10, Math.floor((maxWidth - 16) / 7)), 4);
    const w = Math.max(72, Math.min(maxWidth, Math.max(...lines.map((line) => visualWidth(line) * 6.5 + 16), 72)));
    const h = Math.max(24, lines.length * 13 + 10);
    const anchor = labelPosition(from, to, isBack, edge.parallelOffset || 0, w, layout);
    return {
      edge,
      lines,
      w,
      h,
      desiredX: clamp(anchor.x, layout.marginX, layout.width - layout.marginX - w),
      desiredY: Math.max(12, anchor.y),
    };
  }).sort((a, b) => a.desiredX - b.desiredX || a.desiredY - b.desiredY || a.edge.id.localeCompare(b.edge.id));

  let height = layout.height;
  for (const spec of specs) {
    const box = placeLabel(spec, nodeBoxes, placed, layout.height);
    placed.push(box);
    byId.set(spec.edge.id, box);
    height = Math.max(height, box.y + box.h + 18);
  }

  return { byId, height };
}

function placeLabel(spec, nodeBoxes, placed, initialHeight) {
  const obstacles = nodeBoxes.concat(placed);
  const minY = 12;
  const step = 14;
  const maxSearchY = initialHeight + obstacles.length * step + 180;
  const candidates = [];
  for (let delta = 0; delta <= 140; delta += step) {
    candidates.push(spec.desiredY + delta);
    if (delta) candidates.push(spec.desiredY - delta);
  }
  for (let y = spec.desiredY + 154; y <= maxSearchY; y += step) candidates.push(y);

  for (const candidate of candidates) {
    const box = {
      edgeId: spec.edge.id,
      x: spec.desiredX,
      y: Math.max(minY, candidate),
      w: spec.w,
      h: spec.h,
      lines: spec.lines,
    };
    if (!obstacles.some((other) => intersects(box, other, 2))) return box;
  }

  return {
    edgeId: spec.edge.id,
    x: spec.desiredX,
    y: maxSearchY + placed.length * step,
    w: spec.w,
    h: spec.h,
    lines: spec.lines,
  };
}

function labelMaxWidth(from, to, svgWidth) {
  if (from.x === to.x && from.y === to.y) return Math.min(220, from.w + 70);
  const gap = from.x < to.x ? to.x - (from.x + from.w) : from.x - (to.x + to.w);
  if (gap > 0) return Math.max(78, Math.min(260, gap - 16));
  return Math.min(220, svgWidth * 0.22);
}

function padBox(pos, pad) {
  return {
    x: pos.x - pad,
    y: pos.y - pad,
    w: pos.w + pad * 2,
    h: pos.h + pad * 2,
  };
}

function intersects(a, b, pad = 0) {
  return !(
    a.x + a.w + pad <= b.x ||
    b.x + b.w + pad <= a.x ||
    a.y + a.h + pad <= b.y ||
    b.y + b.h + pad <= a.y
  );
}

function edgePathD(from, to, isBack, parallelOffset) {
  const offset = parallelOffset * 18;
  if (from.x === to.x && from.y === to.y) {
    const topLoop = from.y >= 76;
    const sy = topLoop ? from.y : from.y + from.h;
    const lift = topLoop ? -52 - Math.abs(offset) : 52 + Math.abs(offset);
    const sx = from.x + from.w * 0.72;
    const ex = from.x + from.w * 0.28;
    return `M ${round(sx)} ${round(sy)} C ${round(from.x + from.w)} ${round(sy + lift)}, ${round(from.x)} ${round(sy + lift)}, ${round(ex)} ${round(sy)}`;
  }
  if (isBack) {
    const sx = from.x;
    const sy = from.y + from.h * 0.52 + offset;
    const ex = to.x + to.w;
    const ey = to.y + to.h * 0.52 + offset;
    const lift = sy <= ey ? -84 : 84;
    return `M ${round(sx)} ${round(sy)} C ${round(sx - 80)} ${round(sy + lift)}, ${round(ex + 80)} ${round(ey + lift)}, ${round(ex)} ${round(ey)}`;
  }
  const sx = from.x + from.w;
  const sy = from.y + from.h / 2 + offset;
  const ex = to.x;
  const ey = to.y + to.h / 2 + offset;
  const dx = Math.max(40, Math.abs(ex - sx));
  return `M ${round(sx)} ${round(sy)} C ${round(sx + dx * 0.42)} ${round(sy)}, ${round(ex - dx * 0.42)} ${round(ey)}, ${round(ex)} ${round(ey)}`;
}

function labelPosition(from, to, isBack, parallelOffset, labelWidth, layout) {
  const offset = parallelOffset * 18;
  if (from.x === to.x && from.y === to.y) {
    return from.y >= 76
      ? { x: from.x + (from.w - labelWidth) / 2, y: Math.max(12, from.y - 44 + offset) }
      : { x: from.x + (from.w - labelWidth) / 2, y: from.y + from.h + 14 + offset };
  }
  if (isBack) {
    const left = Math.min(from.x, to.x);
    const right = Math.max(from.x + from.w, to.x + to.w);
    return {
      x: left + (right - left - labelWidth) / 2,
      y: Math.max(12, Math.min(from.y, to.y) - 52 + offset),
    };
  }
  const gapLeft = Math.min(from.x + from.w, to.x);
  const gapRight = Math.max(from.x + from.w, to.x);
  return {
    x: gapLeft + (gapRight - gapLeft - labelWidth) / 2,
    y: (from.y + to.y) / 2 + from.h / 2 - 20 + offset,
  };
}

function wrap(value, maxChars, maxLines) {
  const source = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!source) return [];
  const words = [];
  for (const word of source.includes(" ") ? source.split(" ") : [source]) {
    if (visualWidth(word) > maxChars) words.push(...chunkByVisualWidth(word, maxChars));
    else words.push(word);
  }
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (visualWidth(next) <= maxChars) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word;
    }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length && visualWidth(source) > visualWidth(lines.join(" "))) {
    lines[lines.length - 1] = trimLine(lines[lines.length - 1], maxChars - 3) + "...";
  }
  return lines;
}

function chunkByVisualWidth(value, size) {
  const chars = Array.from(value);
  const chunks = [];
  let chunk = "";
  for (const char of chars) {
    const next = `${chunk}${char}`;
    if (chunk && visualWidth(next) > size) {
      chunks.push(chunk);
      chunk = char;
    } else {
      chunk = next;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function trimLine(value, maxChars) {
  if (visualWidth(value) <= maxChars) return value;
  let result = "";
  for (const char of Array.from(value)) {
    if (visualWidth(`${result}${char}`) > maxChars) break;
    result += char;
  }
  return result;
}

function visualWidth(value) {
  return Array.from(String(value ?? "")).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 1.7 : 1), 0);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function attr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function text(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function round(value) {
  return Number(value.toFixed(1));
}
