import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { createPdfDocumentOptions } from '../src/pdf-text.mjs'

describe('PDF.js document options', () => {
  it('provides the bundled CMaps required by legacy Chinese PDFs', async () => {
    const options = createPdfDocumentOptions(Buffer.from('pdf'))

    assert.equal(options.cMapPacked, true)
    assert.ok(options.cMapUrl.endsWith('/cmaps/'))
    assert.ok(options.standardFontDataUrl.endsWith('/standard_fonts/'))
    await access(join(options.cMapUrl, 'GBK-EUC-H.bcmap'))
  })
})
