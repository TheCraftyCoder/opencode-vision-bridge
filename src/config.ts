import path from "node:path"

export const DEFAULT_MODEL = "zoaholic/gpt-5.6-luna-codex-20x"
export const DEFAULT_TIMEOUT_MS = 180_000

export interface OpenCodeVisionOptions {
  readonly type: "opencode"
  readonly model: string
}

export interface OpenAICompatibleVisionOptions {
  readonly type: "openai-compatible"
  readonly model: string
  readonly baseURL: string
  readonly apiKey: string
}

export type VisionOptions =
  | OpenCodeVisionOptions
  | OpenAICompatibleVisionOptions

export interface PluginOptionsInput {
  readonly vision?:
    | {
        readonly type?: "opencode"
        readonly model?: string
      }
    | {
        readonly type: "openai-compatible"
        readonly model?: string
        readonly baseURL?: string
        readonly apiKey?: string
      }
  readonly saveDir?: string
  readonly timeoutMs?: number
}

export interface PluginOptions {
  readonly vision: VisionOptions
  readonly saveDir: string
  readonly timeoutMs: number
}

export function parseOptions(
  input: PluginOptionsInput,
  projectRoot: string,
): PluginOptions {
  return {
    vision: parseVision(input.vision),
    saveDir: parseSaveDir(input.saveDir, projectRoot),
    timeoutMs: parseTimeout(input.timeoutMs),
  }
}

function parseVision(input: PluginOptionsInput["vision"]): VisionOptions {
  if (input?.type === "openai-compatible") {
    return {
      type: input.type,
      model: requiredString(input.model, "vision.model"),
      baseURL: trimTrailingSlashes(requiredString(input.baseURL, "vision.baseURL")),
      apiKey: requiredString(input.apiKey, "vision.apiKey"),
    }
  }

  return {
    type: "opencode",
    model: optionalString(input?.model, "vision.model") ?? DEFAULT_MODEL,
  }
}

function parseSaveDir(input: string | undefined, projectRoot: string): string {
  const configured = optionalString(input, "saveDir")
  return path.resolve(projectRoot, configured ?? "images")
}

function parseTimeout(input: number | undefined): number {
  if (input === undefined) return DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(input) || input <= 0) {
    throw new TypeError("timeoutMs must be a positive integer")
  }
  return input
}

function optionalString(
  input: string | undefined,
  field: string,
): string | undefined {
  if (input === undefined) return undefined
  return requiredString(input, field)
}

function requiredString(input: unknown, field: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return input.trim()
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "")
}
