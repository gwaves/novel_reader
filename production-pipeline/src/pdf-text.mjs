export async function extractPdfDocument(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true })

  try {
    const document = await loadingTask.promise
    const pages = []

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      pages.push(renderPdfTextItems(content.items))
      page.cleanup()
    }

    const text = pages.filter(Boolean).join('\n\n').trim()
    if (!text) {
      throw new Error('PDF 中没有可提取的文字；如果这是扫描件，请先进行 OCR 后再导入。')
    }
    const metadata = await document.getMetadata().catch(() => null)
    const outline = await document.getOutline().catch(() => null)
    const sections = await buildOutlineSections(document, outline, pages)
    const metadataTitle = String(metadata?.info?.Title || '').trim()
    return { text, title: metadataTitle || undefined, sections }
  } finally {
    await loadingTask.destroy()
  }
}

async function buildOutlineSections(document, outline, pages) {
  const flattened = flattenOutline(outline || [])
  const starts = (await Promise.all(flattened.map(async (item) => {
    const destination = typeof item.dest === 'string' ? await document.getDestination(item.dest) : item.dest
    if (!Array.isArray(destination) || !destination[0]) return null
    const pageIndex = await document.getPageIndex(destination[0]).catch(() => -1)
    return pageIndex >= 0 ? { title: item.title.trim(), pageIndex } : null
  }))).filter((item) => item?.title)

  if (starts.length < 2) return []
  starts.sort((a, b) => a.pageIndex - b.pageIndex)
  return starts.map((start, index) => {
    const endPage = starts[index + 1]?.pageIndex ?? pages.length
    const content = pages.slice(start.pageIndex, Math.max(start.pageIndex + 1, endPage)).join('\n\n').trim()
    return { title: start.title, content: stripRepeatedTitle(content, start.title) }
  }).filter((section) => section.content.replace(/\s+/g, '').length >= 20)
}

function flattenOutline(items) {
  return items.flatMap((item) => [item, ...flattenOutline(item.items || [])])
}

function stripRepeatedTitle(content, title) {
  const lines = content.split('\n')
  const normalizedTitle = title.replace(/\s+/g, '')
  const matchIndex = lines.slice(0, 6).findIndex((line) => line.replace(/\s+/g, '').includes(normalizedTitle))
  if (matchIndex >= 0) lines.splice(matchIndex, 1)
  return lines.join('\n').trim()
}

function renderPdfTextItems(items) {
  const lines = []
  let currentLine = ''
  let previousY = null

  const flushLine = () => {
    const line = currentLine.trim()
    if (line) lines.push(line)
    currentLine = ''
  }

  for (const item of items) {
    if (!('str' in item) || !item.str) continue
    const y = item.transform?.[5]
    if (previousY !== null && typeof y === 'number' && Math.abs(y - previousY) > 2) flushLine()
    currentLine += item.str
    if (item.hasEOL) flushLine()
    if (typeof y === 'number') previousY = y
  }
  flushLine()

  return lines.join('\n')
}
