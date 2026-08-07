import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_MODEL,
  parseOptions,
  type PluginOptionsInput,
} from "../src/config.js"

const projectRoot = "/tmp/plugin-root"

test("parseOptions supplies the built-in OpenCode model and project image directory", () => {
  const options = parseOptions({}, projectRoot)

  assert.equal(options.vision.type, "opencode")
  assert.equal(options.vision.model, DEFAULT_MODEL)
  assert.equal(options.saveDir, "/tmp/plugin-root/images")
})

test("parseOptions accepts a custom OpenAI-compatible endpoint", () => {
  const input: PluginOptionsInput = {
    vision: {
      type: "openai-compatible",
      model: "vision-model",
      baseURL: "https://vision.example/v1/",
      apiKey: "secret",
    },
    saveDir: "/tmp/saved-images",
    timeoutMs: 45_000,
  }

  const options = parseOptions(input, projectRoot)

  assert.deepEqual(options.vision, {
    type: "openai-compatible",
    model: "vision-model",
    baseURL: "https://vision.example/v1",
    apiKey: "secret",
  })
  assert.equal(options.saveDir, "/tmp/saved-images")
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
