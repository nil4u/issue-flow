// @ts-nocheck

const GRAPH_SECTION_TYPES = new Set([
  "architecture", "dependency-graph", "deployment", "runtime-flow", "data-flow",
  "state-machine", "rollout", "screen-flow", "component-tree", "implementation-dag",
])

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function text(value, fallback = "") {
  if (typeof value === "string" || typeof value === "number") return String(value).trim() || fallback
  return fallback
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function safeId(value, fallback) {
  return text(value, fallback).replace(/[^A-Za-z0-9_.:-]+/g, "-")
}

function jsonIsland(data) {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
}

function valueList(value) {
  if (Array.isArray(value)) return value.map((entry) => text(entry)).filter(Boolean)
  const single = text(value)
  return single ? [single] : []
}

function firstCollection(source, keys, fallback = keys[0]) {
  for (const key of keys) {
    if (Array.isArray(source[key])) return { key, items: source[key] }
  }
  return { key: fallback, items: [] }
}

function renderParagraphs(...values) {
  const paragraphs = values.flatMap(valueList)
  return paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")
}

function renderBadges(item) {
  const badges = [item.type, item.kind, item.status, item.owner, item.technology, item.protocol]
    .flatMap(valueList)
    .filter((value, index, values) => values.indexOf(value) === index)
  return badges.length ? `<div class="vp-badges">${badges.map((badge) => `<span>${escapeHtml(badge)}</span>`).join("")}</div>` : ""
}

function pathValues(item) {
  return valueList(item && (item.paths || item.path)).join(" ")
}

function renderPathFilters(section) {
  const declared = array(section.paths).map((entry, index) => {
    const item = record(entry)
    return { id: text(item.id, text(entry, String(index))), label: text(item.label || item.title || item.name, text(entry, String(index))) }
  }).filter((item) => item.id)
  const inferred = [...new Set([
    ...array(section.nodes || section.elements || section.states).flatMap((item) => valueList(item && (item.paths || item.path))),
    ...array(section.edges || section.relationships || section.transitions || section.messages).flatMap((item) => valueList(item && (item.paths || item.path))),
  ])].map((id) => ({ id, label: id }))
  const paths = declared.length ? declared : inferred
  return paths.length ? `<nav class="vp-path-filter" aria-label="路径筛选"><button type="button" data-vp-filter="">全部</button>${paths.map((path) => `<button type="button" data-vp-filter="${escapeHtml(path.id)}">${escapeHtml(path.label)}</button>`).join("")}</nav>` : ""
}

function sectionRef(section, index) {
  return `sections.${safeId(section.id, String(index))}`
}

function itemRef(baseRef, collection, item, index) {
  return `${baseRef}.${collection}.${safeId(item && item.id, String(index))}`
}

function renderSectionShell(section, index, body, kicker = "") {
  const id = safeId(section.id, `section-${index + 1}`)
  const title = text(section.title, text(section.name, `章节 ${index + 1}`))
  const ref = sectionRef(section, index)
  return `<section id="${escapeHtml(id)}" class="vp-section vp-section-${escapeHtml(text(section.type, "content"))}" data-comment-scope="section" data-comment-label="${escapeHtml(title)}" data-ref="${escapeHtml(ref)}">
    <header class="vp-section-head">${kicker ? `<span class="vp-kicker">${escapeHtml(kicker)}</span>` : ""}<h2>${escapeHtml(title)}</h2>${renderParagraphs(section.description)}</header>
    ${body}
  </section>`
}

function renderSummary(section, data, index) {
  const sources = [
    { value: section, ref: sectionRef(section, index) },
    { value: record(section.content), ref: `${sectionRef(section, index)}.content` },
    { value: record(data.core), ref: "core" },
  ]
  const fact = (keys) => {
    for (const source of sources) {
      for (const key of keys) {
        if (source.value[key] !== undefined && source.value[key] !== null && source.value[key] !== "") {
          return { value: source.value[key], ref: `${source.ref}.${key}` }
        }
      }
    }
    return undefined
  }
  const facts = [
    ["目标", fact(["outcome", "goal", "summary"])],
    ["关键矛盾", fact(["contradiction", "mainContradiction"])],
    ["边界", fact(["boundary", "scope"])],
    ["推荐路径", fact(["recommendation", "path"])],
  ].filter(([, item]) => item)
  const body = `<div class="vp-summary-grid">${facts.map(([label, item]) => `<article class="vp-summary-card" data-comment-scope="item" data-ref="${escapeHtml(item.ref)}"><span>${escapeHtml(label)}</span>${renderParagraphs(item.value)}</article>`).join("")}</div>`
  return renderSectionShell(section, index, body, "核心方案")
}

function graphLayers(nodes, edges) {
  const ids = nodes.map((node, index) => safeId(node.id, String(index)))
  const idSet = new Set(ids)
  const indegree = new Map(ids.map((id) => [id, 0]))
  const outgoing = new Map(ids.map((id) => [id, []]))
  for (const edge of edges) {
    const source = text(edge.sourceId || edge.from || edge.source)
    const target = text(edge.destinationId || edge.to || edge.target)
    if (!idSet.has(source) || !idSet.has(target) || source === target) continue
    outgoing.get(source).push(target)
    indegree.set(target, (indegree.get(target) || 0) + 1)
  }
  const queue = ids.filter((id) => indegree.get(id) === 0)
  const layer = new Map(ids.map((id) => [id, 0]))
  const visited = new Set()
  while (queue.length) {
    const current = queue.shift()
    visited.add(current)
    for (const target of outgoing.get(current) || []) {
      layer.set(target, Math.max(layer.get(target) || 0, (layer.get(current) || 0) + 1))
      indegree.set(target, indegree.get(target) - 1)
      if (indegree.get(target) === 0) queue.push(target)
    }
  }
  ids.filter((id) => !visited.has(id)).forEach((id, index) => layer.set(id, index % Math.max(1, Math.ceil(Math.sqrt(ids.length)))))
  return layer
}

const GRAPH_NODE_WIDTH = 210
const GRAPH_NODE_HEIGHT = 92

function layeredGraphLayout(nodes, edges) {
  const layers = graphLayers(nodes, edges)
  const grouped = new Map()
  nodes.forEach((node, nodeIndex) => {
    const id = safeId(node.id, String(nodeIndex))
    const layer = layers.get(id) || 0
    if (!grouped.has(layer)) grouped.set(layer, [])
    grouped.get(layer).push({ node, nodeIndex, id })
  })
  const layerEntries = [...grouped.entries()].sort((left, right) => left[0] - right[0])
  const width = Math.max(820, layerEntries.length * 270 + 100)
  const maxRows = Math.max(...layerEntries.map(([, entries]) => entries.length), 1)
  const height = Math.max(320, maxRows * 150 + 100)
  const positions = new Map()
  for (const [layer, entries] of layerEntries) {
    const rowGap = (height - 100) / Math.max(entries.length, 1)
    entries.forEach((entry, row) => positions.set(entry.id, {
      x: 50 + layer * 270,
      y: 50 + row * rowGap,
      width: GRAPH_NODE_WIDTH,
      height: GRAPH_NODE_HEIGHT,
      entry,
    }))
  }
  return { strategy: "layered", width, height, positions }
}

function treeGraphLayout(nodes, edges) {
  const layers = graphLayers(nodes, edges)
  const grouped = new Map()
  nodes.forEach((node, nodeIndex) => {
    const id = safeId(node.id, String(nodeIndex))
    const layer = layers.get(id) || 0
    if (!grouped.has(layer)) grouped.set(layer, [])
    grouped.get(layer).push({ node, nodeIndex, id })
  })
  const layerEntries = [...grouped.entries()].sort((left, right) => left[0] - right[0])
  const maxColumns = Math.max(...layerEntries.map(([, entries]) => entries.length), 1)
  const width = Math.max(820, maxColumns * 250 + 100)
  const height = Math.max(360, layerEntries.length * 170 + 80)
  const positions = new Map()
  layerEntries.forEach(([, entries], layerIndex) => {
    const columnWidth = (width - 100) / Math.max(entries.length, 1)
    entries.forEach((entry, columnIndex) => positions.set(entry.id, {
      x: 50 + columnIndex * columnWidth + Math.max(0, (columnWidth - GRAPH_NODE_WIDTH) / 2),
      y: 45 + layerIndex * 170,
      width: GRAPH_NODE_WIDTH,
      height: GRAPH_NODE_HEIGHT,
      entry,
    }))
  })
  return { strategy: "tree", width, height, positions }
}

function stateGraphLayout(nodes) {
  const width = Math.max(820, Math.min(1180, nodes.length * 150 + 280))
  const height = Math.max(480, Math.min(760, nodes.length * 90 + 260))
  const centerX = width / 2
  const centerY = height / 2
  const radiusX = Math.max(180, width / 2 - 170)
  const radiusY = Math.max(130, height / 2 - 120)
  const positions = new Map()
  nodes.forEach((node, nodeIndex) => {
    const id = safeId(node.id, String(nodeIndex))
    const angle = nodes.length === 1 ? -Math.PI / 2 : -Math.PI / 2 + nodeIndex * Math.PI * 2 / nodes.length
    positions.set(id, {
      x: centerX + Math.cos(angle) * radiusX - GRAPH_NODE_WIDTH / 2,
      y: centerY + Math.sin(angle) * radiusY - GRAPH_NODE_HEIGHT / 2,
      width: GRAPH_NODE_WIDTH,
      height: GRAPH_NODE_HEIGHT,
      entry: { node, nodeIndex, id },
    })
  })
  return { strategy: "state", width, height, positions }
}

function rolloutGraphLayout(nodes, edges) {
  const layers = graphLayers(nodes, edges)
  const ordered = nodes.map((node, nodeIndex) => ({ node, nodeIndex, id: safeId(node.id, String(nodeIndex)) }))
    .sort((left, right) => (layers.get(left.id) || 0) - (layers.get(right.id) || 0) || left.nodeIndex - right.nodeIndex)
  const columns = Math.min(4, Math.max(1, ordered.length))
  const rows = Math.ceil(ordered.length / columns)
  const width = Math.max(820, columns * 260 + 80)
  const height = Math.max(320, rows * 155 + 100)
  const positions = new Map()
  ordered.forEach((entry, orderedIndex) => {
    const row = Math.floor(orderedIndex / columns)
    const logicalColumn = orderedIndex % columns
    const column = row % 2 === 0 ? logicalColumn : columns - logicalColumn - 1
    positions.set(entry.id, {
      x: 50 + column * 260,
      y: 50 + row * 155,
      width: GRAPH_NODE_WIDTH,
      height: GRAPH_NODE_HEIGHT,
      entry,
    })
  })
  return { strategy: "rollout", width, height, positions }
}

function boundaryGraphLayout(section, nodes) {
  const groupCollection = firstCollection(section, ["groups", "boundaries"])
  if (!groupCollection.items.length) return undefined
  const declaredIds = groupCollection.items.map((group, index) => safeId(group.id, String(index)))
  const columns = [...declaredIds, "__ungrouped__"]
    .map((id) => ({
      id,
      entries: nodes.map((node, nodeIndex) => ({ node, nodeIndex, id: safeId(node.id, String(nodeIndex)) }))
        .filter((entry) => text(entry.node.groupId || entry.node.group, "__ungrouped__") === id),
    }))
    .filter((column) => column.entries.length)
  const width = Math.max(820, columns.length * 285 + 90)
  const maxRows = Math.max(...columns.map((column) => column.entries.length), 1)
  const height = Math.max(360, maxRows * 135 + 130)
  const positions = new Map()
  columns.forEach((column, columnIndex) => {
    column.entries.forEach((entry, rowIndex) => positions.set(entry.id, {
      x: 65 + columnIndex * 285,
      y: 75 + rowIndex * 135,
      width: GRAPH_NODE_WIDTH,
      height: GRAPH_NODE_HEIGHT,
      entry,
    }))
  })
  return { strategy: "boundary", width, height, positions }
}

function graphLayout(section, nodes, edges) {
  const type = text(section.type)
  if (type === "deployment") return boundaryGraphLayout(section, nodes) || layeredGraphLayout(nodes, edges)
  if (type === "state-machine") return stateGraphLayout(nodes)
  if (type === "component-tree") return treeGraphLayout(nodes, edges)
  if (type === "rollout") return rolloutGraphLayout(nodes, edges)
  return layeredGraphLayout(nodes, edges)
}

function graphLayoutLabel(strategy) {
  return ({ layered: "分层拓扑", boundary: "部署边界", state: "状态循环", tree: "层级结构", rollout: "发布阶段" })[strategy] || "关系图"
}

function graphEdgePath(source, target) {
  if (source === target) {
    const x = source.x + source.width
    const y = source.y + source.height / 2
    return `M ${x} ${y} C ${x + 70} ${y - 75}, ${x + 70} ${y + 75}, ${x} ${y + 8}`
  }
  const sourceCenterX = source.x + source.width / 2
  const sourceCenterY = source.y + source.height / 2
  const targetCenterX = target.x + target.width / 2
  const targetCenterY = target.y + target.height / 2
  const dx = targetCenterX - sourceCenterX
  const dy = targetCenterY - sourceCenterY
  if (Math.abs(dx) >= Math.abs(dy)) {
    const x1 = dx >= 0 ? source.x + source.width : source.x
    const x2 = dx >= 0 ? target.x : target.x + target.width
    const bend = Math.max(45, Math.abs(x2 - x1) / 2)
    return `M ${x1} ${sourceCenterY} C ${x1 + Math.sign(dx || 1) * bend} ${sourceCenterY}, ${x2 - Math.sign(dx || 1) * bend} ${targetCenterY}, ${x2} ${targetCenterY}`
  }
  const y1 = dy >= 0 ? source.y + source.height : source.y
  const y2 = dy >= 0 ? target.y : target.y + target.height
  const bend = Math.max(40, Math.abs(y2 - y1) / 2)
  return `M ${sourceCenterX} ${y1} C ${sourceCenterX} ${y1 + Math.sign(dy || 1) * bend}, ${targetCenterX} ${y2 - Math.sign(dy || 1) * bend}, ${targetCenterX} ${y2}`
}

function wrapLabel(value, max = 18) {
  const source = text(value)
  if (!source) return []
  const result = []
  for (let index = 0; index < source.length; index += max) result.push(source.slice(index, index + max))
  return result.slice(0, 3)
}

function renderGraph(section, index) {
  const nodeCollection = firstCollection(section, ["nodes", "elements", "states", "screens", "tasks"])
  const edgeCollection = firstCollection(section, ["edges", "relationships", "transitions", "connections"])
  const nodes = nodeCollection.items
  const edges = edgeCollection.items
  if (!nodes.length) return renderSectionShell(section, index, `<div class="vp-empty">没有可展示的节点</div>`, text(section.type))
  const baseRef = sectionRef(section, index)
  const { strategy, width, height, positions } = graphLayout(section, nodes, edges)
  const markerId = `vp-arrow-${safeId(section.id, String(index))}`
  const groupCollection = firstCollection(section, ["groups", "boundaries"])
  const groupSvg = groupCollection.items.map((group, groupIndex) => {
    const groupId = safeId(group.id, String(groupIndex))
    const members = [...positions.values()].filter(({ entry }) => text(entry.node.groupId || entry.node.group) === groupId)
    if (!members.length) return ""
    const minX = Math.min(...members.map((item) => item.x)) - 24
    const minY = Math.min(...members.map((item) => item.y)) - 34
    const maxX = Math.max(...members.map((item) => item.x + item.width)) + 24
    const maxY = Math.max(...members.map((item) => item.y + item.height)) + 24
    return `<g class="vp-boundary" data-comment-scope="item" data-ref="${escapeHtml(itemRef(baseRef, groupCollection.key, group, groupIndex))}"><rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" rx="18"/><text x="${minX + 14}" y="${minY + 21}">${escapeHtml(text(group.label || group.title || group.name, groupId))}</text></g>`
  }).join("")
  const edgeSvg = edges.map((edge, edgeIndex) => {
    const sourceId = text(edge.sourceId || edge.from || edge.source)
    const targetId = text(edge.destinationId || edge.to || edge.target)
    const source = positions.get(sourceId)
    const target = positions.get(targetId)
    if (!source || !target) return ""
    const path = graphEdgePath(source, target)
    const relationLabel = text(edge.label || edge.description || edge.trigger || edge.name)
    const protocol = text(edge.protocol || edge.technology)
    const label = [relationLabel, protocol].filter(Boolean).join(" · ")
    const kind = text(edge.kind || edge.style || edge.status, "default")
    const labelX = (source.x + source.width / 2 + target.x + target.width / 2) / 2
    const labelY = (source.y + source.height / 2 + target.y + target.height / 2) / 2 - 8
    return `<g class="vp-edge vp-edge-${escapeHtml(kind)}" data-vp-paths="${escapeHtml(pathValues(edge))}" data-ref="${escapeHtml(itemRef(baseRef, edgeCollection.key, edge, edgeIndex))}"><path d="${path}" marker-end="url(#${markerId})"/><title>${escapeHtml(label)}</title>${label ? `<text x="${labelX}" y="${labelY}">${escapeHtml(label)}</text>` : ""}</g>`
  }).join("")
  const nodeSvg = [...positions.values()].map(({ x, y, width: nodeWidth, height: nodeHeight, entry }) => {
    const { node, nodeIndex } = entry
    const title = text(node.name || node.title || node.label, entry.id)
    const lines = wrapLabel(title)
    const description = text(node.description || node.responsibility || node.summary)
    const kind = text(node.type || node.kind || node.status, "node")
    return `<g class="vp-node vp-node-${escapeHtml(kind)}" transform="translate(${x} ${y})" data-vp-paths="${escapeHtml(pathValues(node))}" data-comment-scope="node" data-comment-label="${escapeHtml(title)}" data-ref="${escapeHtml(itemRef(baseRef, nodeCollection.key, node, nodeIndex))}">
      <rect width="${nodeWidth}" height="${nodeHeight}" rx="14"/><text class="vp-node-kind" x="16" y="20">${escapeHtml(kind)}</text>
      ${lines.map((line, lineIndex) => `<text class="vp-node-title" x="16" y="${43 + lineIndex * 18}">${escapeHtml(line)}</text>`).join("")}
      <title>${escapeHtml([title, description, text(node.technology)].filter(Boolean).join(" · "))}</title>
    </g>`
  }).join("")
  const legendKinds = [...new Set(nodes.map((node) => text(node.type || node.kind || node.status)).filter(Boolean))]
  const body = `${renderPathFilters(section)}<div class="vp-diagram-wrap"><svg class="vp-diagram" data-layout="${strategy}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(text(section.title, "架构图"))}"><defs><marker id="${markerId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>${groupSvg}${edgeSvg}${nodeSvg}</svg></div>${legendKinds.length ? `<div class="vp-legend">${legendKinds.map((kind) => `<span><i></i>${escapeHtml(kind)}</span>`).join("")}</div>` : ""}`
  return renderSectionShell(section, index, body, graphLayoutLabel(strategy))
}

function renderSequence(section, index) {
  const participantCollection = firstCollection(section, ["participants", "actors"])
  const messageCollection = firstCollection(section, ["messages", "steps"])
  const participants = participantCollection.items
  const messages = messageCollection.items
  const baseRef = sectionRef(section, index)
  if (!participants.length) return renderSectionShell(section, index, `<div class="vp-empty">没有参与者</div>`, "时序图")
  const width = Math.max(820, participants.length * 190 + 80)
  const height = Math.max(320, messages.length * 74 + 150)
  const markerId = `vp-sequence-arrow-${safeId(section.id, String(index))}`
  const position = new Map(participants.map((participant, participantIndex) => [safeId(participant.id, String(participantIndex)), 70 + participantIndex * ((width - 140) / Math.max(participants.length - 1, 1))]))
  const participantSvg = participants.map((participant, participantIndex) => {
    const id = safeId(participant.id, String(participantIndex))
    const x = position.get(id)
    const name = text(participant.name || participant.label || participant.title, id)
    return `<g data-comment-scope="node" data-ref="${escapeHtml(itemRef(baseRef, participantCollection.key, participant, participantIndex))}"><rect class="vp-sequence-person" x="${x - 70}" y="24" width="140" height="52" rx="12"/><text class="vp-sequence-title" x="${x}" y="56" text-anchor="middle">${escapeHtml(name)}</text><line class="vp-lifeline" x1="${x}" y1="76" x2="${x}" y2="${height - 35}"/></g>`
  }).join("")
  const messageSvg = messages.map((message, messageIndex) => {
    const sourceId = text(message.sourceId || message.from || message.source)
    const targetId = text(message.destinationId || message.to || message.target)
    const x1 = position.get(sourceId)
    const x2 = position.get(targetId)
    if (x1 === undefined || x2 === undefined) return ""
    const y = 112 + messageIndex * 66
    const label = text(message.label || message.description || message.name, `步骤 ${messageIndex + 1}`)
    const dashed = message.async === true || /async|event|callback/i.test(text(message.kind || message.style))
    return `<g class="vp-sequence-message" data-vp-paths="${escapeHtml(pathValues(message))}" data-comment-scope="item" data-ref="${escapeHtml(itemRef(baseRef, messageCollection.key, message, messageIndex))}"><text x="${(x1 + x2) / 2}" y="${y - 10}" text-anchor="middle">${escapeHtml(`${messageIndex + 1}. ${label}`)}</text><line class="${dashed ? "is-dashed" : ""}" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" marker-end="url(#${markerId})"/></g>`
  }).join("")
  const messageIndexById = new Map(messages.map((message, messageIndex) => [safeId(message.id, String(messageIndex)), messageIndex]))
  const fragmentCollection = firstCollection(section, ["fragments"])
  const fragmentSvg = fragmentCollection.items.map((fragment, fragmentIndex) => {
    const start = messageIndexById.get(text(fragment.startId || fragment.from)) ?? (Number(fragment.startIndex) || 0)
    const end = messageIndexById.get(text(fragment.endId || fragment.to)) ?? (Number(fragment.endIndex) || start)
    const y = 84 + Math.min(start, end) * 66
    const fragmentHeight = Math.max(58, (Math.abs(end - start) + 1) * 66)
    return `<g class="vp-sequence-fragment" data-comment-scope="item" data-ref="${escapeHtml(itemRef(baseRef, fragmentCollection.key, fragment, fragmentIndex))}"><rect x="28" y="${y}" width="${width - 56}" height="${fragmentHeight}" rx="10"/><text x="42" y="${y + 20}">${escapeHtml(text(fragment.type || fragment.kind, "group"))}: ${escapeHtml(text(fragment.label || fragment.title || fragment.name))}</text></g>`
  }).join("")
  return renderSectionShell(section, index, `${renderPathFilters(section)}<div class="vp-diagram-wrap"><svg class="vp-sequence" viewBox="0 0 ${width} ${height}"><defs><marker id="${markerId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z"/></marker></defs>${fragmentSvg}${participantSvg}${messageSvg}</svg></div>`, "运行时交互")
}

function renderSwimlane(section, index) {
  const lanes = array(section.lanes)
  const baseRef = sectionRef(section, index)
  const body = `<div class="vp-lanes">${lanes.map((lane, laneIndex) => {
    const laneRef = itemRef(baseRef, "lanes", lane, laneIndex)
    const steps = firstCollection(lane, ["steps", "items"])
    return `<article class="vp-lane" data-comment-scope="item" data-ref="${escapeHtml(laneRef)}"><header><span>${escapeHtml(text(lane.owner || lane.role || lane.name, `泳道 ${laneIndex + 1}`))}</span>${renderParagraphs(lane.description)}</header><div class="vp-lane-steps">${steps.items.map((step, stepIndex) => `<div class="vp-step" data-comment-scope="item" data-ref="${escapeHtml(itemRef(laneRef, steps.key, step, stepIndex))}"><strong>${escapeHtml(text(step.title || step.name || step.label, `步骤 ${stepIndex + 1}`))}</strong>${renderParagraphs(step.description || step.action)}${renderBadges(step)}</div>`).join("")}</div></article>`
  }).join("")}</div>`
  return renderSectionShell(section, index, body, "责任与协作")
}

function renderMatrix(section, index) {
  const columns = array(section.columns).map((column, columnIndex) => record(column).id ? record(column) : { id: String(columnIndex), label: text(column) })
  const rowCollection = firstCollection(section, ["rows", "items"])
  const rows = rowCollection.items
  const baseRef = sectionRef(section, index)
  const body = `<div class="vp-table-wrap"><table class="vp-matrix"><thead><tr><th>${escapeHtml(text(section.rowHeader, "项目"))}</th>${columns.map((column) => `<th>${escapeHtml(text(column.label || column.title || column.name, column.id))}</th>`).join("")}</tr></thead><tbody>${rows.map((row, rowIndex) => {
    const rowRef = itemRef(baseRef, rowCollection.key, row, rowIndex)
    const cells = array(row.cells || row.values)
    return `<tr data-comment-scope="item" data-ref="${escapeHtml(rowRef)}"><th>${escapeHtml(text(row.label || row.title || row.name, `行 ${rowIndex + 1}`))}</th>${columns.map((column, columnIndex) => {
      const raw = cells[columnIndex] ?? record(row.values)[column.id] ?? row[column.id]
      const cell = record(raw)
      const value = Object.keys(cell).length ? text(cell.label || cell.value || cell.status || cell.description) : text(raw)
      const tone = text(cell.tone || cell.status || cell.kind, "neutral")
      const cellRef = Array.isArray(row.cells)
        ? `${rowRef}.cells.${columnIndex}`
        : row.values && typeof row.values === "object"
          ? `${rowRef}.values.${safeId(column.id, String(columnIndex))}`
          : `${rowRef}.${safeId(column.id, String(columnIndex))}`
      return `<td class="tone-${escapeHtml(tone)}" data-comment-scope="cell" data-ref="${escapeHtml(cellRef)}">${escapeHtml(value || "—")}</td>`
    }).join("")}</tr>`
  }).join("")}</tbody></table></div>`
  return renderSectionShell(section, index, body, text(section.variant, "矩阵"))
}

function renderTimeline(section, index) {
  const itemCollection = firstCollection(section, ["items", "steps", "phases"])
  const items = itemCollection.items
  const baseRef = sectionRef(section, index)
  const body = `<ol class="vp-timeline">${items.map((item, itemIndex) => `<li data-comment-scope="item" data-ref="${escapeHtml(itemRef(baseRef, itemCollection.key, item, itemIndex))}"><span class="vp-timeline-index">${itemIndex + 1}</span><div><strong>${escapeHtml(text(item.title || item.name || item.label, `阶段 ${itemIndex + 1}`))}</strong>${renderParagraphs(item.description || item.action || item.outcome)}${renderBadges(item)}</div></li>`).join("")}</ol>`
  return renderSectionShell(section, index, body, text(section.variant, "实施顺序"))
}

function renderTreeNodes(items, baseRef, collectionKey = "items", depth = 0) {
  return `<ul class="vp-tree depth-${depth}">${items.map((item, index) => {
    const ref = itemRef(baseRef, collectionKey, item, index)
    const children = array(item.children || item.items)
    const childKey = Array.isArray(item.children) ? "children" : "items"
    return `<li data-comment-scope="item" data-ref="${escapeHtml(ref)}"><div class="vp-tree-node"><strong>${escapeHtml(text(item.title || item.name || item.label, item.id || `节点 ${index + 1}`))}</strong>${renderParagraphs(item.description)}${renderBadges(item)}</div>${children.length ? renderTreeNodes(children, ref, childKey, depth + 1) : ""}</li>`
  }).join("")}</ul>`
}

function renderTree(section, index) {
  const itemCollection = firstCollection(section, ["items", "nodes"])
  return renderSectionShell(section, index, renderTreeNodes(itemCollection.items, sectionRef(section, index), itemCollection.key), text(section.variant, "结构树"))
}

function renderErd(section, index) {
  const entityCollection = firstCollection(section, ["entities", "items"])
  const entities = entityCollection.items
  const baseRef = sectionRef(section, index)
  const body = `<div class="vp-entity-grid">${entities.map((entity, entityIndex) => {
    const entityRef = itemRef(baseRef, entityCollection.key, entity, entityIndex)
    const fields = firstCollection(entity, ["fields", "columns"])
    return `<article class="vp-entity" data-comment-scope="item" data-ref="${escapeHtml(entityRef)}"><header><strong>${escapeHtml(text(entity.name || entity.title, entity.id || `Entity ${entityIndex + 1}`))}</strong>${renderBadges(entity)}</header><ul>${fields.items.map((field, fieldIndex) => `<li data-comment-scope="cell" data-ref="${escapeHtml(itemRef(entityRef, fields.key, field, fieldIndex))}"><code>${escapeHtml(text(field.name || field.label, field.id || `field_${fieldIndex + 1}`))}</code><span>${escapeHtml(text(field.type || field.dataType))}</span>${field.primaryKey ? "<b>PK</b>" : ""}${field.required ? "<b>必填</b>" : ""}</li>`).join("")}</ul></article>`
  }).join("")}</div>`
  return renderSectionShell(section, index, body, "数据模型")
}

function renderCards(section, index) {
  const itemCollection = firstCollection(section, ["items", "changes", "risks", "validations", "contracts", "evidence", "steps"])
  const items = itemCollection.items
  const baseRef = sectionRef(section, index)
  const body = `<div class="vp-card-grid">${items.map((item, itemIndex) => `<article class="vp-card" data-comment-scope="item" data-ref="${escapeHtml(itemRef(baseRef, itemCollection.key, item, itemIndex))}"><header><strong>${escapeHtml(text(item.title || item.name || item.label || item.path || item.scenario, item.id || `项目 ${itemIndex + 1}`))}</strong>${renderBadges(item)}</header>${renderParagraphs(item.description || item.summary || item.action || item.change || item.expected || item.mitigation || item.reason)}${valueList(item.details || item.criteria || item.checks).length ? `<ul>${valueList(item.details || item.criteria || item.checks).map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul>` : ""}${item.refs ? `<footer>关联：${valueList(item.refs).map((ref) => `<code>${escapeHtml(ref)}</code>`).join(" ")}</footer>` : ""}</article>`).join("")}</div>`
  return renderSectionShell(section, index, body, text(section.variant || section.type, "结构化内容"))
}

function renderWireframe(section, index) {
  const screenCollection = firstCollection(section, ["screens", "items"])
  const screens = screenCollection.items
  const baseRef = sectionRef(section, index)
  const body = `<div class="vp-screen-grid">${screens.map((screen, screenIndex) => {
    const screenRef = itemRef(baseRef, screenCollection.key, screen, screenIndex)
    const regions = firstCollection(screen, ["regions", "components"])
    return `<article class="vp-screen" data-comment-scope="item" data-ref="${escapeHtml(screenRef)}"><header><i></i><i></i><i></i><strong>${escapeHtml(text(screen.title || screen.name, `页面 ${screenIndex + 1}`))}</strong></header><div class="vp-screen-body">${regions.items.map((region, regionIndex) => `<div class="vp-screen-region" data-comment-scope="item" data-ref="${escapeHtml(itemRef(screenRef, regions.key, region, regionIndex))}"><strong>${escapeHtml(text(region.title || region.name || region.label, `区域 ${regionIndex + 1}`))}</strong>${renderParagraphs(region.description)}</div>`).join("")}</div></article>`
  }).join("")}</div>`
  return renderSectionShell(section, index, body, "界面结构")
}

const CHART_COLORS = ["#4f46e5", "#0f766e", "#b45309", "#be123c", "#0369a1", "#7e22ce", "#475569", "#15803d"]

function chartItems(section, baseRef) {
  const itemCollection = firstCollection(section, ["items", "series", "data"])
  const items = itemCollection.items.map((raw, itemIndex) => {
    const item = record(raw)
    const value = Number(item.value ?? raw)
    if (!Number.isFinite(value)) return undefined
    return {
      item,
      itemIndex,
      label: text(item.label || item.name, `数据 ${itemIndex + 1}`),
      value,
      ref: itemRef(baseRef, itemCollection.key, item, itemIndex),
    }
  }).filter(Boolean)
  return items
}

function renderHorizontalBarChart(items) {
  const max = Math.max(...items.map((item) => Math.abs(item.value)), 1)
  return `<div class="vp-bars">${items.map((item) => `<div class="vp-bar-row" data-comment-scope="item" data-ref="${escapeHtml(item.ref)}"><span>${escapeHtml(item.label)}</span><div><i style="width:${Math.max(1, Math.abs(item.value) / max * 100)}%"></i></div><strong>${escapeHtml(item.value)}</strong></div>`).join("")}</div>`
}

function renderColumnChart(items) {
  const max = Math.max(...items.map((item) => Math.abs(item.value)), 1)
  return `<div class="vp-columns">${items.map((item) => `<div class="vp-column" data-comment-scope="item" data-ref="${escapeHtml(item.ref)}"><strong>${escapeHtml(item.value)}</strong><div><i style="height:${Math.max(2, Math.abs(item.value) / max * 100)}%"></i></div><span>${escapeHtml(item.label)}</span></div>`).join("")}</div>`
}

function chartPointLayout(items, width = 900, height = 340) {
  const values = items.map((item) => item.value)
  const min = Math.min(...values, 0)
  const max = Math.max(...values, 0)
  const range = Math.max(max - min, 1)
  return items.map((item, itemIndex) => ({
    ...item,
    x: 60 + itemIndex * (width - 120) / Math.max(items.length - 1, 1),
    y: 35 + (max - item.value) / range * (height - 100),
  }))
}

function renderLineChart(items, area = false) {
  const width = 900
  const height = 340
  const points = chartPointLayout(items, width, height)
  const line = points.map((point, pointIndex) => `${pointIndex ? "L" : "M"} ${point.x} ${point.y}`).join(" ")
  const areaPath = area && points.length ? `${line} L ${points.at(-1).x} ${height - 45} L ${points[0].x} ${height - 45} Z` : ""
  return `<div class="vp-diagram-wrap"><svg class="vp-chart-svg" data-chart="${area ? "area" : "line"}" viewBox="0 0 ${width} ${height}" role="img">${areaPath ? `<path class="vp-chart-area" d="${areaPath}"/>` : ""}<path class="vp-chart-line" d="${line}"/>${points.map((point) => `<g class="vp-chart-point" data-comment-scope="item" data-ref="${escapeHtml(point.ref)}"><circle cx="${point.x}" cy="${point.y}" r="6"/><text x="${point.x}" y="${point.y - 13}" text-anchor="middle">${escapeHtml(point.value)}</text><text x="${point.x}" y="${height - 18}" text-anchor="middle">${escapeHtml(point.label)}</text></g>`).join("")}</svg></div>`
}

function polarPoint(centerX, centerY, radius, degrees) {
  const angle = (degrees - 90) * Math.PI / 180
  return { x: centerX + radius * Math.cos(angle), y: centerY + radius * Math.sin(angle) }
}

function pieSlicePath(centerX, centerY, radius, startAngle, endAngle, innerRadius = 0) {
  const safeEnd = Math.min(endAngle, startAngle + 359.999)
  const outerStart = polarPoint(centerX, centerY, radius, startAngle)
  const outerEnd = polarPoint(centerX, centerY, radius, safeEnd)
  const largeArc = safeEnd - startAngle > 180 ? 1 : 0
  if (!innerRadius) return `M ${centerX} ${centerY} L ${outerStart.x} ${outerStart.y} A ${radius} ${radius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y} Z`
  const innerEnd = polarPoint(centerX, centerY, innerRadius, safeEnd)
  const innerStart = polarPoint(centerX, centerY, innerRadius, startAngle)
  return `M ${outerStart.x} ${outerStart.y} A ${radius} ${radius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y} L ${innerEnd.x} ${innerEnd.y} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y} Z`
}

function renderPieChart(items, donut = false) {
  const positiveItems = items.map((item) => ({ ...item, amount: Math.max(0, item.value) }))
  const total = positiveItems.reduce((sum, item) => sum + item.amount, 0)
  if (!total) return `<div class="vp-empty">饼图需要至少一个正数</div>`
  let angle = 0
  const slices = positiveItems.map((item, itemIndex) => {
    const start = angle
    angle += item.amount / total * 360
    return { ...item, start, end: angle, color: CHART_COLORS[itemIndex % CHART_COLORS.length] }
  })
  return `<div class="vp-pie-layout"><svg class="vp-pie" viewBox="0 0 360 360" role="img">${slices.map((slice) => `<path d="${pieSlicePath(180, 180, 145, slice.start, slice.end, donut ? 82 : 0)}" fill="${slice.color}"><title>${escapeHtml(`${slice.label}: ${slice.value}`)}</title></path>`).join("")}${donut ? `<text x="180" y="174" text-anchor="middle">总计</text><text class="vp-pie-total" x="180" y="204" text-anchor="middle">${escapeHtml(total)}</text>` : ""}</svg><div class="vp-pie-legend">${slices.map((slice) => `<div data-comment-scope="item" data-ref="${escapeHtml(slice.ref)}"><i style="background:${slice.color}"></i><span>${escapeHtml(slice.label)}</span><strong>${escapeHtml(slice.value)}</strong></div>`).join("")}</div></div>`
}

function renderChart(section, index) {
  const baseRef = sectionRef(section, index)
  const items = chartItems(section, baseRef)
  if (!items.length) return renderSectionShell(section, index, `<div class="vp-empty">没有可展示的数值</div>`, "数据图表")
  const variant = text(section.variant, "bar").toLowerCase()
  const body = variant === "column"
    ? renderColumnChart(items)
    : variant === "line"
      ? renderLineChart(items)
      : variant === "area"
        ? renderLineChart(items, true)
        : variant === "donut"
          ? renderPieChart(items, true)
          : variant === "pie"
            ? renderPieChart(items)
            : renderHorizontalBarChart(items)
  const label = ({ bar: "横向条形图", "horizontal-bar": "横向条形图", column: "柱状图", line: "折线图", area: "面积图", donut: "环形图", pie: "饼图" })[variant] || "横向条形图"
  return renderSectionShell(section, index, body, label)
}

function renderPlanSection(sectionValue, index, data) {
  const section = record(sectionValue)
  const type = text(section.type, "cards")
  if (type === "summary" || type === "solution-summary") return renderSummary(section, data, index)
  if (GRAPH_SECTION_TYPES.has(type) || type === "diagram" && text(section.variant) !== "sequence") return renderGraph(section, index)
  if (type === "sequence" || type === "diagram" && text(section.variant) === "sequence") return renderSequence(section, index)
  if (type === "swimlane" || type === "user-journey") return renderSwimlane(section, index)
  if (type === "matrix" || type.endsWith("-matrix")) return renderMatrix(section, index)
  if (type === "timeline" || type === "implementation-steps") return renderTimeline(section, index)
  if (type === "tree") return renderTree(section, index)
  if (type === "erd") return renderErd(section, index)
  if (type === "wireframe") return renderWireframe(section, index)
  if (type === "chart") return renderChart(section, index)
  return renderCards(section, index)
}

function renderDecision(data) {
  const decisions = array(data.decisions)
  const context = record(data.context || data.core)
  const introRef = data.context && typeof data.context === "object" ? "context" : "meta"
  const intro = `<section class="vp-decision-intro" data-comment-scope="section" data-comment-label="决策背景" data-ref="${introRef}"><span class="vp-kicker">Decision</span><h1>${escapeHtml(text(record(data.meta).title || data.title, "需要确认的决策"))}</h1>${renderParagraphs(context.summary || context.description || data.summary)}${renderBadges(context)}</section>`
  const cards = decisions.map((decisionValue, decisionIndex) => {
    const decision = record(decisionValue)
    const id = safeId(decision.id, String(decisionIndex))
    const ref = `decisions.${id}`
    const options = array(decision.options)
    const recommended = text(decision.recommendedOptionId || decision.recommended)
    return `<section class="vp-decision" data-comment-scope="section" data-comment-label="${escapeHtml(text(decision.question || decision.title, `决策 ${decisionIndex + 1}`))}" data-ref="${escapeHtml(ref)}"><header><span class="vp-kicker">${escapeHtml(decision.type === "approval" || !options.length ? "确认项" : "选择项")}</span><h2>${escapeHtml(text(decision.question || decision.title, `决策 ${decisionIndex + 1}`))}</h2>${renderParagraphs(decision.description || decision.context)}</header>${valueList(decision.criteria).length ? `<div class="vp-decision-criteria"><strong>判断标准</strong><ul>${valueList(decision.criteria).map((criterion) => `<li>${escapeHtml(criterion)}</li>`).join("")}</ul></div>` : ""}${options.length ? `<div class="vp-options">${options.map((optionValue, optionIndex) => {
      const option = record(optionValue)
      const optionId = safeId(option.id, String(optionIndex))
      const isRecommended = option.recommended === true || recommended === optionId
      return `<article class="vp-option ${isRecommended ? "is-recommended" : ""}" data-ref="${escapeHtml(`${ref}.options.${optionId}`)}"><header><strong>${escapeHtml(text(option.label || option.title || option.name, `选项 ${optionIndex + 1}`))}</strong>${isRecommended ? "<span>推荐</span>" : ""}</header>${renderParagraphs(option.description || option.summary)}${valueList(option.consequences || option.tradeoffs).length ? `<ul>${valueList(option.consequences || option.tradeoffs).map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>` : ""}</article>`
    }).join("")}</div>` : `<div class="vp-approval-detail">${renderParagraphs(decision.consequence || decision.impact || decision.recommendation)}</div>`}</section>`
  }).join("")
  return `${intro}${cards}`
}

function engineStyles() {
  return `:root{color-scheme:light;--vp-bg:#f5f7fb;--vp-surface:#fff;--vp-surface-2:#f8fafc;--vp-border:#dfe4ec;--vp-text:#172033;--vp-muted:#64748b;--vp-accent:#4f46e5;--vp-accent-soft:#eef2ff;--vp-warn:#b45309;--vp-fail:#be123c;--vp-ok:#0f766e;font:14px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}*{box-sizing:border-box}html{background:var(--vp-bg);color:var(--vp-text)}body{margin:0;padding:36px}main{max-width:1180px;margin:0 auto}.vp-page-head{margin-bottom:24px}.vp-page-head h1,.vp-decision-intro h1{font-size:30px;line-height:1.2;margin:7px 0 10px;letter-spacing:-.02em}.vp-page-head p,.vp-section-head p,.vp-decision header p,.vp-decision-intro p{color:var(--vp-muted);max-width:850px}.vp-kicker{display:inline-flex;color:var(--vp-accent);font-size:11px;font-weight:750;letter-spacing:.1em;text-transform:uppercase}.vp-section,.vp-decision,.vp-decision-intro{background:var(--vp-surface);border:1px solid var(--vp-border);border-radius:18px;padding:24px;margin:0 0 18px;box-shadow:0 8px 24px rgba(15,23,42,.045)}.vp-section-head{margin-bottom:18px}.vp-section-head h2,.vp-decision h2{font-size:21px;line-height:1.3;margin:5px 0}.vp-summary-grid,.vp-card-grid,.vp-entity-grid,.vp-screen-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.vp-summary-card,.vp-card,.vp-entity,.vp-screen,.vp-option{border:1px solid var(--vp-border);border-radius:14px;background:var(--vp-surface-2);padding:16px;min-width:0}.vp-summary-card>span{color:var(--vp-muted);font-size:12px;font-weight:700}.vp-summary-card p{font-size:16px;font-weight:650;margin:7px 0}.vp-card header,.vp-entity header,.vp-option header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.vp-card p,.vp-option p,.vp-tree-node p,.vp-step p{color:var(--vp-muted)}.vp-card ul,.vp-option ul{padding-left:18px}.vp-card footer{border-top:1px solid var(--vp-border);padding-top:10px;color:var(--vp-muted)}code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:#eef1f6;border-radius:5px;padding:2px 5px}.vp-badges,.vp-legend{display:flex;gap:6px;flex-wrap:wrap}.vp-badges span,.vp-legend span{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--vp-border);background:white;border-radius:999px;padding:2px 8px;color:var(--vp-muted);font-size:11px}.vp-legend{margin-top:10px}.vp-legend i{width:8px;height:8px;border-radius:3px;background:var(--vp-accent)}.vp-path-filter{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 10px}.vp-path-filter button{border:1px solid var(--vp-border);border-radius:999px;background:#fff;color:#475569;padding:5px 11px;cursor:pointer}.vp-path-filter button.is-active{border-color:#a5b4fc;background:var(--vp-accent-soft);color:var(--vp-accent)}.vp-diagram-wrap,.vp-table-wrap{overflow:auto;border:1px solid var(--vp-border);border-radius:14px;background:linear-gradient(#fff,#fbfcff)}.vp-diagram,.vp-sequence{display:block;width:100%;min-width:780px;min-height:300px}.vp-boundary rect{fill:#f8fafc;fill-opacity:.72;stroke:#b8c2d1;stroke-dasharray:7 5}.vp-boundary text{font-size:11px;font-weight:700;fill:#64748b}.vp-node rect{fill:#fff;stroke:#cbd5e1;stroke-width:1.5}.vp-node:hover rect{stroke:var(--vp-accent);stroke-width:2}.vp-node-kind{font-size:10px;text-transform:uppercase;fill:var(--vp-muted)}.vp-node-title{font-size:14px;font-weight:700;fill:var(--vp-text)}.vp-node-database rect,.vp-node-store rect{fill:#f0fdfa;stroke:#5eead4}.vp-node-external rect,.vp-node-person rect{fill:#f8fafc;stroke:#94a3b8}.vp-node-fail rect,.vp-node-error rect{fill:#fff1f2;stroke:#fda4af}.vp-edge path{fill:none;stroke:#94a3b8;stroke-width:1.6}.vp-edge-fail path,.vp-edge-error path{stroke:var(--vp-fail);stroke-dasharray:6 4}.vp-edge-async path,.vp-edge-event path{stroke:var(--vp-accent);stroke-dasharray:7 5}.vp-edge text,.vp-sequence-message text{font-size:11px;fill:#475569;paint-order:stroke;stroke:#fff;stroke-width:5px;stroke-linejoin:round}.vp-edge marker path,.vp-sequence marker path{fill:#64748b}.vp-sequence-person{fill:#fff;stroke:#cbd5e1}.vp-sequence-title{font-size:12px;font-weight:700;fill:var(--vp-text)}.vp-lifeline{stroke:#cbd5e1;stroke-dasharray:5 5}.vp-sequence-message line{stroke:#64748b;stroke-width:1.5}.vp-sequence-message line.is-dashed{stroke:var(--vp-accent);stroke-dasharray:6 4}.vp-sequence-fragment rect{fill:#eef2ff;fill-opacity:.42;stroke:#a5b4fc;stroke-dasharray:5 4}.vp-sequence-fragment text{font-size:10px;font-weight:700;fill:#4f46e5}.vp-lanes{display:grid;gap:10px}.vp-lane{display:grid;grid-template-columns:170px 1fr;border:1px solid var(--vp-border);border-radius:14px;overflow:hidden}.vp-lane>header{padding:16px;background:#f1f5f9}.vp-lane>header span{font-weight:750}.vp-lane-steps{display:flex;gap:10px;overflow:auto;padding:12px}.vp-step{min-width:190px;border:1px solid var(--vp-border);border-radius:11px;padding:12px;background:#fff}.vp-matrix{width:100%;border-collapse:collapse;min-width:700px}.vp-matrix th,.vp-matrix td{border-bottom:1px solid var(--vp-border);border-right:1px solid var(--vp-border);padding:11px;text-align:left;vertical-align:top}.vp-matrix thead th{background:#f1f5f9}.vp-matrix td.tone-ok,.vp-matrix td.tone-success{background:#f0fdfa;color:#115e59}.vp-matrix td.tone-warn{background:#fffbeb;color:#92400e}.vp-matrix td.tone-fail,.vp-matrix td.tone-error{background:#fff1f2;color:#9f1239}.vp-timeline{list-style:none;padding:0;margin:0;position:relative}.vp-timeline:before{content:"";position:absolute;left:18px;top:16px;bottom:16px;width:2px;background:#dbe2ea}.vp-timeline li{position:relative;display:grid;grid-template-columns:38px 1fr;gap:14px;padding:0 0 20px}.vp-timeline-index{position:relative;z-index:1;display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:var(--vp-accent);color:white;font-weight:750}.vp-tree,.vp-tree ul{list-style:none;margin:0;padding-left:24px}.vp-tree li{position:relative;margin:8px 0}.vp-tree li:before{content:"";position:absolute;left:-15px;top:21px;width:15px;border-top:1px solid #cbd5e1}.vp-tree-node{border:1px solid var(--vp-border);border-radius:12px;padding:12px;background:#fff}.vp-entity ul{list-style:none;margin:12px -16px -16px;padding:0}.vp-entity li{display:flex;gap:8px;align-items:center;border-top:1px solid var(--vp-border);padding:8px 16px}.vp-entity li span{margin-left:auto;color:var(--vp-muted)}.vp-entity li b{font-size:10px;color:var(--vp-accent)}.vp-screen{padding:0;overflow:hidden}.vp-screen>header{display:flex;align-items:center;gap:5px;padding:10px;background:#e9edf4}.vp-screen>header i{width:8px;height:8px;border-radius:50%;background:#94a3b8}.vp-screen>header strong{margin-left:7px}.vp-screen-body{padding:12px;display:grid;gap:9px}.vp-screen-region{border:1px dashed #b8c2d1;border-radius:10px;min-height:70px;padding:12px}.vp-bars{display:grid;gap:10px}.vp-bar-row{display:grid;grid-template-columns:150px 1fr 70px;align-items:center;gap:10px}.vp-bar-row>div{height:12px;background:#e8ecf3;border-radius:999px;overflow:hidden}.vp-bar-row i{display:block;height:100%;background:var(--vp-accent);border-radius:inherit}.vp-columns{display:flex;align-items:end;gap:14px;min-height:300px;padding:20px 16px 0;border:1px solid var(--vp-border);border-radius:14px;background:linear-gradient(#fff,#fbfcff);overflow:auto}.vp-column{display:grid;grid-template-rows:24px 220px auto;gap:7px;min-width:90px;text-align:center}.vp-column>div{display:flex;align-items:end;justify-content:center;border-bottom:1px solid #cbd5e1}.vp-column i{display:block;width:42px;min-height:2px;border-radius:7px 7px 0 0;background:var(--vp-accent)}.vp-column span{color:var(--vp-muted);font-size:12px}.vp-chart-svg{display:block;width:100%;min-width:760px;min-height:300px}.vp-chart-line{fill:none;stroke:var(--vp-accent);stroke-width:3}.vp-chart-area{fill:var(--vp-accent-soft);stroke:none}.vp-chart-point circle{fill:#fff;stroke:var(--vp-accent);stroke-width:3}.vp-chart-point text{font-size:11px;fill:#475569}.vp-pie-layout{display:grid;grid-template-columns:minmax(280px,420px) minmax(240px,1fr);gap:24px;align-items:center}.vp-pie{width:100%;max-height:380px}.vp-pie>text{font-size:13px;fill:var(--vp-muted)}.vp-pie .vp-pie-total{font-size:24px;font-weight:750;fill:var(--vp-text)}.vp-pie-legend{display:grid;gap:8px}.vp-pie-legend>div{display:grid;grid-template-columns:12px 1fr auto;align-items:center;gap:9px;border:1px solid var(--vp-border);border-radius:10px;padding:9px 11px}.vp-pie-legend i{width:10px;height:10px;border-radius:3px}.vp-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-top:16px}.vp-option.is-recommended{border-color:#a5b4fc;background:var(--vp-accent-soft)}.vp-option header span{color:var(--vp-accent);font-size:11px;font-weight:750}.vp-decision-criteria{background:#f8fafc;border-left:3px solid var(--vp-accent);padding:12px 16px;margin-top:14px}.vp-empty{padding:36px;text-align:center;color:var(--vp-muted)}.vp-dim{opacity:.16!important}[data-vp-paths]{transition:opacity .16s ease}[data-comment-scope],[data-ref]{scroll-margin-top:18px}@media(max-width:760px){body{padding:16px}.vp-section,.vp-decision,.vp-decision-intro{padding:18px}.vp-lane{grid-template-columns:1fr}.vp-bar-row{grid-template-columns:100px 1fr 48px}.vp-pie-layout{grid-template-columns:1fr}}`
}

function engineScript() {
  return `document.addEventListener("click",function(event){var button=event.target.closest("[data-vp-filter]");if(!button)return;var section=button.closest(".vp-section");if(!section)return;var value=button.getAttribute("data-vp-filter")||"";button.parentElement.querySelectorAll("button").forEach(function(item){item.classList.toggle("is-active",item===button)});section.querySelectorAll("[data-vp-paths]").forEach(function(node){var paths=(node.getAttribute("data-vp-paths")||"").split(/\\s+/);node.classList.toggle("vp-dim",Boolean(value)&&paths.indexOf(value)<0)});});`
}

function renderVisualArtifactDocument(dataValue, artifactType) {
  const data = record(dataValue)
  const meta = record(data.meta)
  const title = text(meta.title || data.title, artifactType === "decision" ? "Decision" : "Visual Plan")
  const content = artifactType === "decision"
    ? renderDecision(data)
    : `<header class="vp-page-head" data-comment-scope="section" data-comment-label="方案概览" data-ref="meta"><span class="vp-kicker">Visual Plan</span><h1>${escapeHtml(title)}</h1>${renderParagraphs(meta.description || data.description)}</header>${array(data.sections).map((section, index) => renderPlanSection(section, index, data)).join("")}`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${engineStyles()}</style></head><body><main>${content}</main><script type="application/json" id="plan-data">${jsonIsland(data)}</script><script>${engineScript()}</script></body></html>`
}

export { renderVisualArtifactDocument }
