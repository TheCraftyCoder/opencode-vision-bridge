import assert from "node:assert/strict"
import test from "node:test"

import { VisionRequestRegistry } from "../src/request-registry.js"

test("registry injects the pending image into one-shot session context", () => {
  const registry = new VisionRequestRegistry()
  registry.set("ses_test", {
    dataUrl: "data:image/png;base64,cG5n",
    mediaType: "image/png",
    filename: "screen.png",
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

test("registry injects every rendered PDF page into the GLM Flash request", () => {
  const registry = new VisionRequestRegistry()
  registry.set("ses_pdf", {
    dataUrl: "data:image/png;base64,cGFnZTE=",
    mediaType: "image/png",
    filename: "report-page-1.png",
    additionalMedia: [
      {
        dataUrl: "data:image/png;base64,cGFnZTI=",
        mediaType: "image/png",
        filename: "report-page-2.png",
      },
    ],
    source: {
      mediaType: "application/pdf",
      filename: "report.pdf",
      pageStart: 1,
      pageEnd: 2,
      pageCount: 2,
    },
    question: "Summarize it",
  })
  const messages = [
    { role: "user", content: [{ type: "text", text: "Summarize it" }] },
  ]

  assert.equal(registry.inject("ses_pdf", messages), true)
  assert.deepEqual(messages[0]?.content[1], {
    type: "media",
    mediaType: "image/png",
    data: "data:image/png;base64,cGFnZTE=",
    filename: "report-page-1.png",
  })
  assert.deepEqual(messages[0]?.content[2], {
    type: "media",
    mediaType: "image/png",
    data: "data:image/png;base64,cGFnZTI=",
    filename: "report-page-2.png",
  })
})

test("registry injects a request at most once per session", () => {
  const registry = new VisionRequestRegistry()
  registry.set("ses_once", {
    dataUrl: "data:image/png;base64,cG5n",
    mediaType: "image/png",
    question: "Read it",
  })
  const messages = [
    { role: "user", content: [{ type: "text", text: "Read it" }] },
  ]

  assert.equal(registry.inject("ses_once", messages), true)
  assert.equal(registry.inject("ses_once", messages), false)
  assert.equal(messages[0]?.content.length, 2)
})
