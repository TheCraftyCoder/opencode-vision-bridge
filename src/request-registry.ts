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

let hostMediaProto: object | undefined
let hostMediaCtor: (new (...args: any[]) => any) | undefined

/**
 * Called from the context hook whenever a real Media.Asset passes through.
 * Stores the host prototype so injected media parts can be stamped with the
 * same class, satisfying OpenCode's `instanceof Me` schema check.
 */
export function setHostMediaPrototype(proto: object, ctor?: any): void {
  if (hostMediaProto) return // capture once per runtime instance
  if (proto && typeof proto === "object") {
    hostMediaProto = proto
    if (typeof ctor === "function") {
      hostMediaCtor = ctor
    } else if (typeof (proto as any).constructor === "function") {
      hostMediaCtor = (proto as any).constructor
    }
  }
}

let mediaFactory: ((data: string, mediaType: string) => unknown) | undefined

export async function ensureMediaFactory(): Promise<void> {
  if (mediaFactory) return
  try {
    // Use indirect import to avoid TypeScript resolving the BUN-internal path.
    // This only succeeds when running inside OpenCode's Bun runtime.
    const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<any>
    const mod = await dynamicImport("B:/~BUN/root/chunk-c2cwewwq.js")
    if (typeof mod.RI === "function") {
      mediaFactory = mod.RI
    }
  } catch {}
}

// Eagerly attempt to resolve inside OpenCode runtime
ensureMediaFactory().catch(() => {})

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
  readonly hostMedia?: unknown
}): RequestContextPart {
  const commaIndex = request.dataUrl.indexOf(",")
  const base64Data =
    commaIndex >= 0 ? request.dataUrl.slice(commaIndex + 1) : request.dataUrl

  let media: any = request.hostMedia

  if (media && typeof media === "object") {
    // Reuse the original host Media.Asset — already passes instanceof check.
    media.mediaType = request.mediaType
    if (!media.kind) {
      media.kind = request.mediaType.startsWith("image/") ? "image" : "other"
    }
  } else {
    // Construct a fresh media object and stamp it with the host prototype.
    if (hostMediaCtor) {
      try {
        media = new hostMediaCtor({
          source: {
            type: "base64",
            data: base64Data,
            mediaType: request.mediaType,
          },
          mediaType: request.mediaType,
          kind: request.mediaType.startsWith("image/") ? "image" : "other",
        })
      } catch {}
    }
    if (!media && mediaFactory) {
      try {
        media = mediaFactory(base64Data, request.mediaType)
      } catch {}
    }
    if (!media) {
      media = {
        mediaType: request.mediaType,
        kind: request.mediaType.startsWith("image/") ? "image" : "other",
        source: {
          type: "base64",
          data: base64Data,
          mediaType: request.mediaType,
        },
      }
    }
    if (hostMediaProto && media && typeof media === "object") {
      try {
        Object.setPrototypeOf(media, hostMediaProto)
      } catch {}
    }
    media.mediaType = request.mediaType
    if (!media.kind) {
      media.kind = request.mediaType.startsWith("image/") ? "image" : "other"
    }
  }

  return {
    type: "media",
    media,
    mediaType: request.mediaType,
    data: request.dataUrl,
    ...(request.filename === undefined ? {} : { filename: request.filename }),
  }
}
