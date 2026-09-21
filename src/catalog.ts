import { Agent, Model, Provider, type Plugin } from "@opencode/plugin"

import type { PluginOptions } from "./config.js"

export const CUSTOM_PROVIDER_ID = "moeblack-vision-bridge-custom"
export const INTERNAL_AGENT_ID = "moeblack.vision-bridge.internal"

const CUSTOM_PROVIDER_PACKAGE =
  "@opencode/ai/providers/openai-compatible"
const CUSTOM_CONTEXT_LIMIT = 128_000
const CUSTOM_OUTPUT_LIMIT = 16_384

export const VISION_SYSTEM_PROMPT = [
  "You are the private vision stage of an automatic image bridge.",
  "Inspect every attached image carefully and answer the supplied question using only textual output.",
  "Transcribe visible text, code, stack traces, labels, and numbers exactly when they matter.",
  "Describe layout and spatial relationships precisely. Do not call tools and do not discuss this bridge.",
].join(" ")

export async function configureVisionCatalog(
  ctx: Plugin.Context,
  options: PluginOptions,
): Promise<Model.Ref> {
  const model: Model.Ref =
    options.vision.type === "opencode"
      ? Model.Ref.parse(options.vision.model)
      : await addCustomModel(ctx, options.vision)

  await ctx.agent.transform((agents) => {
    agents.update(INTERNAL_AGENT_ID, (agent) => {
      agent.name = Agent.Name.make("Vision Bridge")
      agent.model = model
      agent.system = VISION_SYSTEM_PROMPT
      agent.description = "Internal transient image-description agent"
      agent.mode = "all"
      agent.hidden = true
      agent.steps = 1
      agent.permissions = [{ action: "*", resource: "*", effect: "deny" }]
    })
  })

  return model
}

async function addCustomModel(
  ctx: Plugin.Context,
  options: Extract<PluginOptions["vision"], { readonly type: "openai-compatible" }>,
): Promise<Model.Ref> {
  const providerID = Provider.ID.make(CUSTOM_PROVIDER_ID)
  const modelID = Model.ID.make(options.model)

  await ctx.provider.transform((providers) => {
    const provider = Object.assign(Provider.Info.empty(providerID), {
        name: "Vision Bridge custom endpoint",
        package: CUSTOM_PROVIDER_PACKAGE,
        settings: {
          baseURL: options.baseURL,
          apiKey: options.apiKey,
        },
      })
    const model = Object.assign(Model.Info.default(providerID, modelID), {
        modelID,
        name: `Vision Bridge: ${options.model}`,
        package: CUSTOM_PROVIDER_PACKAGE,
        capabilities: {
          tools: false,
          input: ["text", "image"],
          output: ["text"],
        },
        limit: {
          context: CUSTOM_CONTEXT_LIMIT,
          output: CUSTOM_OUTPUT_LIMIT,
        },
      })
    providers.add({ info: provider, models: [model] })
  })

  return { providerID, id: modelID }
}
