# 移动端人物画像 MVP

## 目标

移动端在离线阅读时提供“人物画像”入口，让读者可以快速看到主要人物的视觉印象、别名、简介、首次证据和相关人物。第一版优先提升阅读直观感，不在手机端执行图片生成。

## 数据来源

- 人物列表来自移动端已同步的单书数据包 `knowledgeGraph.entities`，筛选 `type === 'character'`。
- 出现次数来自 `knowledgeGraph.entityMentions`。
- 关系数量和相关人物来自 `knowledgeGraph.relations`。
- 首次证据优先使用最早的 `entityMentions.evidence`，没有证据时退回首次出现章节。

## 图片策略

第一版使用随移动端资源打包的静态画像：

- `mobile-app/public/portraits/yaodao/geng-zhao.png`
- `mobile-app/public/portraits/yaodao/ming-zhanxue.png`
- `mobile-app/public/portraits/yaodao/heng-shuying.png`
- `mobile-app/public/portraits/yaodao/ran-hongxia.png`
- `mobile-app/public/portraits/yaodao/huang-ying.png`

匹配规则集中在 `mobile-app/src/lib/characterPortraits.ts`，按实体名称和别名命中。未命中画像的人物显示稳定的文字占位卡，保证任意书籍都有可用体验。

## 同步数据契约

移动端单书数据包支持可选字段 `portraits.characters`，PC 端同步服务会把画像清单随 `/api/mobile/books/:bookId/package` 返回。移动端读取顺序是：

1. 优先使用单书包 `portraits.characters`。
2. 其次使用移动端内置 demo 清单。
3. 仍未命中时使用文字占位画像。

单个人物画像字段：

```ts
type MobileCharacterPortrait = {
  entityId?: string | null
  names: string[]
  url: string
  tone?: string | null
  source?: 'demo' | 'generated' | 'manual' | 'synced' | string
  prompt?: string | null
  updatedAt?: string | null
}
```

`entityId` 命中优先级最高；没有 `entityId` 时只用 `names[0]` 这个规范名匹配知识图谱实体名或标准名。`names` 里的其他别名不会触发画像命中，避免知识图谱把别名拆成独立实体后复用别人的画像。`tone` 当前支持 `jade`、`teal`、`crimson`、`ochre`、`ember`，用于无图占位或卡片背景色。

当前 demo 清单另有静态索引 `mobile-app/public/portraits/catalog.json`，方便后续从 PC 端画像管理页或构建脚本统一读取。

## 移动端交互

- 底部导航新增“人物”。
- 阅读页章节工具栏新增“人物”快捷入口。
- 人物页顶部显示当前选中人物的大图和简介。
- 下方人物网格按画像优先、出现次数和关系数量排序。
- 搜索框支持按人物名、别名、描述和证据检索。
- “跳到首次证据”会打开该人物最早证据所在章节。

## 后续扩展

- PC 端生成或管理人物画像，并随移动数据包同步图片清单。
- 为 PC 端实体增加画像生成 prompt、人工确认状态、更新时间和多版本记录。
- 在阅读页正文中对当前章高频人物提供轻量浮层入口。
- 支持多版本画像和人工确认，避免模型生成结果直接覆盖。
