/** Storage key layout shared by the TUI and server halves of the plugin. */

export const NOTE_KEY_PREFIX = "opencode-note:"

/** Durable key for one session's note. */
export function noteKey(sessionID: string): string {
  return `${NOTE_KEY_PREFIX}${sessionID}`
}
