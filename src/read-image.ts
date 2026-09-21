import { homedir } from "node:os"
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
    const sourcePath = resolveImagePath(
      input.filePath,
      this.#projectDirectory,
      this.#homeDirectory,
    )
    const image = await imageFromFile(sourcePath)
    if (!image.mediaType.startsWith("image/")) {
      throw new TypeError(`read_image only accepts image files: ${sourcePath}`)
    }
    const saved = await saveImage(image, this.#saveDir)
    const description = (
      await this.#describe({
        dataUrl: image.dataUrl,
        mediaType: image.mediaType,
        ...(image.filename === undefined ? {} : { filename: image.filename }),
        fileUrl: saved.url,
        question: input.question ?? DEFAULT_QUESTION,
      })
    ).trim()
    if (description === "") {
      throw new Error("Vision model returned an empty description")
    }
    return attachmentDescriptionText({
      description,
      fileUrl: saved.url,
      mediaType: image.mediaType,
      ...(image.filename === undefined ? {} : { filename: image.filename }),
    })
  }
}

export function resolveImagePath(
  filePath: string,
  projectDirectory: string,
  homeDirectory = homedir(),
): string {
  if (filePath.startsWith("~/")) {
    return path.resolve(homeDirectory, filePath.slice(2))
  }
  return path.resolve(projectDirectory, filePath)
}
