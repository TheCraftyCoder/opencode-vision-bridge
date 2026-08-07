import { createHash } from "node:crypto"

import {
  imageFromPart,
  saveImage,
  type ImageAsset,
  type ImageLikePart,
} from "./image.js"

export const DEFAULT_QUESTION =
  "Describe this image in detail. Preserve all visible text, code, error messages, UI layout, charts, and spatial relationships needed to answer a later question."

export type BridgePart =
  | {
      readonly type: "text"
      readonly text: string
      readonly [key: string]: unknown
    }
  | ImageLikePart
  | {
      readonly type: string
      readonly [key: string]: unknown
    }

export interface BridgeMessage {
  readonly role: string
  content: BridgePart[]
  readonly [key: string]: unknown
}

export interface VisionDescriptionRequest {
  readonly dataUrl: string
  readonly mediaType: string
  readonly filename?: string
  readonly fileUrl: string
  readonly question: string
}

interface DescribedImage {
  readonly description: string
  readonly fileUrl: string
}

interface Occurrence {
  readonly message: BridgeMessage
  readonly partIndex: number
  readonly image: ImageAsset
  readonly question: string
}

export interface VisionBridgeOptions {
  readonly saveDir: string
  readonly describe: (request: VisionDescriptionRequest) => Promise<string>
}

export class VisionBridge {
  readonly #saveDir: string
  readonly #describe: VisionBridgeOptions["describe"]
  readonly #descriptions = new Map<string, Promise<DescribedImage>>()

  constructor(options: VisionBridgeOptions) {
    this.#saveDir = options.saveDir
    this.#describe = options.describe
  }

  async transform(input: {
    readonly modelSupportsVision: boolean
    readonly messages: BridgeMessage[]
  }): Promise<void> {
    if (input.modelSupportsVision) return

    const occurrences = collectOccurrences(input.messages)
    const descriptions = await Promise.all(
      occurrences.map((occurrence) => this.#describeOccurrence(occurrence)),
    )

    for (const [index, occurrence] of occurrences.entries()) {
      const described = descriptions[index]
      if (!described) continue
      occurrence.message.content[occurrence.partIndex] = {
        type: "text",
        text: visionDescriptionText(described),
      }
    }
  }

  async #describeOccurrence(occurrence: Occurrence): Promise<DescribedImage> {
    const saved = await saveImage(occurrence.image, this.#saveDir)
    const key = cacheKey(saved.digest, occurrence.question)
    const existing = this.#descriptions.get(key)
    if (existing) return existing

    const pending = this.#requestDescription(occurrence, saved.url)
    this.#descriptions.set(key, pending)
    try {
      return await pending
    } catch (error) {
      this.#descriptions.delete(key)
      throw error
    }
  }

  async #requestDescription(
    occurrence: Occurrence,
    fileUrl: string,
  ): Promise<DescribedImage> {
    const description = (
      await this.#describe({
        dataUrl: occurrence.image.dataUrl,
        mediaType: occurrence.image.mediaType,
        ...(occurrence.image.filename === undefined
          ? {}
          : { filename: occurrence.image.filename }),
        fileUrl,
        question: occurrence.question,
      })
    ).trim()
    if (description === "") {
      throw new Error("Vision model returned an empty description")
    }
    return { description, fileUrl }
  }
}

export function hasImageParts(messages: readonly BridgeMessage[]): boolean {
  return messages.some((message) =>
    message.content.some(isImageCandidate),
  )
}

function isImageCandidate(part: BridgePart): boolean {
  if (part.type === "media") {
    return (
      typeof part.mediaType === "string" &&
      part.mediaType.toLowerCase().startsWith("image/")
    )
  }
  return (
    part.type === "file" &&
    typeof part.mime === "string" &&
    part.mime.toLowerCase().startsWith("image/") &&
    typeof part.url === "string" &&
    part.url.startsWith("data:")
  )
}

function collectOccurrences(messages: BridgeMessage[]): Occurrence[] {
  const occurrences: Occurrence[] = []
  for (const message of messages) {
    const question = questionFromMessage(message)
    for (const [partIndex, part] of message.content.entries()) {
      const image = imageFromPart(part)
      if (!image) continue
      occurrences.push({ message, partIndex, image, question })
    }
  }
  return occurrences
}

function questionFromMessage(message: BridgeMessage): string {
  const text = message.content
    .filter(
      (part): part is Extract<BridgePart, { readonly type: "text" }> =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
  return text || DEFAULT_QUESTION
}

function cacheKey(imageDigest: string, question: string): string {
  const questionDigest = createHash("sha256").update(question).digest("hex")
  return `${imageDigest}:${questionDigest}`
}

export function visionDescriptionText(image: DescribedImage): string {
  return [
    "[Attached image]",
    `File URL: ${image.fileUrl}`,
    "Visual content:",
    image.description,
    "[/Attached image]",
  ].join("\n")
}
