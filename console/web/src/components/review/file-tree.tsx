import { useMemo, useState, type ReactNode } from "react"
import { ChevronRight, FileCode2, Folder, FolderOpen } from "lucide-react"

import {
  buildFileTree,
  type FileTreeItem,
  type FileTreeNode,
} from "./file-tree-model"

type Props = {
  activePath?: string
  ariaLabel: string
  items: FileTreeItem[]
  onSelect: (path: string) => void
}

export function FileTree({ activePath, ariaLabel, items, onSelect }: Props) {
  const nodes = useMemo(() => buildFileTree(items), [items])
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  function toggle(path: string) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function renderNode(node: FileTreeNode, depth: number): ReactNode {
    if (node.type === "directory") {
      const isCollapsed = collapsed.has(node.path)
      return (
        <li key={`directory:${node.path}`}>
          <button
            type="button"
            className="if-file-tree-row is-directory"
            style={{ paddingInlineStart: `${7 + depth * 14}px` }}
            aria-expanded={!isCollapsed}
            onClick={() => toggle(node.path)}
          >
            <ChevronRight
              className={`if-file-tree-chevron ${isCollapsed ? "" : "is-open"}`}
              size={13}
            />
            {isCollapsed ? <Folder size={14} /> : <FolderOpen size={14} />}
            <span>{node.name}</span>
          </button>
          {!isCollapsed ? (
            <ul>
              {node.children.map((child) => renderNode(child, depth + 1))}
            </ul>
          ) : null}
        </li>
      )
    }
    return (
      <li key={`file:${node.path}`}>
        <button
          type="button"
          className={`if-file-tree-row is-file ${node.path === activePath ? "is-active" : ""}`}
          style={{ paddingInlineStart: `${25 + depth * 14}px` }}
          title={node.path}
          onClick={() => onSelect(node.path)}
        >
          <FileCode2 size={14} />
          <span>{node.name}</span>
          {node.item?.badge ? <small>{node.item.badge}</small> : null}
        </button>
      </li>
    )
  }

  return (
    <nav className="if-file-tree" aria-label={ariaLabel}>
      <ul>{nodes.map((node) => renderNode(node, 0))}</ul>
    </nav>
  )
}
