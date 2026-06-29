import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, vi } from 'vitest'
import App from './App'
import { adminTokenStorageKey } from './api'

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('Gateway 管理后台 UI', () => {
  it('展示总览指标、内容健康和最近事件', () => {
    render(<App />)

    expect(screen.getByText('Novel Reader Gateway')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '总览' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('今日请求')).toBeInTheDocument()
    expect(screen.getByText('错误率')).toBeInTheDocument()
    expect(screen.getByText('内容健康')).toBeInTheDocument()
    expect(screen.getByText('最近事件')).toBeInTheDocument()
    expect(screen.getByText('导入《烬鳞纪》数据包成功')).toBeInTheDocument()
  })

  it('从 Gateway 管理 API 加载书籍和设备数据', async () => {
    vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/admin/books') {
        return jsonResponse({
          books: [
            {
              id: 'api-book',
              title: '接口书籍',
              author: '接口作者',
              chapterCount: 10,
              updatedAt: '2026-06-29T12:00:00.000Z',
              visibility: 'trusted',
              labels: ['private'],
              summaryCoverage: 0.8,
              kgCoverage: 0.7,
              embeddingCoverage: 0.6,
              audioChapterCount: 5,
            },
          ],
        })
      }
      if (url === '/admin/devices') {
        return jsonResponse({
          devices: [
            {
              id: 'api-device',
              name: '接口平板',
              model: 'Android Tablet',
              platform: 'android',
              appVersion: '0.1.0',
              pairingCode: '112233',
              role: 'trusted',
              firstSeenAt: '2026-06-29T10:00:00.000Z',
              lastSeenAt: '2026-06-29T12:00:00.000Z',
              lastIp: '192.168.88.66',
            },
          ],
        })
      }
      if (url === '/admin/metrics') {
        return jsonResponse({
          requests: {
            last15Minutes: 7,
            last24Hours: 42,
            errorRate: 0.125,
            p95Ms: 321,
          },
          downloads: {
            packageLast24Hours: 2,
            audioLast24Hours: 9,
          },
        })
      }
      if (url === '/admin/events') {
        return jsonResponse({
          events: [
            {
              time: '2026-06-29T12:34:00.000Z',
              level: 'warn',
              text: '接口事件',
            },
          ],
        })
      }
      return jsonResponse({}, false, 404)
    })

    const user = userEvent.setup()
    render(<App />)

    expect((await screen.findAllByText(/已连接 Gateway 管理 API/)).length).toBeGreaterThan(0)
    expect(screen.getByText('实时')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('12.5%')).toBeInTheDocument()
    expect(screen.getByText('接口事件')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '书籍' }))
    expect(screen.getByRole('row', { name: /接口书籍 接口作者 trusted/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '设备' }))
    expect(screen.getByRole('row', { name: /接口平板 112233 受信 192\.168\.88\.66/ })).toBeInTheDocument()
  })

  it('书籍列表展示可见范围和标签，并在详情抽屉同步编辑状态', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: '书籍' }))

    const row = screen.getByRole('row', { name: /烬鳞纪 青岚 trusted .*186/ })
    expect(within(row).getByText('trusted')).toBeInTheDocument()
    expect(within(row).getByText('少儿不宜')).toBeInTheDocument()
    expect(within(row).getByText('私有')).toBeInTheDocument()

    await user.click(row)
    expect(screen.getByRole('heading', { name: '烬鳞纪' })).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('可见范围'), 'hidden')
    expect(within(row).getByText('hidden')).toBeInTheDocument()

    await user.click(screen.getByLabelText('测试'))
    expect(screen.getByText('当前标签：少儿不宜、私有、测试')).toBeInTheDocument()
    expect(within(row).getByText('测试')).toBeInTheDocument()
  })

  it('设备列表展示 pairing code 和角色，并在详情抽屉同步角色选择', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: '设备' }))

    const row = screen.getByRole('row', { name: /客厅小米平板 428193 普通 192\.168\.88\.23 2分钟前/ })
    expect(within(row).getByText('428193')).toBeInTheDocument()
    expect(within(row).getByText('普通')).toBeInTheDocument()

    await user.click(row)
    expect(screen.getByRole('heading', { name: '客厅小米平板' })).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('设备角色'), 'trusted')
    expect(screen.getByText('当前角色：受信')).toBeInTheDocument()
    expect(within(row).getByText('受信')).toBeInTheDocument()
  })

  it('在设置页保存管理员 Token，并用它刷新后台数据', async () => {
    const authHeaders: string[] = []
    vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      const authorization = init?.headers instanceof Headers ? init.headers.get('authorization') ?? '' : ''
      authHeaders.push(`${url}:${authorization}`)
      if (authorization !== 'Bearer saved-token') {
        return jsonResponse({ error: 'unauthorized' }, false, 401)
      }
      if (url === '/admin/books') {
        return jsonResponse({
          books: [
            {
              id: 'token-book',
              title: 'Token 书籍',
              author: '后台',
              chapterCount: 3,
              updatedAt: '2026-06-29T12:00:00.000Z',
              visibility: 'admin',
              labels: ['private'],
              summaryCoverage: 1,
              kgCoverage: 1,
              embeddingCoverage: 1,
              audioChapterCount: 3,
            },
          ],
        })
      }
      if (url === '/admin/devices') return jsonResponse({ devices: [] })
      if (url === '/admin/metrics') {
        return jsonResponse({
          requests: { last15Minutes: 1, last24Hours: 9, errorRate: 0, p95Ms: 45 },
          downloads: { packageLast24Hours: 1, audioLast24Hours: 2 },
        })
      }
      if (url === '/admin/events') return jsonResponse({ events: [] })
      return jsonResponse({}, false, 404)
    })

    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByText(/API 不可用，正在显示 mock 数据/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.type(screen.getByLabelText('管理员 Token'), 'saved-token')
    await user.click(screen.getByRole('button', { name: '保存 Token' }))

    expect(window.localStorage.getItem(adminTokenStorageKey)).toBe('saved-token')

    await user.click(screen.getByRole('button', { name: '刷新后台数据' }))

    expect((await screen.findAllByText(/已连接 Gateway 管理 API/)).length).toBeGreaterThan(0)
    expect(screen.getByText('Gateway 管理 API')).toBeInTheDocument()
    expect(authHeaders).toContain('/admin/books:Bearer saved-token')

    await user.click(screen.getByRole('button', { name: '书籍' }))
    expect(screen.getByRole('row', { name: /Token 书籍 后台 admin/ })).toBeInTheDocument()
  })
})

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response
}
