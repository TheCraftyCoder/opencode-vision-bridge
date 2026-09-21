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

export interface VisionClient {
  readonly session: {
    create(input: CreateSessionInput): Promise<{ readonly id: string }>
    generate(
      input: GenerateSessionInput,
      options?: RequestOptions,
    ): Promise<{ readonly text: string }>
    interrupt(input: SessionRequest): Promise<void>
    remove(input: SessionRequest): Promise<void>
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
    const client = await this.#resolveClient()
    const session = await client.session.create({
      title: TRANSIENT_SESSION_TITLE,
      agent: this.#agent,
      model: this.#model,
      location: { directory },
    })
    const sessionRequest = { sessionID: session.id }
    const signal = AbortSignal.timeout(this.#timeoutMs)
    this.#requests.set(session.id, request)

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
      await client.session.interrupt(sessionRequest).catch(() => undefined)
      throw error
    } finally {
      this.#requests.delete(session.id)
      await client.session.remove(sessionRequest)
    }
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
    `Saved local reference: ${request.fileUrl}`,
    "Question or surrounding user text:",
    request.question,
    "Return only an accurate, detailed textual description. Quote visible text exactly where relevant.",
  ].join("\n\n")
}
