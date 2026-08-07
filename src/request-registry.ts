import type { VisionDescriptionRequest } from "./bridge.js"

export interface RequestContextPart {
  readonly type: string
  readonly [key: string]: unknown
}

export interface RequestContextMessage {
  readonly role: string
  content: RequestContextPart[]
  readonly [key: string]: unknown
}

export class VisionRequestRegistry {
  readonly #requests = new Map<string, VisionDescriptionRequest>()

  set(sessionID: string, request: VisionDescriptionRequest): void {
    this.#requests.set(sessionID, request)
  }

  delete(sessionID: string): void {
    this.#requests.delete(sessionID)
  }

  inject(sessionID: string, messages: RequestContextMessage[]): boolean {
    const request = this.#requests.get(sessionID)
    if (!request) return false

    const message = [...messages]
      .reverse()
      .find((candidate) => candidate.role === "user")
    if (!message) {
      messages.push({ role: "user", content: [mediaPart(request)] })
      return true
    }

    message.content.push(mediaPart(request))
    return true
  }
}

function mediaPart(request: VisionDescriptionRequest): RequestContextPart {
  return {
    type: "media",
    mediaType: request.mediaType,
    data: request.dataUrl,
    ...(request.filename === undefined ? {} : { filename: request.filename }),
  }
}
