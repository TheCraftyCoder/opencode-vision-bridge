import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  imageFromFile,
  imageFromPart,
  saveImage,
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

test("imageFromFile maps supported extensions and defaults unknown extensions to PNG", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vision-bridge-file-image-"))
  const expectedTypes = new Map([
    ["image.png", "image/png"],
    ["image.jpg", "image/jpeg"],
    ["image.JPEG", "image/jpeg"],
    ["image.gif", "image/gif"],
    ["image.webp", "image/webp"],
    ["image.bmp", "image/bmp"],
    ["image.avif", "image/avif"],
    ["image.unknown", "image/png"],
  ])

  await Promise.all(
    [...expectedTypes].map(async ([filename, mediaType]) => {
      const filePath = path.join(directory, filename)
      await writeFile(filePath, PNG_BYTES)
      const image = await imageFromFile(filePath)
      assert.equal(image.mediaType, mediaType)
      assert.equal(image.filename, filename)
      assert.deepEqual(image.bytes, PNG_BYTES)
    }),
  )
})
