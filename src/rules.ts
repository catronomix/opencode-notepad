/**
 * Pure rules behind the overlay's modal behaviour: the filename dialog, the
 * escape layering, the panel width clamp and where closing returns to.
 *
 * They live here, not in `tui.tsx`, so each rule can be checked without a
 * renderer or a live host.
 */
import type { Route } from "@opencode/plugin/tui/context"

import { listPathMatches, noteFileExists, resolveNotePath, type PathMatch } from "./note.ts"

/**
 * The file an empty save dialog writes, and the file an empty load dialog
 * opens. One constant, so the placeholder, the written name and the fallback
 * can never drift apart in case.
 */
export const DEFAULT_NOTE_FILE = "NOTE.md"

/**
 * The path the save dialog writes to. An empty or blank answer means
 * `NOTE.md`; `name === undefined` (the dialog was cancelled) is handled by the
 * caller and never reaches this function.
 */
export function saveTarget(query: string): string {
  return query.trim() || DEFAULT_NOTE_FILE
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
 * Completion rows for the dialog: none until something has been typed. An
 * empty field is not a query, and listing the whole project there would put a
 * directory listing in front of every Save.
 */
export function dialogMatches(cwd: string, query: string): PathMatch[] {
  return query.trim() === "" ? [] : listPathMatches(cwd, completionQuery(query))
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
 * Where closing the note returns to.
 *
 * The host navigates to a plugin route *before* the plugin's command runs, so
 * `ui.router.current()` inside the command is already this page: there is no
 * previous route to capture, and `ui.router` exposes no history or change
 * event (`register/navigate/current` only). The screen underneath is therefore
 * read from the session tab bar, which is what the host itself uses to know
 * which chat is on screen: an active tab means the page was opened over that
 * chat, otherwise it was opened over the home screen.
 *
 * A chat the page had to create has no screen of its own yet, so closing it
 * goes home — navigating to a freshly created session is exactly what made
 * closing open a new tab.
 */
export function returnRoute(state: { readonly created: boolean; readonly origin: Route }): Route {
  return state.created ? { type: "home" } : state.origin
}

/**
 * Where Insert goes: the chat the note belongs to, because that is the only
 * prompt its text can be pasted into. An existing screen of that chat is
 * reused; a note that created its own chat has no screen yet, and its tab is
 * opened by the host's tab store when this route becomes current.
 */
export function insertRoute(state: { readonly sessionID: string; readonly origin: Route }): Route {
  if (state.origin.type === "session" && state.origin.sessionID === state.sessionID) return state.origin
  return { type: "session", sessionID: state.sessionID }
}

/**
 * Enter's binding in the page's own keymap layer. OpenCode binds a bare
 * `return` to `input.submit` for every focused edit buffer and consumes it
 * before the textarea can insert a newline; `input_newline` is bound only to
 * `shift+return,ctrl+return,alt+return,ctrl+j`. Claiming `return` here, at a
 * higher layer priority, is what puts the plain Enter back.
 */
export const NEWLINE_BIND = "return"

/** Both filename dialogs draw the same box; only the wording of their actions differs. */
export interface DialogSpec {
  readonly title: string
  readonly hint: string
  readonly placeholder: string
}

export function dialogSpec(kind: "save" | "load"): DialogSpec {
  return {
    title: kind === "save" ? "Save note to a file" : "Load a file into the note",
    hint: kind === "save" ? "Enter writes · Tab completes · Esc cancels" : "Enter opens · Tab completes · Esc cancels",
    placeholder: DEFAULT_NOTE_FILE,
  }
}

/** Content rows both dialogs reserve: title, directory, input, hint and completions. */
export const DIALOG_HEIGHT = 11
export const DIALOG_MATCH_ROWS = 5

/** What Enter in the load dialog does. */
export type LoadPlan =
  | { readonly kind: "open"; readonly path: string }
  | { readonly kind: "browse"; readonly query: string }
  | { readonly kind: "nothing" }

/**
 * The filename field of the dialog. The page owns this buffer: while the dialog
 * is open the note's textarea is blurred and not focusable, so nothing a key
 * does can reach the note behind it.
 */
export interface DialogState {
  readonly text: string
  readonly caret: number
}

export const emptyDialog = (): DialogState => ({ text: "", caret: 0 })

export type DialogResult =
  | { readonly type: "state"; readonly state: DialogState }
  | { readonly type: "commit" }
  | { readonly type: "complete" }
  | { readonly type: "cancel" }

/** Just enough of the host's `KeyEvent` to decide what a keystroke means. */
export interface DialogKey {
  readonly name: string
  readonly sequence?: string
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
  readonly option?: boolean
  readonly super?: boolean
}

/** A printable character: one code point and not a control character. */
export function printableChar(sequence: string | undefined): string | undefined {
  if (!sequence) return undefined
  const first = String.fromCodePoint(sequence.codePointAt(0) ?? 0)
  if (first.length !== sequence.length) return undefined
  return first >= " " && first !== "\u007f" ? first : undefined
}

/**
 * The dialog's whole keyboard behaviour, in one place. Every key the dialog
 * receives is settled here: characters, Backspace, Delete, Left/Right,
 * Home/End, Enter, Tab and Escape. Nothing falls through to the note.
 */
export function dialogKey(state: DialogState, key: DialogKey): DialogResult {
  const { text, caret } = state
  const at = Math.max(0, Math.min(text.length, caret))
  const move = (position: number): DialogResult => ({ type: "state", state: { text, caret: Math.max(0, Math.min(text.length, position)) } })
  switch (key.name) {
    case "escape":
      return { type: "cancel" }
    case "tab":
      return { type: "complete" }
    case "return":
    case "kpenter":
    case "enter":
    case "linefeed":
      return { type: "commit" }
    case "backspace":
      if (at === 0) return { type: "state", state }
      return { type: "state", state: { text: text.slice(0, at - 1) + text.slice(at), caret: at - 1 } }
    case "delete":
      if (at >= text.length) return { type: "state", state }
      return { type: "state", state: { text: text.slice(0, at) + text.slice(at + 1), caret: at } }
    case "left":
      return move(at - 1)
    case "right":
      return move(at + 1)
    case "home":
      return move(0)
    case "end":
      return move(text.length)
  }
  // Ctrl/Alt/Meta combinations are the host's business (paste, clipboard) and
  // must not be typed into a filename, but they are still consumed.
  if (key.ctrl || key.meta || key.option || key.super) return { type: "state", state }
  const typed = printableChar(key.sequence)
  if (typed === undefined) return { type: "state", state }
  return { type: "state", state: { text: text.slice(0, at) + typed + text.slice(at), caret: at + typed.length } }
}

/**
 * Enter in the load dialog: open the typed path, walk into a directory, or fall
 * back to `NOTE.md` / the first match when the field is empty.
 */
export function loadPlan(cwd: string, query: string): LoadPlan {
  const normalized = completionQuery(query).trim()
  if (!normalized) {
    if (noteFileExists(cwd, DEFAULT_NOTE_FILE)) return { kind: "open", path: resolveNotePath(cwd, DEFAULT_NOTE_FILE) }
    const first = listPathMatches(cwd, "")[0]
    if (!first) return { kind: "nothing" }
    return first.directory ? { kind: "browse", query: first.label } : { kind: "open", path: first.path }
  }
  const first = listPathMatches(cwd, normalized)[0]
  if (first?.directory) return { kind: "browse", query: first.label }
  return { kind: "open", path: first?.path ?? resolveNotePath(cwd, normalized) }
}
