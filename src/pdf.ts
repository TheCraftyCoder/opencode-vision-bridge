import type { Canvas, SKRSContext2D } from "@napi-rs/canvas"

import type { AttachmentAsset } from "./image.js"

export const PDF_PAGE_BATCH_SIZE = 8
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
}

export async function* renderPdfPageBatches(
  bytes: Uint8Array,
  filename = "document.pdf",
): AsyncGenerator<PdfPageBatch> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const loading = getDocument({ data: new Uint8Array(bytes), verbosity: 0 })
  const document = await loading.promise
  const canvasFactory = (
    document as unknown as { readonly canvasFactory: CanvasFactory }
  ).canvasFactory

  try {
    for (let start = 1; start <= document.numPages; start += PDF_PAGE_BATCH_SIZE) {
      const end = Math.min(start + PDF_PAGE_BATCH_SIZE - 1, document.numPages)
      const pages: AttachmentAsset[] = []
      for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
        const page = await document.getPage(pageNumber)
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
          await page.render({
            canvas: null,
            canvasContext: entry.context as unknown as CanvasRenderingContext2D,
            viewport,
          }).promise
          const pageBytes = entry.canvas.toBuffer("image/png")
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
      yield { pages, start, end, total: document.numPages }
    }
  } finally {
    await loading.destroy()
  }
}

function pdfPageFilename(filename: string, pageNumber: number): string {
  const stem = filename.toLowerCase().endsWith(".pdf")
    ? filename.slice(0, -4)
    : filename
  return `${stem}-page-${pageNumber}.png`
}
