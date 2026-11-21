# opencode-notepad

A per-chat scratchpad for the OpenCode terminal UI. Press `/note` (or the palette
command) and a near-fullscreen editor opens over the chat: write, mark a
selection, wrap it in Markdown, save it to a file, or hand it to the model — all
without the note ever entering the chat transcript.

Each chat has its own note. Notes keyed by session live in the plugin's durable
store on disk, not in the conversation, so they survive restarts and never cost
context.

## Install

The package has a server part (`.` → `src/index.ts`) and a TUI part
(`./tui` → `src/tui.tsx`), so a single entry loads both.

```jsonc title="~/.config/opencode/opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    // from a checkout, with options
    { "package": "C:/GITHUB/opencode-notepad", "options": { "indent": 2 } },
  ],
}
```

`opencode plugin add opencode-notepad` works too once the package is published.

For a source-only install (OpenCode resolves `@opencode/plugin`, `@opentui/*`
and `solid-js` from its own runtime), copy the flat sources into
`~/.config/opencode/plugins/opencode-notepad/`:

```sh
cp src/*.ts src/*.tsx ~/.config/opencode/plugins/opencode-notepad/
```

OpenCode discovers that directory by file name (`index` and `tui`). Restart the
TUI to pick it up.

## Configuration

| option   | default | meaning                                                            |
| -------- | ------- | ------------------------------------------------------------------ |
| `indent` | `2`     | One indentation level, added by <kbd>Ctrl</kbd>+<kbd>Return</kbd> on top of the current line's own indentation. A number of spaces or a literal string such as `"\t"`. |

## Keys

| key                                       | action                                              |
| ----------------------------------------- | --------------------------------------------------- |
| <kbd>/note</kbd>, palette “Note”           | open the scratchpad for the current chat            |
| <kbd>Esc</kbd>                             | close the filename dialog, else the scratchpad in one press; cancels a running call |
| <kbd>Tab</kbd>                             | move focus between the editor and the button bar    |
| <kbd>Return</kbd>                          | newline (the page takes it back from the host's `input.submit` binding) |
| <kbd>Ctrl</kbd>+<kbd>Return</kbd>          | newline, carrying the current line's indentation and adding one level |
| <kbd>Home</kbd> / <kbd>End</kbd>           | start / end of the current line (<kbd>Shift</kbd> selects to it) |
| <kbd>PgUp</kbd> / <kbd>PgDn</kbd>          | a screen up / down (<kbd>Shift</kbd> selects)       |
| <kbd>Ctrl</kbd>+<kbd>C</kbd>               | copy the selection                                  |
| <kbd>Ctrl</kbd>+<kbd>Insert</kbd>          | copy the selection (the POSIX copy)                 |
| <kbd>Ctrl</kbd>+<kbd>V</kbd>               | paste the clipboard into the note                   |
| <kbd>Shift</kbd>+<kbd>Insert</kbd>         | paste — handled by the terminal, not by this plugin |
| <kbd>←</kbd> <kbd>→</kbd> in the bar       | pick a button                                       |
| <kbd>Return</kbd> / <kbd>Space</kbd>       | press the selected button                           |

Typing one of `* ~ - ( [ { % $ < \` ' " | : ^ _ /` with text selected wraps the
selection instead of replacing it, and the inner text stays selected so the
wrapper chains: select a word, press `*` twice, get `**word**`.

## Buttons

The bracketed letter is the shortcut — pressing it presses the button.

| button     | action                                                                    |
| ---------- | ------------------------------------------------------------------------- |
| `[i]nsert` | put the note (or the selected fragment) into the chat input and close      |
| `[c]lear`  | empty the note                                                             |
| `[s]ave`   | prompt for a file name (default `NOTE.md`) and write it in the chat's working directory |
| `[l]oad`   | `@./`-style path completion; <kbd>Return</kbd> opens the first match       |
| `[f]ormat` | rewrite the note with the current model                                    |
| `[b]tw`    | answer the note as a side question, with the chat as context, and append   |

`Format` and `Btw` use the stateless generation endpoint: the request never
belongs to a session, so the note never leaks into the transcript and the answer
never appears as an assistant turn. `Btw` reads the session's messages through
the client API and inlines them into the prompt instead, as the first block -
the conversation stays a stable prefix, then the note, then the instruction -
so provider prompt caching keeps working across questions.

## Notes and limits

- The scratchpad is a plugin route: a full-screen page with a centred panel at
  70% width and height, at least 80 columns wide and never wider than the
  terminal. The TUI plugin API has no floating layer above the chat, so the chat
  is hidden while the note is open.
- `Insert` returns to the note's own chat, waits for its prompt to come back, and
  writes into that edit buffer; the note stays there for the next message. When
  no prompt is found the page says so in a toast and inserts nothing — it never
  pastes into another buffer and never opens a different session.
- Closing returns to the exact screen the note was opened over — the route
  snapshot the host's own full-screen pages keep — so no new tab is opened and
  the chat is not re-resolved. One <kbd>Esc</kbd> closes the filename dialog and
  the next closes the note; a press that settles the dialog never also leaves.
- `[s]ave` and `[l]oad` resolve paths against the current chat's working
  directory (the session's `location.directory`, falling back to the project
  directory), never against the directory the TUI was launched in. The dialog
  shows the resolved directory. Default save name is exactly `NOTE.md`.
- Both share one dialog: same box, same title/hint rows, and no
  path completions until something has been typed. While the dialog is open it
  owns the keyboard — the note's textarea is blurred and not focusable.
- A brand-new chat has no session yet; opening the note commits one through the
  API (no prompt, no model call) so the note has somewhere stable to live.
- Deleting a chat deletes its note.
- **Known limitation: clipboard keys on Windows terminals.** Copy writes the
  selection to the Windows clipboard (`Set-Clipboard`, with OSC 52 alongside it)
  and paste reads that clipboard back (with OSC 52 as the fallback), so the two
  directions use the same store. What the page cannot control is the terminal:
  Windows Terminal, conhost and ThinkTerm each claim
  <kbd>Ctrl</kbd>+<kbd>Insert</kbd> (their own copy) and
  <kbd>Shift</kbd>+<kbd>Insert</kbd> (their own paste) before the application
  sees them. In ThinkTerm that terminal-side copy has no terminal selection to
  take and empties the clipboard, which reads as the note wiping it; the note
  never receives the key at all. Use <kbd>Ctrl</kbd>+<kbd>C</kbd> and
  <kbd>Ctrl</kbd>+<kbd>V</kbd>, which are not claimed by the terminal and always
  reach the page. <kbd>Shift</kbd>+<kbd>Insert</kbd> pastes through the
  terminal's own path and is expected to work everywhere; that has only been
  observed on ThinkTerm so far.
  - *Issue note:* confirmed on Windows only (cmd/PowerShell for
    <kbd>Ctrl</kbd>+<kbd>Insert</kbd>, ThinkTerm for <kbd>Shift</kbd>+<kbd>Insert</kbd>).
    Needs verification on a POSIX terminal and on a ThinkTerm build with a real
    selection. If a terminal does forward the keys, they reach the page: both
    <kbd>Ctrl</kbd>+<kbd>Insert</kbd> and <kbd>Ctrl</kbd>+<kbd>C</kbd> are bound
    to the same copy, and <kbd>Shift</kbd>+<kbd>Insert</kbd> is not bound at all.

## Development

```sh
npm install
npm run typecheck
```

## License

MIT
