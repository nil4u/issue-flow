const assert = require("node:assert/strict")
const { readFileSync } = require("node:fs")
const { join } = require("node:path")
const test = require("node:test")

const board = readFileSync(join(__dirname, "../src/components/issues-board.tsx"), "utf8")
const styles = readFileSync(join(__dirname, "../src/styles/issue-management.css"), "utf8")
const card = board.slice(board.indexOf("function IssueBoardCard("))

test("board card keeps the same native issue detail link as the list", () => {
  assert.match(board, /<IssueBoardCard[^>]*href=\{issueHref\(issue.number\)\}/)
  assert.match(board, /<IssueListRow[^>]*href=\{issueHref\(issue.number\)\}/)
  assert.match(card, /<article className="issue-card provider-issue-card">/)
  assert.match(card, /<a className="provider-issue-card-link" href=\{href\}>\{issue.title\}<\/a>/)
  assert.doesNotMatch(card, /onClick=|target=/)
})

test("issue detail link covers the card including padding and labels", () => {
  assert.match(styles, /\.provider-issue-card\s*\{[^}]*position: relative;/)
  assert.match(styles, /\.provider-issue-card-link::after\s*\{[^}]*content: "";[^}]*position: absolute;[^}]*inset: 0;/)
  assert.match(styles, /\.provider-issue-card-link:focus-visible::after\s*\{[^}]*outline: 2px solid/)
})

test("Decision and Plan links remain separate above the card-wide issue link", () => {
  assert.match(card, /<\/a>.*<a className="issue-review-link" href=\{reviewHref\}>/)
  assert.match(styles, /\.provider-issue-card > \.issue-review-link\s*\{[^}]*position: relative;[^}]*z-index: 1;[^}]*justify-self: start;/)
})
