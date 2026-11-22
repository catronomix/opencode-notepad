# AGENTS.md

Context for agents working in this repository.

## What this is

An OpenCode plugin (`opencode-notepad`) with two parts:

- `src/index.ts` — server part: a no-op entry point. The TUI half is the only
  writer of notes (see the key rule below).
- `src/tui.tsx` — TUI part: the `/note` route, editor, picker and button bar.
- `src/editor.ts`, `src/note.ts`, `src/llm.ts`, `src/keys.ts` — pure helpers
  shared by both halves. `src/tui.tsx` is the only view; it touches the
  `@opencode/plugin/tui` and `@opentui/*` APIs.

## Rules

- Notes are keyed by session in `context.storage`, as `opencode-notepad.<hex>`
  where the hex is the session ID's UTF-8 bytes (`src/keys.ts`). The encoding is
  reversible, so two session IDs can never share a key. Only the TUI half writes
  notes: the server storage is a different namespace (its `scan`/`remove` see the
  server `kv` table, not TUI state), so a server-side delete could only touch a
  key the plugin never writes. Notes written under the old lossy key are copied
  into the new key and the old record is emptied when the page opens.
  Never put note text into a session message or a prompt that belongs to a
  session.
- `Format` and `Btw` must keep using `client.experimental.generate.text`; the
  calls are stateless on purpose.
- OpenCode loads `tui.tsx` with a plain JSX transform: JSX props are evaluated
  once and never re-render. Anything that changes at runtime is written onto the
  renderable from `sync()` — do not reintroduce signal reads in JSX.
- Keys arrive twice (renderable `onKeyDown` and keymap layers); per-key guards
  (`guardedNewline`, `guardedTab`, `edgeGuard`) keep one physical key from being
  handled twice, and `closing` keeps Escape one-shot.

## Checks

```sh
npx tsc --noEmit
```

No test tooling is shipped. Verify UI changes against a real TUI session.
