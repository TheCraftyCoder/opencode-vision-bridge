import assert from "node:assert/strict"
import test from "node:test"

import {
  OpenCodeVisionRunner,
  TRANSIENT_SESSION_TITLE,
  type VisionClient,
} from "../src/opencode-runner.js"
import { VisionRequestRegistry } from "../src/request-registry.js"

function fakeClient(log: string[]): VisionClient {
  return {
    session: {
      create: async (input) => {
        log.push(`create:${input.title}:${input.location.directory}`)
        return { id: "ses_test" }
      },
      generate: async (input) => {
        log.push(`generate:${input.prompt.includes("Describe it")}`)
        return { text: "vision result" }
      },
      interrupt: async () => {
        log.push("interrupt")
      },
      remove: async () => {
        log.push("remove")
      },
    },
  }
}

test("runner uses a named transient session and deletes it after extracting text", async () => {
  const log: string[] = []
  const runner = new OpenCodeVisionRunner({
    client: fakeClient(log),
    requests: new VisionRequestRegistry(),
    agent: "moeblack.vision-bridge.internal",
    model: { providerID: "opencode", id: "vision" },
    timeoutMs: 30_000,
  })

  const text = await runner.describe({
    dataUrl: "data:image/png;base64,cG5n",
    mediaType: "image/png",
    filename: "screen.png",
    fileUrl: "file:///tmp/screen.png",
    question: "Describe it",
  })

  assert.equal(text, "vision result")
  assert.deepEqual(log, [
    `create:${TRANSIENT_SESSION_TITLE}:${process.cwd()}`,
    "generate:true",
    "remove",
  ])
})

test("runner interrupts and removes the transient session when generation fails", async () => {
  const log: string[] = []
  const client = fakeClient(log)
  client.session.generate = async () => {
    log.push("generate:false")
    throw new Error("provider failed")
  }
  const runner = new OpenCodeVisionRunner({
    client,
    requests: new VisionRequestRegistry(),
    agent: "moeblack.vision-bridge.internal",
    model: { providerID: "opencode", id: "vision" },
    timeoutMs: 30_000,
  })

  await assert.rejects(
    runner.describe({
      dataUrl: "data:image/png;base64,cG5n",
      mediaType: "image/png",
      fileUrl: "file:///tmp/screen.png",
      question: "Describe it",
    }),
    /provider failed/,
  )

  assert.deepEqual(log, [
    `create:${TRANSIENT_SESSION_TITLE}:${process.cwd()}`,
    "generate:false",
    "interrupt",
    "remove",
  ])
})

test("runner identifies rendered PDF page batches in the vision prompt", async () => {
  let prompt = ""
  const client = fakeClient([])
  client.session.generate = async (input) => {
    prompt = input.prompt
    return { text: "PDF result" }
  }
  const runner = new OpenCodeVisionRunner({
    client,
    requests: new VisionRequestRegistry(),
    agent: "moeblack.vision-bridge.internal",
    model: { providerID: "opencode", id: "glm-5.3-flash" },
    timeoutMs: 30_000,
  })

  await runner.describe({
    dataUrl: "data:image/png;base64,cGFnZQ==",
    mediaType: "image/png",
    filename: "report-page-1.png",
    source: {
      mediaType: "application/pdf",
      filename: "report.pdf",
      pageStart: 1,
      pageEnd: 8,
      pageCount: 12,
    },
    fileUrl: "file:///tmp/report.pdf",
    question: "Summarize it",
  })

  assert.match(prompt, /attached PDF pages/)
  assert.match(prompt, /pages 1-8 of 12/)
})
