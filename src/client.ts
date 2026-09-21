import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"

import type { VisionClient } from "./opencode-runner.js"

export function lazyLocalVisionClient(version: string): () => Promise<VisionClient> {
  let pending: Promise<VisionClient> | undefined
  return () => {
    pending ??= connect(version)
    return pending
  }
}

async function connect(version: string): Promise<VisionClient> {
  const endpoint = await Service.discover({ version })
  if (!endpoint) {
    throw new Error(
      `Vision bridge cannot discover the running OpenCode ${version} background service`,
    )
  }

  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers:
      endpoint.auth === undefined
        ? undefined
        : Service.headers({ ...endpoint, auth: endpoint.auth }),
  })

  return {
    session: {
      create: (input) =>
        client.session.create({
          ...input,
          model: {
            providerID: input.model.providerID,
            id: input.model.id,
            ...(input.model.variant === undefined
              ? {}
              : { variant: input.model.variant }),
          },
        }),
      generate: (input, options) => client.session.generate(input, options),
      interrupt: async (input) => {
        await client.session.interrupt(input)
      },
      remove: (input) => client.session.remove(input),
    },
  }
}
