/**
 * TUI half of opencode-notepad: a per-session scratchpad that stays out of the
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
  RGBA,
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
import { createEffect, createRoot, createSignal, onCleanup } from "solid-js"
import { execFileSync } from "node:child_process"

import { indentFor, insertNewline, leadingWhitespace, pageRows, printable, selectionAfterWrap, shade, wrapSelection, wrapperFor } from "./editor.ts"
import { FLAGS_KEY } from "./keys.ts"
import { btwRequest, formatRequest, transcriptOf } from "./llm.ts"
import { MAX_NOTE_BYTES, NOTE_TOO_LARGE, canMigrateLegacy, legacyNoteKey, listPathMatches, noteKey, noteTooLarge, readNoteFile, resolveNotePath, writeNoteFile, type PathMatch } from "./note.ts"
import {
  DIALOG_HEIGHT,
  DIALOG_MATCH_ROWS,
  NEWLINE_BIND,
  applyCompletion,
  completionQuery,
  dialogKey,
  dialogMatches,
  dialogSpec,
  emptyDialog,
  escapeTarget,
  flagFor,
  insertRoute,
  loadPlan,
  panelWidth,
  returnRoute,
  saveTarget,
  withoutFlag,
  type ChatlessFlag,
  type DialogState,
} from "./rules.ts"

const PAGE = "opencode-notepad"

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

/** The names a terminal uses for the page keys, across the parsers in play. */
const PAGE_UP_NAMES = new Set(["pageup", "page_up", "pgup", "kp_pageup", "kppageup"])
const PAGE_DOWN_NAMES = new Set(["pagedown", "page_down", "pgdn", "kp_pagedown", "kppagedown"])

/** How long a result or error line holds the row before the hint returns. */
const STATUS_TIMEOUT = 4000

interface PageState {
  readonly sessionID: string
  readonly created: boolean
  /** The screen the page was opened over, read from the tab bar (see `returnRoute`). */
  readonly origin: Route
  /** The session's own working directory: files resolve against it, never `process.cwd()`. */
  readonly directory: string
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export default Plugin.define({
  id: "opencode-notepad.tui",
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
     * The chat prompt to insert into. The host rebuilds the prompt when the
     * route changes, so the renderable that had focus when the overlay opened
     * is usually gone. What replaces it is focused by the host as soon as the
     * session screen comes back (`focusable = true; focus()` in its prompt
     * effect), so focus decides first and the tree is only the fallback.
     */
    const findChatInput = (avoid: string): EditBufferRenderable | undefined => {
      const usable = (node: EditBufferRenderable) => !node.isDestroyed && node.visible && node.plainText !== avoid
      const focused = context.renderer.currentFocusedEditor
      if (focused && usable(focused)) return focused
      const found: EditBufferRenderable[] = []
      const walk = (node: Renderable) => {
        if (node.isDestroyed) return
        if (isEditBufferRenderable(node) && usable(node)) found.push(node)
        for (const child of node.getChildren?.() ?? []) walk(child)
      }
      walk(context.renderer.root)
      return found[found.length - 1]
    }

    /**
     * Opens the page. Never rejects: the keymap command returns its promise to
     * the host, so every failure (route, location, session creation) is caught
     * here and reported instead of becoming an unhandled rejection.
     */
    const open = async () => {
      try {
        const current = context.ui.router.current()
        if (current.type === "plugin" && current.name === PAGE) return
        const tabs = context.ui.tabs.enabled() ? context.ui.tabs.list() : []
        const activeTab = tabs.find((tab) => tab.active)?.sessionID
        // The host moves to this page before the command runs, so the route under
        // it is not available here. The tab bar is: an active tab is the chat on
        // screen, no active tab is the home screen.
        const origin: Route = activeTab ? { type: "session", sessionID: activeTab } : { type: "home" }
        let sessionID = activeTab
        let created = false
        // Files resolve against the chat's own working directory, never against
        // `process.cwd()` (which is only the directory the TUI was launched in).
        // The host publishes that directory as a `LocationRef`: the session record
        // carries it per chat, `context.location` for the screen being shown, and
        // `data.location.default()` for the project. Read, in that order.
        const projectDirectory = (): string => {
          try {
            return context.location?.directory ?? context.data.location.default().directory
          } catch {
            return process.cwd()
          }
        }
        let directory = projectDirectory()
        if (sessionID) {
          try {
            directory = context.data.session.get(sessionID)?.location.directory ?? directory
          } catch {
            // The session record is a convenience: the project directory will do.
          }
        }
        if (!sessionID) {
          // A brand-new chat has no session yet. Committing one through the API
          // (no prompt, no model call) is what gives the note a stable home. Its
          // tab is deliberately not focused: closing goes home, never to it.
          try {
            const session = await context.client.session.create({ location: { directory } })
            sessionID = session.id
            created = true
            directory = session.location.directory || directory
          } catch (error) {
            context.ui.toast.show({ title: "Note", message: `Could not start a session: ${messageOf(error)}`, variant: "error" })
            return
          }
        }
        page = { sessionID, created, origin, directory }
        context.ui.router.navigate({ type: "plugin", name: PAGE, data: { sessionID, created, directory } })
        // A flag whose chat is gone is not worth a question later. Checked here
        // because the server is connected by the time a command can run.
        void pruneFlags()
      } catch (error) {
        console.error("opencode-notepad: could not open the note", messageOf(error))
        context.ui.toast.show({ title: "Note", message: `Could not open the note: ${messageOf(error)}`, variant: "error" })
      }
    }

    // ---- chat-less note sessions -------------------------------------------
    //
    // A note opened on the home screen has to create the session it belongs to
    // (the note needs a storage key). Closing an empty note removes it again;
    // closing a note with text lands in its chat and flags that chat, because
    // it has no messages yet: only the note lives there. The plugin API has no
    // tab-close hook (`ui.tabs` exposes `enabled/list/open/focus/move/close`
    // only), so the question "did the user close that tab?" is answered by
    // watching `tabs.list()` for the session disappearing. The flags are
    // durable, so a restart cannot make a stale flag delete a chat the user has
    // since used.

    const [flags, updateFlags] = context.storage.store(FLAGS_KEY, { initial: { pending: [] as ChatlessFlag[] } })
    /** Flags written before this run: the only ones that can be stale. */
    const openedAt = Date.now()

    /** Persists the whole flag list. Never rejects: a failed write is reported. */
    const saveFlags = async (next: readonly ChatlessFlag[]) => {
      try {
        await updateFlags((draft) => {
          draft.pending = next.map((flag) => ({ ...flag }))
        })
      } catch (error) {
        console.error("opencode-notepad: could not save the chat-less chat flags", messageOf(error))
        context.ui.toast.show({
          title: "Note",
          message: `Could not save the chat-less chat flags: ${messageOf(error)}`,
          variant: "error",
        })
      }
    }

    const flagSession = (sessionID: string) => saveFlags(flagFor(flags.pending, sessionID, Date.now()))

    const unflagSession = (sessionID: string) => {
      const next = withoutFlag(flags.pending, sessionID)
      return next.length === flags.pending.length ? Promise.resolve() : saveFlags(next)
    }

    /**
     * Empties a session's note record. The TUI storage can read, write and
     * overwrite a key but has no `remove`, so an empty record is the closest the
     * API allows (see README) — and the page writes nothing into it again once
     * the session is gone.
     */
    const dropNote = (sessionID: string) => {
      const [, set] = context.storage.store(noteKey(sessionID), { initial: { text: "" } })
      return Promise.resolve(
        set((draft) => {
          draft.text = ""
        }),
      )
    }

    /** Deletes a session the note created and left empty; the failure is reported, the screen is already home. */
    const removeSession = async (sessionID: string) => {
      try {
        await context.client.session.remove({ sessionID })
      } catch (error) {
        console.error("opencode-notepad: could not delete the empty chat", messageOf(error))
        context.ui.toast.show({
          title: "Note",
          message: `Could not delete the empty chat: ${messageOf(error)}`,
          variant: "error",
        })
      }
    }

    /**
     * Drops the flags whose session is gone (deleted while the TUI was closed).
     * The tab bar cannot answer that — a session may simply have no tab — so
     * the server is asked, from `open()` where the connection is certainly up.
     * A failed lookup drops the flag rather than keeping it: the worst case is
     * a question that is never asked, never a chat deleted on a guess.
     */
    const pruneFlags = async () => {
      for (const flag of [...flags.pending]) {
        if (flag.flaggedAt >= openedAt) continue
        try {
          await context.client.session.get({ sessionID: flag.sessionID })
        } catch (error) {
          console.error("opencode-notepad: dropping a flag whose chat is gone", messageOf(error))
          await unflagSession(flag.sessionID)
        }
      }
    }

    /**
     * Leaves the page. With `insert`, the note (or the fragment that was
     * selected) is written into the chat prompt of its own session once the
     * host has restored that screen.
     */
    const closePage = (insert?: string, text = "") => {
      const state = page
      page = undefined
      // Inserting is proof the chat is in use, whichever page it was opened
      // from (the note reopened over the chat it landed in is an ordinary page
      // with `created: false`): the chat-less question no longer applies.
      if (state && insert !== undefined) void unflagSession(state.sessionID)
      if (state?.created && insert === undefined) {
        if (!text.trim()) {
          // An empty note leaves nothing behind: the session the page had to
          // create is removed again and the user is back on the new-chat
          // screen, where the page was opened.
          context.ui.router.navigate({ type: "home" })
          void removeSession(state.sessionID)
          return
        } else {
          // The note has text, so it must stay reachable: land in the chat it
          // belongs to — the same destination Insert uses, without pasting —
          // and remember that the chat still has no messages of its own.
          context.ui.router.navigate(insertRoute(state))
          void flagSession(state.sessionID)
          return
        }
      }
      // Closing returns to the chat the page was opened over (or home when the
      // page had to create the chat). Insert instead goes to the note's own
      // chat, which is where its text has to be pasted. Neither resolves a
      // session of its own: the host's tab store opens a tab for every session
      // route that becomes current, so an existing chat reuses its screen.
      const destination = state ? (insert === undefined ? returnRoute(state) : insertRoute(state)) : { type: "home" as const }
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
              console.error("opencode-notepad: could not insert into the chat input", messageOf(error))
              context.ui.toast.show({ title: "Note", message: `Could not insert the note: ${messageOf(error)}`, variant: "error" })
              return
            }
          }
          if (Date.now() - started < 2000) {
            setTimeout(attempt, 60)
            return
          }
          // No prompt after the restore: say so and stay put, rather than
          // navigating somewhere else or pasting into the wrong buffer.
          context.ui.toast.show({
            title: "Note",
            message: "Could not find this chat's input after reopening it: the note was not inserted",
            variant: "error",
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
        const directory = typeof data?.directory === "string" ? data.directory : ""
        if (!sessionID) {
          page = undefined
          return (
            <box width="100%" height="100%" backgroundColor={context.theme.background.base} padding={1}>
              <text content="opencode-notepad: no session" fg={context.theme.text.muted} />
            </box>
          )
        }
        return <Note context={context} sessionID={sessionID} created={created} directory={directory} close={closePage} />
      },
    })

    // Deleting a chat deletes its note. The note never leaves the plugin's
    // durable store, so clearing the key is the whole cleanup. The mutator
    // returns a promise: it is caught here, because a rejected write must not
    // surface as an unhandled rejection in the host. The session's chat-less
    // flag goes with it: there is no chat left to ask about.
    const stop = context.data.on("session.deleted", (event) => {
      const sessionID = event.data.sessionID
      dropNote(sessionID).catch((error) =>
        console.error("opencode-notepad: could not clear the note of a deleted session", messageOf(error)),
      )
      void unflagSession(sessionID)
    })

    /**
     * The chat-less question, asked once per disappearance. A session that was
     * flagged and is gone from the tab bar has its tab closed: the note is the
     * only thing in it, so ask before deleting it. The chat is never deleted on
     * a guess — if it has messages, or the check cannot be made, the flag is
     * simply dropped and the chat stays. Never rejects: it is called from an
     * effect, where a rejection would surface in the host.
     */
    const settlingChats = new Set<string>()
    const checkChatless = async (sessionID: string) => {
      if (settlingChats.has(sessionID)) return
      settlingChats.add(sessionID)
      try {
        // Chatting in the session answers the question before it is asked: the
        // chat is not chat-less any more.
        let messages: readonly unknown[]
        try {
          messages = await context.client.session.context({ sessionID })
        } catch (error) {
          console.error("opencode-notepad: could not read a chat-less chat", messageOf(error))
          await unflagSession(sessionID)
          return
        }
        if (messages.length > 0) {
          await unflagSession(sessionID)
          return
        }
        const confirmed = await context.ui.dialog.confirm({
          title: "Delete this chat?",
          message: "This chat has no messages, only the note written from it. Delete the chat and its note?",
          label: { confirm: "Delete", cancel: "Keep" },
        })
        if (!confirmed) {
          // Keeping means keeping both, with the tab left closed.
          await unflagSession(sessionID)
          return
        }
        await context.client.session.remove({ sessionID })
        await dropNote(sessionID)
        await unflagSession(sessionID)
      } catch (error) {
        console.error("opencode-notepad: could not settle a chat-less chat", messageOf(error))
        context.ui.toast.show({
          title: "Note",
          message: `Could not settle the empty chat: ${messageOf(error)}`,
          variant: "error",
        })
      } finally {
        settlingChats.delete(sessionID)
      }
    }

    /**
     * Flags survive a restart, so "disappeared" has to be an edge: only a
     * session this process has actually seen open and then not open counts.
     * A flag loaded at startup with no tab open was never closed here and
     * prompts nothing; the tab has to be seen first.
     */
    const seenOpen = new Set<string>()
    const disposeFlags = createRoot((dispose) => {
      createEffect(() => {
        if (!context.ui.tabs.enabled()) return
        const open = new Set(context.ui.tabs.list().map((tab) => tab.sessionID))
        for (const flag of [...flags.pending]) {
          const sessionID = flag.sessionID
          if (open.has(sessionID)) {
            seenOpen.add(sessionID)
            continue
          }
          // Chatting in it answers the question before it is asked. The flag
          // itself is not pruned here: a session without a tab is not gone, and
          // only the server knows which ones are (see `pruneFlags`).
          let used = false
          try {
            used = context.data.session.message.list(sessionID).length > 0
          } catch {
            used = false
          }
          if (used) {
            seenOpen.delete(sessionID)
            void unflagSession(sessionID)
            continue
          }
          if (!seenOpen.has(sessionID)) continue
          seenOpen.delete(sessionID)
          void checkChatless(sessionID)
        }
      })
      return dispose
    })

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "opencode-notepad.open",
          title: "Note",
          description: "Open the scratchpad for this chat",
          group: "Note",
          bind: "ctrl+shift+n,alt+n",
          palette: true,
          slash: { name: "note" },
          run: () => open(),
        },
      ],
    }))

    return () => {
      disposeFlags()
      stop()
      unregister()
    }
  },
})

interface NoteProps {
  readonly context: Context
  readonly sessionID: string
  readonly created: boolean
  /** The chat's working directory, resolved by the host when the page opened. */
  readonly directory: string
  /** Leaves the page: `insert` is the text to paste, `text` the note as it was left. */
  readonly close: (insert?: string, text?: string) => void
}

function Note(props: NoteProps) {
  const context = props.context
  /** Set when the host disposes the page: nothing may touch its renderables after. */
  let disposed = false
  onCleanup(() => {
    disposed = true
    abort?.abort()
  })
  /** Set once the view has decided to leave, so a second delivery is ignored. */
  let closing = false
  /** The page is leaving or gone: status lines and repaints are pointless now. */
  const settling = () => disposed || closing
  const theme = context.theme
  const colors = {
    background: theme.background.base,
    panel: theme.background.raised.base,
    // The note box's border ink doubles as the title chip's background, so the
    // chip is the border's own colour inverted with the panel behind the text.
    border: theme.markdown.heading,
    text: theme.text.base,
    muted: theme.text.muted,
    faint: theme.text.faint,
    accent: theme.text.action.primary.base,
    emphasis: theme.markdown.emphasis,
    // The popup's border ink. purple.200 is the theme's own scale rather than a
    // value copied out of it; a theme without that scale falls back to the
    // accent hue. The resolved theme exposes more hue scales than its type names.
    popupBorder: (theme.hue as unknown as Record<string, Record<number, RGBA>>).purple?.[200] ?? theme.hue.accent[200],
    // The theme's selection token resolves to a transparent black here, which
    // draws nothing; the action accent is the visible selection block.
    selection: theme.text.action.primary.base,
  }

  /**
   * A colour's channels scaled by `factor`. The popup surfaces are derived from
   * the note box's own background rather than declared: +10% brightness for the
   * popup, and the popup's field 20% darker than that.
   */
  const tone = (color: unknown, factor: number): RGBA => {
    const hex = shade(color, factor)
    return hex === undefined ? (color as RGBA) : RGBA.fromHex(hex)
  }
  const popupFill = tone(colors.panel, 1.1)
  const popupField = tone(popupFill, 0.8)

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
  const indent = indentFor(context.options.indent)

  const [_mode, _setMode] = createSignal<"editor" | "buttons">("editor")
  const [_cursor, _setCursor] = createSignal(0)
  const [_dialog, _setDialog] = createSignal<{ readonly kind: "save" | "load" } | null>(null)
  const [_dialogText, _setDialogText] = createSignal<DialogState>(emptyDialog())
  const [_matches, _setMatches] = createSignal<PathMatch[]>([])
  const [_status, _setStatus] = createSignal("")
  const [_caretOn, _setCaretOn] = createSignal(true)
  const [_busy, _setBusy] = createSignal<{ readonly kind: "format" | "btw"; readonly label: string } | null>(null)

  const size = _size
  const mode = _mode
  const cursor = _cursor
  const dialog = _dialog
  const dialogValue = _dialogText
  const status = _status
  const caretOn = _caretOn
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
  const setDialog = (value: { readonly kind: "save" | "load" } | null) => {
    _setDialog(value)
    sync()
  }
  const setStatus = (value: string) => {
    // The page is leaving or gone: no repaint, no timer, no toast target.
    if (settling()) return
    clearTimeout(statusTimer)
    _setStatus(value)
    sync()
    // A result line is news, not chrome: it is answered at once and then gives
    // the row back to the contextual hint after a few seconds.
    if (value) statusTimer = setTimeout(() => {
      _setStatus("")
      sync()
    }, STATUS_TIMEOUT)
  }
  const setBusy = (value: { readonly kind: "format" | "btw"; readonly label: string } | null) => {
    _setBusy(value)
    sync()
  }

  let area: TextareaRenderable | undefined
  let abort: AbortController | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let statusTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(statusTimer))

  /** One status line and one toast for a write that did not reach the store. */
  const reportSaveFailure = (error: unknown) => {
    if (settling()) return
    console.error("opencode-notepad: could not save the note", messageOf(error))
    setStatus("Could not save the note")
    context.ui.toast.show({ title: "Note", message: "Could not save the note", variant: "error" })
  }

  /**
   * Writes the note into the durable store. The host's mutator returns a
   * promise, and its rejection is caught here so it can never become an
   * unhandled one. The text stays in memory either way, so the next keystroke
   * retries the write.
   */
  const saveNote = (value: string) => {
    try {
      Promise.resolve(
        update((draft) => {
          draft.text = value
        }),
      ).catch(reportSaveFailure)
    } catch (error) {
      reportSaveFailure(error)
    }
  }

  // Migration: notes written before the keys became reversible live under the
  // old, lossy key. The text is copied into the new key and the old record is
  // emptied, once, the first time a session is opened with an empty new note.
  // Only a session ID the old segment encoded without loss is migrated: for any
  // other ID the old key could name a different chat, so it is left alone. The
  // host's TUI storage has no `remove`, so an old record cannot be deleted;
  // emptying it is the closest the API allows (see README).
  let migratedText = ""
  if (!stored.text && canMigrateLegacy(props.sessionID)) {
    try {
      const [legacy, setLegacy] = context.storage.store(legacyNoteKey(props.sessionID), { initial: { text: "" } })
      if (legacy.text) {
        migratedText = legacy.text
        saveNote(migratedText)
        Promise.resolve(
          setLegacy((draft) => {
            draft.text = ""
          }),
        ).catch((error) => console.error("opencode-notepad: could not empty the old note record", messageOf(error)))
      }
    } catch (error) {
      console.error("opencode-notepad: could not migrate the old note", messageOf(error))
    }
  }
  const initialText = stored.text || migratedText
  let latest = initialText
  let overLimitNotified = false

  // The dialog's caret is its focus indicator, so it blinks only while the
  // dialog is open and stops with it.
  let caretTimer: ReturnType<typeof setInterval> | undefined
  const startCaret = () => {
    if (caretTimer) return
    _setCaretOn(true)
    caretTimer = setInterval(() => {
      _setCaretOn(!_caretOn())
      sync()
    }, 530)
  }
  const stopCaret = () => {
    clearInterval(caretTimer)
    caretTimer = undefined
    _setCaretOn(true)
  }
  onCleanup(() => clearInterval(caretTimer))

  // The chat's working directory, captured when the page opened. Save and Load
  // resolve against this, never against the TUI process's cwd.
  const directory =
    props.directory ||
    context.location?.directory ||
    (() => {
      try {
        return context.data.location.default().directory
      } catch {
        return process.cwd()
      }
    })()

  /** Current note text: the buffer once it exists, the store before that. */
  const currentText = () => area?.plainText ?? latest

  /** The reason + user-visible wording every cap refusal shares. */
  const refuseTooLarge = (action: "save" | "paste") => {
    const message = `Cannot ${action === "paste" ? "paste" : "save the note"}: ${NOTE_TOO_LARGE}`
    setStatus(message)
    context.ui.toast.show({ title: "Note", message, variant: "error" })
  }

  const flush = (notify = true) => {
    clearTimeout(saveTimer)
    const value = latest
    // The note never grows past the cap in the store: the text stays in the
    // editor, so the user can cut it down and the next write goes through.
    if (noteTooLarge(value)) {
      if (notify && !overLimitNotified) {
        overLimitNotified = true
        refuseTooLarge("save")
      }
      return
    }
    overLimitNotified = false
    saveNote(value)
  }

  const persist = () => {
    if (!area || disposed) return
    latest = area.plainText
    clearTimeout(saveTimer)
    if (noteTooLarge(latest)) {
      // Typing past the cap: say it once, keep the text, write nothing.
      if (!overLimitNotified) {
        overLimitNotified = true
        refuseTooLarge("save")
      }
      return
    }
    overLimitNotified = false
    saveTimer = setTimeout(() => flush(false), 200)
  }

  onCleanup(() => flush(false))

  /** Replaces the whole buffer (load, clear, format, btw) and persists it. */
  const applyText = (value: string) => {
    if (disposed) return
    latest = value
    area?.setText(value)
    if (noteTooLarge(value)) {
      if (!overLimitNotified) {
        overLimitNotified = true
        refuseTooLarge("save")
      }
    } else {
      overLimitNotified = false
      saveNote(value)
    }
    setMode("editor")
    queueMicrotask(() => {
      if (disposed) return
      area?.focus()
    })
  }

  // ---- guard against a key being handled twice (keymap layer + renderable) --
  let tabGuard = 0
  /**
   * One physical Enter reaches the page twice: once through the keymap (where
   * the page claims `return`) and once through the textarea's own key handler.
   * A short window keeps it a single newline without swallowing a second press.
   */
  let newlineGuard = 0
  /**
   * When the dialog settled the last key. Only that one press is suppressed
   * elsewhere: the dialog's Enter must not also insert a newline, and the
   * dialog's Escape must not also close the view (dialog first). Nothing else
   * uses this window, so a plain Escape is never swallowed.
   */
  let dialogSettledAt = 0
  const dialogSettled = (): boolean => Date.now() - dialogSettledAt < 60
  const guardedNewline = (): boolean => {
    const now = Date.now()
    if (now - newlineGuard < 30) return false
    newlineGuard = now
    return true
  }
  const guardedTab = (): boolean => {
    const now = Date.now()
    if (now - tabGuard < 60) return false
    tabGuard = now
    return true
  }

  const focusEditor = () => {
    if (settling()) return
    setMode("editor")
    queueMicrotask(() => {
      if (disposed) return
      area?.focus()
      sync()
    })
  }

  const focusButtons = () => {
    if (settling()) return
    setMode("buttons")
    area?.blur()
    sync()
  }

  const close = () => {
    flush(false)
    // The note as it stands decides whether the page has anything left to keep:
    // an empty one takes the session it created with it.
    props.close(undefined, currentText())
  }

  /**
   * Escape is layered: a dialog is closed first, then focus returns from the
   * button bar to the editor, and only an Escape in the editor leaves the view.
   * `closing` absorbs the second delivery of the same press (the textarea path
   * and the keymap layer both see it), and `dialogSettled()` absorbs the press
   * the dialog already used.
   */
  const requestClose = () => {
    if (closing) return
    if (escapeTarget(dialog() !== null) === "dialog") {
      closeDialog()
      return
    }
    if (dialogSettled()) return
    if (mode() === "buttons") {
      focusEditor()
      return
    }
    closing = true
    close()
  }

  /**
   * Home/End are line-scoped here. OpenTUI's buffer edges (`gotoBufferHome`)
   * and the host's `input.select.buffer.*` bindings are deliberately bypassed:
   * the textarea's own key map points Home/End at `line-home`/`line-end`, and
   * this handler (plus the page's keymap layer) covers the shifted variants the
   * host binds before the textarea ever sees them.
   *
   * One physical key arrives on both routes (renderable listener and keymap
   * layer). Repeating the move with `select` would move the anchor onto the old
   * cursor and collapse the very selection it just made, so only the first
   * delivery counts.
   */
  let edgeGuard = 0
  const moveLineEdge = (edge: "home" | "end", select: boolean) => {
    if (!area) return
    const now = Date.now()
    if (now - edgeGuard < 30) return
    edgeGuard = now
    if (edge === "home") area.gotoLineHome({ select })
    else area.gotoLineEnd({ select })
  }

  /**
   * A page is the editor's own visible height, less one row of context, moved
   * one wrapped row at a time — the same unit Up/Down use, so a wrapped line
   * counts as the rows it occupies. The textarea has no page action of its own
   * (`TextareaAction` has no `page-*`), and the host binds `pageup`/`pagedown`
   * to scrolling the message list, so the page claims both here: without that
   * claim the host's session layer sees the key first and the note never moves.
   */
  let pageGuard = 0
  const movePage = (direction: number, select: boolean) => {
    if (!area) return
    const now = Date.now()
    if (now - pageGuard < 30) return
    pageGuard = now
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
    // The system clipboard is the one Ctrl+V reads back, so it is written
    // first; OSC 52 covers terminals whose clipboard the OS does not own.
    const written = writeClipboard(selected)
    const osc = context.renderer.copyToClipboardOSC52(selected)
    setStatus(written || osc ? `Copied ${selected.length} characters` : "Could not reach the clipboard")
  }

  /**
   * The clipboard has two halves: the OS one (readable through a platform
   * tool, writable through `writeClipboard`) and OpenTUI's OSC 52 one. Both are
   * used in both directions, so a copy survives either the terminal or the OS.
   * Ctrl+V is claimed before the textarea: the host's `prompt.paste` belongs to
   * the chat prompt, not here.
   */
  const readClipboard = (): string | undefined => {
    // The default pipe buffer is 1 MiB, which a paste-sized clipboard can
    // fill on its own; give the reader room to answer with the whole text so
    // the cap check, not a pipe error, decides whether the paste is allowed.
    const options = {
      encoding: "utf8" as const,
      timeout: 5000,
      windowsHide: true,
      maxBuffer: MAX_NOTE_BYTES * 2 + 64 * 1024,
    }
    try {
      if (process.platform === "win32") {
        return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"], options)
      }
      if (process.platform === "darwin") return execFileSync("pbpaste", [], options)
      try {
        return execFileSync("wl-paste", ["-n"], options)
      } catch {
        return execFileSync("xclip", ["-selection", "clipboard", "-o"], options)
      }
    } catch {
      return undefined
    }
  }

  /** Writes the selection to the system clipboard; `false` when no tool answered. */
  const writeClipboard = (text: string): boolean => {
    const options = { input: text, encoding: "utf8" as const, timeout: 3000, windowsHide: true }
    try {
      if (process.platform === "win32") {
        execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "$input | Set-Clipboard"], options)
        return true
      }
      if (process.platform === "darwin") {
        execFileSync("pbcopy", [], options)
        return true
      }
      try {
        execFileSync("wl-copy", [], options)
        return true
      } catch {
        execFileSync("xclip", ["-selection", "clipboard", "-i"], options)
        return true
      }
    } catch {
      return false
    }
  }

  const pasteClipboard = () => {
    if (!area) return
    const text = readClipboard()
    if (text === undefined) {
      setStatus("Could not read the clipboard")
      return
    }
    if (!text) {
      setStatus("The clipboard is empty")
      return
    }
    const pasted = text.replace(/\r\n/g, "\n").replace(/\n$/, "")
    if (noteTooLarge(currentText() + pasted)) {
      refuseTooLarge("paste")
      return
    }
    area.insertText(pasted)
    persist()
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
  //
  // While a dialog is open it owns the keyboard outright: the note's textarea
  // is blurred and not focusable, the page keymap layers are switched off, and
  // the dialog box itself takes focus and settles every key in `onDialogKey`.
  // Nothing a key does can reach the note behind it.

  const dialogQuery = () => dialogValue().text

  /**
   * The completion list is built when the query changes, never from `sync()`:
   * the dialog's caret blinks every 530 ms and each repaint used to re-read the
   * directory off the render thread.
   */
  const refreshMatches = () => {
    const state = dialog()
    _setMatches(state === null ? [] : dialogMatches(directory, dialogValue().text))
  }

  const setDialogValue = (state: DialogState) => {
    _setDialogText(state)
    refreshMatches()
    sync()
  }

  function openDialog(kind: "save" | "load") {
    if (busy()) return
    setMode("editor")
    setStatus("")
    setDialogValue(emptyDialog())
    setDialog({ kind })
    refreshMatches()
    startCaret()
    queueMicrotask(() => {
      if (area) {
        area.blur()
        area.focusable = false
      }
      dialogBox?.focus()
      sync()
    })
  }

  function closeDialog() {
    if (dialog() === null) return
    setDialog(null)
    stopCaret()
    setStatus("")
    refreshMatches()
    queueMicrotask(() => {
      if (area) area.focusable = true
      // Focus and the page's mode must move together: the mode signal is what
      // enables the editor's keymap layer, and a mode that disagrees with the
      // real focus leaves keys (Escape included) unclaimed.
      focusEditor()
    })
  }

  /** Tab completion: the first match, which is enough to walk into a directory. */
  function completeDialog() {
    if (!dialog()) return
    const first = listPathMatches(directory, completionQuery(dialogQuery()))[0]
    if (!first) return
    const completed = applyCompletion(dialogQuery(), first.label)
    setDialogValue({ text: completed, caret: completed.length })
  }

  function saveTo(target: string) {
    try {
      const path = writeNoteFile(resolveNotePath(directory, target), currentText())
      setStatus(`Saved ${context.ui.format.path(path)}`)
      context.ui.toast.show({ title: "Note", message: `Saved ${context.ui.format.path(path)}`, variant: "success" })
    } catch (error) {
      setStatus(`Could not save: ${messageOf(error)}`)
      context.ui.toast.show({ title: "Note", message: `Could not save: ${messageOf(error)}`, variant: "error" })
    }
  }

  function loadFile(path: string) {
    const shown = context.ui.format.path(path)
    const result = readNoteFile(path)
    if (!result.ok) {
      // The note is left as it was and the load dialog stays open, so a
      // corrected path can be typed straight away.
      setStatus(`Cannot load ${shown}: ${result.reason}`)
      context.ui.toast.show({ title: "Note", message: `Cannot load ${shown}: ${result.reason}`, variant: "error" })
      return
    }
    closeDialog()
    applyText(result.text)
    setStatus(`Loaded ${shown}`)
  }

  function commitSave(query: string) {
    closeDialog()
    saveTo(saveTarget(query))
  }

  function commitLoad(query: string) {
    const plan = loadPlan(directory, query)
    if (plan.kind === "browse") {
      setDialogValue({ text: plan.query, caret: plan.query.length })
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
    if (state.kind === "save") commitSave(dialogQuery())
    else commitLoad(dialogQuery())
  }

  /** Enter in the note: a new line, plus indentation when Ctrl was held. */
  /** The whitespace the cursor's line starts with, read before the line splits. */
  function lineIndent(): string {
    if (!area) return ""
    const row = area.logicalCursor.row
    const line = area.plainText.split("\n")[row] ?? ""
    return leadingWhitespace(line)
  }

  function addNewline(indentAfter: boolean) {
    if (!area) return
    // Ctrl+Return continues the current line's indentation and adds one level,
    // so Enter inside an indented block nests instead of returning to column 0.
    insertNewline(area, indentAfter ? lineIndent() + indent : "")
    persist()
  }

  const modelRef = () => {
    try {
      const current = context.ui.model.current()
      if (!current) return undefined
      return current.variant
        ? { id: current.modelID, providerID: current.providerID, variant: current.variant }
        : { id: current.modelID, providerID: current.providerID }
    } catch (error) {
      console.error("opencode-notepad: could not read the current model", messageOf(error))
      return undefined
    }
  }

  /**
   * Runs one stateless model call. The request never belongs to a session, so
   * neither the note nor the answer can end up in the chat context.
   *
   * Never rejects: its callers hand it to the host, and the reporting in the
   * catch block plus the cleanup in `finally` are guarded so a failure there
   * cannot become a second, unhandled rejection. A page that is closing or gone
   * aborts the call instead of painting its result.
   */
  async function withModel(kind: "format" | "btw", label: string, work: (signal: AbortSignal) => Promise<string>) {
    if (busy() || disposed) return
    const controller = new AbortController()
    abort = controller
    try {
      area?.blur()
      setStatus("")
      setBusy({ kind, label })
      const value = await work(controller.signal)
      if (disposed) return
      applyText(value)
      setStatus(kind === "format" ? "Formatted" : "Answered")
    } catch (error) {
      if (disposed) return
      try {
        if (controller.signal.aborted) setStatus("Cancelled")
        else {
          setStatus(`Failed: ${messageOf(error)}`)
          context.ui.toast.show({
            title: kind === "format" ? "Format failed" : "Btw failed",
            message: messageOf(error),
            variant: "error",
          })
        }
      } catch (reporting) {
        console.error("opencode-notepad: could not report a failed model call", messageOf(reporting))
      }
    } finally {
      abort = undefined
      try {
        if (!disposed) {
          setBusy(null)
          focusEditor()
        }
      } catch (cleanup) {
        console.error("opencode-notepad: could not leave the busy state", messageOf(cleanup))
      }
    }
  }

  function formatNote(): void | Promise<void> {
    const source = currentText()
    if (!source.trim()) {
      setStatus("The note is empty")
      return
    }
    return withModel("format", "Formatting…", async (signal) => {
      const result = await context.client.experimental.generate.text({ prompt: formatRequest(source), model: modelRef() }, { signal })
      return result.text.trim()
    })
  }

  function askBtw(): void | Promise<void> {
    const question = currentText()
    if (!question.trim()) {
      setStatus("The note is empty")
      return
    }
    return withModel("btw", "Answering…", async (signal) => {
      let conversation = ""
      try {
        conversation = transcriptOf(await context.client.session.context({ sessionID: props.sessionID }))
      } catch (error) {
        console.error("opencode-notepad: could not read the chat context for /btw", messageOf(error))
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
    const actions: Record<ButtonKey, () => void | Promise<void>> = {
      i: insert,
      c: clearNote,
      s: () => openDialog("save"),
      l: () => openDialog("load"),
      f: formatNote,
      b: askBtw,
    }
    try {
      const running = actions[button.key]()
      // A model call is the only action that returns a promise. It reports its
      // own failures; the catch is the last line of defence against a rejection
      // escaping into the host's key dispatch.
      if (running) void running.catch((error) => console.error("opencode-notepad: model action failed", messageOf(error)))
    } catch (error) {
      console.error("opencode-notepad: could not run a button action", messageOf(error))
    }
  }

  const pressKey = (letter: ButtonKey) => {
    const index = BUTTONS.findIndex((button) => button.key === letter)
    if (index < 0) return
    setCursor(index)
    pressButton(index)
  }

  // ---- keyboard ------------------------------------------------------------

  /**
   * The dialog's only handler. The dialog box holds focus, so this is the one
   * place a key is interpreted while a dialog is open; every key is consumed
   * here, which is also what keeps it away from the note and from the keymap.
   */
  const onDialogKey = (key: KeyEvent) => {
    if (dialog() === null || busy()) return
    key.preventDefault()
    const result = dialogKey(dialogValue(), {
      name: key.name,
      sequence: key.sequence,
      ctrl: key.ctrl,
      meta: key.meta,
      shift: key.shift,
      option: key.option,
      super: key.super,
    })
    if (result.type === "state") {
      setDialogValue(result.state)
      return
    }
    if (result.type === "cancel") {
      dialogSettledAt = Date.now()
      closeDialog()
      return
    }
    if (result.type === "complete") {
      completeDialog()
      return
    }
    dialogSettledAt = Date.now()
    commitDialog()
  }

  const onEditorKey = (key: KeyEvent) => {
    if (busy()) return
    if (dialog() !== null) {
      // The dialog owns the keyboard while it is open; the note is not fed.
      key.preventDefault()
      return
    }
    if (dialogSettled() && (key.name === "return" || key.name === "kpenter" || key.name === "enter" || key.name === "tab")) {
      // The same press that settled the dialog must not reach the note.
      key.preventDefault()
      return
    }

    if (key.name === "home" || key.name === "end") {
      key.preventDefault()
      moveLineEdge(key.name, key.shift === true)
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
      if (guardedTab()) focusButtons()
      return
    }
    if (key.name === "return" || key.name === "kpenter" || key.name === "enter" || key.name === "linefeed") {
      key.preventDefault()
      // A new line, plus the configured indent when Ctrl was held. Both this
      // path and the keymap command go through `guardedNewline`, because the
      // host delivers one physical Enter to both. `linefeed` counts as the
      // Ctrl variant: a terminal without the kitty protocol reports Ctrl+Enter
      // as LF, which is the only difference it can express.
      if (guardedNewline()) addNewline(key.ctrl === true || key.name === "linefeed")
      return
    }
    if (PAGE_UP_NAMES.has(key.name)) {
      key.preventDefault()
      movePage(-1, key.shift === true)
      return
    }
    if (PAGE_DOWN_NAMES.has(key.name)) {
      key.preventDefault()
      movePage(1, key.shift === true)
      return
    }
    if (key.name === "c" && key.ctrl) {
      key.preventDefault()
      copySelection()
      return
    }
    // Ctrl+Insert is the POSIX copy, and the key most terminals leave intact
    // for the application (`ctrl+shift+c` is the copy the terminal keeps).
    if ((key.name === "insert" || key.name === "kpinsert") && key.ctrl) {
      key.preventDefault()
      copySelection()
      return
    }
    if (key.name === "v" && key.ctrl) {
      key.preventDefault()
      pasteClipboard()
      return
    }
    const typed = printable(key)
    if (typed !== undefined && wrapTyped(typed)) key.preventDefault()
  }

  // Escape is claimed regardless of the page's own focus bookkeeping. The
  // per-mode layers below are only live while `mode()` matches the textarea or
  // the button bar, and a mode that has drifted from the real focus makes the
  // first Escape a no-op: no layer is enabled, and the renderable path never
  // runs because focus is not in the note's textarea. This layer has no such
  // condition (only `busy()`), so one press always settles the view.
  context.keymap.layer(() => ({
    mode: "global",
    priority: 1000,
    enabled: () => !busy(),
    commands: [{ id: "opencode-notepad.escape", bind: "escape", run: () => requestClose() }],
  }))

  // Which layer is live follows the focus: the textarea handles the editor, the
  // keymap handles the button bar and the running model call. The filename
  // dialog is not here at all: it takes focus and handles its own keys.
  context.keymap.layer(() => ({
    mode: "global",
    priority: 110,
    enabled: () => mode() === "editor" && !busy() && dialog() === null,
    commands: [
      { id: "opencode-notepad.editor.buttons", bind: "tab", run: () => { if (guardedTab()) focusButtons() } },
      // Home/End stay on the current line. The plain keys reach the textarea's
      // own key map; the shifted ones are claimed by the host's
      // `input.select.buffer.home`/`end` bindings first, so they are reclaimed
      // here at a higher priority and forwarded to the textarea's line methods.
      { id: "opencode-notepad.editor.line-home", bind: "home", run: () => moveLineEdge("home", false) },
      { id: "opencode-notepad.editor.line-end", bind: "end", run: () => moveLineEdge("end", false) },
      { id: "opencode-notepad.editor.select-line-home", bind: "shift+home", run: () => moveLineEdge("home", true) },
      { id: "opencode-notepad.editor.select-line-end", bind: "shift+end", run: () => moveLineEdge("end", true) },
      // Enter belongs to the note, but OpenCode binds a bare `return` to
      // `input.submit` for the focused editor and consumes it before the
      // textarea sees it. Claiming it here (higher priority) restores the
      // newline. Ctrl+Return is the indented variant and is bound to
      // `input.newline` in the host, so it is claimed at the same priority —
      // otherwise the host inserts its newline with no indentation.
      { id: "opencode-notepad.editor.newline", bind: NEWLINE_BIND, run: () => { if (guardedNewline()) addNewline(false) } },
      {
        id: "opencode-notepad.editor.indent-newline",
        bind: "ctrl+return,linefeed",
        run: () => { if (guardedNewline()) addNewline(true) },
      },
      // PageUp/PageDown are bound to the message list by the host; the note
      // claims both forms so a page move lands in the editor, with the
      // selection when Shift is held.
      { id: "opencode-notepad.editor.page-up", bind: "pageup", run: () => movePage(-1, false) },
      { id: "opencode-notepad.editor.page-down", bind: "pagedown", run: () => movePage(1, false) },
      { id: "opencode-notepad.editor.select-page-up", bind: "shift+pageup", run: () => movePage(-1, true) },
      { id: "opencode-notepad.editor.select-page-down", bind: "shift+pagedown", run: () => movePage(1, true) },
      { id: "opencode-notepad.editor.copy", bind: "ctrl+c,ctrl+insert", run: () => copySelection() },
    ],
  }))

  context.keymap.layer(() => ({
    mode: "global",
    priority: 120,
    enabled: () => mode() === "buttons" && !busy() && dialog() === null,
    commands: [
      { id: "opencode-notepad.buttons.editor", bind: "tab", run: () => { if (guardedTab()) focusEditor() } },
      {
        id: "opencode-notepad.buttons.prev",
        bind: "left,up,shift+tab",
        run: () => setCursor((index) => (index + BUTTONS.length - 1) % BUTTONS.length),
      },
      {
        id: "opencode-notepad.buttons.next",
        bind: "right,down",
        run: () => setCursor((index) => (index + 1) % BUTTONS.length),
      },
      { id: "opencode-notepad.buttons.press", bind: "return,enter,space", run: () => pressButton(cursor()) },
      ...BUTTONS.map((button) => ({
        id: `opencode-notepad.buttons.${button.key}`,
        bind: button.key,
        run: () => pressKey(button.key),
      })),
    ],
  }))

  context.keymap.layer(() => ({
    mode: "global",
    priority: 130,
    enabled: () => busy() !== null,
    commands: [{ id: "opencode-notepad.busy.cancel", bind: "escape", run: () => cancelWork() }],
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
  let titleLine: TextRenderable | undefined
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

  /**
   * The title sits *in* the top border rather than on its own row: inverted
   * chrome (the border's ink as the background, the panel's background as the
   * text) is what separates it from the note's body text.
   */
  const syncTitle = () => {
    if (!titleLine) return
    titleLine.content = styled([{ text: ` ${header()} `, fg: colors.panel, bg: colors.border }])
  }

  const syncHint = () => {
    if (!hintLine) return
    const message = status() || hints()
    hintLine.content = styled([{ text: message }])
    hintLine.fg = status() ? colors.accent : colors.faint
  }

  /**
   * The dialog is a box over the panel, centred, never wider than 72 columns
   * and never wider than the panel itself.
   */
  const dialogWidth = () =>
    Math.max(1, Math.min(Math.max(1, innerWidth() - 2), Math.max(40, Math.floor(size().width * 0.6)), 72))

  /**
   * The dialog's one input row. Its ink is the theme's markdown emphasis and its
   * background is the popup surface a fifth darker, so the row reads as a field
   * inside the popup rather than as a second accent. The caret is a block of the
   * undarkened popup surface: reversed against the field.
   */
  const inputRow = (placeholder: string) => {
    const width = Math.max(1, dialogWidth() - 4)
    const ink = colors.emphasis
    const field = popupField
    const { text, caret } = dialogValue()
    const at = Math.max(0, Math.min(text.length, caret))
    const runs: Array<{ text: string; fg?: unknown; bg?: unknown }> = [{ text: "> ", fg: ink, bg: field }]
    let used = 2
    if (!text) {
      runs.push({ text: " ", fg: ink, bg: caretOn() ? popupFill : field })
      used += 1
      for (const char of placeholder) {
        if (used >= width) break
        runs.push({ text: char, fg: colors.faint, bg: field })
        used += 1
      }
    } else {
      const head = text.slice(0, at)
      if (head) {
        runs.push({ text: head, fg: ink, bg: field })
        used += head.length
      }
      const glyph = text.charAt(at) || " "
      runs.push({ text: glyph, fg: ink, bg: caretOn() ? popupFill : field })
      used += 1
      const tail = text.slice(at + 1)
      if (tail) {
        runs.push({ text: tail, fg: ink, bg: field })
        used += tail.length
      }
    }
    if (used < width) runs.push({ text: " ".repeat(width - used), bg: field })
    return styled(runs)
  }

  const syncDialog = () => {
    const state = dialog()
    if (!dialogBox) return
    dialogBox.visible = state !== null
    if (!state) return
    const spec = dialogSpec(state.kind)
    const width = dialogWidth()
    dialogBox.width = width
    dialogBox.height = DIALOG_HEIGHT
    dialogBox.top = Math.max(0, Math.floor((size().height - DIALOG_HEIGHT) / 2))
    dialogBox.left = Math.max(0, Math.floor((size().width - width) / 2))
    if (dialogTitle) dialogTitle.content = spec.title
    if (dialogDirectory) dialogDirectory.content = context.ui.format.path(directory)
    if (dialogInput) dialogInput.content = inputRow(spec.placeholder)
    if (dialogHint) {
      // A message from the last attempt ("Nothing to load…") takes the row;
      // otherwise the dialog always says what its keys do.
      dialogHint.content = status() || spec.hint
      dialogHint.fg = status() ? colors.accent : colors.faint
    }
    const rows = _matches().slice(0, matchRows.length)
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
    // The host may have disposed the page: its renderables are gone.
    if (disposed) return
    syncSize()
    syncTitle()
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
        <text
          ref={(node: TextRenderable) => {
            titleLine = node
          }}
          position="absolute"
          top={-1}
          left={2}
          wrapMode="none"
          content=""
        />
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
          selectionBg={colors.selection}
          selectionFg={colors.panel}
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
        borderColor={colors.popupBorder}
        // OpenTUI repaints a focused box's border with its own focus colour
        // (#00AAFF by default), which would hide the theme's purple.200; pin both
        // states to the popup's own border ink.
        focusedBorderColor={colors.popupBorder}
        backgroundColor={popupFill}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        focusable
        onKeyDown={onDialogKey}
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
        />
        {Array.from({ length: DIALOG_MATCH_ROWS }, (_, index) => (
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
