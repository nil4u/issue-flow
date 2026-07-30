const assert = require("node:assert/strict")
const test = require("node:test")

require("tsx/cjs")

const { buildFileTree } = require("../src/components/review/file-tree-model.ts")

test("file tree groups shared directories and compacts single-directory chains", () => {
  const tree = buildFileTree([
    { path: "src/components/button.tsx" },
    { path: "src/components/input.tsx" },
    { path: "docs/preview/guide.md" },
    { path: "README.md" },
  ])

  assert.deepEqual(tree.map(({ name, path, type }) => ({ name, path, type })), [
    { name: "docs/preview", path: "docs/preview", type: "directory" },
    { name: "src/components", path: "src/components", type: "directory" },
    { name: "README.md", path: "README.md", type: "file" },
  ])
  assert.deepEqual(tree[1].children.map(({ name, path }) => ({ name, path })), [
    { name: "button.tsx", path: "src/components/button.tsx" },
    { name: "input.tsx", path: "src/components/input.tsx" },
  ])
})
