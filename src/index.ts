/**
 * Server half of opencode-notepad.
 *
 * Notes are owned by the TUI half, which keeps them in its durable store and
 * clears them when the host reports `session.deleted`. This half exists so the
 * package has a normal server entry point, and it removes any note left under
 * the server-side key layout for a session that no longer exists.
 */
import { Plugin } from "@opencode/plugin"
import { noteKey } from "./keys.ts"

export default Plugin.define({
  id: "opencode-notepad",
  async setup(context) {
    const controller = new AbortController()

    const watch = async () => {
      for await (const event of context.event.subscribe({ types: ["session.deleted"], signal: controller.signal })) {
        if (event.type !== "session.deleted") continue
        try {
          await context.storage.remove(noteKey(event.data.sessionID))
        } catch (error) {
          console.error("opencode-notepad: could not clear the note for a deleted session", error)
        }
      }
    }

    void watch().catch((error) => {
      if (controller.signal.aborted) return
      console.error("opencode-notepad: session cleanup stopped", error)
    })

    return () => {
      controller.abort()
    }
  },
})
