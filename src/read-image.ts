import { homedir, tmpdir } from "node:os"
import { realpath } from "node:fs/promises"
import path from "node:path"

import {
  DEFAULT_QUESTION,
  attachmentDescriptionText,
  type VisionDescriptionRequest,
} from "./bridge.js"
import { imageFromFile, saveImage } from "./image.js"

export interface ReadImageInput {
  readonly filePath: string
  readonly question?: string
}

export interface ReadImageToolOptions {
  readonly projectDirectory: string
  readonly saveDir: string
  readonly describe: (request: VisionDescriptionRequest) => Promise<string>
  readonly homeDirectory?: string
}

export class ReadImageTool {
  readonly #projectDirectory: string
  readonly #saveDir: string
  readonly #describe: ReadImageToolOptions["describe"]
  readonly #homeDirectory: string

  constructor(options: ReadImageToolOptions) {
    this.#projectDirectory = options.projectDirectory
    this.#saveDir = options.saveDir
    this.#describe = options.describe
    this.#homeDirectory = options.homeDirectory ?? homedir()
  }

  async execute(input: ReadImageInput): Promise<string> {
    const sourcePath = await resolveImagePathSecure(
      input.filePath,
      this.#projectDirectory,
      this.#homeDirectory,
    )
    const image = await imageFromFile(sourcePath)
    if (!image.mediaType.startsWith("image/")) {
      throw new TypeError(`read_image only accepts image files: ${sourcePath}`)
    }
    await saveImage(image, this.#saveDir)
    const description = (
      await this.#describe({
        dataUrl: image.dataUrl,
        mediaType: image.mediaType,
        ...(image.filename === undefined ? {} : { filename: image.filename }),
        question: input.question ?? DEFAULT_QUESTION,
      })
    ).trim()
    if (description === "") {
      throw new Error("Vision model returned an empty description")
    }
    return attachmentDescriptionText({
      description,
      mediaType: image.mediaType,
      ...(image.filename === undefined ? {} : { filename: image.filename }),
      cacheable: true,
    })
  }
}

export function resolveImagePath(
  filePath: string,
  projectDirectory: string,
  homeDirectory = homedir(),
): string {
  if (filePath === "~" || filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.resolve(homeDirectory, filePath.slice(2))
  }
  return path.resolve(projectDirectory, filePath)
}

/**
 * Resolve a read_image path under the project root or the OpenCode temp folder
 * and reject symlink escapes. Home-relative paths and arbitrary host files are
 * deliberately rejected: the tool is intended to inspect project assets and
 * pasted session attachments.
 */
async function resolveImagePathSecure(
  filePath: string,
  projectDirectory: string,
  homeDirectory: string,
): Promise<string> {
  if (filePath === "~" || filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    throw new TypeError("read_image only accepts paths inside the project directory; ~/ paths are not allowed")
  }

  const projectPath = path.resolve(projectDirectory)
  const candidate = resolveImagePath(filePath, projectPath, homeDirectory)
  const tempOpenCodePath = path.resolve(tmpdir(), "opencode")
  const isProjectFile = isWithin(projectPath, candidate)
  const isTempOpenCodeFile = isWithin(tempOpenCodePath, candidate)

  if (!isProjectFile && !isTempOpenCodeFile) {
    throw new TypeError("read_image only accepts paths inside the project directory")
  }

  const allowedRoot = isProjectFile ? projectPath : tempOpenCodePath
  const [allowedRealPath, candidateRealPath] = await Promise.all([
    realpath(allowedRoot).catch(() => allowedRoot),
    realpath(candidate),
  ])
  if (!isWithin(allowedRealPath, candidateRealPath)) {
    throw new TypeError("read_image rejected a path that escapes the project directory")
  }
  return candidateRealPath
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}
