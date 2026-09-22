import assert from "node:assert/strict"
import test from "node:test"

import plugin from "../index.js"

test("published root entrypoint exports the OpenCode v2 plugin", () => {
  assert.equal(plugin.id, "moeblack.vision-bridge")
  assert.equal(typeof plugin.setup, "function")
})
