import assert from "node:assert/strict"
import test from "node:test"

import {
  ModelCapabilities,
  type CatalogModel,
} from "../src/model-capabilities.js"

const TEXT_MODEL: CatalogModel = {
  id: "deepseek-v4-flash",
  providerID: "zoaholic-chatcomp",
  capabilities: { input: ["text"] },
}

const VISION_MODEL: CatalogModel = {
  id: "gpt-5.6-luna-codex-20x",
  providerID: "zoaholic",
  capabilities: { input: ["text", "image"] },
}

test("model capabilities read the current catalog for every request", async () => {
  let catalog: ReadonlyArray<CatalogModel> = [TEXT_MODEL]
  let loads = 0
  const capabilities = new ModelCapabilities(async () => {
    loads += 1
    return catalog
  })

  assert.equal(loads, 0)
  assert.equal(
    await capabilities.supportsVision({
      providerID: TEXT_MODEL.providerID,
      id: TEXT_MODEL.id,
    }),
    false,
  )

  catalog = [TEXT_MODEL, VISION_MODEL]
  assert.equal(
    await capabilities.supportsVision({
      providerID: VISION_MODEL.providerID,
      id: VISION_MODEL.id,
    }),
    true,
  )
  assert.equal(loads, 2)
})

test("inputCapabilities exposes PDF support independently from image support", async () => {
  const capabilities = new ModelCapabilities(async () => [
    {
      id: "glm-5.3-flash",
      providerID: "opencode",
      capabilities: { input: ["text", "image", "pdf"] },
    },
  ])

  assert.deepEqual(
    await capabilities.inputCapabilities({
      providerID: "opencode",
      id: "glm-5.3-flash",
    }),
    new Set(["text", "image", "pdf"]),
  )
})

test("model capabilities reject a model absent from the current catalog", async () => {
  const capabilities = new ModelCapabilities(async () => [TEXT_MODEL])

  await assert.rejects(
    capabilities.supportsVision({
      providerID: "missing-provider",
      id: "missing-model",
    }),
    /Active model is absent from the catalog: missing-provider\/missing-model/,
  )
})
