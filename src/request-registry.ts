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
  readonly #injected = new Set<string>()

  set(sessionID: string, request: VisionDescriptionRequest): void {
    this.#requests.set(sessionID, request)
    this.#injected.delete(sessionID)
  }

  delete(sessionID: string): void {
    this.#requests.delete(sessionID)
    this.#injected.delete(sessionID)
  }

  inject(sessionID: string, messages: RequestContextMessage[]): boolean {
    const request = this.#requests.get(sessionID)
    if (!request || this.#injected.has(sessionID)) return false

    const message = [...messages]
      .reverse()
      .find((candidate) => candidate.role === "user")
    if (!message) {
      messages.push({ role: "user", content: mediaParts(request) })
      this.#injected.add(sessionID)
      return true
    }

    message.content.push(...mediaParts(request))
    this.#injected.add(sessionID)
    return true
  }
}

function mediaParts(
  request: VisionDescriptionRequest,
): RequestContextPart[] {
  return [
    mediaPart(request),
    ...(request.additionalMedia ?? []).map(mediaPart),
  ]
}

function mediaPart(request: {
  readonly dataUrl: string
  readonly mediaType: string
  readonly filename?: string
}): RequestContextPart {
  return {
    type: "media",
    mediaType: request.mediaType,
    data: request.dataUrl,
    ...(request.filename === undefined ? {} : { filename: request.filename }),
  }
}
