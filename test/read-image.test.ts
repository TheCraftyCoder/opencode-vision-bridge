import assert from "node:assert/strict"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  DEFAULT_QUESTION,
  type VisionDescriptionRequest,
} from "../src/bridge.js"
import { ReadImageTool } from "../src/read-image.js"

const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex")
const JPEG_BYTES = Buffer.from("ffd8ff", "hex")
const AVIF_BYTES = Buffer.from("00000018667479706176696600000000", "hex")

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
  assert.doesNotMatch(result, /File URL:/)
  assert.match(result, /terminal window shows a compiler error/)

  const savedNames = await readdir(input.saveDir)
  assert.equal(savedNames.length, 1)
  assert.deepEqual(
    await readFile(path.join(input.saveDir, savedNames[0]!)),
    PNG_BYTES,
  )
})

test("read_image allows images inside OpenCode temp directory", async () => {
  const input = await fixture()
  const tempDir = path.join(tmpdir(), "opencode")
  await mkdir(tempDir, { recursive: true })
  const pastedPath = path.join(tempDir, "pasted-test.png")
  await writeFile(pastedPath, PNG_BYTES)

  const result = await input.tool.execute({ filePath: pastedPath })

  assert.equal(input.requests.length, 1)
  assert.equal(input.requests[0]?.filename, "pasted-test.png")
  assert.match(result, /terminal window shows a compiler error/)
})


test("read_image resolves relative paths against the catalog project directory", async () => {
  const input = await fixture()
  const imageDirectory = path.join(input.projectDirectory, "assets")
  await mkdir(imageDirectory)
  await writeFile(path.join(imageDirectory, "photo.JPEG"), JPEG_BYTES)

  await input.tool.execute({ filePath: path.join("assets", "photo.JPEG") })

  assert.equal(input.requests[0]?.mediaType, "image/jpeg")
  assert.equal(input.requests[0]?.filename, "photo.JPEG")
  assert.match((await readdir(input.saveDir))[0] ?? "", /^[a-f0-9]{64}\.jpg$/)
})

test("read_image rejects paths beginning with ~/ outside the project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vision-bridge-read-image-home-"))
  const homeDirectory = path.join(root, "home")
  await mkdir(path.join(homeDirectory, "Pictures"), { recursive: true })
  await writeFile(path.join(homeDirectory, "Pictures", "diagram.webp"), PNG_BYTES)
  const input = await fixture(homeDirectory)

  await assert.rejects(
    input.tool.execute({ filePath: "~/Pictures/diagram.webp" }),
    /paths inside the project directory/,
  )
  assert.equal(input.requests.length, 0)
})

test("read_image passes a supplied question to the vision runner unchanged", async () => {
  const input = await fixture()
  const sourcePath = path.join(input.projectDirectory, "detail.avif")
  const question = "Read the exact error code in the upper-right corner."
  await writeFile(sourcePath, AVIF_BYTES)

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

test("read_image rejects PDFs because pasted PDFs use the automatic prompt bridge", async () => {
  const input = await fixture()
  const sourcePath = path.join(input.projectDirectory, "document.pdf")
  await writeFile(sourcePath, Buffer.from("%PDF-1.7"))

  await assert.rejects(
    input.tool.execute({ filePath: sourcePath }),
    /read_image only accepts image files/,
  )
  assert.equal(input.requests.length, 0)
})

test("read_image rejects traversal and absolute paths outside the project", async () => {
  const input = await fixture()
  const outside = path.join(path.dirname(input.projectDirectory), "outside.png")
  await writeFile(outside, PNG_BYTES)

  await assert.rejects(
    input.tool.execute({ filePath: "../outside.png" }),
    /paths inside the project directory/,
  )
  await assert.rejects(
    input.tool.execute({ filePath: outside }),
    /paths inside the project directory/,
  )
  assert.equal(input.requests.length, 0)
})

test("read_image rejects symlinks that escape the project", async (t) => {
  const input = await fixture()
  const outside = path.join(path.dirname(input.projectDirectory), "linked.png")
  const link = path.join(input.projectDirectory, "linked.png")
  await writeFile(outside, PNG_BYTES)
  try {
    await symlink(outside, link)
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
      t.skip("symlink creation is not permitted in this environment")
      return
    }
    throw error
  }

  await assert.rejects(
    input.tool.execute({ filePath: "linked.png" }),
    /escapes the project directory/,
  )
  assert.equal(input.requests.length, 0)
})
