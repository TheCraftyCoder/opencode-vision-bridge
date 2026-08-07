import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  DEFAULT_QUESTION,
  type VisionDescriptionRequest,
} from "../src/bridge.js"
import { ReadImageTool } from "../src/read-image.js"

const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex")

interface Fixture {
  readonly projectDirectory: string
  readonly saveDir: string
  readonly requests: VisionDescriptionRequest[]
  readonly tool: ReadImageTool
}

async function fixture(homeDirectory?: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "vision-bridge-read-image-"))
  const projectDirectory = path.join(root, "project")
  const saveDir = path.join(root, "saved")
  const requests: VisionDescriptionRequest[] = []
  await mkdir(projectDirectory)

  return {
    projectDirectory,
    saveDir,
    requests,
    tool: new ReadImageTool({
      projectDirectory,
      saveDir,
      ...(homeDirectory === undefined ? {} : { homeDirectory }),
      describe: async (request) => {
        requests.push(request)
        return "A terminal window shows a compiler error."
      },
    }),
  }
}

test("read_image reads an absolute image path, saves it, and returns the description", async () => {
  const input = await fixture()
  const sourcePath = path.join(input.projectDirectory, "screen.png")
  await writeFile(sourcePath, PNG_BYTES)

  const result = await input.tool.execute({ filePath: sourcePath })

  assert.equal(input.requests.length, 1)
  assert.equal(input.requests[0]?.mediaType, "image/png")
  assert.equal(input.requests[0]?.filename, "screen.png")
  assert.equal(input.requests[0]?.question, DEFAULT_QUESTION)
  assert.equal(input.requests[0]?.dataUrl, `data:image/png;base64,${PNG_BYTES.toString("base64")}`)
  assert.match(result, /File URL: file:\/\//)
  assert.match(result, /terminal window shows a compiler error/)

  const savedFiles = await readFile(new URL(input.requests[0]!.fileUrl))
  assert.deepEqual(savedFiles, PNG_BYTES)
})

test("read_image resolves relative paths against the catalog project directory", async () => {
  const input = await fixture()
  const imageDirectory = path.join(input.projectDirectory, "assets")
  await mkdir(imageDirectory)
  await writeFile(path.join(imageDirectory, "photo.JPEG"), PNG_BYTES)

  await input.tool.execute({ filePath: path.join("assets", "photo.JPEG") })

  assert.equal(input.requests[0]?.mediaType, "image/jpeg")
  assert.equal(input.requests[0]?.filename, "photo.JPEG")
  assert.match(new URL(input.requests[0]!.fileUrl).pathname, /[a-f0-9]{64}\.jpg$/)
})

test("read_image expands paths beginning with ~/", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vision-bridge-read-image-home-"))
  const homeDirectory = path.join(root, "home")
  await mkdir(path.join(homeDirectory, "Pictures"), { recursive: true })
  await writeFile(path.join(homeDirectory, "Pictures", "diagram.webp"), PNG_BYTES)
  const input = await fixture(homeDirectory)

  await input.tool.execute({ filePath: "~/Pictures/diagram.webp" })

  assert.equal(input.requests[0]?.mediaType, "image/webp")
  assert.equal(input.requests[0]?.filename, "diagram.webp")
})

test("read_image passes a supplied question to the vision runner unchanged", async () => {
  const input = await fixture()
  const sourcePath = path.join(input.projectDirectory, "detail.avif")
  const question = "Read the exact error code in the upper-right corner."
  await writeFile(sourcePath, PNG_BYTES)

  await input.tool.execute({ filePath: sourcePath, question })

  assert.equal(input.requests[0]?.question, question)
  assert.equal(input.requests[0]?.mediaType, "image/avif")
})

test("read_image rejects a missing file", async () => {
  const input = await fixture()

  await assert.rejects(
    input.tool.execute({ filePath: "missing.bmp" }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      error.message.includes(path.join(input.projectDirectory, "missing.bmp")),
  )
  assert.equal(input.requests.length, 0)
})
