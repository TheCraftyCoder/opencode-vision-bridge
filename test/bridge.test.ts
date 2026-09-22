import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

import { PDFDocument } from "@napi-rs/canvas"

import {
  VisionBridge,
  type BridgeMessage,
  type VisionDescriptionRequest,
} from "../src/bridge.js"

const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex")
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`

function pdfBytes(pageCount = 1): Buffer {
  const document = new PDFDocument()
  for (let page = 1; page <= pageCount; page += 1) {
    const context = document.beginPage(320, 200)
    context.fillStyle = "black"
    context.font = "20px sans-serif"
    context.fillText(`PDF page ${page}`, 30, 60)
    document.endPage()
  }
  return document.close()
}

function messages(): BridgeMessage[] {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: "What does the screenshot show?" },
        {
          type: "media",
          mediaType: "image/png",
          data: PNG_DATA_URL,
          filename: "screen.png",
        },
      ],
    },
  ]
}

test("native vision leaves message media untouched and does not call the describer", async () => {
  let calls = 0
  const bridge = new VisionBridge({
    saveDir: await mkdtemp(path.join(tmpdir(), "vision-bridge-native-")),
    describe: async () => {
      calls++
      return "unused"
    },
  })
  const input = messages()

  await bridge.transform({
    modelInputCapabilities: new Set(["text", "image"]),
    messages: input,
  })

  assert.equal(calls, 0)
  assert.equal(input[0]?.content[1]?.type, "media")
})

test("no-vision replaces image media without exposing a local file path", async () => {
  const requests: VisionDescriptionRequest[] = []
  const bridge = new VisionBridge({
    saveDir: await mkdtemp(path.join(tmpdir(), "vision-bridge-transform-")),
    describe: async (request) => {
      requests.push(request)
      return "A terminal showing a TypeScript compiler error."
    },
  })
  const input = messages()

  await bridge.transform({
    modelInputCapabilities: new Set(["text"]),
    messages: input,
  })

  assert.equal(requests.length, 1)
  assert.match(requests[0]?.question ?? "", /What does the screenshot show/)
  const replacement = input[0]?.content[1]
  assert.equal(replacement?.type, "text")
  const replacementText =
    replacement?.type === "text" && typeof replacement.text === "string"
      ? replacement.text
      : ""
  assert.match(replacementText, /TypeScript compiler error/)
  assert.doesNotMatch(replacementText, /file:\/\//)
  assert.equal(replacementText.split("\n")[0], "[Attached image]")
})

test("the same image is described once across repeated context-hook calls", async () => {
  let calls = 0
  const bridge = new VisionBridge({
    saveDir: await mkdtemp(path.join(tmpdir(), "vision-bridge-cache-")),
    describe: async () => {
      calls++
      return "cached description"
    },
  })

  await bridge.transform({
    modelInputCapabilities: new Set(["text"]),
    messages: messages(),
  })
  await bridge.transform({
    modelInputCapabilities: new Set(["text"]),
    messages: messages(),
  })

  assert.equal(calls, 1)
})

test("a vision-provider failure is represented honestly without aborting the parent session", async () => {
  const bridge = new VisionBridge({
    saveDir: await mkdtemp(path.join(tmpdir(), "vision-bridge-unavailable-")),
    describe: async () => {
      throw new Error("OpenCode's free tier can only be used from within OpenCode")
    },
  })
  const input = messages()

  await bridge.transform({
    modelInputCapabilities: new Set(["text"]),
    messages: input,
  })

  const replacement = input[0]?.content[1]
  assert.equal(replacement?.type, "text")
  const replacementText =
    replacement?.type === "text" && typeof replacement.text === "string"
      ? replacement.text
      : ""
  assert.match(replacementText, /Attachment analysis was unavailable/)
  assert.doesNotMatch(replacementText, /free tier can only be used from within OpenCode/)
  assert.doesNotMatch(replacementText, /file:\/\//)
})

test("prompt interception replaces a pasted PDF before attachment resolution", async () => {
  const pdf = pdfBytes()
  const requests: VisionDescriptionRequest[] = []
  const bridge = new VisionBridge({
    saveDir: await mkdtemp(path.join(tmpdir(), "vision-bridge-pdf-")),
    describe: async (request) => {
      requests.push(request)
      return "A two-page design document with an architecture diagram."
    },
  })
  const prompt = {
    text: "Summarize this [PDF 1]",
    files: [
      {
        uri: `data:application/pdf;base64,${pdf.toString("base64")}`,
        name: "design.pdf",
        mention: { start: 15, end: 22, text: "[PDF 1]" },
      },
    ],
  }

  await bridge.transformPrompt(prompt)

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.mediaType, "image/png")
  assert.equal(requests[0]?.source?.mediaType, "application/pdf")
  assert.equal(requests[0]?.source?.filename, "design.pdf")
  assert.deepEqual(prompt.files, [])
  assert.match(prompt.text, /^Summarize this/)
  assert.match(prompt.text, /\[PDF 1\].*\[Attached PDF\]/s)
  assert.match(prompt.text, /\[Attached PDF\]/)
  assert.doesNotMatch(prompt.text, /Filename:/)
  assert.match(prompt.text, /architecture diagram/)
})

test("prompt interception leaves pasted images for capability-aware context handling", async () => {
  let calls = 0
  const bridge = new VisionBridge({
    saveDir: await mkdtemp(path.join(tmpdir(), "vision-bridge-prompt-image-")),
    describe: async () => {
      calls += 1
      return "unused"
    },
  })
  const prompt = {
    text: "Inspect this image",
    files: [{ uri: PNG_DATA_URL, name: "screen.png" }],
  }

  await bridge.transformPrompt(prompt)

  assert.equal(calls, 0)
  assert.equal(prompt.files.length, 1)
})

test("prompt interception reads an attached local PDF file URL", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vision-bridge-file-pdf-"))
  const pdfPath = path.join(directory, "local.pdf")
  await writeFile(pdfPath, pdfBytes())
  const requests: VisionDescriptionRequest[] = []
  const bridge = new VisionBridge({
    saveDir: path.join(directory, "saved"),
    describe: async (request) => {
      requests.push(request)
      return "Local PDF contents"
    },
  })
  const prompt = {
    text: "Summarize it",
    files: [{ uri: pathToFileURL(pdfPath).href, name: "local.pdf" }],
  }

  await bridge.transformPrompt(prompt)

  assert.equal(requests[0]?.mediaType, "image/png")
  assert.equal(requests[0]?.source?.mediaType, "application/pdf")
  assert.deepEqual(prompt.files, [])
  assert.match(prompt.text, /Local PDF contents/)
})

test("prompt interception ignores non-media data attachments", async () => {
  const bridge = new VisionBridge({
    saveDir: await mkdtemp(path.join(tmpdir(), "vision-bridge-prompt-text-")),
    describe: async () => "unused",
  })
  const prompt = {
    text: "Read the note",
    files: [
      {
        uri: "data:text/plain;charset=utf-8;base64,aGVsbG8=",
        name: "note.txt",
      },
    ],
  }

  await bridge.transformPrompt(prompt)

  assert.equal(prompt.files.length, 1)
  assert.equal(prompt.text, "Read the note")
})

test("an invalid pasted PDF becomes an honest unavailable note", async () => {
  let calls = 0
  const bridge = new VisionBridge({
    saveDir: await mkdtemp(path.join(tmpdir(), "vision-bridge-invalid-pdf-")),
    describe: async () => {
      calls += 1
      return "unused"
    },
  })
  const prompt = {
    text: "Read this PDF",
    files: [
      {
        uri: `data:application/pdf;base64,${Buffer.from("not pdf").toString("base64")}`,
        name: "broken.pdf",
      },
    ],
  }

  await bridge.transformPrompt(prompt)

  assert.equal(calls, 0)
  assert.deepEqual(prompt.files, [])
  assert.match(prompt.text, /Attachment analysis was unavailable/)
  assert.doesNotMatch(prompt.text, /Invalid PDF structure/)
})

test("context handling bridges only media unsupported by the active model", async () => {
  const requests: VisionDescriptionRequest[] = []
  const bridge = new VisionBridge({
    saveDir: await mkdtemp(path.join(tmpdir(), "vision-bridge-mixed-")),
    describe: async (request) => {
      requests.push(request)
      return "PDF description"
    },
  })
  const input: BridgeMessage[] = [
    {
      role: "user",
      content: [
        { type: "media", mediaType: "image/png", data: PNG_DATA_URL },
        {
          type: "media",
          mediaType: "application/pdf",
          data: `data:application/pdf;base64,${pdfBytes().toString("base64")}`,
        },
      ],
    },
  ]

  await bridge.transform({
    modelInputCapabilities: new Set(["text", "image"]),
    messages: input,
  })

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.mediaType, "image/png")
  assert.equal(requests[0]?.source?.mediaType, "application/pdf")
  assert.equal(input[0]?.content[0]?.type, "media")
  assert.equal(input[0]?.content[1]?.type, "text")
})

test("PDF pages are rendered into image batches accepted by OpenAI-compatible models", async () => {
  const requests: VisionDescriptionRequest[] = []
  const bridge = new VisionBridge({
    saveDir: await mkdtemp(path.join(tmpdir(), "vision-bridge-pdf-batches-")),
    describe: async (request) => {
      requests.push(request)
      return `Description for pages ${request.source?.pageStart}-${request.source?.pageEnd}`
    },
  })
  const prompt = {
    text: "Summarize every page",
    files: [
      {
        uri: `data:application/pdf;base64,${pdfBytes(9).toString("base64")}`,
        name: "nine-pages.pdf",
      },
    ],
  }

  await bridge.transformPrompt(prompt)

  assert.equal(requests.length, 2)
  assert.deepEqual(
    requests.map((request) => ({
      mediaType: request.mediaType,
      additional: request.additionalMedia?.length,
      start: request.source?.pageStart,
      end: request.source?.pageEnd,
      total: request.source?.pageCount,
    })),
    [
      { mediaType: "image/png", additional: 7, start: 1, end: 8, total: 9 },
      { mediaType: "image/png", additional: 0, start: 9, end: 9, total: 9 },
    ],
  )
  assert.match(prompt.text, /PDF pages 1-8 of 9/)
  assert.match(prompt.text, /PDF pages 9-9 of 9/)
})

test("malformed image data fails soft without rejecting the parent transform", async () => {
  const bridge = new VisionBridge({
    saveDir: await mkdtemp(path.join(tmpdir(), "vision-bridge-malformed-")),
    describe: async () => "unused",
  })
  const input: BridgeMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Read it" },
        {
          type: "media",
          mediaType: "image/png",
          data: "data:image/png;base64,%%%",
        },
      ],
    },
  ]

  await bridge.transform({
    modelInputCapabilities: new Set(["text"]),
    messages: input,
  })

  const replacement = input[0]?.content[1]
  assert.equal(replacement?.type, "text")
  const replacementText =
    replacement?.type === "text" && typeof replacement.text === "string"
      ? replacement.text
      : ""
  assert.match(replacementText, /analysis was unavailable/)
})

test("a missing PDF file fails soft and leaves sibling prompt content intact", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vision-bridge-missing-pdf-"))
  const bridge = new VisionBridge({
    saveDir: path.join(directory, "saved"),
    describe: async () => "unused",
  })
  const prompt = {
    text: "Keep this question",
    files: [
      {
        uri: pathToFileURL(path.join(directory, "missing.pdf")).href,
        name: "missing.pdf",
      },
    ],
  }

  await bridge.transformPrompt(prompt)

  assert.deepEqual(prompt.files, [])
  assert.match(prompt.text, /^Keep this question/)
  assert.match(prompt.text, /analysis was unavailable/)
})

test("a save failure fails soft without calling the provider", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vision-bridge-save-fail-"))
  const blockedPath = path.join(directory, "not-a-directory")
  await writeFile(blockedPath, "blocked")
  let calls = 0
  const bridge = new VisionBridge({
    saveDir: blockedPath,
    describe: async () => {
      calls += 1
      return "unused"
    },
  })
  const input = messages()

  await bridge.transform({
    modelInputCapabilities: new Set(["text"]),
    messages: input,
  })

  assert.equal(calls, 0)
  const replacement = input[0]?.content[1]
  const replacementText =
    replacement?.type === "text" && typeof replacement.text === "string"
      ? replacement.text
      : ""
  assert.match(replacementText, /analysis was unavailable/)
})

test("transient failures are retried instead of cached", async () => {
  let calls = 0
  const bridge = new VisionBridge({
    saveDir: await mkdtemp(path.join(tmpdir(), "vision-bridge-retry-")),
    describe: async () => {
      calls += 1
      throw new Error("temporary provider failure")
    },
  })

  await bridge.transform({
    modelInputCapabilities: new Set(["text"]),
    messages: messages(),
  })
  await bridge.transform({
    modelInputCapabilities: new Set(["text"]),
    messages: messages(),
  })

  assert.equal(calls, 2)
})

test("concurrent duplicate attachments share one in-flight description", async () => {
  let calls = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const bridge = new VisionBridge({
    saveDir: await mkdtemp(path.join(tmpdir(), "vision-bridge-inflight-")),
    describe: async () => {
      calls += 1
      await gate
      return "one shared result"
    },
  })
  const first = messages()
  const second = messages()

  const pending = Promise.all([
    bridge.transform({
      modelInputCapabilities: new Set(["text"]),
      messages: first,
    }),
    bridge.transform({
      modelInputCapabilities: new Set(["text"]),
      messages: second,
    }),
  ])
  await Promise.resolve()
  release?.()
  await pending

  assert.equal(calls, 1)
})

test("a later PDF batch failure preserves earlier pages and is retried", async () => {
  let calls = 0
  const bridge = new VisionBridge({
    saveDir: await mkdtemp(path.join(tmpdir(), "vision-bridge-partial-pdf-")),
    describe: async (request) => {
      calls += 1
      if (request.source?.pageStart === 9) throw new Error("temporary failure")
      return "Pages one through eight"
    },
  })
  const makePrompt = () => ({
    text: "Summarize",
    files: [
      {
        uri: `data:application/pdf;base64,${pdfBytes(9).toString("base64")}`,
        name: "partial.pdf",
      },
    ],
  })
  const first = makePrompt()
  const second = makePrompt()

  await bridge.transformPrompt(first)
  await bridge.transformPrompt(second)

  assert.match(first.text, /Pages one through eight/)
  assert.match(first.text, /PDF pages 9-9 of 9.*analysis was unavailable/s)
  assert.equal(calls, 4)
})

test("context bridging caps the number of analyzed attachments", async () => {
  let calls = 0
  const bridge = new VisionBridge({
    saveDir: await mkdtemp(path.join(tmpdir(), "vision-bridge-count-cap-")),
    describe: async () => {
      calls += 1
      return "described"
    },
  })
  const input: BridgeMessage[] = [
    {
      role: "user",
      content: Array.from({ length: 9 }, () => ({
        type: "media" as const,
        mediaType: "image/png",
        data: PNG_DATA_URL,
      })),
    },
  ]

  await bridge.transform({
    modelInputCapabilities: new Set(["text"]),
    messages: input,
  })

  assert.equal(calls, 1, "duplicates should share one cached description")
  const ninth = input[0]?.content[8]
  assert.equal(ninth?.type, "text")
  const ninthText =
    ninth?.type === "text" && typeof ninth.text === "string" ? ninth.text : ""
  assert.match(
    ninthText,
    /at most 8 bridged attachments/,
  )
})
