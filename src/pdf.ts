import type { Canvas, SKRSContext2D } from "@napi-rs/canvas"
import { createRequire } from "node:module"
import path from "node:path"

import type { AttachmentAsset } from "./image.js"

export const PDF_PAGE_BATCH_SIZE = 8
export const PDF_MAX_BYTES = 25 * 1024 * 1024
export const PDF_MAX_PAGES = 32
export const PDF_RENDER_TIMEOUT_MS = 5 * 60 * 1000
export const PDF_PAGE_RENDER_TIMEOUT_MS = 30_000
export const PDF_MAX_PAGE_IMAGE_BYTES = 4 * 1024 * 1024
export const PDF_MAX_IMAGE_PIXELS = 8 * 1024 * 1024
export const PDF_CANVAS_MAX_AREA_BYTES = 32 * 1024 * 1024

const PDF_RENDER_SCALE = 2
const PDF_MAX_DIMENSION = 2_048

interface CanvasEntry {
  readonly canvas: Canvas
  readonly context: SKRSContext2D
}

interface CanvasFactory {
  create(width: number, height: number): CanvasEntry
  destroy(entry: CanvasEntry): void
}

export interface PdfPageBatch {
  readonly pages: AttachmentAsset[]
  readonly start: number
  readonly end: number
  readonly total: number
  /** True when the document was stopped before all pages could be rendered. */
  readonly truncated: boolean
  readonly truncationReason?: string
}

export interface PdfRenderOptions {
  /** Maximum input PDF size. Defaults to {@link PDF_MAX_BYTES}. */
  readonly maxBytes?: number
  /** Maximum number of pages to render. Defaults to {@link PDF_MAX_PAGES}. */
  readonly maxPages?: number
  /** Maximum time allowed for loading or rendering one operation. */
  readonly pageTimeoutMs?: number
  /** Maximum total time allowed for this PDF, including all pages. */
  readonly timeoutMs?: number
  /** Maximum encoded PNG size for an individual rendered page. */
  readonly maxPageImageBytes?: number
  /** Cancels loading or rendering as soon as the signal is aborted. */
  readonly signal?: AbortSignal
}

export interface PdfJsResourceOptions {
  readonly cMapUrl: string
  readonly cMapPacked: true
  readonly standardFontDataUrl: string
  readonly wasmUrl: string
  readonly useWorkerFetch: false
  readonly maxImageSize: number
  readonly canvasMaxAreaInBytes: number
  readonly stopAtErrors: true
  readonly useSystemFonts: true
  readonly enableXfa: true
  readonly isEvalSupported: false
}

/**
 * Resolve pdf.js' bundled assets from the installed package. Using package
 * resolution here keeps this working when the plugin is installed globally.
 */
export function getPdfJsResourceOptions(): PdfJsResourceOptions {
  const pdfjsRoot = path.dirname(
    path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist")),
  )
  const assetPath = (directory: string): string =>
    `${path.join(pdfjsRoot, directory).split(path.sep).join("/")}/`

  return {
    cMapUrl: assetPath("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: assetPath("standard_fonts"),
    wasmUrl: assetPath("wasm"),
    useWorkerFetch: false,
    maxImageSize: PDF_MAX_IMAGE_PIXELS,
    canvasMaxAreaInBytes: PDF_CANVAS_MAX_AREA_BYTES,
    stopAtErrors: true,
    useSystemFonts: true,
    enableXfa: true,
    isEvalSupported: false,
  }
}

export async function* renderPdfPageBatches(
  bytes: Uint8Array,
  filename = "document.pdf",
  options: PdfRenderOptions = {},
): AsyncGenerator<PdfPageBatch> {
  const limits = normalizeOptions(options)
  if (bytes.byteLength > limits.maxBytes) {
    throw new RangeError(
      `PDF exceeds the ${formatBytes(limits.maxBytes)} input size limit`,
    )
  }
  throwIfAborted(limits.signal)
  const deadline = Date.now() + limits.timeoutMs
  const operationTimeout = (operation: string): number => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`${operation} timed out after ${limits.timeoutMs}ms`)
    }
    return Math.min(remaining, limits.pageTimeoutMs)
  }

  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const loading = getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    ...getPdfJsResourceOptions(),
  })
  let document: Awaited<typeof loading.promise>
  try {
    document = await withControl(
      loading.promise,
      limits.signal,
      operationTimeout("Loading PDF"),
      "Loading PDF",
    )
  } catch (error) {
    await loading.destroy().catch(() => undefined)
    throw error
  }
  const canvasFactory = (
    document as unknown as { readonly canvasFactory: CanvasFactory }
  ).canvasFactory

  try {
    const renderPageCount = Math.min(document.numPages, limits.maxPages)
    for (let start = 1; start <= renderPageCount; start += PDF_PAGE_BATCH_SIZE) {
      throwIfAborted(limits.signal)
      const end = Math.min(start + PDF_PAGE_BATCH_SIZE - 1, renderPageCount)
      const pages: AttachmentAsset[] = []
      for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
        throwIfAborted(limits.signal)
        const page = await withControl(
          document.getPage(pageNumber),
          limits.signal,
          operationTimeout(`Loading PDF page ${pageNumber}`),
          `Loading PDF page ${pageNumber}`,
        )
        const initial = page.getViewport({ scale: 1 })
        const scale = Math.min(
          PDF_RENDER_SCALE,
          PDF_MAX_DIMENSION / Math.max(initial.width, initial.height),
        )
        const viewport = page.getViewport({ scale })
        const entry = canvasFactory.create(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        )
        try {
          const renderTask = page.render({
            canvas: null,
            canvasContext: entry.context as unknown as CanvasRenderingContext2D,
            viewport,
          })
          try {
            await withControl(
              renderTask.promise,
              limits.signal,
              operationTimeout(`Rendering PDF page ${pageNumber}`),
              `Rendering PDF page ${pageNumber}`,
            )
          } catch (error) {
            // Cancel the worker task on timeout/abort so it cannot continue
            // consuming memory after this generator has failed.
            renderTask.cancel()
            void renderTask.promise.catch(() => undefined)
            throw error
          }
          const pageBytes = entry.canvas.toBuffer("image/png")
          if (pageBytes.byteLength > limits.maxPageImageBytes) {
            throw new RangeError(
              `Rendered PDF page ${pageNumber} exceeds the ${formatBytes(limits.maxPageImageBytes)} image size limit`,
            )
          }
          pages.push({
            bytes: pageBytes,
            dataUrl: `data:image/png;base64,${pageBytes.toString("base64")}`,
            mediaType: "image/png",
            filename: pdfPageFilename(filename, pageNumber),
          })
        } finally {
          canvasFactory.destroy(entry)
          page.cleanup()
        }
      }
      const truncated =
        end === renderPageCount && renderPageCount < document.numPages
      yield {
        pages,
        start,
        end,
        total: document.numPages,
        truncated,
        ...(truncated
          ? {
              truncationReason:
                `PDF page limit reached; rendered ${renderPageCount} of ${document.numPages} pages`,
            }
          : {}),
      }
    }
  } finally {
    await loading.destroy()
  }
}

interface NormalizedPdfRenderOptions {
  readonly maxBytes: number
  readonly maxPages: number
  readonly timeoutMs: number
  readonly pageTimeoutMs: number
  readonly maxPageImageBytes: number
  readonly signal?: AbortSignal
}

function normalizeOptions(options: PdfRenderOptions): NormalizedPdfRenderOptions {
  return {
    maxBytes: positiveLimit(options.maxBytes, PDF_MAX_BYTES, "maxBytes"),
    maxPages: positiveLimit(options.maxPages, PDF_MAX_PAGES, "maxPages"),
    timeoutMs: positiveLimit(
      options.timeoutMs,
      PDF_RENDER_TIMEOUT_MS,
      "timeoutMs",
    ),
    pageTimeoutMs: positiveLimit(
      options.pageTimeoutMs,
      PDF_PAGE_RENDER_TIMEOUT_MS,
      "pageTimeoutMs",
    ),
    maxPageImageBytes: positiveLimit(
      options.maxPageImageBytes,
      PDF_MAX_PAGE_IMAGE_BYTES,
      "maxPageImageBytes",
    ),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return value
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const error = new Error("PDF rendering was aborted")
  error.name = "AbortError"
  throw error
}

function withControl<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      finish("reject", new Error(`${operation} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const onAbort = () => {
      const error = new Error("PDF rendering was aborted")
      error.name = "AbortError"
      finish("reject", error)
    }
    const finish = (kind: "resolve" | "reject", value: T | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (kind === "resolve") resolve(value as T)
      else reject(value)
    }

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => finish("resolve", value),
      (error: unknown) =>
        finish(
          "reject",
          error instanceof Error ? error : new Error(String(error)),
        ),
    )
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${bytes} bytes`
  return `${Math.round(bytes / (1024 * 1024))} MiB`
}

function pdfPageFilename(filename: string, pageNumber: number): string {
  const stem = filename.toLowerCase().endsWith(".pdf")
    ? filename.slice(0, -4)
    : filename
  return `${stem}-page-${pageNumber}.png`
}
