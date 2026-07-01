# 系统性 Code Review Checklist

更新时间：2026-07-01

本文档用于正规化阶段的模块评审。每次评审应记录范围、结论、P0/P1/P2 问题、对应测试用例编号，以及暂缓理由。

## 1. 通用检查

- API 契约：响应结构、错误码、HTTP 状态是否稳定；前端是否区分空数据、失败、未授权和 mock fallback。
- 鉴权边界：admin/mobile token 是否分离；设备角色和书籍 visibility 是否在所有入口一致生效。
- 数据一致性：新增、编辑、删除、合并、拆分、恢复、发布是否会留下孤儿数据或旧索引。
- 失败恢复：批处理、模型调用、下载、发布、导入是否可重试、可续跑、可定位失败项。
- 可观测性：关键操作是否有状态、日志、metrics/events 或 verify report。
- 性能与容量：大书、大 package、大 MP3、长任务是否避免一次性读入过多数据。
- 测试映射：P0/P1 修复必须对应 `docs/test-case-matrix.md` 中的用例编号或新增用例。

## 2. PC Web 与本地 API

- 导入：TXT/EPUB 编码、章节顺序、异常标题、超长章节是否有回归。
- 阅读：多书进度、章节滚动、阅读偏好是否按 bookId/chapterId 隔离。
- 数据库：导出、恢复、非法 SQLite、恢复前备份是否覆盖失败路径。
- AI/RAG：模型配置错误、embedding 覆盖率不足、答案生成失败时是否保留可用检索结果。

## 3. 知识图谱

- 图谱写入：raw extraction、实体、关系、mentions 是否在事务内一致提交。
- 高风险操作：合并、拆分、删除、端点切换是否清理孤儿引用。
- 重扫：预览阶段不得写入，确认后才替换。
- 共指：LLM 结果必须经过结构校验，不能把未确认实体合并。
- 导出：JSON/GraphML 应可解析并包含 evidence。

## 4. Production Pipeline

- stage：每个 stage 必须可独立运行、可观测、可失败续跑。
- job/doctor：缺少 source、model、publish、verify 配置时应提前报错。
- publish：合并 `books.json` 时不得覆盖其他书；package/audio 应保留可回滚 artifact。
- verify：真实 Gateway 校验要覆盖 Admin catalog、mobile session 可见性、package、audio manifest/download、Admin audio refresh。
- 日志：run.json、child run、verify report 应足够定位失败 stage、失败 item 和远端状态。

## 5. Gateway API

- 生产 token：生产环境必须显式配置 admin/mobile token，dev fallback 不能生效。
- 书库可见性：default/trusted/hidden/disabled 在 `/mobile/books`、package、audio、RAG 路由一致。
- 下载：package、MP3、APK 下载路径不能穿越，content-type 应稳定。
- 管理操作：删除、刷新、清理、重新导入必须同步 catalog、package、audio summary。
- 指标事件：401/403/404/5xx、package/audio 下载应进入 metrics/events，便于真实排查。

## 6. Admin UI

- 数据来源：未授权或部分接口失败时不得混入 mock 数据。
- 操作状态：保存中、成功、失败回滚、重试入口必须可见。
- 书籍/设备/音频/package：UI 状态必须与 Gateway API 语义一致。
- 请求日志：应能按路由、状态、设备、错误类别定位问题。

## 7. Gateway Android App

- 连接：token 错误、设备禁用、受信角色变化应有中文提示。
- 本地缓存：阅读进度、package、MP3 目录、同步进度必须按 bookId 隔离。
- 音频：原生下载、离线播放、批量停止和当前章播放状态应与缓存一致。
- 更新：只有线上 `versionCode` 严格高于本机才显示安装入口。
- 真机边界：系统 APK 安装确认、原生私有目录和离线播放必须保留真实设备验收记录。

## 8. Review 产出格式

```text
范围：
结论：
已运行验证：
P0：
P1：
P2：
测试矩阵更新：
暂缓项：
```
