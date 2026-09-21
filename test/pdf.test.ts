import assert from "node:assert/strict"
import test from "node:test"

import { PDFDocument } from "@napi-rs/canvas"

import { renderPdfPageBatches } from "../src/pdf.js"

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
