/**
 * Pure rules behind the overlay's modal behaviour: the filename dialog, the
 * escape layering, the panel width clamp and where closing returns to.
 *
 * They live here, not in `tui.tsx`, so each rule can be checked without a
 * renderer or a live host.
 */
import type { Route } from "@opencode/plugin/tui/context"

import { listPathMatches, noteFileExists, resolveNotePath } from "./note.ts"

/**
 * The path the save dialog writes to. An empty or blank answer means `NOTE.md`;
 * `name === undefined` (the dialog was cancelled) is handled by the caller and
 * never reaches this function.
 */
export function saveTarget(query: string): string {
  return query.trim() || "NOTE.md"
}

/** `@./`-style queries are accepted: a leading `@` decorates, it is not a path. */
export function completionQuery(query: string): string {
  const trimmed = query.trimStart()
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed
}

/** Writing a completion back keeps any `@` the user typed. */
export function applyCompletion(query: string, label: string): string {
  const prefix = query.trimStart().startsWith("@") ? "@" : ""
  return `${prefix}${label}`
}

/**
 * Escape is layered: while the filename dialog is open it closes only the
 * dialog. The note view closes only on a later Escape.
 */
export function escapeTarget(dialogOpen: boolean): "dialog" | "view" {
  return dialogOpen ? "dialog" : "view"
}

/**
 * Panel width: 70% of the window with a 15% margin, a floor of 80 columns, and
 * clamped to the window so a narrow terminal is never overrun.
 */
export function panelWidth(windowWidth: number): number {
  const width = Math.max(1, Math.floor(windowWidth))
  return Math.max(1, Math.min(width, Math.max(80, Math.floor(width * 0.7))))
}

/**
 * Where closing the note returns to: the session the page was opened from, and
 * home only when there genuinely was no session to return to.
 */
export function returnRoute(state: {
  readonly created: boolean
  readonly sessionID: string
  readonly previous: Route
}): Route {
  if (state.created) return { type: "session", sessionID: state.sessionID }
  if (state.previous.type === "session") return state.previous
  return { type: "home" }
}

/** What Enter in the load dialog does. */
export type LoadPlan =
  | { readonly kind: "open"; readonly path: string }
  | { readonly kind: "browse"; readonly query: string }
  | { readonly kind: "nothing" }

/**
 * Enter in the load dialog: open the typed path, walk into a directory, or fall
 * back to `NOTE.md` / the first match when the field is empty.
 */
export function loadPlan(cwd: string, query: string): LoadPlan {
  const normalized = completionQuery(query).trim()
  if (!normalized) {
    if (noteFileExists(cwd, "NOTE.md")) return { kind: "open", path: resolveNotePath(cwd, "NOTE.md") }
    const first = listPathMatches(cwd, "")[0]
    if (!first) return { kind: "nothing" }
    return first.directory ? { kind: "browse", query: first.label } : { kind: "open", path: first.path }
  }
  const first = listPathMatches(cwd, normalized)[0]
  if (first?.directory) return { kind: "browse", query: first.label }
  return { kind: "open", path: first?.path ?? resolveNotePath(cwd, normalized) }
}
