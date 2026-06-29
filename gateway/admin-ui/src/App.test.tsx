import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, vi } from 'vitest'
import App from './App'

afterEach(() => {
  vi.restoreAllMocks()
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
      return jsonResponse({}, false, 404)
    })

    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByText(/已连接 Gateway 管理 API/)).toBeInTheDocument()
    expect(screen.getByText('实时')).toBeInTheDocument()

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
})

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response
}
