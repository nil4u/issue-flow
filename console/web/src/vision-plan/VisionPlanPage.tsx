import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, Clipboard, FileText, GitPullRequest, MessageCircle, Send, Trash2, X } from "lucide-react";
import { approveAllDecisions, approveVisionArtifact, loadVisualArtifact, submitReviewDraft } from "./api";
import { anchorSelector, findDataRef, formatPlanDataSnippet, parsePlanDataIsland, PLAN_DATA_ISLAND_ID, resolvePlanDataRef } from "./anchors";
import { decisionItemsFromDocument, interactiveDecisionRefs, type DecisionItem, type DecisionOption } from "./decision-items";
import { anchorOffsetForPoint, resolveVisualTargetPosition, visualTargetMarkerStyle, type MarkerFrameMetrics } from "./marker-position";
import { addStoredReviewDraft, clearReviewStorage, deleteStoredReviewDraft, saveSubmittedReview, updateStoredReviewDraft } from "./review-storage";
import type { ArtifactType, DecisionReview, DraftReviewItem, FeedbackRequest, IssueArtifact, LoadedIssue, VisionRouteContext, VisualReview, VisualTarget } from "./types";
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
};

function artifactLabel(type: ArtifactType) {
  if (type === "decision") return "决策";
  return "方案";
}

function artifactStatusLabel(status = "pending") {
  if (status === "approved") return "已通过";
  return "待审阅";
}

function reviewStatusLabel(status = "changes-requested") {
  return status === "approved" ? "已通过" : "已提交";
}

function feedbackIntentLabel(intent: FeedbackRequest["intent"]) {
  if (intent === "defect") return "缺陷";
  if (intent === "question") return "疑问";
  return "优化";
}

function decisionActionLabel(action: DecisionReview["action"]) {
  if (action === "approve") return "通过";
  if (action === "select") return "选择";
  return "讨论";
}

function reviewItemLocation(item: DraftReviewItem) {
  const target = item.visualTarget;
  const element = target?.element ?? target?.elements?.[0];
  return target?.anchorRef
    ?? element?.dataRef
    ?? target?.anchorSelector
    ?? element?.selector
    ?? item.decision?.ref
    ?? target?.path
    ?? item.sourceRefs?.[0]?.path
    ?? item.targetId;
}

function sourceRefTypeForArtifact(type: ArtifactType) {
  if (type === "decision") return "decision";
  return "plan";
}

function draftBelongsToArtifact(item: DraftReviewItem | null | undefined, artifactType: ArtifactType) {
  if (!item) return false;
  return item.visualTarget?.artifact === artifactType || (item.sourceRefs ?? []).some((ref) => (
    ref.type === artifactType ||
    ref.path === `${artifactType}/data/${artifactType}-data.json`
  ));
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
const SECTION_SELECTOR = '[data-comment-scope="section"]';

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
  const style = document.createElement("style");
  style.id = COMMENT_ACTION_STYLE_ID;
  style.textContent = `
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

function makeDecisionVisualTarget(artifact: IssueArtifact, overlay: HTMLDivElement, frame: HTMLIFrameElement | null, element: Element): VisualTarget {
  return makeElementVisualTarget(artifact, overlay, frame, element, "决策项");
}

export function VisionPlanPage({ gitServerId, projectId, issueNumber, artifactType }: VisionRouteContext) {
  const context = useMemo(() => ({ gitServerId, projectId, issueNumber, artifactType }), [gitServerId, projectId, issueNumber, artifactType]);
  const [issue, setIssue] = useState<LoadedIssue | null>(null);
  const [draftItems, setDraftItems] = useState<DraftReviewItem[]>([]);
  const [reviews, setReviews] = useState<VisualReview[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [artifactSections, setArtifactSections] = useState<ArtifactSection[]>([]);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [globalFeedbackText, setGlobalFeedbackText] = useState("");
  const [visualCommentText, setVisualCommentText] = useState("");
  const [feedbackIntent, setFeedbackIntent] = useState<FeedbackRequest["intent"]>("defect");
  const [pendingTarget, setPendingTarget] = useState<VisualTarget | null>(null);
  const [pendingDecision, setPendingDecision] = useState<DecisionAnchorTarget | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [agentPrompt, setAgentPrompt] = useState<string | null>(null);
  const [modal, setModal] = useState<"approve" | "submit" | "comment" | "edit" | "decision-discuss" | "history" | null>(null);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [visualTick, setVisualTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [artifactHtml, setArtifactHtml] = useState<string | null>(null);
  const [artifactFormat, setArtifactFormat] = useState<"json" | "markdown">("json");
  const [decisionItemMode, setDecisionItemMode] = useState<"approval" | "choice" | "mixed">("approval");
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const frameScrollCleanupRef = useRef<(() => void) | null>(null);
  const commentActionCleanupRef = useRef<(() => void) | null>(null);
  const sectionObserverCleanupRef = useRef<(() => void) | null>(null);
  const overlayResizeObserverRef = useRef<ResizeObserver | null>(null);
  const decisionItemsRef = useRef<DecisionItem[]>([]);

  useEffect(() => {
    setBusy(true);
    setError(null);
    setStatus(null);
    setAgentPrompt(null);
    setSelectedDraftId(null);
    setPendingDecision(null);
    decisionItemsRef.current = [];
    setDecisionItemMode("approval");
    setArtifactSections([]);
    setActiveSectionId(null);
    loadVisualArtifact(context)
      .then((loaded) => {
        setIssue(loaded.issue);
        setDraftItems(loaded.drafts.filter(Boolean));
        setReviews(loaded.reviews);
        setArtifactHtml(loaded.html);
        setArtifactFormat(loaded.format);
      })
      .catch((loadError) => {
        setIssue(null);
        setError(loadError instanceof Error ? loadError.message : "加载可视化产物失败");
      })
      .finally(() => setBusy(false));
  }, [context]);

  useEffect(() => {
    if (!issue) return;
    setSelectedDraftId(null);
    setPendingTarget(null);
    setPendingDecision(null);
    setVisualCommentText("");
    setArtifactSections([]);
    setActiveSectionId(null);
  }, [artifactType, issue]);

  const currentArtifact = useMemo(() => issue?.artifacts.find((artifact) => artifact.type === artifactType) ?? issue?.artifacts[0] ?? null, [artifactType, issue]);
  const refreshVisualPositions = useCallback(() => setVisualTick((value) => value + 1), []);

  function syncActiveSection() {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    const visible = Array.from(doc.querySelectorAll(SECTION_SELECTOR)).filter(isVisibleArtifactSection);
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
      button.type = "button";
      button.className = COMMENT_ACTION_CLASS;
      button.textContent = "评论";
      button.setAttribute("data-agentrix-injected", "comment-action");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!activeElement) return;
        const target = commentTargetFromElement(activeElement);
        if (target) openElementComment(target);
      });

      const hide = () => {
        activeElement = null;
        button.removeAttribute("data-agentrix-visible");
      };
      const positionFor = (element: Element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          hide();
          return;
        }
        button.style.left = `${Math.max(8, Math.min(doc.documentElement.clientWidth - 96, rect.right - 16))}px`;
        button.style.top = `${Math.max(8, rect.top + 8)}px`;
        button.setAttribute("data-agentrix-visible", "true");
      };
      const activateFromEvent = (event: Event) => {
        const target = eventElementTarget(event, doc);
        if (!target || button.contains(target)) return;
        const element = findCommentableElement(target);
        if (!element) {
          if (!activeElement || !target.closest(COMMENTABLE_SELECTOR)) hide();
          return;
        }
        activeElement = element;
        positionFor(element);
      };
      const refreshPosition = () => {
        if (activeElement) positionFor(activeElement);
      };

      const frameWindow = frameRef.current?.contentWindow;
      doc.addEventListener("pointerover", activateFromEvent);
      doc.addEventListener("focusin", activateFromEvent);
      doc.addEventListener("scroll", refreshPosition, true);
      frameWindow?.addEventListener("resize", refreshPosition);
      doc.body?.appendChild(button);
      commentActionCleanupRef.current = () => {
        doc.removeEventListener("pointerover", activateFromEvent);
        doc.removeEventListener("focusin", activateFromEvent);
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

  function scanArtifactSections() {
    const doc = frameRef.current?.contentDocument;
    if (!doc) {
      setArtifactSections([]);
      return;
    }
    try {
      const seenLabels = new Set<string>();
      const sections = Array.from(doc.querySelectorAll(SECTION_SELECTOR))
        .map((element, index) => ({ element, index }))
        .filter(({ element }) => isVisibleArtifactSection(element))
        .filter(({ element }) => !findDataRef(element)?.startsWith("decisions."))
        .map(({ element, index }) => {
          const id = `agentrix-section-${index + 1}`;
          element.setAttribute("data-agentrix-section-id", id);
          return {
            id,
            label: sectionLabel(element, index)
          };
        })
        .filter((section) => {
          const key = section.label.trim().toLocaleLowerCase();
          if (seenLabels.has(key)) return false;
          seenLabels.add(key);
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

  const scopedDraftItems = useMemo(() => draftItems.filter((item) => draftBelongsToArtifact(item, currentArtifact?.type ?? artifactType)), [artifactType, currentArtifact?.type, draftItems]);
  const selectedDraft = scopedDraftItems.find((item) => item.id === selectedDraftId) ?? scopedDraftItems[0] ?? null;
  const editingDraft = scopedDraftItems.find((item) => item.id === editingDraftId) ?? null;
  const selectedReview = reviews.find((review) => review.id === selectedReviewId) ?? null;
  const hasDecisionDiscussion = scopedDraftItems.some((item) => item.decision?.action === "discuss");
  void visualTick;

  async function addFeedbackToDraft(input: Partial<FeedbackRequest> = {}, options: { resetGlobal?: boolean; resetVisual?: boolean } = {}) {
    if (!issue || !currentArtifact) return;
    const comment = input.comment?.trim();
    if (!comment) return;
    setStatus(null);
    setAgentPrompt(null);
    setError(null);
    try {
      const item = addStoredReviewDraft(context, {
        targetType: input.targetType ?? "artifact",
        targetId: input.targetId ?? currentArtifact.path,
        sourceRefs: input.sourceRefs ?? [{ type: sourceRefTypeForArtifact(currentArtifact.type), path: currentArtifact.path, label: artifactLabel(currentArtifact.type) }],
        visualTarget: input.visualTarget,
        decision: input.decision,
        comment,
        severity: input.severity ?? (feedbackIntent === "defect" ? "major" : "note"),
        intent: input.intent ?? feedbackIntent
      });
      setDraftItems((items) => [...items.filter(Boolean), item]);
      setSelectedDraftId(item.id);
      if (options.resetGlobal) setGlobalFeedbackText("");
      if (options.resetVisual) setVisualCommentText("");
      setPendingTarget(null);
      setModal(null);
      setStatus("已添加到当前审阅");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "添加审阅意见失败");
    }
  }

  function addGlobalFeedbackToDraft() {
    void addFeedbackToDraft({ comment: globalFeedbackText }, { resetGlobal: true });
  }

  function openElementComment(target: VisualTarget) {
    setPendingTarget(target);
    setVisualCommentText("");
    setModal("comment");
    setStatus("已选择页面内容，请填写评论后保存到当前审阅");
  }

  function saveVisualComment() {
    if (!pendingTarget) return;
    void addFeedbackToDraft({ comment: visualCommentText, visualTarget: pendingTarget }, { resetVisual: true });
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
    if (!currentArtifact) return;
    const input: FeedbackRequest = {
      targetType: "artifact",
      targetId: decision.ref,
      sourceRefs: [{ type: sourceRefTypeForArtifact(currentArtifact?.type ?? "plan"), path: currentArtifact?.path ?? "plan/data/plan-data.json", label: artifactLabel(currentArtifact?.type ?? "plan") }],
      visualTarget: decision.visualTarget,
      decision: decisionReviewPayload(decision, action),
      comment,
      severity: "note",
      intent: action === "discuss" ? "question" : "refinement"
    };
    setStatus(null);
    setError(null);
    try {
      const existing = scopedDraftItems.find((item) => item.decision?.ref === decision.ref);
      const saved = existing
        ? updateStoredReviewDraft(context, existing.id, input)
        : addStoredReviewDraft(context, input);
      setDraftItems((items) => existing
        ? items.map((item) => item.id === existing.id ? saved : item)
        : [...items.filter(Boolean), saved]);
      setSelectedDraftId(saved.id);
      setVisualCommentText("");
      setPendingDecision(null);
      setModal(null);
      setStatus(action === "select" ? "已选择方案" : action === "approve" ? "已通过决策项" : "已添加决策讨论");
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
    setPendingDecision(decision);
    setVisualCommentText("");
    setFeedbackIntent("question");
    setModal("decision-discuss");
    setStatus("已定位到决策项，请填写讨论内容后保存");
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
    setFeedbackIntent(item.intent);
    setModal("edit");
    if (item.visualTarget && overlayRef.current) {
      const metrics = measureFrame(frameRef.current, overlayRef.current);
      const position = resolveVisualTargetPosition(item.visualTarget, metrics, frameRef.current?.contentDocument ?? null);
      frameRef.current?.contentWindow?.scrollTo({
        left: position.documentX - metrics.viewportWidth / 2,
        top: position.documentY - metrics.viewportHeight / 2,
        behavior: "smooth"
      });
    }
    refreshVisualPositions();
  }

  async function updateExistingDraft() {
    if (!issue || !editingDraft) return;
    const comment = visualCommentText.trim();
    if (!comment) return;
    setStatus(null);
    setAgentPrompt(null);
    setError(null);
    try {
      const updated = updateStoredReviewDraft(context, editingDraft.id, {
        targetType: editingDraft.targetType,
        targetId: editingDraft.targetId,
        sourceRefs: editingDraft.sourceRefs,
        visualTarget: editingDraft.visualTarget,
        decision: editingDraft.decision,
        comment,
        severity: feedbackIntent === "defect" ? "major" : "note",
        intent: feedbackIntent
      });
      setDraftItems((items) => items.map((item) => item.id === updated.id ? updated : item));
      setSelectedDraftId(updated.id);
      setEditingDraftId(null);
      setVisualCommentText("");
      setModal(null);
      setStatus("审阅意见已更新");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "更新审阅意见失败");
    }
  }

  function closeCommentModal() {
    setModal(null);
    setPendingTarget(null);
    setPendingDecision(null);
    setEditingDraftId(null);
    setVisualCommentText("");
  }

  function openReviewHistory(review: VisualReview) {
    setSelectedReviewId(review.id);
    setModal("history");
  }

  async function removeReviewItem(itemId: string) {
    if (!issue) return;
    setError(null);
    setStatus(null);
    try {
      deleteStoredReviewDraft(context, itemId);
      setDraftItems((items) => items.filter((item) => item.id !== itemId));
      setStatus("已从当前审阅中删除");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除审阅意见失败");
    }
  }

  async function confirmSubmitReview() {
    if (!issue || !scopedDraftItems.length) return;
    setSubmittingReview(true);
    setError(null);
    try {
      const result = await submitReviewDraft(context, scopedDraftItems);
      const submittedIds = new Set(scopedDraftItems.map((item) => item.id));
      setDraftItems((items) => items.filter((item) => !submittedIds.has(item.id)));
      if (result.status === "approved") {
        clearReviewStorage(context);
        setReviews([]);
      } else {
        saveSubmittedReview(context, result.review);
        setReviews((items) => [result.review, ...items]);
      }
      setIssue((loaded) => loaded ? { ...loaded, artifacts: loaded.artifacts.map((artifact) => ({ ...artifact, status: result.status })) } : loaded);
      setStatus(result.status === "approved" ? "决策已通过" : "审阅已提交，等待修改");
      setModal(null);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "提交审阅失败");
    } finally {
      setSubmittingReview(false);
    }
  }

  async function approvePlan() {
    if (!issue) return;
    setStatus(null);
    setAgentPrompt(null);
    setError(null);
    try {
      const result = await approveVisionArtifact(context);
      clearReviewStorage(context);
      setDraftItems([]);
      setReviews([]);
      setIssue((loaded) => loaded ? { ...loaded, artifacts: loaded.artifacts.map((artifact) => ({ ...artifact, status: result.artifact.status })) } : loaded);
      setStatus("方案已通过并合入默认分支，可以开始实施");
      setModal(null);
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : "通过方案失败");
    }
  }

  async function approveEveryDecision() {
    if (!issue || currentArtifact?.type !== "decision") return;
    setSubmittingReview(true);
    setStatus(null);
    setAgentPrompt(null);
    setError(null);
    try {
      const result = await approveAllDecisions(context, scopedDraftItems);
      setDraftItems((items) => items.filter((item) => !draftBelongsToArtifact(item, "decision")));
      if (result.status === "approved") {
        clearReviewStorage(context);
        setReviews([]);
      } else {
        saveSubmittedReview(context, result.review);
        setReviews((items) => [result.review, ...items]);
      }
      setIssue((loaded) => loaded ? { ...loaded, artifacts: loaded.artifacts.map((artifact) => ({ ...artifact, status: result.status })) } : loaded);
      setStatus(result.status === "approved" ? "决策已全部通过" : "其他决策已通过，讨论项已提交");
      setModal(null);
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : "全部通过失败");
    } finally {
      setSubmittingReview(false);
    }
  }

  async function copyAgentPrompt() {
    if (!agentPrompt) return;
    await navigator.clipboard?.writeText(agentPrompt);
    setStatus("智能体消息已复制");
  }

  const visualTargetStyles = useMemo(() => {
    const overlay = overlayRef.current;
    const frame = frameRef.current;
    return new Map(scopedDraftItems
      .filter((item) => item.visualTarget)
      .map((item) => [item.id, visualTargetStyle(item.visualTarget!, overlay, frame)]));
  }, [scopedDraftItems, visualTick]);

  function bindReviewMarker(element: HTMLButtonElement | null, item: DraftReviewItem) {
    if (!element) return;
    element.onpointerdown = (event) => event.stopPropagation();
    element.onpointerup = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDraftEditor(item);
    };
    element.onclick = (event) => {
      event.stopPropagation();
      if (event.detail === 0) openDraftEditor(item);
    };
    element.onfocus = () => {
      if (!element.matches(":focus-visible")) openDraftEditor(item);
    };
  }

  return (
    <main className="vision-plan-page artifact-engine">
      <aside className="workspace-panel">
        <div className="brand-row">
          <span className="brand-mark"><FileText size={20} /></span>
          <div>
            <p className="brand-kicker">ISSUE FLOW</p>
            <h1>{artifactLabel(artifactType)}审阅</h1>
            <p>{issue ? issue.title : `议题 #${issueNumber}`}</p>
          </div>
        </div>

        {issue ? (
          <section className="panel-section navigation-section">
            <div className="section-title"><FileText size={17} /><h2>内容导航</h2></div>
            <div className="artifact-directory">
              {artifactSections.length ? (
                <nav aria-label={`${currentArtifact ? artifactLabel(currentArtifact.type) : "产物"}章节`}>
                  {artifactSections.map((section) => (
                    <button key={section.id} type="button" className={section.id === activeSectionId ? "is-active" : ""} onClick={() => scrollToArtifactSection(section.id)}>
                      <span>{section.label}</span>
                    </button>
                  ))}
                </nav>
              ) : <p className="muted">当前{currentArtifact ? artifactLabel(currentArtifact.type) : "产物"}没有可导航的章节</p>}
            </div>
          </section>
        ) : null}

        <section className="panel-section review-box">
          <div className="section-title"><MessageCircle size={17} /><h2>整体反馈</h2></div>
            <p className="section-description">针对整个{currentArtifact ? artifactLabel(currentArtifact.type) : "产物"}补充意见；{artifactFormat === "markdown" ? "Markdown Plan 支持整体或正文评论。" : "也可以在右侧内容中悬停后添加评论。"}</p>
          <div className="segmented">
            <button type="button" className={feedbackIntent === "defect" ? "is-active" : ""} onClick={() => setFeedbackIntent("defect")}>缺陷</button>
            <button type="button" className={feedbackIntent === "question" ? "is-active" : ""} onClick={() => setFeedbackIntent("question")}>疑问</button>
            <button type="button" className={feedbackIntent === "refinement" ? "is-active" : ""} onClick={() => setFeedbackIntent("refinement")}>优化</button>
          </div>
          <textarea value={globalFeedbackText} onChange={(event) => setGlobalFeedbackText(event.target.value)} placeholder="填写对当前产物的整体意见…" />
          <button type="button" className="add-review-button" onClick={addGlobalFeedbackToDraft} disabled={!currentArtifact || !globalFeedbackText.trim()}>提交</button>
          {status ? <p className="success-box">{status}</p> : null}
        </section>

        <section className="panel-section draft-review-box">
          <div className="section-title"><Clipboard size={17} /><h2>当前审阅</h2><span className="section-count">{scopedDraftItems.length}</span></div>
          {scopedDraftItems.length ? (
            <div className="draft-list">
              {scopedDraftItems.map((item) => (
                <article key={item.id} className={`draft-item ${selectedDraft?.id === item.id ? "is-selected" : ""}`}>
                  <button type="button" className="draft-select" onClick={() => openDraftEditor(item)}>
                    <span className="draft-icon" aria-hidden="true">{item.decision && item.decision.action !== "discuss" ? <CheckCircle2 size={16} /> : <MessageCircle size={16} />}</span>
                    <span className="draft-comment">{item.decision ? `${decisionActionLabel(item.decision.action)}：${item.decision.ref} · ${item.comment}` : item.comment}</span>
                  </button>
                  <button type="button" className="icon-button delete-review-item" aria-label={`删除审阅意见 ${item.id}`} onClick={() => removeReviewItem(item.id)}><Trash2 size={14} /></button>
                </article>
              ))}
            </div>
          ) : <div className="panel-empty"><MessageCircle size={18} /><p>还没有审阅意见</p><span>从右侧内容添加评论，或填写整体反馈。</span></div>}
        </section>

        <section className="panel-section review-history-box">
          <div className="section-title"><FileText size={17} /><h2>审阅记录</h2><span className="section-count">{reviews.length}</span></div>
          {reviews.length ? reviews.map((review) => (
            <button key={review.id} type="button" className="review-history-item" onClick={() => openReviewHistory(review)} aria-label={`查看 ${new Date(review.submittedAt || review.createdAt).toLocaleString("zh-CN")} 的审阅记录`}>
              <strong>{reviewStatusLabel(review.status)}</strong>
              <span>{new Date(review.submittedAt || review.createdAt).toLocaleString("zh-CN")}</span>
              <p>{review.payload?.items?.length || 0} 条审阅意见</p>
            </button>
          )) : <p className="muted">暂无已提交的审阅记录</p>}
        </section>

        {error ? <pre className="error-box">{error}</pre> : null}
      </aside>

      <section className="artifact-stage">
        <header className="artifact-toolbar">
          <div className="artifact-heading">
            <a className="artifact-back-link" href={`/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/issues`} aria-label="返回 Issues 看板" title="返回 Issues 看板"><ArrowLeft size={17} /></a>
            <div><span className="toolbar-kicker">当前产物</span><strong>{artifactLabel(artifactType)}</strong></div>
            <span className={`artifact-status status-${currentArtifact?.status || "pending"}`}>{artifactStatusLabel(currentArtifact?.status)}</span>
          </div>
          <div className="toolbar-actions">
            {currentArtifact?.mergeRequestUrl ? <a href={currentArtifact.mergeRequestUrl} target="_blank" rel="noreferrer"><GitPullRequest size={16} />查看 MR #{currentArtifact.mergeRequestNumber}</a> : null}
            <button type="button" onClick={() => setModal("submit")} disabled={!issue || !scopedDraftItems.length || currentArtifact?.status === "approved"}><Send size={16} />提交审阅{scopedDraftItems.length ? ` · ${scopedDraftItems.length}` : ""}</button>
            {currentArtifact?.type === "decision" ? <button type="button" className="approve-action" onClick={approveEveryDecision} disabled={!issue || submittingReview || currentArtifact.status === "approved"}><CheckCircle2 size={16} />{currentArtifact.status === "approved" ? "决策已完成" : submittingReview ? "正在提交…" : hasDecisionDiscussion ? "通过其他决策" : decisionItemMode === "choice" ? "采用全部推荐" : decisionItemMode === "mixed" ? "完成全部推荐" : "全部通过"}</button> : null}
            {currentArtifact?.type === "plan" ? <button type="button" className="approve-action" onClick={approvePlan} disabled={!issue || currentArtifact.status === "approved"}><CheckCircle2 size={16} />{currentArtifact.status === "approved" ? "方案已通过" : "通过方案"}</button> : null}
          </div>
        </header>

        {agentPrompt ? (
          <div className="agent-prompt-banner">
            <strong>发送给智能体</strong>
            <span>{agentPrompt}</span>
            <button type="button" onClick={copyAgentPrompt}>复制消息</button>
            <button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setAgentPrompt(null)}><X size={14} /></button>
          </div>
        ) : null}

        <div className="artifact-frame-wrap">
          {busy ? <div className="empty-state">正在加载 Plan MR 产物…</div> : currentArtifact ? (
            <>
              <iframe
                ref={frameRef}
                key={`${issue?.issueId}-${currentArtifact.type}`}
                title={`${issue?.issueId} ${artifactLabel(currentArtifact.type)}`}
                srcDoc={artifactHtml ?? "<!doctype html><body>正在加载产物…</body>"}
                className="artifact-frame"
                onLoad={handleFrameLoad}
              />
              <div
                ref={overlayRef}
                className="annotation-overlay"
              >
                {scopedDraftItems.map((item) => item.visualTarget ? (
                  item.visualTarget.kind === "point" ? (
                    <button
                      key={item.id}
                      ref={(element) => bindReviewMarker(element, item)}
                      type="button"
                      className={`marker point ${selectedDraft?.id === item.id ? "is-selected" : ""}`}
                      style={{ left: visualTargetStyles.get(item.id)?.left, top: visualTargetStyles.get(item.id)?.top }}
                      aria-label="编辑评论"
                      title={item.comment}
                    ><MessageCircle size={15} /></button>
                  ) : (
                    <button
                      key={item.id}
                      ref={(element) => bindReviewMarker(element, item)}
                      type="button"
                      className={`marker region ${selectedDraft?.id === item.id ? "is-selected" : ""}`}
                      style={{
                        left: visualTargetStyles.get(item.id)?.left,
                        top: visualTargetStyles.get(item.id)?.top,
                        width: visualTargetStyles.get(item.id)?.width,
                        height: visualTargetStyles.get(item.id)?.height
                      }}
                      aria-label="编辑评论"
                      title={item.comment}
                    ><span><MessageCircle size={15} /></span></button>
                  )
                ) : null)}
              </div>
            </>
          ) : (
            <div className="empty-state">当前 Plan MR 尚未发布</div>
          )}
        </div>
      </section>

      {modal ? (
        <div className="modal-backdrop" role="presentation">
          <section className="review-modal" role="dialog" aria-modal="true" aria-labelledby="review-modal-title">
            <button type="button" className="modal-close" aria-label="关闭弹窗" onClick={() => modal === "comment" || modal === "edit" || modal === "decision-discuss" ? closeCommentModal() : setModal(null)}><X size={16} /></button>
            {modal === "comment" && pendingTarget ? (
              <>
                <h2 id="review-modal-title">添加评论</h2>
                <p>已选择{artifactLabel(pendingTarget.artifact)}中的具体内容，请选择类型并填写意见。</p>
                <div className="segmented">
                  <button type="button" className={feedbackIntent === "defect" ? "is-active" : ""} onClick={() => setFeedbackIntent("defect")}>缺陷</button>
                  <button type="button" className={feedbackIntent === "question" ? "is-active" : ""} onClick={() => setFeedbackIntent("question")}>疑问</button>
                  <button type="button" className={feedbackIntent === "refinement" ? "is-active" : ""} onClick={() => setFeedbackIntent("refinement")}>优化</button>
                </div>
                <textarea value={visualCommentText} onChange={(event) => setVisualCommentText(event.target.value)} placeholder="填写对所选内容的审阅意见…" autoFocus />
                <button type="button" className="add-review-button" onClick={saveVisualComment} disabled={!visualCommentText.trim()}>保存评论</button>
              </>
            ) : modal === "decision-discuss" && pendingDecision ? (
              <>
                <h2 id="review-modal-title">讨论决策</h2>
                <p>{pendingDecision.question ?? pendingDecision.ref}</p>
                <textarea value={visualCommentText} onChange={(event) => setVisualCommentText(event.target.value)} placeholder="填写需要讨论或澄清的内容…" autoFocus />
                <button type="button" className="add-review-button" onClick={saveDecisionDiscussion} disabled={!visualCommentText.trim()}>保存讨论</button>
              </>
            ) : modal === "edit" && editingDraft ? (
              <>
                <h2 id="review-modal-title">编辑审阅意见</h2>
                <p>{editingDraft.decision ? `正在编辑决策 ${editingDraft.decision.ref} 的“${decisionActionLabel(editingDraft.decision.action)}”意见。` : editingDraft.visualTarget ? `正在编辑${artifactLabel(editingDraft.visualTarget.artifact)}中的评论。` : `正在编辑针对 ${editingDraft.targetId} 的整体反馈。`}</p>
                <div className="segmented">
                  <button type="button" className={feedbackIntent === "defect" ? "is-active" : ""} onClick={() => setFeedbackIntent("defect")}>缺陷</button>
                  <button type="button" className={feedbackIntent === "question" ? "is-active" : ""} onClick={() => setFeedbackIntent("question")}>疑问</button>
                  <button type="button" className={feedbackIntent === "refinement" ? "is-active" : ""} onClick={() => setFeedbackIntent("refinement")}>优化</button>
                </div>
                <textarea value={visualCommentText} onChange={(event) => setVisualCommentText(event.target.value)} placeholder="修改这条审阅意见…" autoFocus />
                <button type="button" className="add-review-button" onClick={updateExistingDraft} disabled={!visualCommentText.trim()}>保存修改</button>
              </>
            ) : modal === "history" && selectedReview ? (
              <>
                <h2 id="review-modal-title">审阅详情</h2>
                <div className="review-history-summary">
                  <span className={`artifact-status status-${selectedReview.status}`}>{reviewStatusLabel(selectedReview.status)}</span>
                  <span>{new Date(selectedReview.submittedAt || selectedReview.createdAt).toLocaleString("zh-CN")}</span>
                  {selectedReview.user?.name || selectedReview.user?.username ? <span>{selectedReview.user.name || selectedReview.user.username}</span> : null}
                </div>
                {selectedReview.payload?.items?.length ? (
                  <div className="modal-draft-list history-review-items">
                    {selectedReview.payload.items.map((item) => (
                      <article key={item.id}>
                        <strong>{item.decision ? `${decisionActionLabel(item.decision.action)}决策` : item.intent ? feedbackIntentLabel(item.intent) : "审阅意见"}</strong>
                        <p>{item.comment}</p>
                        <small>定位：{reviewItemLocation(item)}</small>
                      </article>
                    ))}
                  </div>
                ) : <div className="panel-empty"><FileText size={18} /><p>本次审阅没有文字意见</p></div>}
              </>
            ) : modal === "approve" ? (
              <>
                <h2 id="review-modal-title">产物已通过</h2>
                <p>当前产物已经通过，请将以下消息发送给智能体：</p>
                <pre>{agentPrompt}</pre>
                <button type="button" onClick={copyAgentPrompt} disabled={!agentPrompt}><Clipboard size={16} />复制消息</button>
              </>
            ) : agentPrompt ? (
              <>
                <h2 id="review-modal-title">审阅已提交</h2>
                <p>请将以下消息发送给智能体：</p>
                <pre>{agentPrompt}</pre>
                <button type="button" onClick={copyAgentPrompt}><Clipboard size={16} />复制消息</button>
              </>
            ) : scopedDraftItems.length ? (
              <>
                <h2 id="review-modal-title">提交审阅</h2>
                <p>将当前草稿中的全部意见提交为一次正式审阅。提交后，这些意见会从草稿区移入审阅记录。</p>
                <div className="modal-draft-list">
                  {scopedDraftItems.map((item) => <article key={item.id}><strong>{item.decision ? `${decisionActionLabel(item.decision.action)}决策 · ${item.decision.ref}` : feedbackIntentLabel(item.intent)}</strong><p>{item.comment}</p></article>)}
                </div>
                <button type="button" className="submit-review-action" onClick={confirmSubmitReview} disabled={submittingReview}><Send size={16} />{submittingReview ? "正在提交…" : "确认提交审阅"}</button>
              </>
            ) : <p>当前没有可提交的审阅意见</p>}
          </section>
        </div>
      ) : null}
    </main>
  );
}
