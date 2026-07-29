export type FileTreeItem = {
  path: string
  badge?: string
}

export type FileTreeNode = {
  name: string
  path: string
  type: "directory" | "file"
  children: FileTreeNode[]
  item?: FileTreeItem
}

function sortNodes(nodes: FileTreeNode[]) {
  return nodes.sort(
    (left, right) =>
      Number(right.type === "directory") - Number(left.type === "directory") ||
      left.name.localeCompare(right.name)
  )
}

function compactDirectory(node: FileTreeNode): FileTreeNode {
  const children = node.children.map(compactDirectory)
  if (
    node.type !== "directory" ||
    children.length !== 1 ||
    children[0].type !== "directory"
  ) {
    return { ...node, children: sortNodes(children) }
  }
  const child = children[0]
  return { ...child, name: `${node.name}/${child.name}` }
}

export function buildFileTree(items: FileTreeItem[]) {
  const root: FileTreeNode = {
    name: "",
    path: "",
    type: "directory",
    children: [],
  }
  for (const item of items) {
    const segments = item.path.split("/").filter(Boolean)
    let parent = root
    segments.forEach((name, index) => {
      const type = index === segments.length - 1 ? "file" : "directory"
      const nodePath = segments.slice(0, index + 1).join("/")
      let node = parent.children.find(
        (candidate) => candidate.name === name && candidate.type === type
      )
      if (!node) {
        node = {
          name,
          path: nodePath,
          type,
          children: [],
          ...(type === "file" ? { item } : {}),
        }
        parent.children.push(node)
      }
      parent = node
    })
  }
  return sortNodes(root.children.map(compactDirectory))
}
