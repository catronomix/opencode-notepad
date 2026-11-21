/**
 * Pure editing helpers. Nothing here touches the renderer or the plugin API,
 * so the rules that make the overlay feel like an editor live in one place and
 * stay independent of OpenTUI's editing buffer.
 */

/**
 * Characters that wrap a selection. Directional characters get their matching
 * closing character; every other character wraps with itself, which is what
 * makes `**bold**`, `` `code` ``, `~~strike~~` and friends chain naturally.
 */
export const WRAPPER_PAIRS: Readonly<Record<string, string>> = {
  "(": ")",
  "[": "]",
  "{": "}",
  "<": ">",
  "*": "*",
  "~": "~",
  "-": "-",
  "%": "%",
  $: "$",
  "`": "`",
  "'": "'",
  '"': '"',
  "|": "|",
  ":": ":",
  "^": "^",
  _: "_",
  "/": "/",
}

export interface Wrapper {
  readonly open: string
  readonly close: string
}

/** The wrapper a character would apply, or undefined when it is not one. */
export function wrapperFor(char: string): Wrapper | undefined {
  const close = WRAPPER_PAIRS[char]
  return close === undefined ? undefined : { open: char, close }
}

export function wrapSelection(open: string, selected: string, close: string): string {
  return `${open}${selected}${close}`
}

/**
 * Selection to restore after wrapping. The selection is `[start, end)` in
 * document offsets; the replacement inserts both wrappers, so the whole
 * wrapped run is selected again. That is what makes wrappers chain: `{` over
 * `text` leaves `{text}` selected, and `*` over that leaves `*{text}*`
 * selected instead of reaching into the braces.
 */
export function selectionAfterWrap(
  selection: { readonly start: number; readonly end: number },
  wrapper: Wrapper,
): { readonly start: number; readonly end: number } {
  return { start: selection.start, end: selection.end + wrapper.open.length + wrapper.close.length }
}

/** Just enough of an edit buffer to add a line: a textarea, in practice. */
export interface NewlineTarget {
  newLine(): boolean
  insertText(text: string): void
}

/**
 * Enter's whole effect: a new line, plus the configured indentation when the
 * caller asked for it (Ctrl+Return). Shared by the textarea's own submit hook
 * and the keymap command, so both routes through the host agree.
 */
export function insertNewline(target: NewlineTarget, indent = ""): void {
  target.newLine()
  if (indent) target.insertText(indent)
}

/** Rows a PageUp/PageDown moves the cursor, given the editor's visible height. */
export function pageRows(editorHeight: number): number {
  return Math.max(1, Math.floor(editorHeight) - 1)
}

/**
 * Indentation inserted by Ctrl+Return. Configured with `indent`: a number of
 * spaces, or a literal string (tabs, or an unusual project style).
 */
export function indentFor(option: unknown): string {
  if (typeof option === "string" && !option.includes("\n")) return option
  if (typeof option === "number" && Number.isFinite(option)) return " ".repeat(Math.max(0, Math.min(16, Math.trunc(option))))
  return "  "
}

/**
 * The whitespace a line starts with. Ctrl+Return copies it onto the new line,
 * so pressing Enter inside an indented block nests instead of jumping back to
 * column zero.
 */
export function leadingWhitespace(line: string): string {
  const match = /^[ \t]*/.exec(line)
  return match ? match[0] : ""
}

/**
 * A colour scaled towards black, so a surface can be tinted without leaving the
 * theme. Accepts a hex string or a resolved `RGBA`; `undefined` when the value
 * is neither, so the caller can fall back rather than draw a wrong colour.
 */
export function shade(color: unknown, factor: number): string | undefined {
  const scale = Math.max(0, Math.min(1, factor))
  const hex = typeof color === "string" ? color.trim() : ""
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex)
  const pack = (r: number, g: number, b: number) =>
    `#${((Math.round(r * scale) << 16) | (Math.round(g * scale) << 8) | Math.round(b * scale)).toString(16).padStart(6, "0")}`
  if (match) {
    const digits = match[1]
    const full = digits.length === 3 ? digits.split("").map((digit) => digit + digit).join("") : digits.slice(0, 6)
    const value = Number.parseInt(full, 16)
    return pack((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff)
  }
  if (color && typeof color === "object" && "toInts" in color && typeof (color as { toInts: unknown }).toInts === "function") {
    const [r, g, b] = (color as { toInts(): [number, number, number, number] }).toInts()
    return pack(r, g, b)
  }
  return undefined
}

/**
 * A single printable character typed by the user, or undefined.
 *
 * Control characters are excluded: terminals report Return as the one-character
 * sequence `\r` and Tab as `\t`, and neither is text the user typed.
 */
export function printable(key: {
  readonly sequence?: string
  readonly name?: string
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly super?: boolean
  readonly eventType?: string
}): string | undefined {
  if (key.ctrl || key.meta || key.super) return undefined
  if (key.eventType !== undefined && key.eventType !== "press" && key.eventType !== "repeat") return undefined
  const sequence = key.sequence
  const single =
    typeof sequence === "string" && sequence.length === 1
      ? sequence
      : typeof key.name === "string" && key.name.length === 1
        ? key.name
        : undefined
  if (single === undefined) return undefined
  const code = single.codePointAt(0)
  if (code === undefined || code < 0x20 || code === 0x7f) return undefined
  return single
}
