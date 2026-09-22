import assert from "node:assert/strict"
import { access } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import { createCanvas, loadImage, PDFDocument } from "@napi-rs/canvas"

import {
  getPdfJsResourceOptions,
  renderPdfPageBatches,
} from "../src/pdf.js"

function createPdf(pageCount: number): Buffer {
  const document = new PDFDocument()
  for (let page = 1; page <= pageCount; page += 1) {
    const context = document.beginPage(300, 180)
    context.fillStyle = "black"
    context.font = "18px sans-serif"
    context.fillText(`Rendered page ${page}`, 20, 50)
    document.endPage()
  }
  return document.close()
}

function createUnembeddedHelveticaPdf(text: string): Buffer {
  const content = `BT /F1 24 Tf 40 100 Td (${text}) Tj ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 180] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let body = "%PDF-1.4\n"
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body)
}

test("PDF renderer produces PNG pages in provider-safe batches", async () => {
  const batches = []
  for await (const batch of renderPdfPageBatches(
    createPdf(9),
    "report.pdf",
  )) {
    batches.push(batch)
  }

  assert.equal(batches.length, 2)
  assert.deepEqual(
    batches.map((batch) => [batch.start, batch.end, batch.total]),
    [
      [1, 8, 9],
      [9, 9, 9],
    ],
  )
  assert.equal(batches[0]?.pages.length, 8)
  assert.equal(batches[1]?.pages.length, 1)
  const first = batches[0]?.pages[0]
  assert.equal(first?.mediaType, "image/png")
  assert.equal(first?.filename, "report-page-1.png")
  assert.deepEqual(first?.bytes.subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"))
})

test("PDF renderer rejects invalid PDF bytes", async () => {
  await assert.rejects(async () => {
    for await (const _batch of renderPdfPageBatches(
      Buffer.from("not a pdf"),
      "broken.pdf",
    )) {
      // The generator should fail before yielding.
    }
  })
})

test("PDF renderer reports a page-limit truncation in batch metadata", async () => {
  const batches = []
  for await (const batch of renderPdfPageBatches(createPdf(4), "report.pdf", {
    maxPages: 2,
  })) {
    batches.push(batch)
  }

  assert.equal(batches.length, 1)
  assert.equal(batches[0]?.pages.length, 2)
  assert.equal(batches[0]?.total, 4)
  assert.equal(batches[0]?.truncated, true)
  assert.match(batches[0]?.truncationReason ?? "", /rendered 2 of 4 pages/)
})

test("PDF renderer enforces the input byte limit before parsing", async () => {
  await assert.rejects(
    async () => {
      for await (const _batch of renderPdfPageBatches(createPdf(1), "report.pdf", {
        maxBytes: 1,
      })) {
        // The renderer should reject before yielding.
      }
    },
    /input size limit/,
  )
})

test("PDF renderer honors an already-aborted signal", async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    async () => {
      for await (const _batch of renderPdfPageBatches(
        createPdf(1),
        "report.pdf",
        { signal: controller.signal },
      )) {
        // The renderer should reject before loading the PDF.
      }
    },
    (error: unknown) =>
      error instanceof Error && error.name === "AbortError",
  )
})

test("PDF renderer resolves readable bundled pdf.js resource paths", async () => {
  const options = getPdfJsResourceOptions()
  assert.match(options.cMapUrl, /pdfjs-dist[\\/]cmaps[\\/]$/)
  assert.match(options.standardFontDataUrl, /pdfjs-dist[\\/]standard_fonts[\\/]$/)
  assert.match(options.wasmUrl, /pdfjs-dist[\\/]wasm[\\/]$/)
  assert.doesNotMatch(options.cMapUrl, /^file:/)
  await Promise.all([
    access(path.join(options.cMapUrl, "78-H.bcmap")),
    access(path.join(options.standardFontDataUrl, "FoxitFixed.pfb")),
    access(path.join(options.wasmUrl, "jbig2.wasm")),
  ])
  assert.equal(options.useWorkerFetch, false)
  assert.equal(options.stopAtErrors, true)
})

test("PDF renderer paints text from an unembedded standard font", async () => {
  let png: Buffer | undefined
  for await (const batch of renderPdfPageBatches(
    createUnembeddedHelveticaPdf("STANDARD FONT"),
    "standard-font.pdf",
  )) {
    png = batch.pages[0]?.bytes
  }
  assert.ok(png)

  const image = await loadImage(png)
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext("2d")
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, image.width, image.height).data
  let darkPixels = 0
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index]! + pixels[index + 1]! + pixels[index + 2]! < 700) {
      darkPixels += 1
    }
  }
  assert.ok(darkPixels > 100, `expected rendered glyphs, found ${darkPixels} dark pixels`)
})
