import { IssueFlowStore as CoreIssueFlowStore } from "../core/store.js"

export type IssueFlowStore = any

export function createIssueFlowStore(options: Record<string, unknown> = {}): IssueFlowStore {
  return new CoreIssueFlowStore(options)
}
