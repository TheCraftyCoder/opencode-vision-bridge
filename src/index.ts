import { fileURLToPath } from "node:url"

import { Plugin } from "@opencode/plugin"

import {
  VisionBridge,
  hasAttachmentParts,
  type BridgePrompt,
  type BridgeMessage,
} from "./bridge.js"
import {
  configureVisionCatalog,
  INTERNAL_AGENT_ID,
  VISION_SYSTEM_PROMPT,
} from "./catalog.js"
import { parseOptions, type PluginOptionsInput } from "./config.js"
import { ModelCapabilities } from "./model-capabilities.js"
import {
  OpenCodeVisionRunner,
  type VisionClient,
} from "./opencode-runner.js"
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
    const location = ctx.location
    // Setup runs inside OpenCode's batched catalog boot. Read model data only
    // when a request arrives so catalog.updated has committed the generation.
    const capabilities = new ModelCapabilities(async () => {
      const current = await ctx.model.list()
      return current.data
    })
    const requests = new VisionRequestRegistry()
    const runner = new OpenCodeVisionRunner({
      client: inProcessVisionClient(ctx),
      requests,
      agent: INTERNAL_AGENT_ID,
      model: visionModel,
      directory: location.directory,
      timeoutMs: options.timeoutMs,
    })
    const bridges = new Map<string, VisionBridge>()
    const bridgeFor = (directory: string): VisionBridge => {
      const existing = bridges.get(directory)
      if (existing) return existing
      const bridge = new VisionBridge({
        saveDir: options.saveDir,
        describe: (request) => runner.describe(request, directory),
      })
      bridges.set(directory, bridge)
      return bridge
    }
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
        output: {
          type: "object",
          properties: {
            description: { type: "string" },
          },
          required: ["description"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const text = await readImage.execute(input as ReadImageInput)
          return {
            output: { description: text },
            content: text,
          }
        },
        options: { codemode: true },
      })
    })

    const prepareInternalVisionRequest = (event: {
      readonly agent: string
      readonly sessionID: string
      system: Array<{ type: "text"; text: string }>
      tools: Record<string, unknown>
      messages: unknown[]
    }): boolean => {
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
        return true
      }
      return false
    }

    await ctx.session.hook("context", async (event) => {
      if (prepareInternalVisionRequest(event)) return

      const messages = event.messages as unknown as BridgeMessage[]
      if (!hasAttachmentParts(messages)) return
      const session = await ctx.session.get({ sessionID: event.sessionID })
      await bridgeFor(session.location.directory).transform({
        modelInputCapabilities: await capabilities.inputCapabilities(event.model),
        messages,
      })
    })

    await ctx.session.hook("prompt", async (event) => {
      if (!event.prompt.files?.length) return
      const session = await ctx.session.get({ sessionID: event.sessionID })
      await bridgeFor(session.location.directory).transformPrompt(
        event.prompt as BridgePrompt,
      )
    })

    await ctx.session.hook("generate", async (event) => {
      prepareInternalVisionRequest(event)
    })
  },
})

function inProcessVisionClient(ctx: Parameters<typeof Plugin.define>[0]["setup"] extends (
  context: infer Context,
) => unknown ? Context : never): VisionClient {
  return {
    session: {
      create: (input) =>
        ctx.session.create({
          ...input,
          model: {
            providerID: input.model.providerID,
            id: input.model.id,
            ...(input.model.variant === undefined
              ? {}
              : { variant: input.model.variant }),
          },
        }),
      generate: (input, options) => ctx.session.generate(input, options),
      interrupt: async (input) => {
        await ctx.session.interrupt(input)
      },
      // The Promise plugin surface does not expose session removal. Keeping this
      // empty transient session is preferable to re-entering the HTTP server
      // from its own context hook, which interrupts the parent request in V2.
      remove: async () => undefined,
    },
  }
}
