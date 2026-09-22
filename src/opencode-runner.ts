import type { VisionDescriptionRequest } from "./bridge.js"
import type { VisionRequestRegistry } from "./request-registry.js"

export const TRANSIENT_SESSION_TITLE = "Vision bridge transient request"

export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string | undefined
}

interface CreateSessionInput {
  readonly title: string
  readonly agent: string
  readonly model: ModelRef
  readonly location: { readonly directory: string }
}

interface GenerateSessionInput {
  readonly sessionID: string
  readonly prompt: string
}

interface SessionRequest {
  readonly sessionID: string
}

interface RequestOptions {
  readonly signal?: AbortSignal
}

interface SessionState {
  readonly directory: string
  client: VisionClient | undefined
  sessionID: string | undefined
  queue: Promise<void>
}

export interface VisionClient {
  readonly session: {
    create(input: CreateSessionInput): Promise<{ readonly id: string }>
    generate(
      input: GenerateSessionInput,
      options?: RequestOptions,
    ): Promise<{ readonly text: string }>
    interrupt(input: SessionRequest): Promise<void>
  }
}

export interface OpenCodeVisionRunnerOptions {
  readonly client: VisionClient | (() => Promise<VisionClient>)
  readonly requests: VisionRequestRegistry
  readonly agent: string
  readonly model: ModelRef
  readonly directory?: string
  readonly timeoutMs: number
}

export class OpenCodeVisionRunner {
  readonly #client: OpenCodeVisionRunnerOptions["client"]
  readonly #requests: VisionRequestRegistry
  readonly #agent: string
  readonly #model: ModelRef
  readonly #directory: string
  readonly #timeoutMs: number
  readonly #sessions = new Map<string, SessionState>()

  constructor(options: OpenCodeVisionRunnerOptions) {
    this.#client = options.client
    this.#requests = options.requests
    this.#agent = options.agent
    this.#model = options.model
    this.#directory = options.directory ?? process.cwd()
    this.#timeoutMs = options.timeoutMs
  }

  async describe(
    request: VisionDescriptionRequest,
    directory = this.#directory,
  ): Promise<string> {
    const state = this.#sessionFor(directory)
    // Keep the tail settled even when a request fails. This prevents one
    // provider error from rejecting every later request in the same queue.
    const result = state.queue.then(() => this.#describeOnSession(state, request))
    state.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  #sessionFor(directory: string): SessionState {
    const existing = this.#sessions.get(directory)
    if (existing) return existing

    const state: SessionState = {
      directory,
      client: undefined,
      sessionID: undefined,
      queue: Promise.resolve(),
    }
    this.#sessions.set(directory, state)
    return state
  }

  async #describeOnSession(
    state: SessionState,
    request: VisionDescriptionRequest,
  ): Promise<string> {
    const client = await this.#ensureSession(state)
    const sessionID = state.sessionID
    if (!sessionID) throw new Error("Vision session was not created")

    const sessionRequest = { sessionID }
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs)
    const signal = request.signal
      ? AbortSignal.any([timeoutSignal, request.signal])
      : timeoutSignal
    this.#requests.set(sessionID, request)

    try {
      const response = await client.session.generate(
        {
          ...sessionRequest,
          prompt: visionPrompt(request),
        },
        { signal },
      )
      const text = response.text.trim()
      if (text === "") throw new Error("Vision generation returned no text")
      return text
    } catch (error) {
      // Keep the reusable session after provider and timeout failures. Creating
      // a replacement for every transient failure would leak sessions because
      // the in-process plugin API cannot remove them safely from inside a hook.
      await client.session.interrupt(sessionRequest).catch(() => undefined)
      throw error
    } finally {
      this.#requests.delete(sessionID)
    }
  }

  async #ensureSession(state: SessionState): Promise<VisionClient> {
    if (state.client && state.sessionID) return state.client

    const client = await this.#resolveClient()
    const session = await client.session.create({
      title: TRANSIENT_SESSION_TITLE,
      agent: this.#agent,
      model: this.#model,
      location: { directory: state.directory },
    })
    state.client = client
    state.sessionID = session.id
    return client
  }

  async #resolveClient(): Promise<VisionClient> {
    return typeof this.#client === "function" ? this.#client() : this.#client
  }
}

function visionPrompt(request: VisionDescriptionRequest): string {
  const source = request.source
  const attachmentType = source ? "PDF pages" : "image"
  const pageContext = source
    ? `This batch contains PDF pages ${source.pageStart}-${source.pageEnd} of ${source.pageCount}. Preserve page boundaries and page numbers in the response.`
    : undefined
  return [
    `Inspect the attached ${attachmentType} and provide the evidence needed by another model.`,
    ...(pageContext ? [pageContext] : []),
    "Question or surrounding user text:",
    request.question,
    "Return only an accurate, detailed textual description. Quote visible text exactly where relevant.",
  ].join("\n\n")
}
