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
  type BoxRenderable,
  type EditBufferRenderable,
  type KeyEvent,
  type TextChunk,
  type TextRenderable,
  type TextareaRenderable,
} from "@opentui/core"
import type { Context, Route } from "@opencode/plugin/tui/context"
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup } from "solid-js"

import { indentFor, pageRows, printable, selectionAfterWrap, wrapSelection, wrapperFor } from "./editor.ts"
import { btwRequest, formatRequest, transcriptOf } from "./llm.ts"
import { listPathMatches, noteFileExists, noteKey, readNoteFile, resolveNotePath, writeNoteFile, type PathMatch } from "./note.ts"

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
  /** The chat editor that had focus when the overlay opened, if any. */
  readonly editor: EditBufferRenderable | null
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export default Plugin.define({
  id: "opencode-note.tui",
  async setup(context) {
    // The page is a fresh component on every open; this is the state a route
    // reload cannot carry (renderable identity).
    let page: PageState | undefined

    const open = async () => {
      const current = context.ui.router.current()
      if (current.type === "plugin" && current.name === PAGE) return
      const tabs = context.ui.tabs.enabled() ? context.ui.tabs.list() : []
      let sessionID = tabs.find((tab) => tab.active)?.sessionID ?? (current.type === "session" ? current.sessionID : undefined)
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
      page = { sessionID, created, previous: current, editor: context.renderer.currentFocusedEditor }
      context.ui.router.navigate({ type: "plugin", name: PAGE, data: { sessionID, created, previous: current } })
    }

    /**
     * Leaves the page. With `insert`, the note (or the fragment that was
     * selected) is written into the chat input once the host has restored it.
     */
    const closePage = (insert?: string) => {
      const state = page
      page = undefined
      const destination: Route = state?.created
        ? { type: "session", sessionID: state.sessionID }
        : (state?.previous ?? { type: "home" })
      context.ui.router.navigate(destination)

      if (insert !== undefined) {
        const captured = state?.editor
        setTimeout(() => {
          try {
            // The host rebuilds the prompt when the route changes, so the chat
            // editor is usually a different renderable than the one captured;
            // prefer whatever holds focus now and fall back to the captured one.
            const focused = context.renderer.currentFocusedEditor
            const target = focused && !focused.isDestroyed ? focused : captured && !captured.isDestroyed ? captured : undefined
            if (target) {
              context.renderer.focusRenderable(target)
              target.insertText(insert)
              return
            }
            context.renderer.copyToClipboardOSC52(insert)
            context.ui.toast.show({
              title: "Note",
              message: "No chat input was available: the note is on the clipboard instead",
              variant: "warning",
            })
          } catch (error) {
            console.error("opencode-note: could not insert into the chat input", error)
            context.ui.toast.show({ title: "Note", message: `Could not insert the note: ${messageOf(error)}`, variant: "error" })
          }
        }, 150)
      }

      // Safety net: never leave the user trapped on a blank page.
      setTimeout(() => {
        const now = context.ui.router.current()
        if (now.type === "plugin" && now.name === PAGE) context.ui.router.navigate({ type: "home" })
      }, 400)
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
    selectionBackground: theme.background.raised.high,
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
  const [_picker, _setPicker] = createSignal<string | null>(null)
  const [_status, _setStatus] = createSignal("")
  const [_busy, _setBusy] = createSignal<{ readonly kind: "format" | "btw"; readonly label: string } | null>(null)

  const size = _size
  const mode = _mode
  const cursor = _cursor
  const picker = _picker
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
  const setPicker = (value: string | null) => {
    _setPicker(value)
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

  async function saveNote() {
    const name = await context.ui.dialog.prompt({
      title: "Save note",
      description: `Written relative to ${context.ui.format.path(cwd)}`,
      placeholder: "notes/today.md",
      value: "NOTE.md",
    })
    const target = name?.trim()
    if (!target) {
      focusEditor()
      return
    }
    try {
      const path = writeNoteFile(resolveNotePath(cwd, target), currentText())
      setStatus(`Saved ${context.ui.format.path(path)}`)
      context.ui.toast.show({ title: "Note", message: `Saved ${context.ui.format.path(path)}`, variant: "success" })
    } catch (error) {
      setStatus(`Could not save: ${messageOf(error)}`)
      context.ui.toast.show({ title: "Note", message: `Could not save: ${messageOf(error)}`, variant: "error" })
    }
    focusEditor()
  }

  function startPicker() {
    setMode("editor")
    setStatus("")
    setPicker("")
    queueMicrotask(() => area?.focus())
  }

  const matches = () => (picker() === null ? [] : listPathMatches(cwd, picker() ?? ""))

  function loadFile(path: string) {
    try {
      applyText(readNoteFile(path))
      setPicker(null)
      setStatus(`Loaded ${context.ui.format.path(path)}`)
    } catch {
      setStatus(`Cannot read ${context.ui.format.path(path)}`)
    }
  }

  function pickMatch(match: PathMatch) {
    if (match.directory) {
      setPicker(match.label)
      return
    }
    loadFile(match.path)
  }

  function commitPicker() {
    const query = (picker() ?? "").trim()
    if (!query) {
      if (noteFileExists(cwd, "NOTE.md")) {
        loadFile(resolveNotePath(cwd, "NOTE.md"))
        return
      }
      const first = matches()[0]
      if (first) {
        pickMatch(first)
        return
      }
      setStatus("Nothing to load: no NOTE.md in this directory")
      return
    }
    const first = matches()[0]
    if (first?.directory) {
      setPicker(first.label)
      return
    }
    loadFile(first?.path ?? resolveNotePath(cwd, query))
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
      s: () => void saveNote(),
      l: startPicker,
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

  const onEditorKey = (key: KeyEvent) => {
    if (busy()) return
    if (picker() !== null) {
      // The picker owns the keyboard while it is open; the textarea is not fed.
      const typed = printable(key)
      if (typed !== undefined) {
        key.preventDefault()
        setPicker(`${picker() ?? ""}${typed}`)
        return
      }
      if (key.name === "backspace") {
        key.preventDefault()
        setPicker((picker() ?? "").slice(0, -1))
        return
      }
      if (key.name === "return" || key.name === "kpenter") {
        key.preventDefault()
        commitPicker()
        return
      }
      if (key.name === "escape") {
        key.preventDefault()
        setPicker(null)
        setStatus("")
      }
      return
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
    if (key.name === "return" && key.ctrl) {
      key.preventDefault()
      area?.newLine()
      if (indent) area?.insertText(indent)
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
    enabled: () => mode() === "editor" && !busy(),
    commands: [
      { id: "opencode-note.editor.escape", bind: "escape", run: () => requestClose() },
      { id: "opencode-note.editor.buttons", bind: "tab", run: () => { if (guarded("tab")) focusButtons() } },
    ],
  }))

  context.keymap.layer(() => ({
    mode: "global",
    priority: 120,
    enabled: () => mode() === "buttons" && !busy(),
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

  // ---- rendering -----------------------------------------------------------
  //
  // OpenCode loads this file with a plain JSX transform, so a reconciled prop is
  // evaluated once: a signal read inside JSX never re-renders. Every part of the
  // page that changes while it is open is therefore written onto its renderable
  // from an effect below, which is also how the host's own views stay live.

  const innerWidth = () => Math.max(24, Math.floor(size().width * 0.7))
  const innerHeight = () => Math.max(8, Math.floor(size().height * 0.7))

  const header = () => {
    const short = props.sessionID.replace(/^ses_/, "").slice(0, 8)
    return `note · ${short}${props.created ? " · new chat" : ""}`
  }

  const hints = () => {
    if (picker() !== null) {
      return noteFileExists(cwd, "NOTE.md")
        ? "Load: Enter opens NOTE.md · type to autocomplete · Esc cancels"
        : "Load: type a path · Enter opens the first match · Esc cancels"
    }
    if (mode() === "buttons") return "Tab to edit · ←→ select · Enter or Space presses · Esc closes"
    return "Tab for commands · Esc closes · Ctrl+Enter newline and indent · Ctrl+C copies"
  }

  let rootBox: BoxRenderable | undefined
  let panelBox: BoxRenderable | undefined
  let buttonBar: TextRenderable | undefined
  let hintLine: TextRenderable | undefined
  let pickerBox: BoxRenderable | undefined
  let pickerInput: TextRenderable | undefined
  let pickerHint: TextRenderable | undefined
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

  const syncPicker = () => {
    if (!pickerBox) return
    pickerBox.visible = picker() !== null
    if (picker() === null) return
    if (pickerInput) pickerInput.content = styled([{ text: "> ", fg: colors.accent }, { text: picker() ?? "", fg: colors.text }])
    const named = picker() === "" && noteFileExists(cwd, "NOTE.md")
    if (pickerHint) {
      pickerHint.visible = named
      pickerHint.content = "  NOTE.md  (Enter opens it)"
    }
    const rows = matches().slice(0, matchRows.length)
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
    syncPicker()
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
          selectionBg={colors.selectionBackground}
          selectionFg={colors.text}
          placeholder="Write anything. It stays here, out of the chat."
          onContentChange={() => persist()}
          onKeyDown={onEditorKey}
        />
        <box
          ref={(node: BoxRenderable) => {
            pickerBox = node
          }}
          flexDirection="column"
          visible={false}
        >
          <text
            ref={(node: TextRenderable) => {
              pickerInput = node
            }}
            wrapMode="none"
            content=">"
          />
          <text
            ref={(node: TextRenderable) => {
              pickerHint = node
            }}
            wrapMode="none"
            content="  NOTE.md  (Enter opens it)"
            fg={colors.faint}
            visible={false}
          />
          {[0, 1, 2, 3].map((index) => (
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
