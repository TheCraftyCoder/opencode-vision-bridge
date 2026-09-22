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
    },
  }
}

test("runner reuses a named session for requests in the same directory", async () => {
  const log: string[] = []
  const runner = new OpenCodeVisionRunner({
    client: fakeClient(log),
    requests: new VisionRequestRegistry(),
    agent: "moeblack.vision-bridge.internal",
    model: { providerID: "opencode", id: "vision" },
    timeoutMs: 30_000,
  })

  const request = {
    dataUrl: "data:image/png;base64,cG5n",
    mediaType: "image/png",
    filename: "screen.png",
    question: "Describe it",
  }
  const text = await runner.describe(request)
  const secondText = await runner.describe({ ...request, question: "Follow-up" })

  assert.equal(text, "vision result")
  assert.equal(secondText, "vision result")
  assert.deepEqual(log, [
    `create:${TRANSIENT_SESSION_TITLE}:${process.cwd()}`,
    "generate:true",
    "generate:false",
  ])
})

test("runner interrupts but retains the reusable session when generation fails", async () => {
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
      question: "Describe it",
    }),
    /provider failed/,
  )

  assert.deepEqual(log, [
    `create:${TRANSIENT_SESSION_TITLE}:${process.cwd()}`,
    "generate:false",
    "interrupt",
  ])
})

test("runner serializes concurrent requests sharing a session", async () => {
  const log: string[] = []
  let active = 0
  let maximumActive = 0
  const client = fakeClient(log)
  client.session.generate = async (input) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    log.push(`start:${input.prompt.includes("first") ? "first" : "second"}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
    log.push(`end:${input.prompt.includes("first") ? "first" : "second"}`)
    active -= 1
    return { text: "vision result" }
  }
  const runner = new OpenCodeVisionRunner({
    client,
    requests: new VisionRequestRegistry(),
    agent: "moeblack.vision-bridge.internal",
    model: { providerID: "opencode", id: "vision" },
    timeoutMs: 30_000,
  })

  await Promise.all([
    runner.describe({
      dataUrl: "data:image/png;base64,cA==",
      mediaType: "image/png",
      question: "first",
    }),
    runner.describe({
      dataUrl: "data:image/png;base64,cA==",
      mediaType: "image/png",
      question: "second",
    }),
  ])

  assert.equal(maximumActive, 1)
  assert.deepEqual(log, [
    `create:${TRANSIENT_SESSION_TITLE}:${process.cwd()}`,
    "start:first",
    "end:first",
    "start:second",
    "end:second",
  ])
})

test("runner reuses the bounded session after a generation failure", async () => {
  const log: string[] = []
  const client = fakeClient(log)
  let attempts = 0
  client.session.generate = async () => {
    attempts += 1
    log.push(`generate:${attempts}`)
    if (attempts === 1) throw new Error("provider failed")
    return { text: "recovered" }
  }
  const runner = new OpenCodeVisionRunner({
    client,
    requests: new VisionRequestRegistry(),
    agent: "moeblack.vision-bridge.internal",
    model: { providerID: "opencode", id: "vision" },
    timeoutMs: 30_000,
  })
  const request = {
    dataUrl: "data:image/png;base64,cA==",
    mediaType: "image/png",
    question: "recover",
  }

  await assert.rejects(runner.describe(request), /provider failed/)
  assert.equal(await runner.describe(request), "recovered")
  assert.deepEqual(log, [
    `create:${TRANSIENT_SESSION_TITLE}:${process.cwd()}`,
    "generate:1",
    "interrupt",
    "generate:2",
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
    question: "Summarize it",
  })

  assert.match(prompt, /attached PDF pages/)
  assert.match(prompt, /pages 1-8 of 12/)
})
