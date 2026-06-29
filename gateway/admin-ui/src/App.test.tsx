import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'

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
