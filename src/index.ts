/**
 * Server half of opencode-notepad.
 *
 * Notes are owned by the TUI half alone: it keeps them in the TUI durable store
 * and clears them when the host reports `session.deleted`. This half exists so
 * the package has a normal server entry point, and it deliberately writes
 * nothing: the server and TUI storages are separate (the server's `scan` and
 * `remove` reach the server `kv` table, while TUI state lives in one file per
 * key under the host's state directory), so a server-side delete could only ever
 * touch a key the plugin never writes.
 */
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "opencode-notepad",
  async setup() {
    return () => {}
  },
})
