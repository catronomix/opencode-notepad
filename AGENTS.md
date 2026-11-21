# AGENTS.md

Context for agents working in this repository.

## What this is

An OpenCode plugin (`opencode-notepad`) with two parts:

- `src/index.ts` — server part: clears a deleted chat's note from storage.
- `src/tui.tsx` — TUI part: the `/note` route, editor, picker and button bar.
- `src/editor.ts`, `src/note.ts`, `src/llm.ts`, `src/keys.ts` — pure helpers
  shared by both halves. `src/tui.tsx` is the only view; it touches the
  `@opencode/plugin/tui` and `@opentui/*` APIs.

## Rules

- Notes are keyed by session (`opencode-notepad.<sessionID>`) in `context.storage`.
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
