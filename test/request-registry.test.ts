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
  const injected = messages[0]?.content[1] as Record<string, unknown>
  assert.equal(injected?.type, "media")
  assert.equal(injected?.mediaType, "image/png")
  assert.equal(injected?.data, "data:image/png;base64,cG5n")
  assert.equal(injected?.filename, "screen.png")
  assert.ok(injected?.media && typeof injected.media === "object")
  const media = injected.media as Record<string, unknown>
  assert.equal(media.mediaType, "image/png")
  assert.equal(media.kind, "image")
  assert.deepEqual(media.source, {
    type: "base64",
    data: "cG5n",
    mediaType: "image/png",
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
  const injected1 = messages[0]?.content[1] as Record<string, unknown>
  assert.equal(injected1?.type, "media")
  assert.equal(injected1?.mediaType, "image/png")
  assert.equal(injected1?.data, "data:image/png;base64,cGFnZTE=")
  assert.equal(injected1?.filename, "report-page-1.png")
  const media1 = injected1?.media as Record<string, unknown>
  assert.equal(media1?.mediaType, "image/png")

  const injected2 = messages[0]?.content[2] as Record<string, unknown>
  assert.equal(injected2?.type, "media")
  assert.equal(injected2?.mediaType, "image/png")
  assert.equal(injected2?.data, "data:image/png;base64,cGFnZTI=")
  assert.equal(injected2?.filename, "report-page-2.png")
  const media2 = injected2?.media as Record<string, unknown>
  assert.equal(media2?.mediaType, "image/png")
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
