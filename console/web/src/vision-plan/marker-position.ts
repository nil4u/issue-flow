import type { VisualTarget } from "./types";

export type MarkerFrameMetrics = {
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
};

export type MarkerStyle = {
  left: string;
  top: string;
  width: string;
  height: string;
};

type QueryableDocument = Pick<Document, "querySelector" | "querySelectorAll">;

function clampRatio(value: number) {
  return Math.max(0, Math.min(1, value));
}

function escapeAttributeString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function dataRefSelector(ref: string) {
  return `[data-ref="${escapeAttributeString(ref)}"]`;
}

function safeQuerySelector(document: QueryableDocument, selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

function safeQuerySelectorAll(document: QueryableDocument, selector: string): Element[] {
  try {
    return Array.from(document.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function elementMatches(element: Element, selector: string) {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

export function resolveMarkerAnchor(document: QueryableDocument | null | undefined, target: VisualTarget): Element | null {
  if (!document) return null;

  if (target.anchorRef) {
    const refMatches = safeQuerySelectorAll(document, dataRefSelector(target.anchorRef));
    if (refMatches.length) {
      if (target.anchorSelector) {
        const anchorSelector = target.anchorSelector;
        const selectorMatch = refMatches.find((element) => elementMatches(element, anchorSelector));
        if (selectorMatch) return selectorMatch;
      }
      return refMatches[0] ?? null;
    }
  }

  return target.anchorSelector ? safeQuerySelector(document, target.anchorSelector) : null;
}

export function anchorOffsetForPoint(element: Element, visualX: number, visualY: number) {
  const rect = element.getBoundingClientRect();
  return {
    anchorOffsetX: clampRatio((visualX - rect.left) / Math.max(1, rect.width)),
    anchorOffsetY: clampRatio((visualY - rect.top) / Math.max(1, rect.height))
  };
}

export function resolveVisualTargetPosition(target: VisualTarget, metrics: MarkerFrameMetrics, document?: QueryableDocument | null) {
  const anchor = resolveMarkerAnchor(document, target);
  const hasAnchorOffset = target.anchorOffsetX !== undefined && target.anchorOffsetY !== undefined;

  if (anchor && hasAnchorOffset) {
    const rect = anchor.getBoundingClientRect();
    return {
      anchored: true,
      documentX: metrics.scrollX + rect.left + rect.width * target.anchorOffsetX!,
      documentY: metrics.scrollY + rect.top + rect.height * target.anchorOffsetY!,
      width: target.kind === "rect" ? target.width ?? (target.widthRatio ?? 0) * metrics.documentWidth : 0,
      height: target.kind === "rect" ? target.height ?? (target.heightRatio ?? 0) * metrics.documentHeight : 0
    };
  }

  return {
    anchored: false,
    documentX: target.xRatio * metrics.documentWidth,
    documentY: target.yRatio * metrics.documentHeight,
    width: target.kind === "rect" ? (target.widthRatio ?? 0) * metrics.documentWidth : 0,
    height: target.kind === "rect" ? (target.heightRatio ?? 0) * metrics.documentHeight : 0
  };
}

export function visualTargetMarkerStyle(target: VisualTarget, metrics: MarkerFrameMetrics, document?: QueryableDocument | null): MarkerStyle {
  const position = resolveVisualTargetPosition(target, metrics, document);
  return {
    left: `${position.documentX - metrics.scrollX}px`,
    top: `${position.documentY - metrics.scrollY}px`,
    width: `${position.width}px`,
    height: `${position.height}px`
  };
}
