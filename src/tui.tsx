/**
 * TUI half of opencode-note: a per-session scratchpad that stays out of the
 * chat transcript.
 *
 * The page is a plugin route, so it owns the whole screen while it is open: a
 * centred, bordered 70% x 70% panel (15% margin on every side) drawn over the
 * host background. Editing itself is OpenTUI's textarea, which is where mouse
 * selection, paste, undo and soft wrapping come from; this file only adds the
 * behaviours the overlay promises (line-home/End, page movement, selection
 * wrapping, Ctrl+Enter indentation, the button bar and the model buttons).
 */
import {
  StyledText,
  defaultTextareaKeyBindings,
  isEditBufferRenderable,
  type BoxRenderable,
  type EditBufferRenderable,
  type KeyEvent,
  type Renderable,
  type TextChunk,
  type TextRenderable,
  type TextareaRenderable,
} from "@opentui/core"
import type { Context, Route } from "@opencode/plugin/tui/context"
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup } from "solid-js"

import { indentFor, pageRows, printable, selectionAfterWrap, wrapSelection, wrapperFor } from "./editor.ts"
import { btwRequest, formatRequest, transcriptOf } from "./llm.ts"
import { listPathMatches, noteFileExists, noteKey, readNoteFile, resolveNotePath, writeNoteFile } from "./note.ts"
import { applyCompletion, completionQuery, escapeTarget, loadPlan, panelWidth, saveTarget, returnRoute } from "./rules.ts"

const PAGE = "opencode-note"

const BUTTONS = [
  { key: "i", label: "nsert", title: "Insert the note into the chat input" },
  { key: "c", label: "lear", title: "Clear the note" },
  { key: "s", label: "ave", title: "Save the note to a file" },
  { key: "l", label: "oad", title: "Load a file into the note" },
  { key: "f", label: "ormat", title: "Rewrite the note with the model" },
  { key: "b", label: "tw", title: "Ask the note as /btw, with this chat as context" },
] as const

type ButtonKey = (typeof BUTTONS)[number]["key"]

/** Home/End mean line edges here; the textarea defaults them to buffer edges. */
const KEY_BINDINGS = [
  ...defaultTextareaKeyBindings.filter((binding) => binding.name !== "home" && binding.name !== "end"),
  { name: "home", action: "line-home" as const },
  { name: "end", action: "line-end" as const },
  { name: "home", shift: true, action: "select-line-home" as const },
  { name: "end", shift: true, action: "select-line-end" as const },
]

interface PageState {
  readonly sessionID: string
  readonly created: boolean
  readonly previous: Route
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export default Plugin.define({
  id: "opencode-note.tui",
  async setup(context) {
    // The page is a fresh component on every open; this is the state a route
    // reload cannot carry (renderable identity).
    let page: PageState | undefined

    /** Whether the plugin page is the route the host is showing right now. */
    const onPage = () => {
      const current = context.ui.router.current()
      return current.type === "plugin" && current.name === PAGE
    }

    /**
     * The chat input to insert into. The host rebuilds the prompt when the route
     * changes, so the renderable that had focus when the overlay opened is
     * usually gone. Prefer whatever holds focus once the session route is back,
     * and only then fall back to walking the tree for an edit buffer — which is
     * what makes insertion work in an existing session after a slow re-render.
     */
    const findChatInput = (avoid: string): EditBufferRenderable | undefined => {
      const usable = (node: EditBufferRenderable) => !node.isDestroyed && node.plainText !== avoid
      const focused = context.renderer.currentFocusedEditor
      if (focused && usable(focused)) return focused
      const found: EditBufferRenderable[] = []
      const walk = (node: Renderable) => {
        if (node.isDestroyed) return
        if (isEditBufferRenderable(node) && node.visible && usable(node)) found.push(node)
        for (const child of node.getChildren?.() ?? []) walk(child)
      }
      walk(context.renderer.root)
      return found[found.length - 1]
    }

    const open = async () => {
      const current = context.ui.router.current()
      if (current.type === "plugin" && current.name === PAGE) return
      const tabs = context.ui.tabs.enabled() ? context.ui.tabs.list() : []
      const activeTab = tabs.find((tab) => tab.active)?.sessionID
      // Remember the session, not just the route: a note opened from the home
      // screen with a tab active still belongs to that tab and must go back to it.
      const previous: Route =
        current.type === "session" ? current : activeTab ? { type: "session", sessionID: activeTab } : current
      let sessionID = activeTab ?? (current.type === "session" ? current.sessionID : undefined)
      let created = false
      if (!sessionID) {
        // A brand-new chat has no session yet. Committing one through the API
        // (no prompt, no model call) is what gives the note a stable home.
        try {
          const session = await context.client.session.create({})
          sessionID = session.id
          created = true
          if (context.ui.tabs.enabled()) context.ui.tabs.focus(sessionID)
        } catch (error) {
          context.ui.toast.show({ title: "Note", message: `Could not start a session: ${messageOf(error)}`, variant: "error" })
          return
        }
      }
      page = { sessionID, created, previous }
      context.ui.router.navigate({ type: "plugin", name: PAGE, data: { sessionID, created } })
    }

    /**
     * Leaves the page. With `insert`, the note (or the fragment that was
     * selected) is written into the chat input once the host has restored it.
     */
    const closePage = (insert?: string) => {
      const state = page
      page = undefined
      const destination: Route = state
        ? returnRoute(state)
        : { type: "home" }
      context.ui.router.navigate(destination)

      if (insert !== undefined) {
        const started = Date.now()
        const attempt = () => {
          // Never write into the overlay's own editor: wait until the host has
          // actually left the plugin route.
          if (onPage()) {
            if (Date.now() - started < 2000) setTimeout(attempt, 60)
            return
          }
          const target = findChatInput(insert)
          if (target) {
            try {
              context.renderer.focusRenderable(target)
              target.insertText(insert)
              return
            } catch (error) {
              console.error("opencode-note: could not insert into the chat input", error)
              context.ui.toast.show({ title: "Note", message: `Could not insert the note: ${messageOf(error)}`, variant: "error" })
              return
            }
          }
          if (Date.now() - started < 2000) {
            setTimeout(attempt, 60)
            return
          }
          context.renderer.copyToClipboardOSC52(insert)
          context.ui.toast.show({
            title: "Note",
            message: "No chat input was available: the note is on the clipboard instead",
            variant: "warning",
          })
        }
        setTimeout(attempt, 40)
      }
    }

    const unregister = context.ui.router.register({
      name: PAGE,
      render: ({ data }) => {
        const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
        const created = data?.created === true
        if (!sessionID) {
          page = undefined
          return (
            <box width="100%" height="100%" backgroundColor={context.theme.background.base} padding={1}>
              <text content="opencode-note: no session" fg={context.theme.text.muted} />
            </box>
          )
        }
        return <Note context={context} sessionID={sessionID} created={created} close={closePage} />
      },
    })

    // Deleting a chat deletes its note. The note never leaves the plugin's
    // durable store, so clearing the key is the whole cleanup.
    const stop = context.data.on("session.deleted", (event) => {
      try {
        const [, set] = context.storage.store(noteKey(event.data.sessionID), { initial: { text: "" } })
        void set((draft) => {
          draft.text = ""
        })
      } catch (error) {
        console.error("opencode-note: could not clear the note of a deleted session", error)
      }
    })

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "opencode-note.open",
          title: "Note",
          description: "Open the scratchpad for this chat",
          group: "Note",
          bind: "ctrl+shift+n,alt+n",
          palette: true,
          slash: { name: "note" },
          run: () => void open(),
        },
      ],
    }))

    return () => {
      stop()
      unregister()
    }
  },
})

interface NoteProps {
  readonly context: Context
  readonly sessionID: string
  readonly created: boolean
  readonly close: (insert?: string) => void
}

function Note(props: NoteProps) {
  const context = props.context
  const theme = context.theme
  const colors = {
    background: theme.background.base,
    panel: theme.background.raised.base,
    border: theme.border.base,
    text: theme.text.base,
    muted: theme.text.muted,
    faint: theme.text.faint,
    accent: theme.text.action.primary.base,
  }

  const [_size, _setSize] = createSignal({
    width: Math.max(1, context.renderer.width),
    height: Math.max(1, context.renderer.height),
  })
  const onResize = (width: number, height: number) => {
    const next = { width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) }
    const previous = _size()
    if (previous.width === next.width && previous.height === next.height) return
    _setSize(next)
    sync()
  }
  context.renderer.on("resize", onResize)
  onCleanup(() => context.renderer.off("resize", onResize))

  const [stored, update] = context.storage.store(noteKey(props.sessionID), { initial: { text: "" } })
  const initialText = stored.text
  const indent = indentFor(context.options.indent)

  const [_mode, _setMode] = createSignal<"editor" | "buttons">("editor")
  const [_cursor, _setCursor] = createSignal(0)
  const [_dialog, _setDialog] = createSignal<{ readonly kind: "save" | "load"; readonly query: string } | null>(null)
  const [_status, _setStatus] = createSignal("")
  const [_busy, _setBusy] = createSignal<{ readonly kind: "format" | "btw"; readonly label: string } | null>(null)

  const size = _size
  const mode = _mode
  const cursor = _cursor
  const dialog = _dialog
  const status = _status
  const busy = _busy

  // Every write goes through a wrapper so the page is redrawn at the moment the
  // state changes. The host's renderer does not re-evaluate JSX props, and its
  // solid scheduler is not driven by this code, so nothing else would repaint.
  const setMode = (value: "editor" | "buttons") => {
    _setMode(value)
    sync()
  }
  const setCursor = (value: number | ((current: number) => number)) => {
    if (typeof value === "function") _setCursor(value)
    else _setCursor(value)
    sync()
  }
  const setDialog = (value: { readonly kind: "save" | "load"; readonly query: string } | null) => {
    _setDialog(value)
    sync()
  }
  const setStatus = (value: string) => {
    _setStatus(value)
    sync()
  }
  const setBusy = (value: { readonly kind: "format" | "btw"; readonly label: string } | null) => {
    _setBusy(value)
    sync()
  }

  let area: TextareaRenderable | undefined
  let latest = initialText
  let abort: AbortController | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  const cwd = process.cwd()

  /** Current note text: the buffer once it exists, the store before that. */
  const currentText = () => area?.plainText ?? latest

  const flush = () => {
    clearTimeout(saveTimer)
    const value = latest
    void update((draft) => {
      draft.text = value
    })
  }

  const persist = () => {
    if (!area) return
    latest = area.plainText
    clearTimeout(saveTimer)
    saveTimer = setTimeout(flush, 200)
  }

  onCleanup(() => flush())

  /** Replaces the whole buffer (load, clear, format, btw) and persists it. */
  const applyText = (value: string) => {
    latest = value
    area?.setText(value)
    void update((draft) => {
      draft.text = value
    })
    setMode("editor")
    queueMicrotask(() => area?.focus())
  }

  // ---- guard against a key being handled twice (keymap layer + renderable) --
  let closeGuard = 0
  let tabGuard = 0
  /** When the filename dialog last closed: the same Escape must not close the view. */
  let dialogClosedAt = 0
  const guarded = (slot: "close" | "tab"): boolean => {
    const now = Date.now()
    if (slot === "close") {
      if (now - closeGuard < 60) return false
      closeGuard = now
      return true
    }
    if (now - tabGuard < 60) return false
    tabGuard = now
    return true
  }

  const focusEditor = () => {
    setMode("editor")
    queueMicrotask(() => area?.focus())
  }

  const focusButtons = () => {
    setMode("buttons")
    area?.blur()
  }

  const close = () => {
    flush()
    props.close()
  }

  const requestClose = () => {
    if (escapeTarget(dialog() !== null) === "dialog") {
      closeDialog()
      return
    }
    if (Date.now() - dialogClosedAt < 120) return
    if (guarded("close")) close()
  }

  const movePage = (direction: number, select: boolean) => {
    if (!area) return
    const rows = pageRows(area.height ?? 10)
    for (let index = 0; index < rows; index++) {
      if (direction < 0) area.moveCursorUp({ select })
      else area.moveCursorDown({ select })
    }
  }

  const copySelection = () => {
    const selected = area?.getSelectedText()
    if (!selected) {
      setStatus("Nothing selected")
      return
    }
    const copied = context.renderer.copyToClipboardOSC52(selected)
    setStatus(copied ? `Copied ${selected.length} characters` : "Could not reach the clipboard")
  }

  /** Wraps the selection with the typed character, keeping the inner text selected. */
  const wrapTyped = (char: string): boolean => {
    if (!area) return false
    const wrapper = wrapperFor(char)
    if (!wrapper) return false
    const selection = area.getSelection()
    if (!selection) return false
    const selected = area.getSelectedText()
    if (!selected) return false
    area.insertText(wrapSelection(wrapper.open, selected, wrapper.close))
    const after = selectionAfterWrap(selection, wrapper)
    area.setSelection(after.start, after.end)
    persist()
    return true
  }

  // ---- buttons -------------------------------------------------------------

  function insert() {
    const value = area?.getSelectedText() || currentText()
    if (!value) {
      setStatus("The note is empty")
      return
    }
    area?.clearSelection()
    flush()
    // `closePage` navigates away; the note itself stays in the store.
    props.close(value)
  }

  function clearNote() {
    applyText("")
    setStatus("Cleared")
  }

  // ---- filename dialog: Save and Load share one implementation ------------

  const dialogQuery = () => dialog()?.query ?? ""
  const completions = () => (dialog() === null ? [] : listPathMatches(cwd, completionQuery(dialogQuery())))

  function openDialog(kind: "save" | "load") {
    if (busy()) return
    setMode("editor")
    setStatus("")
    setDialog({ kind, query: "" })
    // The editor keeps focus so typing still arrives through `onEditorKey`; the
    // dialog draws over it and swallows the keys it needs.
    queueMicrotask(() => area?.focus())
  }

  function closeDialog() {
    if (dialog() === null) return
    dialogClosedAt = Date.now()
    setDialog(null)
    setStatus("")
    queueMicrotask(() => area?.focus())
  }

  function updateDialogQuery(change: (query: string) => string) {
    const state = dialog()
    if (!state) return
    setDialog({ kind: state.kind, query: change(state.query) })
  }

  /** Tab completion: the first match, which is enough to walk into a directory. */
  function completeDialog() {
    const state = dialog()
    if (!state) return
    const first = listPathMatches(cwd, completionQuery(state.query))[0]
    if (!first) return
    setDialog({ kind: state.kind, query: applyCompletion(state.query, first.label) })
  }

  function saveTo(target: string) {
    try {
      const path = writeNoteFile(resolveNotePath(cwd, target), currentText())
      setStatus(`Saved ${context.ui.format.path(path)}`)
      context.ui.toast.show({ title: "Note", message: `Saved ${context.ui.format.path(path)}`, variant: "success" })
    } catch (error) {
      setStatus(`Could not save: ${messageOf(error)}`)
      context.ui.toast.show({ title: "Note", message: `Could not save: ${messageOf(error)}`, variant: "error" })
    }
  }

  function loadFile(path: string) {
    try {
      const text = readNoteFile(path)
      closeDialog()
      applyText(text)
      setStatus(`Loaded ${context.ui.format.path(path)}`)
    } catch {
      setStatus(`Cannot read ${context.ui.format.path(path)}`)
    }
  }

  function commitSave(query: string) {
    closeDialog()
    saveTo(saveTarget(query))
  }

  function commitLoad(query: string) {
    const plan = loadPlan(cwd, query)
    if (plan.kind === "browse") {
      setDialog({ kind: "load", query: plan.query })
      return
    }
    if (plan.kind === "nothing") {
      // Keep the dialog open: a path can still be typed.
      setStatus("Nothing to load: no NOTE.md in this directory")
      return
    }
    // Enter commits: opening the file closes the dialog.
    loadFile(plan.path)
  }

  function commitDialog() {
    const state = dialog()
    if (!state) return
    if (state.kind === "save") commitSave(state.query)
    else commitLoad(state.query)
  }

  const modelRef = () => {
    const current = context.ui.model.current()
    if (!current) return undefined
    return current.variant
      ? { id: current.modelID, providerID: current.providerID, variant: current.variant }
      : { id: current.modelID, providerID: current.providerID }
  }

  /**
   * Runs one stateless model call. The request never belongs to a session, so
   * neither the note nor the answer can end up in the chat context.
   */
  async function withModel(kind: "format" | "btw", label: string, work: (signal: AbortSignal) => Promise<string>) {
    if (busy()) return
    const controller = new AbortController()
    abort = controller
    area?.blur()
    setStatus("")
    setBusy({ kind, label })
    try {
      const value = await work(controller.signal)
      applyText(value)
      setStatus(kind === "format" ? "Formatted" : "Answered")
    } catch (error) {
      if (controller.signal.aborted) setStatus("Cancelled")
      else {
        setStatus(`Failed: ${messageOf(error)}`)
        context.ui.toast.show({
          title: kind === "format" ? "Format failed" : "Btw failed",
          message: messageOf(error),
          variant: "error",
        })
      }
    } finally {
      abort = undefined
      setBusy(null)
      focusEditor()
    }
  }

  function formatNote() {
    const source = currentText()
    if (!source.trim()) {
      setStatus("The note is empty")
      return
    }
    void withModel("format", "Formatting…", async (signal) => {
      const result = await context.client.experimental.generate.text({ prompt: formatRequest(source), model: modelRef() }, { signal })
      return result.text.trim()
    })
  }

  function askBtw() {
    const question = currentText()
    if (!question.trim()) {
      setStatus("The note is empty")
      return
    }
    void withModel("btw", "Answering…", async (signal) => {
      let conversation = ""
      try {
        conversation = transcriptOf(await context.client.session.context({ sessionID: props.sessionID }))
      } catch (error) {
        console.error("opencode-note: could not read the chat context for /btw", error)
      }
      const result = await context.client.experimental.generate.text(
        { prompt: btwRequest(question, conversation), model: modelRef() },
        { signal },
      )
      return `${question.replace(/\n+$/, "")}\n\n---\n\n${result.text.trim()}`
    })
  }

  function cancelWork() {
    if (!busy()) return
    abort?.abort()
    setStatus("Cancelled")
  }

  const pressButton = (index: number) => {
    const button = BUTTONS[index]
    if (!button) return
    const actions: Record<ButtonKey, () => void> = {
      i: insert,
      c: clearNote,
      s: () => openDialog("save"),
      l: () => openDialog("load"),
      f: formatNote,
      b: askBtw,
    }
    actions[button.key]()
  }

  const pressKey = (letter: ButtonKey) => {
    const index = BUTTONS.findIndex((button) => button.key === letter)
    if (index < 0) return
    setCursor(index)
    pressButton(index)
  }

  // ---- keyboard ------------------------------------------------------------

  const onDialogKey = (key: KeyEvent) => {
    const typed = printable(key)
    if (typed !== undefined) {
      key.preventDefault()
      updateDialogQuery((query) => query + typed)
      return
    }
    if (key.name === "backspace") {
      key.preventDefault()
      updateDialogQuery((query) => query.slice(0, -1))
      return
    }
    if (key.name === "return" || key.name === "kpenter" || key.name === "enter") {
      key.preventDefault()
      commitDialog()
      return
    }
    if (key.name === "tab") {
      key.preventDefault()
      completeDialog()
      return
    }
    if (key.name === "escape") {
      key.preventDefault()
      closeDialog()
    }
  }

  const onEditorKey = (key: KeyEvent) => {
    if (busy()) return
    if (dialog() !== null) {
      // The dialog owns the keyboard while it is open; the textarea is not fed.
      onDialogKey(key)
      return
    }
    if (Date.now() - dialogClosedAt < 120) {
      // The same keypress that settled the dialog must not reach the editor.
      if (key.name === "return" || key.name === "kpenter" || key.name === "enter" || key.name === "tab") {
        key.preventDefault()
        return
      }
    }

    if (key.name === "escape") {
      key.preventDefault()
      requestClose()
      return
    }
    if (key.name === "tab") {
      key.preventDefault()
      if (key.shift) return
      if (guarded("tab")) focusButtons()
      return
    }
    if (key.name === "return" || key.name === "kpenter" || key.name === "enter") {
      key.preventDefault()
      area?.newLine()
      if (key.ctrl && indent) area?.insertText(indent)
      persist()
      return
    }
    if (key.name === "pageup") {
      key.preventDefault()
      movePage(-1, key.shift)
      return
    }
    if (key.name === "pagedown") {
      key.preventDefault()
      movePage(1, key.shift)
      return
    }
    if (key.name === "c" && key.ctrl) {
      key.preventDefault()
      copySelection()
      return
    }
    const typed = printable(key)
    if (typed !== undefined && wrapTyped(typed)) key.preventDefault()
  }

  // Which layer is live follows the focus: the textarea handles the editor, the
  // keymap handles the button bar and the running model call.
  context.keymap.layer(() => ({
    mode: "global",
    priority: 110,
    enabled: () => mode() === "editor" && !busy() && dialog() === null,
    commands: [
      { id: "opencode-note.editor.escape", bind: "escape", run: () => requestClose() },
      { id: "opencode-note.editor.buttons", bind: "tab", run: () => { if (guarded("tab")) focusButtons() } },
    ],
  }))

  context.keymap.layer(() => ({
    mode: "global",
    priority: 120,
    enabled: () => mode() === "buttons" && !busy() && dialog() === null,
    commands: [
      { id: "opencode-note.buttons.editor", bind: "tab", run: () => { if (guarded("tab")) focusEditor() } },
      {
        id: "opencode-note.buttons.prev",
        bind: "left,up,shift+tab",
        run: () => setCursor((index) => (index + BUTTONS.length - 1) % BUTTONS.length),
      },
      {
        id: "opencode-note.buttons.next",
        bind: "right,down",
        run: () => setCursor((index) => (index + 1) % BUTTONS.length),
      },
      { id: "opencode-note.buttons.press", bind: "return,enter,space", run: () => pressButton(cursor()) },
      { id: "opencode-note.buttons.escape", bind: "escape", run: () => requestClose() },
      ...BUTTONS.map((button) => ({
        id: `opencode-note.buttons.${button.key}`,
        bind: button.key,
        run: () => pressKey(button.key),
      })),
    ],
  }))

  context.keymap.layer(() => ({
    mode: "global",
    priority: 130,
    enabled: () => busy() !== null,
    commands: [{ id: "opencode-note.busy.cancel", bind: "escape", run: () => cancelWork() }],
  }))

  // The filename dialog wins over every page binding: its Escape closes the
  // dialog, never the view, and Enter commits instead of adding a newline.
  context.keymap.layer(() => ({
    mode: "global",
    priority: 140,
    enabled: () => dialog() !== null && !busy(),
    commands: [
      { id: "opencode-note.dialog.escape", bind: "escape", run: () => closeDialog() },
      { id: "opencode-note.dialog.commit", bind: "return,enter", run: () => commitDialog() },
      { id: "opencode-note.dialog.complete", bind: "tab", run: () => completeDialog() },
    ],
  }))

  // ---- rendering -----------------------------------------------------------
  //
  // OpenCode loads this file with a plain JSX transform, so a reconciled prop is
  // evaluated once: a signal read inside JSX never re-renders. Every part of the
  // page that changes while it is open is therefore written onto its renderable
  // from an effect below, which is also how the host's own views stay live.

  const innerWidth = () => panelWidth(size().width)
  const innerHeight = () => Math.max(8, Math.floor(size().height * 0.7))

  const header = () => {
    const short = props.sessionID.replace(/^ses_/, "").slice(0, 8)
    return `note · ${short}${props.created ? " · new chat" : ""}`
  }

  const hints = () => {
    if (dialog() !== null) {
      return dialog()?.kind === "load"
        ? "Load: Enter opens · Tab completes · typing filters · Esc cancels"
        : "Save: Enter writes · Tab completes · typing filters · Esc cancels"
    }
    if (mode() === "buttons") return "Tab to edit · ←→ select · Enter or Space presses · Esc closes"
    return "Tab for commands · Esc closes · Ctrl+Enter newline and indent · Ctrl+C copies"
  }

  let rootBox: BoxRenderable | undefined
  let panelBox: BoxRenderable | undefined
  let buttonBar: TextRenderable | undefined
  let hintLine: TextRenderable | undefined
  let dialogBox: BoxRenderable | undefined
  let dialogTitle: TextRenderable | undefined
  let dialogDirectory: TextRenderable | undefined
  let dialogInput: TextRenderable | undefined
  let dialogHint: TextRenderable | undefined
  const matchRows: Array<TextRenderable | undefined> = []
  let busyBox: BoxRenderable | undefined
  let busyLine: TextRenderable | undefined

  const styled = (chunks: Array<{ text: string; fg?: unknown; bg?: unknown }>) =>
    new StyledText(chunks.map((chunk) => ({ __isChunk: true, text: chunk.text, fg: chunk.fg, bg: chunk.bg }) as TextChunk))

  const syncSize = () => {
    if (rootBox) {
      rootBox.width = size().width
      rootBox.height = size().height
    }
    if (panelBox) {
      panelBox.width = innerWidth()
      panelBox.height = innerHeight()
    }
    if (busyBox) {
      const width = Math.max(24, Math.min(48, size().width - 2))
      busyBox.width = width
      busyBox.height = 3
      busyBox.top = Math.max(0, Math.floor(size().height / 2) - 2)
      busyBox.left = Math.max(0, Math.floor((size().width - width) / 2))
    }
  }

  /** `[i]nsert`: the bracketed letter carries the theme's action accent. */
  const syncButtons = () => {
    if (!buttonBar) return
    const runs: Array<{ text: string; fg?: unknown; bg?: unknown }> = []
    BUTTONS.forEach((button, index) => {
      const selected = mode() === "buttons" && cursor() === index
      const plain = selected ? { fg: colors.panel, bg: colors.accent } : { fg: colors.muted }
      const letter = selected ? { fg: colors.panel, bg: colors.accent } : { fg: colors.accent }
      runs.push({ text: "[", ...plain })
      runs.push({ text: button.key, ...letter })
      runs.push({ text: `]${button.label}  `, ...plain })
    })
    buttonBar.content = styled(runs)
  }

  const syncHint = () => {
    if (!hintLine) return
    const message = status() || hints()
    hintLine.content = styled([{ text: message }])
    hintLine.fg = status() ? colors.accent : colors.faint
  }

  const dialogWidth = () =>
    Math.max(1, Math.min(Math.max(1, innerWidth() - 2), Math.max(40, Math.floor(size().width * 0.6))))
  const DIALOG_HEIGHT = 9

  const syncDialog = () => {
    const state = dialog()
    if (!dialogBox) return
    dialogBox.visible = state !== null
    if (!state) return
    const width = dialogWidth()
    dialogBox.width = width
    dialogBox.height = DIALOG_HEIGHT
    dialogBox.top = Math.max(0, Math.floor((size().height - DIALOG_HEIGHT) / 2))
    dialogBox.left = Math.max(0, Math.floor((size().width - width) / 2))
    if (dialogTitle) dialogTitle.content = state.kind === "save" ? "Save note to a file" : "Load a file into the note"
    if (dialogDirectory) dialogDirectory.content = `relative to ${context.ui.format.path(cwd)}`
    if (dialogInput) {
      dialogInput.content = state.query
        ? styled([{ text: "> ", fg: colors.accent }, { text: state.query, fg: colors.text }])
        : styled([{ text: "> ", fg: colors.accent }, { text: "NOTE.md", fg: colors.faint }])
    }
    if (dialogHint) {
      const named = completionQuery(state.query) === "" && noteFileExists(cwd, "NOTE.md")
      dialogHint.visible = state.kind === "load" && named
      dialogHint.content = "  NOTE.md  (Enter opens it)"
    }
    const rows = completions().slice(0, matchRows.length)
    matchRows.forEach((row, index) => {
      if (!row) return
      const match = rows[index]
      row.visible = match !== undefined
      if (!match) return
      row.content = styled([{ text: `  ${match.label}` }])
      row.fg = match.directory ? colors.muted : colors.text
    })
  }

  const syncBusy = () => {
    const running = busy()
    if (busyBox) busyBox.visible = running !== null
    if (busyLine && running) busyLine.content = `${running.label}   Esc to cancel`
  }

  function sync() {
    syncSize()
    syncButtons()
    syncHint()
    syncDialog()
    syncBusy()
  }

  return (
    <box
      ref={(node: BoxRenderable) => {
        rootBox = node
      }}
      width={size().width}
      height={size().height}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      backgroundColor={colors.background}
    >
      <box
        ref={(node: BoxRenderable) => {
          panelBox = node
        }}
        width={innerWidth()}
        height={innerHeight()}
        border
        borderStyle="rounded"
        borderColor={colors.border}
        backgroundColor={colors.panel}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        <text wrapMode="none" content={header()} fg={colors.accent} />
        <textarea
          ref={(node: TextareaRenderable) => {
            area = node
            queueMicrotask(() => {
              node.focus()
              sync()
            })
          }}
          flexGrow={1}
          width="100%"
          initialValue={initialText}
          keyBindings={KEY_BINDINGS}
          wrapMode="word"
          backgroundColor={colors.panel}
          focusedBackgroundColor={colors.panel}
          textColor={colors.text}
          focusedTextColor={colors.text}
          cursorColor={colors.accent}
          placeholder="Write anything. It stays here, out of the chat."
          onContentChange={() => persist()}
          onKeyDown={onEditorKey}
        />
        <text
          ref={(node: TextRenderable) => {
            buttonBar = node
          }}
          wrapMode="none"
          content={BUTTONS.map((button) => `[${button.key}]${button.label}`).join("  ")}
        />
        <text
          ref={(node: TextRenderable) => {
            hintLine = node
          }}
          wrapMode="none"
          content={hints()}
          fg={colors.faint}
        />
      </box>
      <box
        ref={(node: BoxRenderable) => {
          dialogBox = node
        }}
        position="absolute"
        top={0}
        left={0}
        width={40}
        height={DIALOG_HEIGHT}
        border
        borderStyle="rounded"
        borderColor={colors.accent}
        backgroundColor={colors.panel}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        visible={false}
      >
        <text
          ref={(node: TextRenderable) => {
            dialogTitle = node
          }}
          wrapMode="none"
          content="Save note to a file"
          fg={colors.accent}
        />
        <text
          ref={(node: TextRenderable) => {
            dialogDirectory = node
          }}
          wrapMode="none"
          content=""
          fg={colors.muted}
        />
        <text
          ref={(node: TextRenderable) => {
            dialogInput = node
          }}
          wrapMode="none"
          content=""
        />
        <text
          ref={(node: TextRenderable) => {
            dialogHint = node
          }}
          wrapMode="none"
          content=""
          fg={colors.faint}
          visible={false}
        />
        {[0, 1, 2, 3, 4].map((index) => (
          <text
            ref={(node: TextRenderable) => {
              matchRows[index] = node
            }}
            wrapMode="none"
            content=" "
            visible={false}
          />
        ))}
      </box>
      <box
        ref={(node: BoxRenderable) => {
          busyBox = node
        }}
        position="absolute"
        top={Math.max(0, Math.floor(size().height / 2) - 2)}
        left={Math.max(0, Math.floor((size().width - Math.min(48, size().width)) / 2))}
        width={Math.min(48, size().width)}
        height={3}
        border
        borderStyle="rounded"
        borderColor={colors.accent}
        backgroundColor={colors.panel}
        alignItems="center"
        justifyContent="center"
        visible={false}
      >
        <text
          ref={(node: TextRenderable) => {
            busyLine = node
          }}
          wrapMode="none"
          content=""
          fg={colors.accent}
        />
      </box>
    </box>
  )
}
