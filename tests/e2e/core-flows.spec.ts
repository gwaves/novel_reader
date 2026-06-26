import { expect, test, type Page } from '@playwright/test'

const sampleNovel = `
第一章 初入江湖
少年林青第一次离开山村，遇见了神秘的白衣客。

第二章 雨夜传书
白衣客留下密信，林青决定前往青州。

第三章 青州旧友
林青在城中遇见旧友阿梨，二人发现密信另有玄机。
`

async function mockLocalServices(page: Page) {
  await page.route('**/api/state?source=structured&content=metadata', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ state: null }),
    })
  })

  await page.route('**/api/state', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/rag/embeddings/status**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        embeddedChapters: 0,
        totalChapters: 3,
        missingChapters: 3,
        summarizedChapters: 0,
        embeddedChunks: 0,
        totalChunks: 3,
        missingChunks: 3,
        dimension: null,
      }),
    })
  })

  await page.route('**/api/rag/search', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          {
            chapterId: '1-第一章 初入江湖',
            chapterIndex: 1,
            chapterTitle: '第一章 初入江湖',
            summary: {
              short: '林青离村遇见白衣客。',
              detail: '少年林青第一次离开山村，遇见神秘的白衣客。',
            },
            score: 0.87,
            contentSnippet: '少年林青第一次离开山村',
            matchedEntities: ['林青'],
            matchType: 'chunk',
          },
        ],
        entityMatches: [],
      }),
    })
  })

  await page.route('http://localhost:11434/**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ models: [] }),
    })
  })
}

test.beforeEach(async ({ page }) => {
  await mockLocalServices(page)
})

test('imports a TXT novel and opens the reader flow', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: '导入第一本小说，按步骤启用 AI' })).toBeVisible()

  await page.locator('input[type="file"][accept*=".txt"]').setInputFiles({
    name: 'agent-smoke-novel.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(sampleNovel),
  })

  await expect(page.getByRole('heading', { name: '第一章 初入江湖' })).toBeVisible()
  const chapterList = page.getByRole('complementary', { name: '章节目录' })
  await expect(chapterList).toContainText('agent-smoke-novel')
  await expect(chapterList.getByRole('button', { name: /第二章 雨夜传书/ })).toBeVisible()

  await page.locator('.chapter-heading').getByRole('button', { name: '下一章', exact: true }).click()
  await expect(page.getByRole('heading', { name: '第二章 雨夜传书' })).toBeVisible()

  await page.getByLabel('搜索章节').fill('青州')
  await expect(page.getByText('找到 1 章')).toBeVisible()
  await chapterList.getByRole('button', { name: /第三章 青州旧友/ }).click()
  await expect(page.getByRole('heading', { name: '第三章 青州旧友' })).toBeVisible()
})

test('opens smart search and renders mocked RAG results', async ({ page }) => {
  await page.goto('/')
  await page.locator('input[type="file"][accept*=".txt"]').setInputFiles({
    name: 'agent-smoke-novel.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(sampleNovel),
  })

  await page.getByRole('button', { name: '智能搜索' }).click()

  await expect(page.getByRole('heading', { name: 'agent-smoke-novel' })).toBeVisible()
  await expect(page.getByText('Embedding 覆盖：0/3 章')).toBeVisible()

  await page.getByPlaceholder('例如：某某功法第一次出现在哪里').fill('林青在哪里遇见白衣客')
  await page.getByRole('button', { name: '搜索', exact: true }).click()

  await expect(page.getByText('第一章 初入江湖')).toBeVisible()
  await expect(page.getByText('少年林青第一次离开山村，遇见神秘的白衣客。')).toBeVisible()
})
