import { createHash } from "node:crypto"

import {
  attachmentFromPart,
  attachmentFromUri,
  isPdfMediaType,
  isSupportedMediaType,
  saveAttachment,
  type AttachmentAsset,
  type AttachmentLikePart,
} from "./image.js"
import { renderPdfPageBatches } from "./pdf.js"

export const DEFAULT_QUESTION =
  "Describe this attachment in detail. Preserve all visible text, code, error messages, document structure, UI layout, charts, and spatial relationships needed to answer a later question."

export type BridgePart =
  | {
      readonly type: "text"
      readonly text: string
      readonly [key: string]: unknown
    }
  | AttachmentLikePart
  | {
      readonly type: string
      readonly [key: string]: unknown
    }

export interface BridgeMessage {
  readonly role: string
  content: BridgePart[]
  readonly [key: string]: unknown
}

export interface PromptFile {
  readonly uri: string
  readonly name?: string
  readonly description?: string
  readonly mention?: {
    readonly start: number
    readonly end: number
    readonly text: string
  }
}

export interface BridgePrompt {
  text: string
  files?: PromptFile[]
}

export interface VisionDescriptionRequest {
  readonly dataUrl: string
  readonly mediaType: string
  readonly filename?: string
  readonly additionalMedia?: ReadonlyArray<{
    readonly dataUrl: string
    readonly mediaType: string
    readonly filename?: string
  }>
  readonly source?: {
    readonly mediaType: string
    readonly filename?: string
    readonly pageStart: number
    readonly pageEnd: number
    readonly pageCount: number
  }
  readonly fileUrl: string
  readonly question: string
}

interface DescribedAttachment {
  readonly description: string
  readonly fileUrl: string
  readonly mediaType: string
  readonly filename?: string
}

interface Occurrence {
  readonly message: BridgeMessage
  readonly partIndex: number
  readonly attachment: AttachmentAsset
  readonly question: string
}

interface PromptOccurrence {
  readonly fileIndex: number
  readonly file: PromptFile
  readonly attachment: AttachmentAsset
  readonly question: string
}

export interface VisionBridgeOptions {
  readonly saveDir: string
  readonly describe: (request: VisionDescriptionRequest) => Promise<string>
}

export class VisionBridge {
  readonly #saveDir: string
  readonly #describe: VisionBridgeOptions["describe"]
  readonly #descriptions = new Map<string, Promise<DescribedAttachment>>()

  constructor(options: VisionBridgeOptions) {
    this.#saveDir = options.saveDir
    this.#describe = options.describe
  }

  /**
   * Intercept PDFs before OpenCode's attachment resolver omits them from the
   * model request. Images stay on the normal path and are handled in context,
   * where the active model's capabilities are available.
   */
  async transformPrompt(prompt: BridgePrompt): Promise<void> {
    if (!prompt.files?.length) return

    const question = questionFromText(prompt.text)
    const candidates = await Promise.all(
      prompt.files.map(
        async (
          file,
          fileIndex,
        ): Promise<PromptOccurrence | undefined> => {
          const attachment = await attachmentFromUri(file.uri, file.name)
          if (!attachment || !isPdfMediaType(attachment.mediaType)) {
            return undefined
          }
          return { fileIndex, file, attachment, question }
        },
      ),
    )
    const occurrences = candidates.filter(
      (candidate): candidate is PromptOccurrence => candidate !== undefined,
    )
    if (occurrences.length === 0) return

    const descriptions = await Promise.all(
      occurrences.map((occurrence) =>
        this.#describeAttachment(occurrence.attachment, occurrence.question),
      ),
    )
    const removed = new Set(
      occurrences.map((occurrence) => occurrence.fileIndex),
    )
    prompt.files.splice(
      0,
      prompt.files.length,
      ...prompt.files.filter((_, index) => !removed.has(index)),
    )

    const originalText = removeMentions(
      prompt.text,
      occurrences.map((occurrence) => occurrence.file),
    ).trim()
    const injected = descriptions.map(attachmentDescriptionText).join("\n\n")
    prompt.text = originalText === "" ? injected : `${originalText}\n\n${injected}`
  }

  async transform(input: {
    readonly modelInputCapabilities: ReadonlySet<string>
    readonly messages: BridgeMessage[]
  }): Promise<void> {
    const occurrences = collectOccurrences(
      input.messages,
      input.modelInputCapabilities,
    )
    const descriptions = await Promise.all(
      occurrences.map((occurrence) =>
        this.#describeAttachment(occurrence.attachment, occurrence.question),
      ),
    )

    for (const [index, occurrence] of occurrences.entries()) {
      const described = descriptions[index]
      if (!described) continue
      occurrence.message.content[occurrence.partIndex] = {
        type: "text",
        text: attachmentDescriptionText(described),
      }
    }
  }

  async #describeAttachment(
    attachment: AttachmentAsset,
    question: string,
  ): Promise<DescribedAttachment> {
    const saved = await saveAttachment(attachment, this.#saveDir)
    const key = cacheKey(saved.digest, question)
    const existing = this.#descriptions.get(key)
    if (existing) return existing

    const pending = this.#requestDescription(attachment, question, saved.url)
    this.#descriptions.set(key, pending)
    try {
      return await pending
    } catch (error) {
      this.#descriptions.delete(key)
      throw error
    }
  }

  async #requestDescription(
    attachment: AttachmentAsset,
    question: string,
    fileUrl: string,
  ): Promise<DescribedAttachment> {
    try {
      const description = isPdfMediaType(attachment.mediaType)
        ? await this.#describePdf(attachment, question, fileUrl)
        : await this.#describeSingle(attachment, question, fileUrl)
      return describedAttachment(
        attachment,
        fileUrl,
        description === ""
          ? "Attachment analysis was unavailable because the configured vision model returned an empty description. Do not infer content from this attachment."
          : description,
      )
    } catch (error) {
      return describedAttachment(
        attachment,
        fileUrl,
        unavailableDescription(error),
      )
    }
  }

  async #describeSingle(
    attachment: AttachmentAsset,
    question: string,
    fileUrl: string,
  ): Promise<string> {
    return (
      await this.#describe({
        dataUrl: attachment.dataUrl,
        mediaType: attachment.mediaType,
        ...(attachment.filename === undefined
          ? {}
          : { filename: attachment.filename }),
        fileUrl,
        question,
      })
    ).trim()
  }

  async #describePdf(
    attachment: AttachmentAsset,
    question: string,
    fileUrl: string,
  ): Promise<string> {
    const descriptions: string[] = []
    for await (const batch of renderPdfPageBatches(
      attachment.bytes,
      attachment.filename,
    )) {
      const [first, ...additional] = batch.pages
      if (!first) continue
      const description = (
        await this.#describe({
          dataUrl: first.dataUrl,
          mediaType: first.mediaType,
          ...(first.filename === undefined ? {} : { filename: first.filename }),
          additionalMedia: additional.map((page) => ({
            dataUrl: page.dataUrl,
            mediaType: page.mediaType,
            ...(page.filename === undefined ? {} : { filename: page.filename }),
          })),
          source: {
            mediaType: attachment.mediaType,
            ...(attachment.filename === undefined
              ? {}
              : { filename: attachment.filename }),
            pageStart: batch.start,
            pageEnd: batch.end,
            pageCount: batch.total,
          },
          fileUrl,
          question,
        })
      ).trim()
      if (description !== "") {
        descriptions.push(
          `[PDF pages ${batch.start}-${batch.end} of ${batch.total}]\n${description}`,
        )
      }
    }
    return descriptions.join("\n\n")
  }
}

function describedAttachment(
  attachment: AttachmentAsset,
  fileUrl: string,
  description: string,
): DescribedAttachment {
  return {
    description,
    fileUrl,
    mediaType: attachment.mediaType,
    ...(attachment.filename === undefined
      ? {}
      : { filename: attachment.filename }),
  }
}

function unavailableDescription(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error)
  return [
    "Attachment analysis was unavailable from the configured vision model.",
    `Reason: ${reason}`,
    "Do not infer content from this attachment.",
  ].join(" ")
}

export function hasAttachmentParts(messages: readonly BridgeMessage[]): boolean {
  return messages.some((message) => message.content.some(isAttachmentCandidate))
}

/** @deprecated Use hasAttachmentParts. */
export const hasImageParts = hasAttachmentParts

function isAttachmentCandidate(part: BridgePart): boolean {
  if (part.type === "media") {
    return (
      typeof part.mediaType === "string" &&
      isSupportedMediaType(part.mediaType)
    )
  }
  if (part.type !== "file" || typeof part.url !== "string") return false
  const mediaType =
    typeof part.mime === "string"
      ? part.mime
      : "mediaType" in part && typeof part.mediaType === "string"
        ? part.mediaType
        : undefined
  return (
    mediaType !== undefined &&
    isSupportedMediaType(mediaType) &&
    part.url.startsWith("data:")
  )
}

function collectOccurrences(
  messages: BridgeMessage[],
  modelInputCapabilities: ReadonlySet<string>,
): Occurrence[] {
  const occurrences: Occurrence[] = []
  for (const message of messages) {
    const question = questionFromMessage(message)
    for (const [partIndex, part] of message.content.entries()) {
      const attachment = attachmentFromPart(part)
      if (
        !attachment ||
        modelSupportsMedia(modelInputCapabilities, attachment.mediaType)
      ) {
        continue
      }
      occurrences.push({ message, partIndex, attachment, question })
    }
  }
  return occurrences
}

function modelSupportsMedia(
  capabilities: ReadonlySet<string>,
  mediaType: string,
): boolean {
  if (mediaType.startsWith("image/")) return capabilities.has("image")
  if (isPdfMediaType(mediaType)) {
    return (
      capabilities.has("pdf") ||
      capabilities.has("document") ||
      capabilities.has("file")
    )
  }
  return false
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
  return questionFromText(text)
}

function questionFromText(text: string): string {
  return text.trim() || DEFAULT_QUESTION
}

function removeMentions(text: string, files: readonly PromptFile[]): string {
  const mentions = files
    .map((file) => file.mention)
    .filter(
      (mention): mention is NonNullable<PromptFile["mention"]> =>
        mention !== undefined,
    )
    .filter(
      (mention) =>
        mention.start >= 0 &&
        mention.end >= mention.start &&
        text.slice(mention.start, mention.end) === mention.text,
    )
    .sort((left, right) => right.start - left.start)

  let result = text
  for (const mention of mentions) {
    result = `${result.slice(0, mention.start)}${result.slice(mention.end)}`
  }
  return result
}

function cacheKey(attachmentDigest: string, question: string): string {
  const questionDigest = createHash("sha256").update(question).digest("hex")
  return `${attachmentDigest}:${questionDigest}`
}

export function attachmentDescriptionText(
  attachment: DescribedAttachment,
): string {
  const label = isPdfMediaType(attachment.mediaType) ? "PDF" : "image"
  return [
    `[Attached ${label}]`,
    ...(attachment.filename ? [`Filename: ${attachment.filename}`] : []),
    `File URL: ${attachment.fileUrl}`,
    label === "PDF" ? "Document content:" : "Visual content:",
    attachment.description,
    `[/Attached ${label}]`,
  ].join("\n")
}

/** @deprecated Use attachmentDescriptionText. */
export const visionDescriptionText = attachmentDescriptionText
