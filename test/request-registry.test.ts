import assert from "node:assert/strict"
import test from "node:test"

import { VisionRequestRegistry } from "../src/request-registry.js"

test("registry injects the pending image into one-shot session context", () => {
  const registry = new VisionRequestRegistry()
  registry.set("ses_test", {
    dataUrl: "data:image/png;base64,cG5n",
    mediaType: "image/png",
    filename: "screen.png",
    fileUrl: "file:///tmp/screen.png",
    question: "Read it",
  })
  const messages = [
    {
      role: "user",
      content: [{ type: "text", text: "Read it" }],
    },
  ]

  assert.equal(registry.inject("ses_test", messages), true)
  assert.deepEqual(messages[0]?.content[1], {
    type: "media",
    mediaType: "image/png",
    data: "data:image/png;base64,cG5n",
    filename: "screen.png",
  })
})

test("registry leaves unrelated sessions unchanged", () => {
  const registry = new VisionRequestRegistry()
  const messages = [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    },
  ]

  assert.equal(registry.inject("ses_other", messages), false)
  assert.equal(messages[0]?.content.length, 1)
})
