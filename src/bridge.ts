import { createHash } from "node:crypto"

import {
  attachmentFromPart,
  attachmentFromUri,
  isPdfMediaType,
  isRecord,
  isSupportedMediaType,
  saveAttachment,
  type AttachmentAsset,
  type AttachmentLikePart,
} from "./image.js"
import { renderPdfPageBatches } from "./pdf.js"

export const DEFAULT_QUESTION =
  "Describe this attachment in detail. Preserve all visible text, code, error messages, document structure, UI layout, charts, and spatial relationships needed to answer a later question."

const CACHE_TTL_MS = 15 * 60 * 1_000
const MAX_CACHE_ENTRIES = 128
const MAX_PDFS_PER_PROMPT = 4
const MAX_ATTACHMENTS_PER_CONTEXT = 8
const UNAVAILABLE_DESCRIPTION =
  "Attachment analysis was unavailable. Do not infer content from this attachment; ask the user to retry."

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
  readonly hostMedia?: unknown
  readonly additionalMedia?: ReadonlyArray<{
    readonly dataUrl: string
    readonly mediaType: string
    readonly filename?: string
    readonly hostMedia?: unknown
  }>
  readonly source?: {
    readonly mediaType: string
    readonly filename?: string
    readonly pageStart: number
    readonly pageEnd: number
    readonly pageCount: number
  }
  readonly question: string
  readonly signal?: AbortSignal
}

interface DescribedAttachment {
  readonly description: string
  readonly mediaType: string
  readonly filename?: string
  readonly cacheable: boolean
}

interface Occurrence {
  readonly message: BridgeMessage
  readonly partIndex: number
  readonly attachment: AttachmentAsset
  readonly question: string
}

interface CacheEntry {
  readonly pending: Promise<DescribedAttachment>
  expiresAt?: number
}

interface DescriptionAttempt {
  readonly description: string
  readonly complete: boolean
}

export interface VisionBridgeOptions {
  readonly saveDir: string
  readonly timeoutMs?: number
  readonly describe: (request: VisionDescriptionRequest) => Promise<string>
}

export class VisionBridge {
  readonly #saveDir: string
  readonly #timeoutMs: number
  readonly #describe: VisionBridgeOptions["describe"]
  readonly #descriptions = new Map<string, CacheEntry>()

  constructor(options: VisionBridgeOptions) {
    this.#saveDir = options.saveDir
    this.#timeoutMs = options.timeoutMs ?? 180_000
    this.#describe = options.describe
  }

  /** Handle PDFs before OpenCode omits unsupported binary prompt files. */
  async transformPrompt(prompt: BridgePrompt): Promise<void> {
    if (!prompt.files?.length) return

    const question = questionFromText(prompt.text)
    const removed = new Set<number>()
    const descriptions: DescribedAttachment[] = []
    let processed = 0

    for (const [fileIndex, file] of prompt.files.entries()) {
      if (!isPdfPromptFile(file)) continue
      removed.add(fileIndex)
      if (processed >= MAX_PDFS_PER_PROMPT) {
        descriptions.push(
          unavailableAttachment(
            "application/pdf",
            file.name,
            `PDF was not analyzed because a prompt may contain at most ${MAX_PDFS_PER_PROMPT} PDFs.`,
          ),
        )
        continue
      }
      processed += 1

      try {
        const attachment = await attachmentFromUri(file.uri, file.name)
        if (!attachment || !isPdfMediaType(attachment.mediaType)) {
          descriptions.push(
            unavailableAttachment("application/pdf", file.name),
          )
          continue
        }
        descriptions.push(await this.#describeAttachment(attachment, question))
      } catch {
        descriptions.push(unavailableAttachment("application/pdf", file.name))
      }
    }

    if (removed.size === 0) return
    prompt.files.splice(
      0,
      prompt.files.length,
      ...prompt.files.filter((_, index) => !removed.has(index)),
    )

    const injected = descriptions.map(attachmentDescriptionText).join("\n\n")
    prompt.text = prompt.text === "" ? injected : `${prompt.text}\n\n${injected}`
  }

  async transform(input: {
    readonly modelInputCapabilities: ReadonlySet<string>
    readonly messages: BridgeMessage[]
  }): Promise<void> {
    const occurrences: Occurrence[] = []
    let analyzed = 0
    for (const message of input.messages) {
      const question = questionFromMessage(message)
      for (const [partIndex, part] of message.content.entries()) {
        if (!isAttachmentCandidate(part)) continue
        const mediaType = mediaTypeFromPart(part)
        if (
          mediaType !== undefined &&
          modelSupportsMedia(input.modelInputCapabilities, mediaType)
        ) {
          continue
        }
        if (analyzed >= MAX_ATTACHMENTS_PER_CONTEXT) {
          message.content[partIndex] = {
            type: "text",
            text: attachmentDescriptionText(
              unavailableAttachment(
                mediaType ?? "application/octet-stream",
                filenameFromPart(part),
                `Attachment was not analyzed because a model request may contain at most ${MAX_ATTACHMENTS_PER_CONTEXT} bridged attachments.`,
              ),
            ),
          }
          continue
        }
        analyzed += 1
        try {
          const attachment = attachmentFromPart(part)
          if (!attachment) continue
          occurrences.push({ message, partIndex, attachment, question })
        } catch {
          message.content[partIndex] = {
            type: "text",
            text: attachmentDescriptionText(
              unavailableAttachment(
                mediaType ?? "application/octet-stream",
                filenameFromPart(part),
              ),
            ),
          }
        }
      }
    }

    // Serialize attachment work to bound memory and provider concurrency.
    for (const occurrence of occurrences) {
      const described = await this.#describeAttachment(
        occurrence.attachment,
        occurrence.question,
      )
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
    const digest = createHash("sha256").update(attachment.bytes).digest("hex")
    const key = cacheKey(digest, question)
    const now = Date.now()
    const existing = this.#descriptions.get(key)
    if (existing && (existing.expiresAt === undefined || existing.expiresAt > now)) {
      return existing.pending
    }
    if (existing) this.#descriptions.delete(key)

    const pending = this.#saveAndDescribe(attachment, question)
    const entry: CacheEntry = { pending }
    this.#descriptions.set(key, entry)
    this.#trimCache()

    const described = await pending
    if (!described.cacheable) {
      if (this.#descriptions.get(key) === entry) this.#descriptions.delete(key)
      return described
    }
    entry.expiresAt = Date.now() + CACHE_TTL_MS
    return described
  }

  async #saveAndDescribe(
    attachment: AttachmentAsset,
    question: string,
  ): Promise<DescribedAttachment> {
    try {
      await saveAttachment(attachment, this.#saveDir)
      const attempt = isPdfMediaType(attachment.mediaType)
        ? await this.#describePdf(attachment, question)
        : await this.#describeSingle(attachment, question)
      if (attempt.description.trim() === "") {
        return unavailableAttachment(attachment.mediaType, attachment.filename)
      }
      return describedAttachment(
        attachment,
        attempt.description,
        attempt.complete,
      )
    } catch {
      return unavailableAttachment(attachment.mediaType, attachment.filename)
    }
  }

  async #describeSingle(
    attachment: AttachmentAsset,
    question: string,
  ): Promise<DescriptionAttempt> {
    try {
      const description = (
        await this.#describe({
          dataUrl: attachment.dataUrl,
          mediaType: attachment.mediaType,
          hostMedia: attachment.hostMedia,
          ...(attachment.filename === undefined
            ? {}
            : { filename: sanitizeFilename(attachment.filename) }),
          question,
        })
      ).trim()
      return { description, complete: description !== "" }
    } catch {
      return { description: UNAVAILABLE_DESCRIPTION, complete: false }
    }
  }

  async #describePdf(
    attachment: AttachmentAsset,
    question: string,
  ): Promise<DescriptionAttempt> {
    const descriptions: string[] = []
    let complete = true
    const signal = AbortSignal.timeout(this.#timeoutMs)

    try {
      for await (const batch of renderPdfPageBatches(
        attachment.bytes,
        attachment.filename,
        { signal },
      )) {
        const [first, ...additional] = batch.pages
        if (!first) continue
        try {
          const description = (
            await this.#describe({
              dataUrl: first.dataUrl,
              mediaType: first.mediaType,
              ...(first.filename === undefined
                ? {}
                : { filename: sanitizeFilename(first.filename) }),
              additionalMedia: additional.map((page) => ({
                dataUrl: page.dataUrl,
                mediaType: page.mediaType,
                ...(page.filename === undefined
                  ? {}
                  : { filename: sanitizeFilename(page.filename) }),
              })),
              source: {
                mediaType: attachment.mediaType,
                ...(attachment.filename === undefined
                  ? {}
                  : { filename: sanitizeFilename(attachment.filename) }),
                pageStart: batch.start,
                pageEnd: batch.end,
                pageCount: batch.total,
              },
              question,
              signal,
            })
          ).trim()
          if (description === "") throw new Error("empty description")
          descriptions.push(
            `[PDF pages ${batch.start}-${batch.end} of ${batch.total}]\n${description}`,
          )
        } catch {
          complete = false
          descriptions.push(
            `[PDF pages ${batch.start}-${batch.end} of ${batch.total}]\n${UNAVAILABLE_DESCRIPTION}`,
          )
        }
        if (batch.truncated) {
          complete = false
          descriptions.push(
            `[PDF truncated after page ${batch.end} of ${batch.total} by the configured safety limit.]`,
          )
        }
      }
    } catch {
      complete = false
      descriptions.push(UNAVAILABLE_DESCRIPTION)
    }

    return { description: descriptions.join("\n\n"), complete }
  }

  #trimCache(): void {
    while (this.#descriptions.size > MAX_CACHE_ENTRIES) {
      const oldest = this.#descriptions.keys().next().value as string | undefined
      if (oldest === undefined) return
      this.#descriptions.delete(oldest)
    }
  }
}

function describedAttachment(
  attachment: AttachmentAsset,
  description: string,
  cacheable: boolean,
): DescribedAttachment {
  return {
    description,
    mediaType: attachment.mediaType,
    ...(attachment.filename === undefined
      ? {}
      : { filename: sanitizeFilename(attachment.filename) }),
    cacheable,
  }
}

function unavailableAttachment(
  mediaType: string,
  filename?: string,
  description = UNAVAILABLE_DESCRIPTION,
): DescribedAttachment {
  return {
    description,
    mediaType,
    ...(filename === undefined ? {} : { filename: sanitizeFilename(filename) }),
    cacheable: false,
  }
}

export function hasAttachmentParts(messages: readonly BridgeMessage[]): boolean {
  return messages.some((message) => message.content.some(isAttachmentCandidate))
}

/** @deprecated Use hasAttachmentParts. */
export const hasImageParts = hasAttachmentParts

function isAttachmentCandidate(part: BridgePart): boolean {
  const mediaType = mediaTypeFromPart(part)
  if (mediaType === undefined || !isSupportedMediaType(mediaType)) return false
  return part.type === "media" || (part.type === "file" && isDataUrl(part.url))
}

function mediaTypeFromPart(part: BridgePart): string | undefined {
  if (part.type === "media") {
    if (typeof part.mediaType === "string") {
      return part.mediaType.toLowerCase()
    }
    if (isRecord(part.media)) {
      if (typeof part.media.mediaType === "string") {
        return part.media.mediaType.toLowerCase()
      }
      if (
        isRecord(part.media.source) &&
        typeof part.media.source.mediaType === "string"
      ) {
        return part.media.source.mediaType.toLowerCase()
      }
    }
  }
  if (part.type !== "file") return undefined
  if (typeof part.mime === "string") return part.mime.toLowerCase()
  if ("mediaType" in part && typeof part.mediaType === "string") {
    return part.mediaType.toLowerCase()
  }
  return undefined
}

function filenameFromPart(part: BridgePart): string | undefined {
  return "filename" in part && typeof part.filename === "string"
    ? part.filename
    : undefined
}

function isDataUrl(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("data:")
}

function modelSupportsMedia(
  capabilities: ReadonlySet<string>,
  mediaType: string,
): boolean {
  if (mediaType.startsWith("image/")) return capabilities.has("image")
  if (isPdfMediaType(mediaType)) return capabilities.has("pdf")
  return false
}

function isPdfPromptFile(file: PromptFile): boolean {
  const uri = file.uri.toLowerCase()
  if (uri.startsWith("data:application/pdf;")) return true
  if (file.name?.toLowerCase().endsWith(".pdf")) return true
  if (!uri.startsWith("file:")) return false
  try {
    return new URL(file.uri).pathname.toLowerCase().endsWith(".pdf")
  } catch {
    return false
  }
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

function cacheKey(attachmentDigest: string, question: string): string {
  const questionDigest = createHash("sha256").update(question).digest("hex")
  return `${attachmentDigest}:${questionDigest}`
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").slice(0, 200)
}

export function attachmentDescriptionText(
  attachment: DescribedAttachment,
): string {
  const label = isPdfMediaType(attachment.mediaType) ? "PDF" : "image"
  return [
    `[Attached ${label}]`,
    label === "PDF" ? "Document content:" : "Visual content:",
    attachment.description,
    `[/Attached ${label}]`,
  ].join("\n")
}

/** @deprecated Use attachmentDescriptionText. */
export const visionDescriptionText = attachmentDescriptionText
