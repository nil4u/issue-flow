import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, GitPullRequest, MessageCircle, X } from "lucide-react";
import { actOnOptimizationProposal, approveAllDecisions, approveVisionArtifact, loadVisualArtifact, submitReviewDraft } from "./api";
import { anchorSelector, findDataRef, formatPlanDataSnippet, parsePlanDataIsland, PLAN_DATA_ISLAND_ID, resolvePlanDataRef } from "./anchors";
import { decisionItemsFromDocument, interactiveDecisionRefs, type DecisionItem, type DecisionOption } from "./decision-items";
import { ArtifactReviewPanel } from "./ArtifactReviewPanel";
import { FileTree } from "@/components/review/file-tree";
import { anchorOffsetForPoint, resolveVisualTargetPosition, visualTargetMarkerStyle, type MarkerFrameMetrics } from "./marker-position";
import { addStoredReviewDraft, clearReviewStorage, deleteStoredReviewDraft, saveSubmittedReview, updateStoredReviewDraft } from "./review-storage";
import type { ArtifactType, DecisionReview, DraftReviewItem, FeedbackRequest, IssueArtifact, LoadedIssue, OptimizationProposalState, VisionRouteContext, VisualReview, VisualTarget } from "./types";
import "./vision-plan.css";

type FrameMetrics = MarkerFrameMetrics;
type DecisionAnchorTarget = {
  ref: string;
  id?: string;
  question?: string;
  type: DecisionItem["type"];
  optionId?: string;
  optionLabel?: string;
  visualTarget: VisualTarget;
};
type ArtifactSection = {
  id: string;
  label: string;
  ref?: string;
  level?: number;
};

function artifactLabel(type: ArtifactType) {
  if (type === "decision") return "决策";
  if (type === "optimization") return "自动化优化";
  if (type === "markdown") return "Markdown";
  return "方案";
}

function sourceRefTypeForArtifact(type: ArtifactType) {
  if (type === "decision") return "decision";
  if (type === "optimization") return "optimization";
  if (type === "markdown") return "file";
  return "plan";
}

function draftBelongsToArtifact(item: DraftReviewItem | null | undefined, artifact: IssueArtifact) {
  if (!item) return false;
  const paths = [item.visualTarget?.path, ...(item.sourceRefs ?? []).map((ref) => ref.path)].filter(Boolean);
  if (paths.length) return paths.includes(artifact.path);
  return item.visualTarget?.artifact === artifact.type || (item.sourceRefs ?? []).some((ref) => ref.type === artifact.type);
}

function compareDraftDocumentOrder(left: DraftReviewItem, right: DraftReviewItem) {
  const leftTarget = left.visualTarget;
  const rightTarget = right.visualTarget;
  if (!leftTarget || !rightTarget) return leftTarget ? -1 : rightTarget ? 1 : left.createdAt.localeCompare(right.createdAt);
  return leftTarget.yRatio - rightTarget.yRatio
    || leftTarget.xRatio - rightTarget.xRatio
    || left.createdAt.localeCompare(right.createdAt);
}

function measureFrame(frame: HTMLIFrameElement | null, overlay: HTMLDivElement): FrameMetrics {
  const rect = overlay.getBoundingClientRect();
  try {
    const doc = frame?.contentDocument;
    const win = frame?.contentWindow;
    if (!doc || !win) throw new Error("无法访问可视化产物页面");
    const root = doc.documentElement;
    const body = doc.body;
    return {
      scrollX: win.scrollX,
      scrollY: win.scrollY,
      viewportWidth: win.innerWidth || rect.width,
      viewportHeight: win.innerHeight || rect.height,
      documentWidth: Math.max(root.scrollWidth, body?.scrollWidth ?? 0, root.clientWidth, rect.width),
      documentHeight: Math.max(root.scrollHeight, body?.scrollHeight ?? 0, root.clientHeight, rect.height)
    };
  } catch {
    return {
      scrollX: 0,
      scrollY: 0,
      viewportWidth: rect.width,
      viewportHeight: rect.height,
      documentWidth: rect.width,
      documentHeight: rect.height
    };
  }
}

function visualTargetStyle(target: VisualTarget, overlay: HTMLDivElement | null, frame: HTMLIFrameElement | null) {
  const metrics = overlay ? measureFrame(frame, overlay) : {
    scrollX: 0,
    scrollY: 0,
    viewportWidth: target.viewportWidth,
    viewportHeight: target.viewportHeight,
    documentWidth: target.documentWidth,
    documentHeight: target.documentHeight
  };
  return visualTargetMarkerStyle(target, metrics, frame?.contentDocument ?? null);
}

function cssEscape(value: string) {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function compactLabel(value: string | null | undefined, maxLength = 78) {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function sectionLabel(element: Element, index: number) {
  return compactLabel(element.getAttribute("data-comment-label")) ??
    compactLabel(element.getAttribute("aria-label")) ??
    compactLabel(element.querySelector("h1,h2,h3,h4")?.textContent) ??
    compactLabel(element.getAttribute("data-ref")?.split(".").at(-1)) ??
    `章节 ${index + 1}`;
}

const DECISION_ACTIONS_CLASS = "agentrix-decision-actions";
const DECISION_ACTION_STYLE_ID = "agentrix-decision-action-style";
const COMMENT_ACTION_CLASS = "agentrix-comment-action";
const COMMENT_ACTION_STYLE_ID = "agentrix-comment-action-style";
const COMMENTABLE_SELECTOR = "[data-comment-scope]";
const OPTIMIZATION_ACTION_STYLE_ID = "issue-flow-optimization-action-style";
const SECTION_SELECTOR = '[data-comment-scope="section"]';
const NAVIGATION_SELECTOR = SECTION_SELECTOR;

function eventElementTarget(event: Event, document: Document): Element | null {
  const target = event.target;
  const FrameElement = document.defaultView?.Element;
  return FrameElement && target instanceof FrameElement ? target : null;
}

function isVisibleArtifactSection(element: Element) {
  if (element.closest("[hidden],[aria-hidden='true']")) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style?.display !== "none" && style?.visibility !== "hidden" && element.getClientRects().length > 0;
}

function ensureDecisionActionStyle(document: Document) {
  if (document.getElementById(DECISION_ACTION_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = DECISION_ACTION_STYLE_ID;
  style.textContent = `
    .${DECISION_ACTIONS_CLASS} {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid rgba(23, 32, 38, 0.12);
    }
    .${DECISION_ACTIONS_CLASS} button {
      appearance: none;
      min-height: 30px;
      border: 1px solid #e4e4e7;
      border-radius: 6px;
      padding: 4px 10px;
      background: #ffffff;
      color: #18181b;
      font: 700 12px/1.2 "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
    }
    .${DECISION_ACTIONS_CLASS} button[data-agentrix-decision-action="approve"] {
      border-color: #18181b;
      background: #18181b;
      color: #ffffff;
    }
    .${DECISION_ACTIONS_CLASS} button[data-agentrix-decision-action="select"] {
      border-color: #2563eb;
      background: #eff6ff;
      color: #1d4ed8;
    }
    .${DECISION_ACTIONS_CLASS} button[data-agentrix-decision-action="select"][aria-pressed="true"] {
      background: #2563eb;
      color: #ffffff;
    }
    .${DECISION_ACTIONS_CLASS} button[data-agentrix-decision-action="discuss"] {
      border-color: #d4d4d8;
      background: #ffffff;
      color: #3f3f46;
    }
  `;
  document.head?.appendChild(style);
}

function ensureCommentActionStyle(document: Document) {
  if (document.getElementById(COMMENT_ACTION_STYLE_ID)) return;
  const trackColor = [document.documentElement, document.body]
    .map((element) => document.defaultView?.getComputedStyle(element).backgroundColor)
    .find((color) => color && color !== "rgba(0, 0, 0, 0)") ?? "#fff";
  const style = document.createElement("style");
  style.id = COMMENT_ACTION_STYLE_ID;
  style.textContent = `
    :root {
      --agentrix-scrollbar-track: ${trackColor};
    }
    :root, * {
      scrollbar-width: thin;
      scrollbar-color: rgba(113, 113, 122, 0.28) var(--agentrix-scrollbar-track);
    }
    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
      background: var(--agentrix-scrollbar-track);
    }
    ::-webkit-scrollbar-track {
      background: var(--agentrix-scrollbar-track);
    }
    ::-webkit-scrollbar-corner {
      background: var(--agentrix-scrollbar-track);
    }
    ::-webkit-scrollbar-thumb {
      border-radius: 999px;
      background: rgba(113, 113, 122, 0.28);
    }
    :hover::-webkit-scrollbar-thumb {
      background: rgba(113, 113, 122, 0.42);
    }
    .${COMMENT_ACTION_CLASS} {
      appearance: none;
      position: fixed;
      z-index: 2147483646;
      display: none;
      min-width: 30px;
      min-height: 30px;
      border: 1px solid #18181b;
      border-radius: 999px;
      padding: 0 9px;
      background: #18181b;
      color: #ffffff;
      font: 700 12px/1.2 "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.18);
      cursor: pointer;
    }
    .${COMMENT_ACTION_CLASS}[data-agentrix-visible="true"] {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
  `;
  document.head?.appendChild(style);
}

function elementSourceHtml(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll("[data-agentrix-injected]").forEach((node) => node.remove());
  return clone.outerHTML;
}

function describeElement(element: Element | null, coverage?: ElementCoverage) {
  if (!element) return undefined;
  const tagName = element.tagName.toLowerCase();
  const id = element.id || undefined;
  const className = typeof element.className === "string" ? element.className.trim().replace(/\s+/g, " ") || undefined : undefined;
  const role = element.getAttribute("role") || undefined;
  const ariaLabel = element.getAttribute("aria-label") || undefined;
  const html = elementSourceHtml(element).trim().replace(/\s+/g, " ").slice(0, 8000) || undefined;
  const dataRef = findDataRef(element);
  const selector = anchorSelector(element);
  return { selector, tagName, id, className, role, ariaLabel, dataRef, html, ...coverage };
}

type ElementCoverage = {
  coverage: "full" | "mostly" | "partial" | "touches";
  coveredArea: string;
  elementCoverageRatio: number;
  selectionCoverageRatio: number;
};

function resolvePlanDataForRef(frame: HTMLIFrameElement | null, ref: string | undefined): { data?: VisualTarget["data"]; value?: unknown } {
  if (!ref) return {};
  let islandText: string | null | undefined;
  try {
    islandText = frame?.contentDocument?.getElementById(PLAN_DATA_ISLAND_ID)?.textContent;
  } catch {
    return {};
  }
  const planData = parsePlanDataIsland(islandText);
  if (planData === undefined) return {};
  const value = resolvePlanDataRef(planData, ref);
  const json = formatPlanDataSnippet(value);
  return { data: json ? { ref, json } : undefined, value };
}

function resolvePlanDataForElement(frame: HTMLIFrameElement | null, element: Element | undefined): VisualTarget["data"] {
  return resolvePlanDataForRef(frame, element ? findDataRef(element) : undefined).data;
}

function makeElementVisualTarget(artifact: IssueArtifact, overlay: HTMLDivElement, frame: HTMLIFrameElement | null, element: Element, coveredArea: string): VisualTarget {
  const elementRect = element.getBoundingClientRect();
  const metrics = measureFrame(frame, overlay);
  const pointX = Math.max(0, Math.min(metrics.viewportWidth, elementRect.left + elementRect.width / 2));
  const pointY = Math.max(0, Math.min(metrics.viewportHeight, elementRect.top + elementRect.height / 2));
  const anchorOffset = anchorOffsetForPoint(element, pointX, pointY);
  const description = describeElement(element, {
    coverage: "full",
    coveredArea,
    elementCoverageRatio: 1,
    selectionCoverageRatio: 1
  });
  return {
    artifact: artifact.type,
    path: artifact.path,
    kind: "point",
    x: pointX,
    y: pointY,
    xRatio: Math.max(0, Math.min(1, (metrics.scrollX + pointX) / metrics.documentWidth)),
    yRatio: Math.max(0, Math.min(1, (metrics.scrollY + pointY) / metrics.documentHeight)),
    viewportWidth: metrics.viewportWidth,
    viewportHeight: metrics.viewportHeight,
    documentWidth: metrics.documentWidth,
    documentHeight: metrics.documentHeight,
    anchorRef: description?.dataRef,
    anchorSelector: description?.selector,
    ...anchorOffset,
    element: description,
    elements: description ? [description] : undefined,
    data: resolvePlanDataForElement(frame, element)
  };
}

function closestSelectionBlock(node: Node) {
  const element = node.nodeType === 1 ? node as Element : node.parentElement;
  return element?.closest("p,li,pre,blockquote,td,th,h1,h2,h3,h4") ?? element;
}

function selectionBlock(range: Range) {
  return closestSelectionBlock(range.startContainer) ?? closestSelectionBlock(range.commonAncestorContainer);
}

function makeSelectionVisualTarget(artifact: IssueArtifact, overlay: HTMLDivElement, frame: HTMLIFrameElement | null, range: Range, element: Element): VisualTarget | null {
  const selectionText = range.toString().replace(/\s+/g, " ").trim();
  const rect = range.getBoundingClientRect();
  if (!selectionText || rect.width <= 0 || rect.height <= 0) return null;
  const metrics = measureFrame(frame, overlay);
  const stableAnchor = element.closest("[data-ref]") ?? element;
  const elementRect = element.getBoundingClientRect();
  const anchorOffset = anchorOffsetForPoint(stableAnchor, rect.left, rect.top);
  const elementArea = Math.max(1, elementRect.width * elementRect.height);
  const selectionArea = Math.max(1, rect.width * rect.height);
  const description = describeElement(element, {
    coverage: "partial",
    coveredArea: "选中文字",
    elementCoverageRatio: Math.min(1, selectionArea / elementArea),
    selectionCoverageRatio: 1
  });
  return {
    artifact: artifact.type,
    path: artifact.path,
    kind: "rect",
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    xRatio: Math.max(0, Math.min(1, (metrics.scrollX + rect.left) / metrics.documentWidth)),
    yRatio: Math.max(0, Math.min(1, (metrics.scrollY + rect.top) / metrics.documentHeight)),
    widthRatio: Math.max(0, Math.min(1, rect.width / metrics.documentWidth)),
    heightRatio: Math.max(0, Math.min(1, rect.height / metrics.documentHeight)),
    viewportWidth: metrics.viewportWidth,
    viewportHeight: metrics.viewportHeight,
    documentWidth: metrics.documentWidth,
    documentHeight: metrics.documentHeight,
    anchorRef: findDataRef(stableAnchor),
    anchorSelector: anchorSelector(stableAnchor),
    ...anchorOffset,
    element: description,
    elements: description ? [description] : undefined,
    selectionText: selectionText.slice(0, 1200),
    data: resolvePlanDataForElement(frame, element)
  };
}

function makeDecisionVisualTarget(artifact: IssueArtifact, overlay: HTMLDivElement, frame: HTMLIFrameElement | null, element: Element): VisualTarget {
  return makeElementVisualTarget(artifact, overlay, frame, element, "决策项");
}

export function VisionPlanPage({ gitServerId, projectId, issueNumber, mergeRequestNumber, artifactPath }: VisionRouteContext) {
  const routeContext = useMemo(
    () => ({ gitServerId, projectId, issueNumber, mergeRequestNumber, artifactPath }),
    [gitServerId, projectId, issueNumber, mergeRequestNumber, artifactPath],
  );
  const embedded = typeof window !== "undefined" && window.self !== window.top;
  const [issue, setIssue] = useState<LoadedIssue | null>(null);
  const [draftItems, setDraftItems] = useState<DraftReviewItem[]>([]);
  const [reviews, setReviews] = useState<VisualReview[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [artifactSections, setArtifactSections] = useState<ArtifactSection[]>([]);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [visualCommentText, setVisualCommentText] = useState("");
  const [commentComposerOpen, setCommentComposerOpen] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<VisualTarget | null>(null);
  const [pendingDecision, setPendingDecision] = useState<DecisionAnchorTarget | null>(null);
  const [agentPrompt, setAgentPrompt] = useState<string | null>(null);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [visualTick, setVisualTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [reviewCollapsed, setReviewCollapsed] = useState(true);
  const [artifactHtml, setArtifactHtml] = useState<string | null>(null);
  const [artifactFormat, setArtifactFormat] = useState<"json" | "markdown" | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(artifactPath ?? null);
  const [decisionItemMode, setDecisionItemMode] = useState<"approval" | "choice" | "mixed">("approval");
  const [optimizationProposals, setOptimizationProposals] = useState<OptimizationProposalState[]>([]);
  const [optimizationActionId, setOptimizationActionId] = useState<string | null>(null);
  const [developerFeedback, setDeveloperFeedback] = useState<{ title: string; url: string } | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const frameScrollCleanupRef = useRef<(() => void) | null>(null);
  const commentActionCleanupRef = useRef<(() => void) | null>(null);
  const commentActionEnabledRef = useRef(true);
  const sectionObserverCleanupRef = useRef<(() => void) | null>(null);
  const overlayResizeObserverRef = useRef<ResizeObserver | null>(null);
  const decisionItemsRef = useRef<DecisionItem[]>([]);
  const currentArtifact = useMemo(() => issue?.artifacts.find((artifact) => artifact.path === selectedPath) ?? null, [issue, selectedPath]);
  const artifactTreeItems = useMemo(() => (issue?.artifacts ?? []).map((artifact) => ({ path: artifact.path })), [issue?.artifacts]);
  const context = useMemo(() => ({ gitServerId, projectId, issueNumber, mergeRequestNumber, artifactPath: currentArtifact?.path }), [currentArtifact?.path, gitServerId, issueNumber, mergeRequestNumber, projectId]);
  const artifactContext = useMemo(() => currentArtifact ? { ...context, artifactType: currentArtifact.type } : null, [context, currentArtifact]);
  commentActionEnabledRef.current = !commentComposerOpen && !editingDraftId;

  useEffect(() => {
    setBusy(true);
    setArtifactFormat(null);
    setError(null);
    setAgentPrompt(null);
    setSelectedDraftId(null);
    setCommentComposerOpen(false);
    setPendingDecision(null);
    decisionItemsRef.current = [];
    setDecisionItemMode("approval");
    setArtifactSections([]);
    setActiveSectionId(null);
    loadVisualArtifact(routeContext)
      .then((loaded) => {
        setIssue(loaded.issue);
        setSelectedPath(loaded.selectedPath);
        setDraftItems(loaded.drafts.filter(Boolean));
        setReviews(loaded.reviews);
        setArtifactHtml(loaded.html);
        setArtifactFormat(loaded.format);
        setOptimizationProposals(loaded.optimization?.proposals ?? []);
        if (!routeContext.artifactPath && typeof window !== "undefined") {
          const url = new URL(window.location.href);
          url.searchParams.set("path", loaded.selectedPath);
          window.history.replaceState(null, "", url);
        }
      })
      .catch((loadError) => {
        setIssue(null);
        setError(loadError instanceof Error ? loadError.message : "加载可视化产物失败");
      })
      .finally(() => setBusy(false));
  }, [routeContext]);

  useEffect(() => {
    if (!issue) return;
    setSelectedDraftId(null);
    setCommentComposerOpen(false);
    setPendingTarget(null);
    setPendingDecision(null);
    setVisualCommentText("");
    setArtifactSections([]);
    setActiveSectionId(null);
  }, [currentArtifact?.path, issue]);

  async function selectArtifact(path: string) {
    if (!path || path === currentArtifact?.path) return;
    setBusy(true);
    setArtifactFormat(null);
    setError(null);
    setAgentPrompt(null);
    setSelectedDraftId(null);
    setCommentComposerOpen(false);
    setPendingTarget(null);
    setPendingDecision(null);
    setEditingDraftId(null);
    setArtifactSections([]);
    setActiveSectionId(null);
    try {
      const loaded = await loadVisualArtifact({ gitServerId, projectId, issueNumber, mergeRequestNumber, artifactPath: path });
      setIssue(loaded.issue);
      setSelectedPath(loaded.selectedPath);
      setDraftItems(loaded.drafts.filter(Boolean));
      setReviews(loaded.reviews);
      setArtifactHtml(loaded.html);
      setArtifactFormat(loaded.format);
      setOptimizationProposals(loaded.optimization?.proposals ?? []);
      const url = new URL(window.location.href);
      url.searchParams.set("path", loaded.selectedPath);
      window.history.pushState(null, "", url);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载预览文件失败");
    } finally {
      setBusy(false);
    }
  }

  const refreshVisualPositions = useCallback(() => setVisualTick((value) => value + 1), []);

  function syncActiveSection() {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    const visible = Array.from(doc.querySelectorAll(NAVIGATION_SELECTOR)).filter(isVisibleArtifactSection);
    if (!visible.length) {
      setActiveSectionId(null);
      return;
    }
    const frameWindow = frameRef.current?.contentWindow;
    const root = doc.documentElement;
    if (frameWindow && frameWindow.scrollY + frameWindow.innerHeight >= root.scrollHeight - 8) {
      setActiveSectionId(visible.at(-1)?.getAttribute("data-agentrix-section-id") ?? null);
      return;
    }
    const active = visible.reduce((candidate, section) => (
      section.getBoundingClientRect().top <= 120 ? section : candidate
    ), visible[0]);
    setActiveSectionId(active.getAttribute("data-agentrix-section-id"));
  }

  // Bind scroll/resize tracking to the artifact's *current* contentWindow. This must run
  // on every iframe load, not on a render-time effect: in bridge mode the artifact is a
  // srcDoc whose real document arrives asynchronously and replaces the placeholder document,
  // so a listener attached before that load lands on a stale window and never fires. Without
  // a live scroll listener, browse-mode markers never reposition — off-screen markers stay
  // clipped and visible ones drift off their target.
  const bindFrameScroll = useCallback(() => {
    frameScrollCleanupRef.current?.();
    frameScrollCleanupRef.current = null;
    const frameWindow = frameRef.current?.contentWindow;
    const frameDocument = frameRef.current?.contentDocument;
    if (!frameWindow) return;
    const handleFrameViewportChange = () => {
      refreshVisualPositions();
      syncActiveSection();
    };
    frameWindow.addEventListener("scroll", handleFrameViewportChange, { passive: true });
    frameWindow.addEventListener("resize", refreshVisualPositions);
    const FrameResizeObserver = (frameWindow as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    const resizeObserver = typeof FrameResizeObserver === "function"
      ? new FrameResizeObserver(refreshVisualPositions)
      : null;
    if (resizeObserver && frameDocument) {
      resizeObserver.observe(frameDocument.documentElement);
      if (frameDocument.body) resizeObserver.observe(frameDocument.body);
    }
    frameScrollCleanupRef.current = () => {
      frameWindow.removeEventListener("scroll", handleFrameViewportChange);
      frameWindow.removeEventListener("resize", refreshVisualPositions);
      resizeObserver?.disconnect();
    };
  }, [currentArtifact?.path, refreshVisualPositions]);

  function isInteractiveDecisionRef(ref: string | undefined) {
    return Boolean(ref && interactiveDecisionRefs(decisionItemsRef.current).has(ref));
  }

  function decisionTargetFromElement(element: Element, item: DecisionItem, option?: DecisionOption): DecisionAnchorTarget | null {
    if (!currentArtifact || !overlayRef.current) return null;
    return {
      ref: item.ref,
      id: item.id,
      question: item.question,
      type: item.type,
      optionId: option?.id,
      optionLabel: option?.label,
      visualTarget: makeDecisionVisualTarget(currentArtifact, overlayRef.current, frameRef.current, element)
    };
  }

  function commentTargetFromElement(element: Element): VisualTarget | null {
    if (!currentArtifact || !overlayRef.current) return null;
    const scope = element.getAttribute("data-comment-scope")?.trim() || "item";
    if (scope === "edge") return null;
    if (isInteractiveDecisionRef(element.getAttribute("data-ref")?.trim())) return null;
    return makeElementVisualTarget(currentArtifact, overlayRef.current, frameRef.current, element, `${scope} 内容项`);
  }

  function findCommentableElement(start: Element | null): Element | null {
    for (let node: Element | null = start; node; node = node.parentElement) {
      const scope = node.getAttribute("data-comment-scope")?.trim();
      if (!scope || scope === "edge") continue;
      if (isInteractiveDecisionRef(node.getAttribute("data-ref")?.trim())) return null;
      const tagName = node.tagName.toLowerCase();
      if (["path", "line", "polyline", "polygon"].includes(tagName)) return null;
      return node;
    }
    return null;
  }

  function injectCommentActionControl() {
    const doc = frameRef.current?.contentDocument;
    if (!doc || !currentArtifact) return;
    try {
      commentActionCleanupRef.current?.();
      commentActionCleanupRef.current = null;
      ensureCommentActionStyle(doc);
      doc.querySelectorAll(`.${COMMENT_ACTION_CLASS}`).forEach((node) => node.remove());
      if (!doc.querySelector(COMMENTABLE_SELECTOR)) return;

      const button = doc.createElement("button");
      let activeElement: Element | null = null;
      let activeRange: Range | null = null;
      let activeTarget: VisualTarget | null = null;
      button.type = "button";
      button.className = COMMENT_ACTION_CLASS;
      button.textContent = "评论";
      button.setAttribute("data-agentrix-injected", "comment-action");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const target = activeTarget ?? (activeElement ? commentTargetFromElement(activeElement) : null);
        if (target) {
          commentActionEnabledRef.current = false;
          hide();
          openElementComment(target);
        }
      });

      const hide = () => {
        activeElement = null;
        activeRange = null;
        activeTarget = null;
        button.removeAttribute("data-agentrix-visible");
      };
      const positionForRect = (rect: DOMRect) => {
        if (rect.width <= 0 || rect.height <= 0) {
          hide();
          return;
        }
        button.style.left = `${Math.max(8, Math.min(doc.documentElement.clientWidth - 96, rect.right - 16))}px`;
        button.style.top = `${Math.max(8, rect.top + 8)}px`;
        button.setAttribute("data-agentrix-visible", "true");
      };
      const positionFor = (element: Element) => positionForRect(element.getBoundingClientRect());
      const captureSelection = () => {
        if (!commentActionEnabledRef.current) return false;
        if (artifactFormat !== "markdown" || !overlayRef.current || !currentArtifact) return false;
        const selection = doc.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
        const range = selection.getRangeAt(0).cloneRange();
        const element = selectionBlock(range);
        if (!element) return false;
        const target = makeSelectionVisualTarget(currentArtifact, overlayRef.current, frameRef.current, range, element);
        if (!target) return false;
        activeElement = element;
        activeRange = range;
        activeTarget = target;
        positionForRect(range.getBoundingClientRect());
        return true;
      };
      const activateFromEvent = (event: Event) => {
        if (!commentActionEnabledRef.current) {
          hide();
          return;
        }
        const target = eventElementTarget(event, doc);
        if (!target || button.contains(target)) return;
        if (activeRange && !doc.getSelection()?.isCollapsed) return;
        const element = findCommentableElement(target);
        if (!element) {
          if (!activeElement || !target.closest(COMMENTABLE_SELECTOR)) hide();
          return;
        }
        activeElement = element;
        activeRange = null;
        activeTarget = null;
        positionFor(element);
      };
      const refreshPosition = () => {
        if (activeRange) positionForRect(activeRange.getBoundingClientRect());
        else if (activeElement) positionFor(activeElement);
      };
      const captureSelectionAfterInput = () => frameRef.current?.contentWindow?.setTimeout(() => {
        if (!captureSelection() && activeRange) hide();
      }, 0);

      const frameWindow = frameRef.current?.contentWindow;
      doc.addEventListener("pointerover", activateFromEvent);
      doc.addEventListener("focusin", activateFromEvent);
      doc.addEventListener("pointerup", captureSelectionAfterInput);
      doc.addEventListener("keyup", captureSelectionAfterInput);
      doc.addEventListener("scroll", refreshPosition, true);
      frameWindow?.addEventListener("resize", refreshPosition);
      doc.body?.appendChild(button);
      commentActionCleanupRef.current = () => {
        doc.removeEventListener("pointerover", activateFromEvent);
        doc.removeEventListener("focusin", activateFromEvent);
        doc.removeEventListener("pointerup", captureSelectionAfterInput);
        doc.removeEventListener("keyup", captureSelectionAfterInput);
        doc.removeEventListener("scroll", refreshPosition, true);
        frameWindow?.removeEventListener("resize", refreshPosition);
        button.remove();
      };
    } catch {
      // Cross-origin or transient iframe states should not break artifact review.
    }
  }

  function injectDecisionActionControls() {
    const doc = frameRef.current?.contentDocument;
    if (!doc || !currentArtifact) return;
    try {
      ensureDecisionActionStyle(doc);
      doc.querySelectorAll(`.${DECISION_ACTIONS_CLASS}`).forEach((node) => node.remove());
      decisionItemsRef.current = currentArtifact.type === "decision" ? decisionItemsFromDocument(doc) : [];
      const hasChoice = decisionItemsRef.current.some((item) => item.type === "choice");
      const hasApproval = decisionItemsRef.current.some((item) => item.type === "approval");
      setDecisionItemMode(hasChoice && hasApproval ? "mixed" : hasChoice ? "choice" : "approval");
      if (currentArtifact.type !== "decision" || currentArtifact.status === "approved") return;
      for (const item of decisionItemsRef.current) {
        const element = doc.querySelector(`[data-ref="${cssEscape(item.ref)}"]`);
        if (!element) continue;
        if (item.type === "choice") {
          for (const option of item.options) {
            const optionElement = doc.querySelector(`[data-ref="${cssEscape(option.ref)}"]`);
            if (!optionElement) continue;
            const actions = doc.createElement("div");
            actions.className = DECISION_ACTIONS_CLASS;
            actions.setAttribute("data-agentrix-injected", "decision-actions");
            actions.setAttribute("data-agentrix-decision-ref", item.ref);
            const select = doc.createElement("button");
            const selected = scopedDraftItems.some((draft) => draft.decision?.ref === item.ref && draft.decision.action === "select" && draft.decision.optionId === option.id);
            select.type = "button";
            select.textContent = selected ? "已选择" : "选择";
            select.setAttribute("data-agentrix-decision-action", "select");
            select.setAttribute("aria-pressed", String(selected));
            select.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              const target = decisionTargetFromElement(optionElement, item, option);
              if (target) selectDecisionOption(target);
            });
            actions.append(select);
            optionElement.appendChild(actions);
          }
        }
        const actions = doc.createElement("div");
        actions.className = DECISION_ACTIONS_CLASS;
        actions.setAttribute("data-agentrix-injected", "decision-actions");
        actions.setAttribute("data-agentrix-decision-ref", item.ref);

        if (item.type === "approval") {
          const approve = doc.createElement("button");
          const approved = scopedDraftItems.some((draft) => draft.decision?.ref === item.ref && draft.decision.action === "approve");
          approve.type = "button";
          approve.textContent = approved ? "已通过" : "通过";
          approve.setAttribute("data-agentrix-decision-action", "approve");
          approve.setAttribute("aria-pressed", String(approved));
          approve.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const target = decisionTargetFromElement(element, item);
            if (target) approveDecision(target);
          });
          actions.append(approve);
        }

        const discuss = doc.createElement("button");
        discuss.type = "button";
        discuss.textContent = "讨论";
        discuss.setAttribute("data-agentrix-decision-action", "discuss");
        discuss.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const target = decisionTargetFromElement(element, item);
          if (target) discussDecision(target);
        });

        actions.append(discuss);
        element.appendChild(actions);
      }
    } catch {
      // Cross-origin or transient iframe states should not break artifact review.
    }
  }

  function injectOptimizationActionControls() {
    const doc = frameRef.current?.contentDocument;
    if (!doc || currentArtifact?.type !== "optimization") return;
    try {
      if (!doc.getElementById(OPTIMIZATION_ACTION_STYLE_ID)) {
        const style = doc.createElement("style");
        style.id = OPTIMIZATION_ACTION_STYLE_ID;
        style.textContent = `
          [data-optimization-actions] button { appearance:none; min-height:34px; border:1px solid #d4d4d8; border-radius:7px; padding:6px 12px; background:#fff; color:#27272a; font:700 12px/1.2 ui-sans-serif,system-ui,sans-serif; cursor:pointer; }
          [data-optimization-actions] button[data-action="approve"] { border-color:#18181b; background:#18181b; color:#fff; }
          [data-optimization-actions] button:disabled { cursor:wait; opacity:.55; }
        `;
        doc.head?.appendChild(style);
      }
      const states = new Map(optimizationProposals.map((proposal) => [proposal.id, proposal]));
      doc.querySelectorAll<HTMLElement>("[data-optimization-actions]").forEach((container) => {
        container.replaceChildren();
        const proposalId = container.dataset.optimizationActions ?? "";
        const proposal = states.get(proposalId);
        if (!proposal || proposal.state !== "pending") return;
        if (container.dataset.optimizationKind === "project-developer-feedback") return;
        const feedback = container.dataset.optimizationKind === "issue-flow-feedback";
        const approve = doc.createElement("button");
        approve.type = "button";
        approve.dataset.action = "approve";
        approve.textContent = optimizationActionId === proposalId
          ? feedback ? "正在复制…" : "正在创建…"
          : feedback ? "复制给开发者" : "通过并创建 Issue";
        approve.disabled = Boolean(optimizationActionId);
        approve.addEventListener("click", () => void (feedback ? copyDeveloperFeedback(proposalId) : handleOptimizationAction(proposalId, "approve")));
        container.append(approve);
        if (feedback) return;
        const ignore = doc.createElement("button");
        ignore.type = "button";
        ignore.dataset.action = "ignore";
        ignore.textContent = optimizationActionId === proposalId ? "处理中…" : "忽略";
        ignore.disabled = Boolean(optimizationActionId);
        ignore.addEventListener("click", () => void handleOptimizationAction(proposalId, "ignore"));
        container.append(ignore);
      });
    } catch {
      // Cross-origin or transient iframe states should not break artifact actions.
    }
  }

  function scanArtifactSections() {
    const doc = frameRef.current?.contentDocument;
    if (!doc) {
      setArtifactSections([]);
      return;
    }
    try {
      const seenSections = new Set<string>();
      const sections = Array.from(doc.querySelectorAll(NAVIGATION_SELECTOR))
        .map((element, index) => ({ element, index }))
        .filter(({ element }) => isVisibleArtifactSection(element))
        .filter(({ element }) => !findDataRef(element)?.startsWith("decisions."))
        .map(({ element, index }) => {
          const id = `agentrix-section-${index + 1}`;
          element.setAttribute("data-agentrix-section-id", id);
          return {
            id,
            label: sectionLabel(element, index),
            ref: findDataRef(element),
            level: Number.parseInt(element.getAttribute("data-section-level") ?? "", 10) || undefined
          };
        })
        .filter((section) => {
          const key = section.ref ?? section.label.trim().toLocaleLowerCase();
          if (seenSections.has(key)) return false;
          seenSections.add(key);
          return true;
        });
      setArtifactSections(sections);
      setActiveSectionId((current) => sections.some((section) => section.id === current) ? current : sections[0]?.id ?? null);
    } catch {
      setArtifactSections([]);
      setActiveSectionId(null);
    }
  }

  function observeArtifactSections() {
    sectionObserverCleanupRef.current?.();
    sectionObserverCleanupRef.current = null;
    const doc = frameRef.current?.contentDocument;
    const FrameMutationObserver = (frameRef.current?.contentWindow as unknown as { MutationObserver?: typeof MutationObserver } | null)?.MutationObserver;
    if (!doc?.body || typeof FrameMutationObserver !== "function") return;
    const observer = new FrameMutationObserver(() => {
      scanArtifactSections();
      syncActiveSection();
    });
    observer.observe(doc.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "class", "style"]
    });
    sectionObserverCleanupRef.current = () => observer.disconnect();
  }

  function scrollToArtifactSection(sectionId: string) {
    const doc = frameRef.current?.contentDocument;
    const element = doc?.querySelector(`[data-agentrix-section-id="${cssEscape(sectionId)}"]`);
    if (!element) return;
    setActiveSectionId(sectionId);
    element.scrollIntoView({ behavior: "smooth", block: "start" });
    refreshVisualPositions();
  }

  function handleFrameLoad() {
    bindFrameScroll();
    injectDecisionActionControls();
    injectOptimizationActionControls();
    injectCommentActionControl();
    scanArtifactSections();
    observeArtifactSections();
    syncActiveSection();
    refreshVisualPositions();
  }

  useEffect(() => {
    if (currentArtifact?.type === "decision") injectDecisionActionControls();
  }, [currentArtifact?.status, draftItems]);

  useEffect(() => {
    if (currentArtifact?.type === "optimization") injectOptimizationActionControls();
  }, [currentArtifact?.type, optimizationProposals, optimizationActionId]);

  useEffect(() => {
    window.addEventListener("resize", refreshVisualPositions);
    if (overlayRef.current && typeof ResizeObserver === "function") {
      overlayResizeObserverRef.current = new ResizeObserver(refreshVisualPositions);
      overlayResizeObserverRef.current.observe(overlayRef.current);
    }
    return () => {
      window.removeEventListener("resize", refreshVisualPositions);
      frameScrollCleanupRef.current?.();
      frameScrollCleanupRef.current = null;
      commentActionCleanupRef.current?.();
      commentActionCleanupRef.current = null;
      sectionObserverCleanupRef.current?.();
      sectionObserverCleanupRef.current = null;
      overlayResizeObserverRef.current?.disconnect();
      overlayResizeObserverRef.current = null;
    };
  }, [currentArtifact?.path, refreshVisualPositions]);

  const scopedDraftItems = useMemo(() => currentArtifact ? draftItems.filter((item) => draftBelongsToArtifact(item, currentArtifact)) : [], [currentArtifact, draftItems]);
  const orderedDraftItems = useMemo(() => [...scopedDraftItems].sort(compareDraftDocumentOrder), [scopedDraftItems]);
  const submittedReviewItems = useMemo(() => currentArtifact
    ? reviews.flatMap((review) => review.payload?.items ?? []).filter((item) => draftBelongsToArtifact(item, currentArtifact))
    : [], [currentArtifact, reviews]);
  const reviewMarkerItems = useMemo(() => [...orderedDraftItems, ...submittedReviewItems].sort(compareDraftDocumentOrder), [orderedDraftItems, submittedReviewItems]);
  const editingDraft = scopedDraftItems.find((item) => item.id === editingDraftId) ?? null;
  const hasDecisionDiscussion = scopedDraftItems.some((item) => item.decision?.action === "discuss");
  const decisionApprovalState = [
    currentArtifact?.status === "approved" && "approved",
    submittingReview && "submitting",
    hasDecisionDiscussion && "discussion",
    decisionItemMode
  ].find(Boolean) as "approved" | "submitting" | "discussion" | typeof decisionItemMode;
  const approvalLabel = currentArtifact?.type === "decision"
    ? {
      approved: "决策已完成",
      submitting: "正在提交…",
      discussion: "通过其他决策",
      choice: "采用全部推荐",
      mixed: "完成全部推荐",
      approval: "全部通过"
    }[decisionApprovalState]
    : currentArtifact?.status === "approved" ? "方案已通过" : "通过方案";
  void visualTick;

  async function addFeedbackToDraft(input: Partial<FeedbackRequest> = {}, options: { resetVisual?: boolean } = {}) {
    if (!issue || !currentArtifact || !artifactContext) return false;
    const comment = input.comment?.trim();
    if (!comment) return false;
    setAgentPrompt(null);
    setError(null);
    try {
      const item = addStoredReviewDraft(artifactContext, {
        targetType: input.targetType ?? "artifact",
        targetId: input.targetId ?? currentArtifact.path,
        sourceRefs: input.sourceRefs ?? [{ type: sourceRefTypeForArtifact(currentArtifact.type), path: currentArtifact.path, label: artifactLabel(currentArtifact.type) }],
        visualTarget: input.visualTarget,
        decision: input.decision,
        comment,
        severity: input.severity ?? "note",
        intent: input.intent ?? "refinement"
      });
      setDraftItems((items) => [...items.filter(Boolean), item]);
      setSelectedDraftId(item.id);
      if (options.resetVisual) setVisualCommentText("");
      setCommentComposerOpen(false);
      setPendingTarget(null);
      setPendingDecision(null);
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "添加审阅意见失败");
      return false;
    }
  }

  function openElementComment(target: VisualTarget) {
    setReviewCollapsed(false);
    setCommentComposerOpen(true);
    setPendingTarget(target);
    setPendingDecision(null);
    setVisualCommentText("");
    setEditingDraftId(null);
  }

  function saveVisualComment() {
    const visualTarget = pendingTarget ?? undefined;
    void addFeedbackToDraft({ comment: visualCommentText, visualTarget }, { resetVisual: true });
  }

  function openOverallComment() {
    setCommentComposerOpen(true);
    setPendingTarget(null);
    setPendingDecision(null);
    setEditingDraftId(null);
    setVisualCommentText("");
  }

  function decisionReviewPayload(decision: DecisionAnchorTarget, action: DecisionReview["action"]): DecisionReview {
    return {
      action,
      ref: decision.ref,
      id: decision.id,
      question: decision.question,
      optionId: decision.optionId,
      optionLabel: decision.optionLabel
    };
  }

  async function addDecisionReview(decision: DecisionAnchorTarget, action: DecisionReview["action"], comment: string) {
    if (!currentArtifact || !artifactContext) return;
    const input: FeedbackRequest = {
      targetType: "artifact",
      targetId: decision.ref,
      sourceRefs: [{ type: sourceRefTypeForArtifact(currentArtifact?.type ?? "plan"), path: currentArtifact?.path ?? "plan/data/plan.json.isv", label: artifactLabel(currentArtifact?.type ?? "plan") }],
      visualTarget: decision.visualTarget,
      decision: decisionReviewPayload(decision, action),
      comment,
      severity: "note",
      intent: action === "discuss" ? "question" : "refinement"
    };
    setError(null);
    try {
      const existing = scopedDraftItems.find((item) => item.decision?.ref === decision.ref);
      const saved = existing
        ? updateStoredReviewDraft(artifactContext, existing.id, input)
        : addStoredReviewDraft(artifactContext, input);
      setDraftItems((items) => existing
        ? items.map((item) => item.id === existing.id ? saved : item)
        : [...items.filter(Boolean), saved]);
      setSelectedDraftId(saved.id);
      setVisualCommentText("");
      setPendingDecision(null);
      setPendingTarget(null);
      setCommentComposerOpen(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存决策失败");
    }
  }

  function approveDecision(decision: DecisionAnchorTarget) {
    const label = decision.question ?? decision.ref;
    void addDecisionReview(decision, "approve", `通过决策：${label}`);
  }

  function selectDecisionOption(decision: DecisionAnchorTarget) {
    const label = decision.optionLabel ?? decision.optionId ?? decision.ref;
    void addDecisionReview(decision, "select", `选择方案：${label}`);
  }

  function discussDecision(decision: DecisionAnchorTarget) {
    setCommentComposerOpen(true);
    setPendingDecision(decision);
    setPendingTarget(decision.visualTarget);
    setEditingDraftId(null);
    setVisualCommentText("");
  }

  function saveDecisionDiscussion() {
    if (!pendingDecision) return;
    const comment = visualCommentText.trim();
    if (!comment) return;
    void addDecisionReview(pendingDecision, "discuss", comment);
  }

  function openDraftEditor(item: DraftReviewItem) {
    setSelectedDraftId(item.id);
    setEditingDraftId(item.id);
    setVisualCommentText(item.comment);
    setPendingTarget(null);
    setPendingDecision(null);
    setCommentComposerOpen(false);
  }

  function selectDraft(item: DraftReviewItem) {
    setSelectedDraftId(item.id);
    if (!item.visualTarget || !overlayRef.current) return;
    const metrics = measureFrame(frameRef.current, overlayRef.current);
    const position = resolveVisualTargetPosition(item.visualTarget, metrics, frameRef.current?.contentDocument ?? null);
    frameRef.current?.contentWindow?.scrollTo({
      left: Math.max(0, position.documentX - metrics.viewportWidth / 2),
      top: Math.max(0, position.documentY - metrics.viewportHeight / 2),
      behavior: "smooth"
    });
  }

  async function updateExistingDraft() {
    if (!issue || !editingDraft || !artifactContext) return;
    const comment = visualCommentText.trim();
    if (!comment) return;
    setAgentPrompt(null);
    setError(null);
    try {
      const updated = updateStoredReviewDraft(artifactContext, editingDraft.id, {
        targetType: editingDraft.targetType,
        targetId: editingDraft.targetId,
        sourceRefs: editingDraft.sourceRefs,
        visualTarget: editingDraft.visualTarget,
        decision: editingDraft.decision,
        comment,
        severity: "note",
        intent: "refinement"
      });
      setDraftItems((items) => items.map((item) => item.id === updated.id ? updated : item));
      setSelectedDraftId(updated.id);
      setEditingDraftId(null);
      setPendingTarget(null);
      setCommentComposerOpen(false);
      setVisualCommentText("");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "更新审阅意见失败");
    }
  }

  function closeCommentModal() {
    setPendingTarget(null);
    setPendingDecision(null);
    setCommentComposerOpen(false);
    setEditingDraftId(null);
    setVisualCommentText("");
  }

  async function removeReviewItem(itemId: string) {
    if (!issue || !artifactContext) return;
    setError(null);
    try {
      deleteStoredReviewDraft(artifactContext, itemId);
      setDraftItems((items) => items.filter((item) => item.id !== itemId));
      if (editingDraftId === itemId) closeCommentModal();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除审阅意见失败");
    }
  }

  async function confirmSubmitReview() {
    if (!issue || !artifactContext || !currentArtifact || !orderedDraftItems.length) return;
    const reviewedArtifact = currentArtifact;
    setSubmittingReview(true);
    setError(null);
    try {
      const result = await submitReviewDraft(context, orderedDraftItems);
      const submittedIds = new Set(orderedDraftItems.map((item) => item.id));
      setDraftItems((items) => items.filter((item) => !submittedIds.has(item.id)));
      if (result.status === "approved") {
        clearReviewStorage(artifactContext);
        setReviews([]);
      } else {
        saveSubmittedReview(artifactContext, result.review);
        setReviews((items) => [result.review, ...items]);
      }
      setIssue((loaded) => loaded ? { ...loaded, artifacts: loaded.artifacts.map((artifact) => artifact.path === reviewedArtifact.path ? { ...artifact, status: result.status } : artifact) } : loaded);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "提交审阅失败");
    } finally {
      setSubmittingReview(false);
    }
  }

  async function approvePlan() {
    if (!issue || !artifactContext || !currentArtifact) return;
    const reviewedArtifact = currentArtifact;
    setAgentPrompt(null);
    setError(null);
    try {
      const result = await approveVisionArtifact(context);
      clearReviewStorage(artifactContext);
      setDraftItems([]);
      setReviews([]);
      setIssue((loaded) => loaded ? { ...loaded, artifacts: loaded.artifacts.map((artifact) => artifact.path === reviewedArtifact.path ? { ...artifact, status: result.artifact.status } : artifact) } : loaded);
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : "通过方案失败");
    }
  }

  async function approveEveryDecision() {
    if (!issue || !artifactContext || currentArtifact?.type !== "decision") return;
    const reviewedArtifact = currentArtifact;
    setSubmittingReview(true);
    setAgentPrompt(null);
    setError(null);
    try {
      const result = await approveAllDecisions(context, orderedDraftItems);
      setDraftItems((items) => items.filter((item) => !draftBelongsToArtifact(item, reviewedArtifact)));
      if (result.status === "approved") {
        clearReviewStorage(artifactContext);
        setReviews([]);
      } else {
        saveSubmittedReview(artifactContext, result.review);
        setReviews((items) => [result.review, ...items]);
      }
      setIssue((loaded) => loaded ? { ...loaded, artifacts: loaded.artifacts.map((artifact) => artifact.path === reviewedArtifact.path ? { ...artifact, status: result.status } : artifact) } : loaded);
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : "全部通过失败");
    } finally {
      setSubmittingReview(false);
    }
  }

  async function handleOptimizationAction(proposalId: string, action: "approve" | "ignore") {
    if (currentArtifact?.type !== "optimization") return;
    setOptimizationActionId(proposalId);
    setError(null);
    try {
      await actOnOptimizationProposal(context, proposalId, action);
      const loaded = await loadVisualArtifact(context);
      setIssue(loaded.issue);
      setArtifactHtml(loaded.html);
      setArtifactFormat(loaded.format);
      setDraftItems(loaded.drafts.filter(Boolean));
      setReviews(loaded.reviews);
      setOptimizationProposals(loaded.optimization?.proposals ?? []);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "处理优化方案失败");
    } finally {
      setOptimizationActionId(null);
    }
  }

  async function copyDeveloperFeedback(proposalId: string) {
    const proposal = optimizationProposals.find((item) => item.id === proposalId);
    if (!proposal?.feedback) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(proposal.feedback.text);
      setDeveloperFeedback({ title: proposal.feedback.title, url: proposal.feedback.url });
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "复制开发者反馈失败");
    }
  }

  async function copyAgentPrompt() {
    if (!agentPrompt) return;
    await navigator.clipboard?.writeText(agentPrompt);
  }

  const visualTargetStyles = useMemo(() => {
    const overlay = overlayRef.current;
    const frame = frameRef.current;
    return new Map(reviewMarkerItems
      .filter((item) => item.visualTarget)
      .map((item) => [item.id, visualTargetStyle(item.visualTarget!, overlay, frame)]));
  }, [reviewMarkerItems, visualTick]);

  return (
    <main className={`vision-plan-page artifact-engine is-review-workspace ${reviewCollapsed ? "is-comments-collapsed" : ""}`}>
      <header className="review-workspace-header">
        <div className="artifact-heading">
          {!embedded ? <a className="artifact-back-link" href={`/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/issues`} aria-label="返回 Issues 看板" title="返回 Issues 看板"><ArrowLeft size={17} /></a> : null}
          <div>
            <strong>{currentArtifact ? `${artifactLabel(currentArtifact.type)}审阅` : "产物审阅"}</strong>
            <span>{issue ? issue.title : `议题 #${issueNumber}`}</span>
          </div>
        </div>
        <div className="toolbar-actions">
          {issue && issue.artifacts.length > 1 ? (
            <label className="artifact-file-select">
              <span>预览文件</span>
              <select value={currentArtifact?.path ?? ""} onChange={(event) => void selectArtifact(event.currentTarget.value)}>
                {issue.artifacts.map((artifact) => <option key={artifact.path} value={artifact.path}>{artifact.path}</option>)}
              </select>
            </label>
          ) : null}
          {!embedded ? issue?.mergeRequests.map((mergeRequest) => (
            <a
              key={mergeRequest.number}
              href={`/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/merge-requests/${mergeRequest.number}`}
              title={mergeRequest.title}
            >
              <GitPullRequest size={16} />查看 MR #{mergeRequest.number}
            </a>
          )) : null}
        </div>
      </header>

      <aside className="workspace-panel">
        {issue ? (
          <section className="panel-section navigation-section">
            <div className="artifact-directory">
              {issue.artifacts.length > 1 ? <>
                <div className="artifact-file-list">
                  <div className="artifact-nav-label"><strong>文件</strong><span>{issue.artifacts.length}</span></div>
                  <FileTree ariaLabel="MR 预览文件" items={artifactTreeItems} activePath={currentArtifact?.path} onSelect={(path) => void selectArtifact(path)} />
                </div>
                <div className="artifact-nav-divider" />
              </> : null}
              <div className="artifact-nav-label"><strong>章节</strong><span>{artifactSections.length}</span></div>
              {artifactSections.length ? (
                <nav className="artifact-section-tree" aria-label={`${currentArtifact ? artifactLabel(currentArtifact.type) : "产物"}章节`}>
                  {artifactSections.map((section) => (
                    <button key={section.id} type="button" data-level={section.level} className={section.id === activeSectionId ? "is-active" : ""} onClick={() => scrollToArtifactSection(section.id)}>
                      <span>{section.label}</span>
                    </button>
                  ))}
                </nav>
              ) : <p className="muted">当前{currentArtifact ? artifactLabel(currentArtifact.type) : "产物"}没有可导航的章节</p>}
            </div>
          </section>
        ) : null}
      </aside>

      <section className="artifact-stage">
        {developerFeedback ? (
          <div className="developer-feedback-banner">
            <div><strong>反馈建议已复制</strong><span>{developerFeedback.title}</span></div>
            <a href={developerFeedback.url} target="_blank" rel="noreferrer">打开 GitHub 并粘贴正文</a>
            <button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setDeveloperFeedback(null)}><X size={14} /></button>
          </div>
        ) : null}
        {agentPrompt ? (
          <div className="agent-prompt-banner">
            <strong>发送给智能体</strong>
            <span>{agentPrompt}</span>
            <button type="button" onClick={copyAgentPrompt}>复制消息</button>
            <button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setAgentPrompt(null)}><X size={14} /></button>
          </div>
        ) : null}

        <div className="artifact-frame-wrap">
          {busy ? <div className="empty-state">正在加载 MR Preview…</div> : !currentArtifact && error ? <div className="empty-state"><pre className="error-box">{error}</pre></div> : currentArtifact ? (
            <>
              <iframe
                ref={frameRef}
                key={`${issue?.issueId}-${currentArtifact.path}`}
                title={`${issue?.issueId} ${artifactLabel(currentArtifact.type)}`}
                srcDoc={artifactHtml ?? "<!doctype html><body>正在加载产物…</body>"}
                className="artifact-frame"
                onLoad={handleFrameLoad}
              />
              <div
                ref={overlayRef}
                className="annotation-overlay"
              >
                {reviewMarkerItems.map((item) => item.visualTarget ? (
                  item.visualTarget.kind === "point" ? (
                    <span
                      key={item.id}
                      className={`marker point ${selectedDraftId === item.id ? "is-selected" : ""}`}
                      style={{ left: visualTargetStyles.get(item.id)?.left, top: visualTargetStyles.get(item.id)?.top }}
                      title={item.comment}
                      aria-hidden="true"
                    />
                  ) : (
                    <span
                      key={item.id}
                      className={`marker region ${selectedDraftId === item.id ? "is-selected" : ""}`}
                      style={{
                        left: visualTargetStyles.get(item.id)?.left,
                        top: visualTargetStyles.get(item.id)?.top,
                        width: visualTargetStyles.get(item.id)?.width,
                        height: visualTargetStyles.get(item.id)?.height
                      }}
                      title={item.comment}
                      aria-hidden="true"
                    />
                  )
                ) : null)}
              </div>
            </>
          ) : (
            <div className="empty-state">当前 MR 没有可预览的文件</div>
          )}
        </div>
      </section>

      {artifactFormat && currentArtifact && !reviewCollapsed ? (
        <ArtifactReviewPanel
          approvable={currentArtifact.workflow === "plan"}
          approved={currentArtifact.status === "approved"}
          approvalLabel={approvalLabel}
          approvalEnabled={currentArtifact.type !== "optimization"}
          approveWithDrafts={currentArtifact.type === "decision"}
          composerOpen={commentComposerOpen && !editingDraft}
          commentText={visualCommentText}
          drafts={orderedDraftItems}
          editingDraft={editingDraft}
          error={error}
          pendingTarget={pendingTarget}
          reviews={reviews}
          selectedDraftId={selectedDraftId}
          submitting={submittingReview}
          onApprove={currentArtifact.type === "decision" ? approveEveryDecision : approvePlan}
          onCancelComment={closeCommentModal}
          onChangeComment={setVisualCommentText}
          onCollapse={() => setReviewCollapsed(true)}
          onEditDraft={openDraftEditor}
          onOpenOverallComment={openOverallComment}
          onRemoveDraft={removeReviewItem}
          onSelectDraft={selectDraft}
          onSaveComment={pendingDecision ? saveDecisionDiscussion : saveVisualComment}
          onSubmit={confirmSubmitReview}
          onUpdateComment={updateExistingDraft}
        />
      ) : null}

      {artifactFormat && currentArtifact && reviewCollapsed ? (
        <button type="button" className="collapsed-review-bubble" aria-label={`展开评论区，当前 ${reviewMarkerItems.length} 条评论`} onClick={() => setReviewCollapsed(false)}>
          <MessageCircle size={16} />评论({reviewMarkerItems.length})
        </button>
      ) : null}

    </main>
  );
}
