import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"

import {
  attachmentFromPart,
  attachmentFromUri,
  imageFromFile,
  imageFromPart,
  saveImage,
  MAX_ATTACHMENT_BYTES,
  type ImageLikePart,
} from "../src/image.js"

const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex")
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`

test("imageFromPart reads the V2 media-part data URL shape", () => {
  const image = imageFromPart({
    type: "media",
    mediaType: "image/png",
    data: PNG_DATA_URL,
    filename: "clipboard.png",
  })

  assert.ok(image)
  assert.equal(image.mediaType, "image/png")
  assert.equal(image.filename, "clipboard.png")
  assert.deepEqual(image.bytes, PNG_BYTES)
})

test("imageFromPart also reads the data-URL file-part shape", () => {
  const part: ImageLikePart = {
    type: "file",
    mime: "image/png",
    url: PNG_DATA_URL,
    filename: "pasted.png",
  }

  const image = imageFromPart(part)

  assert.ok(image)
  assert.deepEqual(image.bytes, PNG_BYTES)
})

test("imageFromPart ignores non-image parts", () => {
  assert.equal(
    imageFromPart({ type: "media", mediaType: "text/plain", data: "aGVsbG8=" }),
    undefined,
  )
})

test("attachmentFromPart reads PDF media parts", () => {
  const bytes = Buffer.from("%PDF-1.7")
  const attachment = attachmentFromPart({
    type: "media",
    mediaType: "application/pdf",
    data: `data:application/pdf;base64,${bytes.toString("base64")}`,
    filename: "report.pdf",
  })

  assert.ok(attachment)
  assert.equal(attachment.mediaType, "application/pdf")
  assert.equal(attachment.filename, "report.pdf")
  assert.deepEqual(attachment.bytes, bytes)
})

test("attachmentFromUri reads pasted PDF data URLs", async () => {
  const bytes = Buffer.from("%PDF-1.7")
  const attachment = await attachmentFromUri(
    `data:application/pdf;base64,${bytes.toString("base64")}`,
    "pasted.pdf",
  )

  assert.ok(attachment)
  assert.equal(attachment.mediaType, "application/pdf")
  assert.equal(attachment.filename, "pasted.pdf")
  assert.deepEqual(attachment.bytes, bytes)
})

test("attachmentFromUri ignores unsupported disk extensions instead of guessing PNG", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vision-bridge-file-uri-"))
  const filePath = path.join(directory, ".env")
  await writeFile(filePath, PNG_BYTES)

  assert.equal(await attachmentFromUri(pathToFileURL(filePath).href), undefined)
})

test("data URLs are size-limited before Base64 allocation", () => {
  const oversized = "A".repeat(Math.ceil((MAX_ATTACHMENT_BYTES + 1) / 3) * 4)
  assert.throws(
    () => attachmentFromPart({ type: "media", mediaType: "image/png", data: oversized }),
    /exceeds the .*byte size limit/,
  )
})

test("saveImage writes a deterministic digest-named file and returns its file URL", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vision-bridge-image-"))
  const image = imageFromPart({
    type: "media",
    mediaType: "image/png",
    data: PNG_DATA_URL,
  })
  assert.ok(image)

  const first = await saveImage(image, directory)
  const second = await saveImage(image, directory)

  assert.equal(first.path, second.path)
  assert.match(first.url, /^file:\/\//)
  assert.match(path.basename(first.path), /^[a-f0-9]{64}\.png$/)
  assert.deepEqual(await readFile(first.path), PNG_BYTES)
})

test("imageFromFile maps only supported extensions and validates file signatures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vision-bridge-file-image-"))
  const expectedTypes = new Map([
    ["image.png", ["image/png", Buffer.from("89504e470d0a1a0a", "hex")]],
    ["image.jpg", ["image/jpeg", Buffer.from("ffd8ff", "hex")]],
    ["image.JPEG", ["image/jpeg", Buffer.from("ffd8ff", "hex")]],
    ["image.gif", ["image/gif", Buffer.from("GIF89a")]],
    ["image.webp", ["image/webp", Buffer.from("524946460000000057454250", "hex")]],
    ["image.bmp", ["image/bmp", Buffer.from("BM")]],
    ["image.avif", ["image/avif", Buffer.from("00000018667479706176696600000000", "hex")]],
  ])

  await Promise.all(
    [...expectedTypes].map(async ([filename, expected]) => {
      const filePath = path.join(directory, filename)
      const [mediaType, bytes] = expected as [string, Buffer]
      await writeFile(filePath, bytes)
      const image = await imageFromFile(filePath)
      assert.equal(image.mediaType, mediaType)
      assert.equal(image.filename, filename)
      assert.deepEqual(image.bytes, bytes)
    }),
  )

  await writeFile(path.join(directory, "image.unknown"), PNG_BYTES)
  await assert.rejects(
    imageFromFile(path.join(directory, "image.unknown")),
    /Unsupported attachment file extension/,
  )
  await writeFile(path.join(directory, ".env"), PNG_BYTES)
  await assert.rejects(
    imageFromFile(path.join(directory, ".env")),
    /Unsupported attachment file extension/,
  )
})

test("imageFromFile rejects an oversized disk attachment before reading it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vision-bridge-file-image-large-"))
  const filePath = path.join(directory, "large.png")
  await writeFile(filePath, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0))

  await assert.rejects(
    imageFromFile(filePath),
    /exceeds the .*byte size limit/,
  )
})
