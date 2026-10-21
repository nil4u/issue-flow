const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("tsx/cjs")

const { appLinkNavigationPath } = require("../src/app-route.ts")
const { isConsoleSessionExpired } = require("../src/lib/console-session.ts")

const origin = "https://console.example.com"
const plainClick = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false }

test("plain left click on same-origin link navigates inside the SPA", () => {
  assert.equal(appLinkNavigationPath(plainClick, { href: "/repos/gl/1/issues/15?returnTo=%2Frepos" }, origin), "/repos/gl/1/issues/15?returnTo=%2Frepos")
  assert.equal(appLinkNavigationPath(plainClick, { href: `${origin}/repos/gl/1/merge-requests/3#diff` }, origin), "/repos/gl/1/merge-requests/3#diff")
  assert.equal(appLinkNavigationPath(plainClick, { href: "/repos/gl/1/plan/4", target: "_self" }, origin), "/repos/gl/1/plan/4")
})

test("modifier keys, non-left buttons and prevented clicks keep browser behavior", () => {
  for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) {
    assert.equal(appLinkNavigationPath({ ...plainClick, [key]: true }, { href: "/repos" }, origin), "")
  }
  assert.equal(appLinkNavigationPath({ ...plainClick, button: 1 }, { href: "/repos" }, origin), "")
  assert.equal(appLinkNavigationPath({ ...plainClick, defaultPrevented: true }, { href: "/repos" }, origin), "")
})

test("new-tab, download and cross-origin links keep browser behavior", () => {
  assert.equal(appLinkNavigationPath(plainClick, { href: "/repos", target: "_blank" }, origin), "")
  assert.equal(appLinkNavigationPath(plainClick, { href: "/repos", download: true }, origin), "")
  assert.equal(appLinkNavigationPath(plainClick, { href: "https://gitlab.example.com/group/repo/-/issues/1" }, origin), "")
})

test("only Console login_required responses expire the local session", () => {
  assert.equal(isConsoleSessionExpired(401, { error: "login_required" }), true)
  assert.equal(isConsoleSessionExpired(401, { error: "git_login_required" }), false)
  assert.equal(isConsoleSessionExpired(401, { error: "gitlab_login_required" }), false)
  assert.equal(isConsoleSessionExpired(401, {}), false)
  assert.equal(isConsoleSessionExpired(401, null), false)
  assert.equal(isConsoleSessionExpired(403, { error: "login_required" }), false)
})

test("in-app page links do not trigger full page reloads", () => {
  const files = [
    "src/components/issues-board.tsx",
    "src/components/issues/issues-kanban.tsx",
    "src/components/issues/issues-list.tsx",
    "src/components/merge-requests-board.tsx",
    "src/components/issue-page.tsx",
    "src/components/merge-request-page.tsx",
    "src/components/automation-insights.tsx",
    "src/components/metrics-drill-drawer.tsx",
    "src/vision-plan/VisionPlanPage.tsx",
  ]
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8")
    assert.doesNotMatch(source, /location\.assign/, file)
    // 剩余的原生 <a> 只允许是新标签打开的外部链接
    const anchors = source.match(/<a\b[^>]*>/g) || []
    for (const anchor of anchors) assert.match(anchor, /target="_blank"/, `${file}: ${anchor}`)
  }
})

test("App renders detail routes from controller location and avoids login flash", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src/App.tsx"), "utf8")
  assert.match(app, /dashboard\.location/)
  assert.doesNotMatch(app, /parse(Issue|MergeRequest|VisualArtifact)Route\(\)/)
  assert.match(app, /loginStateLoaded/)
  const controller = fs.readFileSync(path.join(__dirname, "..", "src/hooks/use-dashboard-controller.ts"), "utf8")
  assert.match(controller, /APP_NAVIGATE_EVENT/)
  assert.match(controller, /SESSION_EXPIRED_EVENT/)
})
