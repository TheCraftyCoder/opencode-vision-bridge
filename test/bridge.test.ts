import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  VisionBridge,
  type BridgeMessage,
  type VisionDescriptionRequest,
} from "../src/bridge.js"

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from("png").toString("base64")}`

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

  await bridge.transform({ modelSupportsVision: true, messages: input })

  assert.equal(calls, 0)
  assert.equal(input[0]?.content[1]?.type, "media")
})

test("no-vision replaces image media with description text and the saved file URL", async () => {
  const requests: VisionDescriptionRequest[] = []
  const bridge = new VisionBridge({
    saveDir: await mkdtemp(path.join(tmpdir(), "vision-bridge-transform-")),
    describe: async (request) => {
      requests.push(request)
      return "A terminal showing a TypeScript compiler error."
    },
  })
  const input = messages()

  await bridge.transform({ modelSupportsVision: false, messages: input })

  assert.equal(requests.length, 1)
  assert.match(requests[0]?.question ?? "", /What does the screenshot show/)
  const replacement = input[0]?.content[1]
  assert.equal(replacement?.type, "text")
  const replacementText =
    replacement?.type === "text" && typeof replacement.text === "string"
      ? replacement.text
      : ""
  assert.match(replacementText, /TypeScript compiler error/)
  assert.match(replacementText, /file:\/\//)
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

  await bridge.transform({ modelSupportsVision: false, messages: messages() })
  await bridge.transform({ modelSupportsVision: false, messages: messages() })

  assert.equal(calls, 1)
})
