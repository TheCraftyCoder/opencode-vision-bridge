import { createHash } from "node:crypto"
import { mkdir, open, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/s
const DATA_URL_MEDIA_TYPE_PATTERN = /^data:([^;,]+)/

const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "application/pdf": "pdf",
}

const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
}

/** Maximum size accepted for either an in-memory or disk attachment. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

const SUPPORTED_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
  "application/pdf",
])

export type AttachmentLikePart =
  | {
      readonly type: "media"
      readonly mediaType?: string
      readonly data?: string | Uint8Array
      readonly media?: unknown
      readonly filename?: string
    }
  | {
      readonly type: "file"
      readonly mime: string
      readonly url: string
      readonly filename?: string
    }


export interface AttachmentAsset {
  readonly bytes: Buffer
  readonly dataUrl: string
  readonly mediaType: string
  readonly filename?: string
  readonly hostMedia?: unknown
}

export interface SavedAttachment {
  readonly digest: string
  readonly path: string
  readonly url: string
}

export function attachmentFromPart(part: unknown): AttachmentAsset | undefined {
  if (!isRecord(part)) return undefined
  if (part.type === "media") return attachmentFromMediaPart(part)
  if (part.type === "file") return attachmentFromFilePart(part)
  return undefined
}

export async function attachmentFromUri(
  uri: string,
  filename?: string,
): Promise<AttachmentAsset | undefined> {
  if (uri.startsWith("data:")) {
    const mediaType = DATA_URL_MEDIA_TYPE_PATTERN.exec(uri)?.[1]
    if (!mediaType || !isSupportedMediaType(mediaType)) return undefined
    const decoded = decodeDataUrl(uri)
    return makeAttachment(decoded.bytes, decoded.mediaType, filename)
  }
  if (!uri.startsWith("file:")) return undefined

  const filePath = fileURLToPath(uri)
  if (!mediaTypeFromPath(filePath)) return undefined
  const attachment = await attachmentFromFile(filePath)
  return makeAttachment(
    attachment.bytes,
    attachment.mediaType,
    filename ?? attachment.filename,
  )
}

export async function attachmentFromFile(
  filePath: string,
): Promise<AttachmentAsset> {
  const mediaType = mediaTypeFromPath(filePath)
  if (!mediaType || !isSupportedMediaType(mediaType)) {
    throw new TypeError(
      `Unsupported attachment file extension: ${path.basename(filePath)}`,
    )
  }
  const bytes = await readFileWithLimit(filePath)
  validateFileSignature(bytes, mediaType, filePath)
  return makeAttachment(bytes, mediaType, path.basename(filePath))
}

export async function saveAttachment(
  attachment: AttachmentAsset,
  directory: string,
): Promise<SavedAttachment> {
  const digest = createHash("sha256").update(attachment.bytes).digest("hex")
  const extension = MEDIA_EXTENSIONS[attachment.mediaType] ?? "bin"
  const filePath = path.join(directory, `${digest}.${extension}`)

  await mkdir(directory, { recursive: true })
  try {
    await writeFile(filePath, attachment.bytes, { flag: "wx" })
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
  }

  return {
    digest,
    path: filePath,
    url: pathToFileURL(filePath).href,
  }
}

function attachmentFromMediaPart(
  part: Record<string, unknown>,
): AttachmentAsset | undefined {
  const rawMediaType = extractMediaTypeFromMediaPart(part)
  if (typeof rawMediaType !== "string") return undefined
  const declaredType = normalizeMediaType(rawMediaType)
  if (!isSupportedMediaType(declaredType)) return undefined

  const data = extractDataFromMediaPart(part)
  if (typeof data !== "string" && !(data instanceof Uint8Array)) {
    return undefined
  }

  const decoded =
    typeof data === "string"
      ? decodeStringData(data, declaredType)
      : { bytes: bytesFromUint8Array(data), mediaType: declaredType }

  return makeAttachment(
    decoded.bytes,
    decoded.mediaType,
    optionalFilename(part.filename),
    part.media,
  )
}

function extractMediaTypeFromMediaPart(
  part: Record<string, unknown>,
): string | undefined {
  if (typeof part.mediaType === "string") return part.mediaType
  if (isRecord(part.media)) {
    if (typeof part.media.mediaType === "string") return part.media.mediaType
    if (
      isRecord(part.media.source) &&
      typeof part.media.source.mediaType === "string"
    ) {
      return part.media.source.mediaType
    }
  }
  return undefined
}

function extractDataFromMediaPart(
  part: Record<string, unknown>,
): string | Uint8Array | undefined {
  if (typeof part.data === "string" || part.data instanceof Uint8Array) {
    return part.data
  }
  if (isRecord(part.media)) {
    if (typeof part.media.inline === "function") {
      try {
        const inline = (part.media.inline as () => unknown)()
        if (isRecord(inline)) {
          if (typeof inline.dataUrl === "string") return inline.dataUrl
          if (typeof inline.base64 === "string") return inline.base64
        }
      } catch {
        // ignore inline() failure
      }
    }
    if (isRecord(part.media.source)) {
      const source = part.media.source
      if (source.type === "base64" && typeof source.data === "string") {
        return source.data
      }
      if (
        source.type === "bytes" &&
        (typeof source.data === "string" || source.data instanceof Uint8Array)
      ) {
        return source.data
      }
      if (
        source.type === "url" &&
        typeof source.url === "string" &&
        source.url.startsWith("data:")
      ) {
        return source.url
      }
    }
    if (typeof part.media.data === "string" || part.media.data instanceof Uint8Array) {
      return part.media.data
    }
    if (typeof part.media.dataUrl === "string") {
      return part.media.dataUrl
    }
  }
  return undefined
}


function attachmentFromFilePart(
  part: Record<string, unknown>,
): AttachmentAsset | undefined {
  const mime =
    typeof part.mime === "string"
      ? part.mime
      : typeof part.mediaType === "string"
        ? part.mediaType
        : undefined
  if (mime === undefined || typeof part.url !== "string") {
    return undefined
  }
  const declaredType = normalizeMediaType(mime)
  if (!isSupportedMediaType(declaredType) || !part.url.startsWith("data:")) {
    return undefined
  }

  const decoded = decodeDataUrl(part.url)
  if (decoded.mediaType !== declaredType) {
    throw new TypeError(
      `Attachment media type ${declaredType} does not match data URL type ${decoded.mediaType}`,
    )
  }
  return makeAttachment(
    decoded.bytes,
    decoded.mediaType,
    optionalFilename(part.filename),
    part.media,
  )
}

function decodeStringData(
  data: string,
  declaredType: string,
): { readonly bytes: Buffer; readonly mediaType: string } {
  if (!data.startsWith("data:")) {
    return { bytes: decodeBase64(data), mediaType: declaredType }
  }
  const decoded = decodeDataUrl(data)
  if (decoded.mediaType !== declaredType) {
    throw new TypeError(
      `Attachment media type ${declaredType} does not match data URL type ${decoded.mediaType}`,
    )
  }
  return decoded
}

function decodeDataUrl(
  value: string,
): { readonly bytes: Buffer; readonly mediaType: string } {
  const match = DATA_URL_PATTERN.exec(value)
  if (!match?.[1] || match[2] === undefined) {
    throw new TypeError(
      "Attachment data URL must contain a MIME type and Base64 data",
    )
  }
  const mediaType = normalizeMediaType(match[1])
  return { bytes: decodeBase64(match[2]), mediaType }
}

function decodeBase64(value: string): Buffer {
  if (value.length === 0 || value.length % 4 !== 0) {
    throw new TypeError("Attachment contains invalid Base64 data")
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  const decodedLength = (value.length / 4) * 3 - padding
  if (decodedLength > MAX_ATTACHMENT_BYTES) {
    throw new RangeError(
      `Attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte size limit`,
    )
  }
  if (!BASE64_PATTERN.test(value)) {
    throw new TypeError("Attachment contains invalid Base64 data")
  }
  const bytes = Buffer.from(value, "base64")
  if (bytes.toString("base64") !== value) {
    throw new TypeError("Attachment contains non-canonical Base64 data")
  }
  return bytes
}

function makeAttachment(
  bytes: Buffer,
  mediaType: string,
  filename: string | undefined,
  hostMedia?: unknown,
): AttachmentAsset {
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new RangeError(
      `Attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte size limit`,
    )
  }
  validateFileSignature(bytes, mediaType, filename ?? "attachment")
  return {
    bytes,
    dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`,
    mediaType,
    ...(filename === undefined ? {} : { filename }),
    ...(hostMedia === undefined ? {} : { hostMedia }),
  }
}

function mediaTypeFromPath(filePath: string): string | undefined {
  return EXTENSION_MEDIA_TYPES[path.extname(filePath).toLowerCase()]
}

export function isSupportedMediaType(mediaType: string): boolean {
  const normalized = normalizeMediaType(mediaType)
  return SUPPORTED_MEDIA_TYPES.has(normalized)
}

export function isPdfMediaType(mediaType: string): boolean {
  return normalizeMediaType(mediaType) === "application/pdf"
}

// Backwards-compatible image helpers used by the explicit read_image tool.
export type ImageLikePart = AttachmentLikePart
export type ImageAsset = AttachmentAsset
export type SavedImage = SavedAttachment
export const imageFromPart = attachmentFromPart
export const imageFromFile = attachmentFromFile
export const saveImage = saveAttachment

function optionalFilename(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function normalizeMediaType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase()
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}


function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST"
}

function bytesFromUint8Array(value: Uint8Array): Buffer {
  if (value.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new RangeError(
      `Attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte size limit`,
    )
  }
  return Buffer.from(value)
}

async function readFileWithLimit(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, "r")
  try {
    const initial = await handle.stat()
    if (!initial.isFile()) {
      throw new TypeError(`Attachment path is not a regular file: ${filePath}`)
    }
    if (initial.size > MAX_ATTACHMENT_BYTES) {
      throw new RangeError(
        `Attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte size limit`,
      )
    }

    const bytes = Buffer.allocUnsafe(initial.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    const final = await handle.stat()
    if (final.size > MAX_ATTACHMENT_BYTES) {
      throw new RangeError(
        `Attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte size limit`,
      )
    }
    return offset === bytes.byteLength ? bytes : bytes.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

function validateFileSignature(
  bytes: Uint8Array,
  mediaType: string,
  filePath: string,
): void {
  const matches =
    (mediaType === "image/png" && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    (mediaType === "image/jpeg" && startsWith(bytes, [0xff, 0xd8, 0xff])) ||
    (mediaType === "image/gif" && (startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a"))) ||
    (mediaType === "image/webp" && startsWithAscii(bytes, "RIFF") && startsWithAscii(bytes.subarray(8), "WEBP")) ||
    (mediaType === "image/bmp" && startsWithAscii(bytes, "BM")) ||
    (mediaType === "image/avif" && isAvif(bytes)) ||
    (mediaType === "application/pdf" &&
      includesAscii(bytes.subarray(0, 1024), "%PDF-"))
  if (!matches) {
    throw new TypeError(`File contents do not match ${mediaType}: ${filePath}`)
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value)
}

function startsWithAscii(bytes: Uint8Array, prefix: string): boolean {
  return startsWith(bytes, [...prefix].map((character) => character.charCodeAt(0)))
}

function includesAscii(bytes: Uint8Array, value: string): boolean {
  return new TextDecoder("latin1").decode(bytes).includes(value)
}

function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const boxType = String.fromCharCode(...bytes.subarray(4, 8))
  if (boxType !== "ftyp") return false
  const brands = new TextDecoder().decode(bytes.subarray(8))
  return brands.includes("avif") || brands.includes("avis")
}
