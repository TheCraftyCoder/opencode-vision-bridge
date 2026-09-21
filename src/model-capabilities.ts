import type { ModelRef } from "./opencode-runner.js"

export interface CatalogModel {
  readonly id: string
  readonly providerID: string
  readonly capabilities: {
    readonly input: ReadonlyArray<string>
  }
}

export type CatalogModelLoader = () => Promise<ReadonlyArray<CatalogModel>>

export class ModelCapabilities {
  readonly #load: CatalogModelLoader

  constructor(load: CatalogModelLoader) {
    this.#load = load
  }

  async inputCapabilities(model: ModelRef): Promise<ReadonlySet<string>> {
    const models = await this.#load()
    const info = models.find(
      (candidate) =>
        candidate.providerID === model.providerID && candidate.id === model.id,
    )
    if (!info) {
      throw new Error(
        `Active model is absent from the catalog: ${model.providerID}/${model.id}`,
      )
    }
    return new Set(
      info.capabilities.input.map((capability) => capability.toLowerCase()),
    )
  }

  async supportsVision(model: ModelRef): Promise<boolean> {
    return (await this.inputCapabilities(model)).has("image")
  }
}
