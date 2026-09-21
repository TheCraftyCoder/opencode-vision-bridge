import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"

import {
  DEFAULT_VISION_MODEL,
  parseOptions,
  type PluginOptionsInput,
} from "../src/config.js"

const projectRoot = "/tmp/plugin-root"

test("parseOptions defaults to GLM-5.3-Flash through OpenCode", () => {
  const options = parseOptions({}, projectRoot)

  assert.deepEqual(options.vision, {
    type: "opencode",
    model: DEFAULT_VISION_MODEL,
  })
})

test("parseOptions accepts an explicit OpenCode provider model", () => {
  const options = parseOptions(
    { vision: { model: "provider/vision-model" } },
    projectRoot,
  )

  assert.deepEqual(options.vision, {
    type: "opencode",
    model: "provider/vision-model",
  })
  assert.equal(options.saveDir, path.resolve(projectRoot, "images"))
})

test("parseOptions accepts a custom OpenAI-compatible endpoint", () => {
  const input: PluginOptionsInput = {
    vision: {
      type: "openai-compatible",
      model: "vision-model",
      baseURL: "https://vision.example/v1/",
      apiKey: "secret",
    },
    saveDir: path.resolve(projectRoot, "saved-images"),
    timeoutMs: 45_000,
  }

  const options = parseOptions(input, projectRoot)

  assert.deepEqual(options.vision, {
    type: "openai-compatible",
    model: "vision-model",
    baseURL: "https://vision.example/v1",
    apiKey: "secret",
  })
  assert.equal(options.saveDir, path.resolve(projectRoot, "saved-images"))
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
        projectRoot,
      ),
    /apiKey/,
  )
})
