/**
 * Storage key layout shared by the TUI and server halves of the plugin.
 *
 * Durable storage validates every key by splitting it on `.` and checking each
 * segment against `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`. A note key is therefore two
 * segments — the plugin's own name and the session — and the session part is
 * sanitized so a session ID with an unexpected character cannot crash the
 * route that opens the note.
 */

export const NOTE_KEY_PREFIX = "opencode-note"

/** What one segment may contain, mirroring the host's validator. */
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** True when `value` is a single storage segment the host accepts. */
export function isStorageSegment(value: string): boolean {
  return SEGMENT.test(value)
}

/**
 * Turns arbitrary text into one storage segment: characters outside the
 * allowed set become `-`, dots are folded too (they would split the key), and a
 * leading non-alphanumeric gets a `s` prefix.
 */
export function storageSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "-")
  if (!cleaned) return "empty"
  return /^[a-zA-Z0-9]/.test(cleaned) ? cleaned : `s${cleaned}`
}

/**
 * Durable key for one session's note, e.g. `opencode-note.ses_e0166d823ffe`.
 * The TUI namespaces it further (`plugin.<id>.<key>`), and every segment of the
 * resulting path must be valid.
 */
export function noteKey(sessionID: string): string {
  return `${NOTE_KEY_PREFIX}.${storageSegment(sessionID)}`
}
