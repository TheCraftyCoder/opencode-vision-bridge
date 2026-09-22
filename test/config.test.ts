import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_VISION_MODEL,
  parseOptions,
  type PluginOptionsInput,
} from "../src/config.js"

test("parseOptions defaults to GLM-5.3-Flash through OpenCode", () => {
  const options = parseOptions({})

  assert.deepEqual(options.vision, {
    type: "opencode",
    model: DEFAULT_VISION_MODEL,
  })
  assert.equal(options.saveDir, undefined)
})

test("parseOptions accepts an explicit OpenCode provider model", () => {
  const options = parseOptions(
    { vision: { model: "provider/vision-model" } },
  )

  assert.deepEqual(options.vision, {
    type: "opencode",
    model: "provider/vision-model",
  })
  assert.equal(options.saveDir, undefined)
})

test("parseOptions accepts a custom OpenAI-compatible endpoint", () => {
  const input: PluginOptionsInput = {
    vision: {
      type: "openai-compatible",
      model: "vision-model",
      baseURL: "https://vision.example/v1/",
      apiKey: "secret",
    },
    saveDir: "saved-images",
    timeoutMs: 45_000,
  }

  const options = parseOptions(input)

  assert.deepEqual(options.vision, {
    type: "openai-compatible",
    model: "vision-model",
    baseURL: "https://vision.example/v1",
    apiKey: "secret",
  })
  assert.equal(options.saveDir, "saved-images")
  assert.equal(options.timeoutMs, 45_000)
})

test("parseOptions rejects incomplete custom endpoint settings", () => {
  assert.throws(
    () =>
      parseOptions(
        {
          vision: {
            type: "openai-compatible",
            model: "vision-model",
            baseURL: "https://vision.example/v1",
          },
        },
      ),
    /apiKey/,
  )
})
