import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/s

const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/avif": "avif",
}

export type ImageLikePart =
  | {
      readonly type: "media"
      readonly mediaType: string
      readonly data: string | Uint8Array
      readonly filename?: string
    }
  | {
      readonly type: "file"
      readonly mime: string
      readonly url: string
      readonly filename?: string
    }

export interface ImageAsset {
  readonly bytes: Buffer
  readonly dataUrl: string
  readonly mediaType: string
  readonly filename?: string
}

export interface SavedImage {
  readonly digest: string
  readonly path: string
  readonly url: string
}

export function imageFromPart(part: unknown): ImageAsset | undefined {
  if (!isRecord(part)) return undefined
  if (part.type === "media") return imageFromMediaPart(part)
  if (part.type === "file") return imageFromFilePart(part)
  return undefined
}

export async function saveImage(
  image: ImageAsset,
  directory: string,
): Promise<SavedImage> {
  const digest = createHash("sha256").update(image.bytes).digest("hex")
  const extension = MEDIA_EXTENSIONS[image.mediaType] ?? "img"
  const filePath = path.join(directory, `${digest}.${extension}`)

  await mkdir(directory, { recursive: true })
  try {
    await writeFile(filePath, image.bytes, { flag: "wx" })
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
  }

  return {
    digest,
    path: filePath,
    url: pathToFileURL(filePath).href,
  }
}

function imageFromMediaPart(part: Record<string, unknown>): ImageAsset | undefined {
  if (typeof part.mediaType !== "string") return undefined
  const declaredType = normalizeMediaType(part.mediaType)
  if (!declaredType.startsWith("image/")) return undefined
  if (typeof part.data !== "string" && !(part.data instanceof Uint8Array)) {
    return undefined
  }

  const decoded =
    typeof part.data === "string"
      ? decodeStringData(part.data, declaredType)
      : { bytes: Buffer.from(part.data), mediaType: declaredType }

  return makeImage(decoded.bytes, decoded.mediaType, optionalFilename(part.filename))
}

function imageFromFilePart(part: Record<string, unknown>): ImageAsset | undefined {
  if (typeof part.mime !== "string" || typeof part.url !== "string") {
    return undefined
  }
  const declaredType = normalizeMediaType(part.mime)
  if (!declaredType.startsWith("image/") || !part.url.startsWith("data:")) {
    return undefined
  }

  const decoded = decodeDataUrl(part.url)
  if (decoded.mediaType !== declaredType) {
    throw new TypeError(
      `Image media type ${declaredType} does not match data URL type ${decoded.mediaType}`,
    )
  }
  return makeImage(decoded.bytes, decoded.mediaType, optionalFilename(part.filename))
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
      `Image media type ${declaredType} does not match data URL type ${decoded.mediaType}`,
    )
  }
  return decoded
}

function decodeDataUrl(
  value: string,
): { readonly bytes: Buffer; readonly mediaType: string } {
  const match = DATA_URL_PATTERN.exec(value)
  if (!match?.[1] || match[2] === undefined) {
    throw new TypeError("Image data URL must contain a MIME type and Base64 data")
  }
  const mediaType = normalizeMediaType(match[1])
  if (!mediaType.startsWith("image/")) {
    throw new TypeError(`Data URL is not an image: ${mediaType}`)
  }
  return { bytes: decodeBase64(match[2]), mediaType }
}

function decodeBase64(value: string): Buffer {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value)
  ) {
    throw new TypeError("Image contains invalid Base64 data")
  }
  const bytes = Buffer.from(value, "base64")
  if (bytes.toString("base64") !== value) {
    throw new TypeError("Image contains non-canonical Base64 data")
  }
  return bytes
}

function makeImage(
  bytes: Buffer,
  mediaType: string,
  filename: string | undefined,
): ImageAsset {
  return {
    bytes,
    dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`,
    mediaType,
    ...(filename === undefined ? {} : { filename }),
  }
}

function optionalFilename(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function normalizeMediaType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST"
}
