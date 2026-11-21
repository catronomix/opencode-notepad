/**
 * Prompts for the two model-backed buttons.
 *
 * Both use the stateless generation endpoint (`experimental.generate.text`), so
 * neither call creates a session message: the note never leaks into the chat
 * transcript and the answer never appears as an assistant turn.
 */

export interface ChatMessageLike {
  readonly type?: string
  readonly text?: string
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>
}

function messageText(message: ChatMessageLike): string | undefined {
  if (typeof message.text === "string") return message.text
  if (!Array.isArray(message.content)) return undefined
  const parts = message.content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string)
  return parts.length ? parts.join("\n") : undefined
}

/**
 * Renders the session's messages as a plain transcript. Tool calls and
 * reasoning are dropped: /btw wants the conversation, not the machinery.
 * Only the tail is kept so a long session cannot blow the prompt up.
 */
export function transcriptOf(messages: readonly ChatMessageLike[], limit = 12_000): string {
  const lines: string[] = []
  for (const message of messages) {
    const text = messageText(message)?.trim()
    if (!text) continue
    const role =
      message.type === "user" ? "User" : message.type === "assistant" ? "Assistant" : message.type === "system" ? "System" : undefined
    if (!role) continue
    lines.push(`${role}: ${text}`)
  }
  const joined = lines.join("\n\n")
  if (joined.length <= limit) return joined
  return `…\n${joined.slice(joined.length - limit)}`
}

export function formatRequest(note: string): string {
  return [
    "Rewrite the note below so it is clearer and better organised.",
    "Keep the author's meaning, language and formatting conventions (Markdown stays Markdown).",
    "Fix spelling, grammar and structure. Do not add commentary, headings you were not asked for, or a preamble.",
    "Return only the rewritten note.",
    "",
    "--- NOTE ---",
    note,
    "--- END NOTE ---",
  ].join("\n")
}

export function btwRequest(question: string, conversation: string): string {
  const parts = [
    "You are answering a side question (/btw) about an ongoing coding session.",
    "Answer the note below using the conversation as context. Be direct and brief; do not restate the question.",
    "Return only the answer.",
  ]
  if (conversation.trim()) {
    parts.push("", "--- CONVERSATION ---", conversation, "--- END CONVERSATION ---")
  }
  parts.push("", "--- NOTE ---", question, "--- END NOTE ---")
  return parts.join("\n")
}
