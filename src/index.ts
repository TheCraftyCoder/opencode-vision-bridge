import { fileURLToPath } from "node:url"

import { Plugin } from "@opencode-ai/plugin"

import {
  VisionBridge,
  hasImageParts,
  type BridgeMessage,
} from "./bridge.js"
import {
  configureVisionCatalog,
  INTERNAL_AGENT_ID,
  VISION_SYSTEM_PROMPT,
} from "./catalog.js"
import { lazyLocalVisionClient } from "./client.js"
import { parseOptions, type PluginOptionsInput } from "./config.js"
import { ModelCapabilities } from "./model-capabilities.js"
import { OpenCodeVisionRunner } from "./opencode-runner.js"
import { ReadImageTool, type ReadImageInput } from "./read-image.js"
import {
  VisionRequestRegistry,
  type RequestContextMessage,
} from "./request-registry.js"

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url))

export default Plugin.define({
  id: "moeblack.vision-bridge",
  setup: async (ctx) => {
    const options = parseOptions(ctx.options as PluginOptionsInput, PROJECT_ROOT)
    const visionModel = await configureVisionCatalog(ctx, options)
    const { location } = await ctx.catalog.model.list()
    // Setup runs inside OpenCode's batched catalog boot. Read model data only
    // when a request arrives so catalog.updated has committed the generation.
    const capabilities = new ModelCapabilities(async () => {
      const current = await ctx.catalog.model.list()
      return current.data
    })
    const requests = new VisionRequestRegistry()
    const runner = new OpenCodeVisionRunner({
      client: lazyLocalVisionClient(ctx.app.version),
      requests,
      agent: INTERNAL_AGENT_ID,
      model: visionModel,
      directory: location.directory,
      timeoutMs: options.timeoutMs,
    })
    const bridge = new VisionBridge({
      saveDir: options.saveDir,
      describe: (request) => runner.describe(request),
    })
    const readImage = new ReadImageTool({
      projectDirectory: location.directory,
      saveDir: options.saveDir,
      describe: (request) => runner.describe(request),
    })

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "read_image",
        description:
          "Read an image file from disk with the configured vision model. Use this for an existing image path when visual details are needed.",
        input: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              minLength: 1,
              description:
                "Image file path. Supports absolute paths, ~/ paths, and paths relative to the project directory.",
            },
            question: {
              type: "string",
              minLength: 1,
              description:
                "Optional question to focus the visual analysis. Omit for a general detailed description.",
            },
          },
          required: ["filePath"],
          additionalProperties: false,
        },
        execute: async (input) => ({
          content: await readImage.execute(input as ReadImageInput),
        }),
        options: { codemode: true },
      })
    })

    await ctx.session.hook("context", async (event) => {
      if (event.agent === INTERNAL_AGENT_ID) {
        event.system.splice(0, event.system.length, {
          type: "text",
          text: VISION_SYSTEM_PROMPT,
        })
        for (const name of Object.keys(event.tools)) delete event.tools[name]
        requests.inject(
          event.sessionID,
          event.messages as unknown as RequestContextMessage[],
        )
        return
      }

      const messages = event.messages as unknown as BridgeMessage[]
      if (!hasImageParts(messages)) return
      await bridge.transform({
        modelSupportsVision: await capabilities.supportsVision(event.model),
        messages,
      })
    })
  },
})
