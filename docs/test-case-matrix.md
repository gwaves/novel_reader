# 测试用例矩阵

更新时间：2026-07-01

本文档是正规化测试阶段的第一版测试设计。它以 [产品功能说明书](product-spec.md) 为功能基线，用于指导后续自动化测试补齐、系统性 Code Review、运维验证和发布回归。

## 1. 口径说明

### 1.1 测试层级

| 层级 | 说明 |
|------|------|
| Unit | 纯函数、数据转换、状态迁移、解析器、helper |
| API | 本地 API、Gateway API、production-pipeline CLI/API 契约 |
| UI | 浏览器组件或页面行为，优先使用 Vitest/Testing Library |
| E2E | Playwright 浏览器端主流程 |
| Android | Gateway Android App 逻辑测试、模拟器或真机验证 |
| Ops | 真实 Gateway、真实文件系统、发布、部署、日志、指标验证 |
| Manual | 暂时只能人工验证或需要真实模型/真机/外部服务 |

### 1.2 风险等级

| 等级 | 定义 |
|------|------|
| P0 | 数据破坏、安全越权、发布错误、无法恢复的主流程故障 |
| P1 | 用户主流程不可用、重要数据不一致、误导性运维状态 |
| P2 | 局部体验、性能、兼容性或可维护性问题 |

### 1.3 覆盖状态

| 状态 | 说明 |
|------|------|
| Existing | 已有自动化覆盖，后续需确认是否足够 |
| Partial | 有部分覆盖，但缺关键断言或失败路径 |
| Planned | 需要新增自动化测试 |
| Manual | 需要手工/真机/真实 Gateway 验证 |
| Ops Gap | 需要先补运维/观测能力，再形成可验证用例 |

## 2. 当前自动化基线

现有 [testing.md](testing.md) 记录的基线：

- `npm run test:unit`：覆盖章节拆分、状态迁移、配置清洗、字数统计、标题推断等确定性逻辑。
- `npm run test:e2e`：覆盖首次启动、TXT 导入、阅读导航、章节搜索、智能搜索页和 mocked RAG 渲染。
- `npm run test:smoke`：串联 unit 与 E2E，是第一批 CI 候选。
- `gateway/`、`gateway/admin-ui/`、`gateway-android-app/`、`production-pipeline/` 已有各自测试入口，但需要按本矩阵重新标注缺口。

## 3. PC 本地阅读器

| ID | 用例 | 前置条件 | 期望结果 | 层级 | 风险 | 状态 |
|----|------|----------|----------|------|------|------|
| PC-IMPORT-001 | TXT 导入 UTF-8 正常章节 | 干净本地库，选择规则中文章节标题 TXT | 生成书籍、章节、字数，自动进入阅读器 | Unit + E2E | P1 | Existing |
| PC-IMPORT-002 | TXT 导入 GB18030 自动识别 | 准备 GB18030 样例 | 不需要人工选择编码，章节正文无乱码 | Unit + E2E | P1 | Existing |
| PC-IMPORT-003 | TXT 异常标题/正文第一回拆章 | 样例含 `正文 第一回` 等边界标题 | 保持历史拆章行为，不误拆正文 | Unit | P1 | Existing |
| PC-IMPORT-004 | EPUB spine 顺序导入 | 准备多 XHTML spine EPUB | 章节顺序与 OPF spine 一致，正文可读 | Unit + E2E | P1 | Existing |
| PC-IMPORT-005 | 超长章节导入与展示 | 单章超长文本 | 导入不阻塞，阅读器可展示和滚动 | E2E | P2 | Existing |
| PC-READ-001 | 多书阅读进度隔离 | 两本书分别阅读到不同章节/位置 | 切书、重启后各自恢复，不互相覆盖 | Unit + E2E | P0 | Existing |
| PC-READ-002 | 阅读偏好保存 | 修改主题、字号、行高、宽度等 | 刷新后偏好仍生效 | Unit + E2E | P2 | Existing |
| PC-READ-003 | 章节切换回到顶部 | 阅读到章节中部后切下一章 | 新章节从顶部开始，不继承旧滚动位置 | E2E | P2 | Existing |
| PC-DATA-001 | 数据库备份导出 | 已有书籍、概要、图谱、embedding | 导出的 SQLite 包含完整数据 | API + E2E | P0 | Existing |
| PC-DATA-002 | 数据库恢复前自动备份 | 上传 SQLite 备份 | 当前库先备份，重启后恢复目标库 | API + Manual | P0 | Existing |
| PC-DATA-003 | 恢复非法 SQLite | 上传非 SQLite 文件 | 拒绝恢复，当前数据库不变 | API | P0 | Existing |

## 4. AI 概要与模型配置

| ID | 用例 | 前置条件 | 期望结果 | 层级 | 风险 | 状态 |
|----|------|----------|----------|------|------|------|
| AI-CONFIG-001 | 本地 Ollama 配置校验 | 配置可访问 Ollama | 保存成功并显示可用状态 | API + UI | P1 | Existing |
| AI-CONFIG-002 | OpenAI-compatible 配置校验 | 配置 baseUrl/apiKey/model | 生成模型与 embedding 模型分别校验 | API + UI | P1 | Existing |
| AI-CONFIG-003 | 模型配置错误提示 | 错误 URL、错误 token、维度不匹配 | 明确提示失败原因，不保存不可用配置 | API + UI | P1 | Existing |
| AI-SUMMARY-001 | 单章概要生成 | 已配置 mocked LLM | 当前章生成概要并写入数据库 | Unit + E2E | P1 | Existing |
| AI-SUMMARY-002 | 当前页概要生成 | 当前分页 100 章范围 | 生成页级概要，失败项可见 | Unit + E2E | P2 | Existing |
| AI-SUMMARY-003 | 全书缺失概要批量生成 | 书籍存在大量缺失概要 | 超过阈值有确认，已生成章节不重复生成 | Unit + E2E | P1 | Existing |
| AI-SUMMARY-004 | 批量概要单章失败 | mocked LLM 对部分章节失败 | 整批不中断，报告成功/失败数量 | API + UI | P1 | Existing |
| AI-SUMMARY-005 | 覆盖策略 | 章节已有概要 | 默认不覆盖，显式覆盖时才替换 | Unit | P1 | Existing |

## 5. 知识图谱

| ID | 用例 | 前置条件 | 期望结果 | 层级 | 风险 | 状态 |
|----|------|----------|----------|------|------|------|
| KG-SCAN-001 | 扫描当前章节 | mocked LLM 返回实体/关系 JSON | 保存 raw extraction、实体、关系和证据 | API + UI | P1 | Partial |
| KG-SCAN-002 | 范围扫描跳过已完成章节 | 部分章节已有扫描结果 | 默认跳过已完成章节，只处理缺失章节 | API | P1 | Planned |
| KG-SCAN-003 | 全书扫描任务刷新恢复 | 扫描任务 pending 时刷新页面 | 自动恢复任务状态，不重复处理已完成章节 | API + UI | P1 | Partial |
| KG-SCAN-004 | 停止扫描 | 长任务运行中点击停止 | 当前 worker 收尾后任务变为 cancelled | UI | P1 | Partial |
| KG-SCAN-005 | 覆盖重扫预览 | 已有图谱，触发重扫预览 | 展示新增/更新/删除 diff，确认后才写入 | API | P0 | Existing |
| KG-SCAN-006 | saved JSON 重放 | 已有 raw extraction | 不调用模型即可重建局部图谱 | API | P1 | Existing |
| KG-ENTITY-001 | 实体编辑 | 选择实体修改名称/类型/别名/描述 | 实体更新，相关搜索和详情同步 | API + UI | P1 | Partial |
| KG-ENTITY-002 | 实体合并 | 选择多个实体合并到主实体 | 别名、提及、关系迁移，无孤儿数据 | API | P0 | Existing |
| KG-ENTITY-003 | 实体拆分 | 从源实体拆出别名/章节/关系 | 新旧实体 first/last seen、关系证据正确 | API | P0 | Existing |
| KG-ENTITY-004 | 实体删除 | 删除实体 | 相关提及/关系清理，不残留坏引用 | API | P0 | Existing |
| KG-REL-001 | 关系编辑 | 修改关系类型/描述 | 关系详情和列表同步更新 | API + UI | P1 | Partial |
| KG-REL-002 | 切换关系端点 | 将 source/target 改到其他实体 | 禁止自环/跨书；冲突关系合并证据 | API | P0 | Existing |
| KG-REVIEW-001 | 低置信度复审队列 | 构造低置信度实体/关系 | 自动进入复审队列，可筛选 | API + UI | P1 | Partial |
| KG-REVIEW-002 | 批量标记/忽略/删除 | 复审队列多选 | 状态变更正确，高风险删除可追踪 | API | P0 | Existing |
| KG-COREF-001 | 全局共指候选 | 多个疑似同一人物实体 | 候选组件正确生成 | Unit + API | P1 | Existing |
| KG-COREF-002 | LLM 共指合并 | mocked LLM 返回合并判断 | 只合并同一身份实体，关系冲突可控 | API | P0 | Existing |
| KG-EXPORT-001 | JSON/GraphML 导出 | 书籍有图谱 | 导出包含实体、关系、证据，可被解析 | API + UI | P2 | Planned |

## 6. RAG 搜索

| ID | 用例 | 前置条件 | 期望结果 | 层级 | 风险 | 状态 |
|----|------|----------|----------|------|------|------|
| RAG-EMB-001 | embedding 覆盖率展示 | 书籍有概要和正文 chunk | 展示 summary/chunk 覆盖率 | API + UI | P1 | Partial |
| RAG-EMB-002 | 生成概要和正文 chunk embedding | mocked embedding 服务 | 写入 summary/chunk 向量，维度正确 | API | P1 | Existing |
| RAG-EMB-003 | 覆盖率不足阻断搜索 | 缺少 embedding | 明确提示先生成 embedding，不返回误导答案 | API + UI | P1 | Existing |
| RAG-SEARCH-001 | 跨章节检索 | 已生成 summary/chunk/KG | 返回章节、片段、实体增强结果 | API + E2E | P1 | Existing |
| RAG-SEARCH-002 | 图谱实体增强 | 查询命中实体别名 | 搜索结果包含相关章节和证据 | API | P1 | Existing |
| RAG-ANSWER-001 | 基于召回生成答案 | mocked LLM 和检索结果 | 答案基于检索上下文，展示来源 | Unit + E2E | P1 | Existing |
| RAG-ANSWER-002 | 生成答案失败 | LLM 失败/超时 | 保留检索结果，提示答案生成失败 | Unit + E2E | P1 | Existing |

## 7. production-pipeline

| ID | 用例 | 前置条件 | 期望结果 | 层级 | 风险 | 状态 |
|----|------|----------|----------|------|------|------|
| PIPE-JOB-001 | job JSON schema 校验 | 缺少 bookId/stages/model/publish 配置 | doctor 报告明确缺失项 | API | P1 | Existing |
| PIPE-IMPORT-001 | TXT/EPUB/MOBI/AZW 导入 | 准备样例源文件 | 导入主 SQLite 或 run store，章节/字数正确 | API | P1 | Planned |
| PIPE-STAGE-001 | summary 独立阶段 | job 只运行 summary | 可独立完成、可续跑、写入 run.json | API | P1 | Existing |
| PIPE-STAGE-002 | KG 独立阶段 | job 只运行 kg | 失败项可重试，进度可见 | API | P1 | Existing |
| PIPE-STAGE-003 | embedding 独立阶段 | Ollama mocked/测试服务 | 生成覆盖率元数据和向量计数 | API | P1 | Existing |
| PIPE-STAGE-004 | audio 独立阶段 | mocked director/TTS | 输出 MP3、manifest、audio.json | API | P1 | Existing |
| PIPE-RESUME-001 | 阶段失败后续跑 | 人为制造中断 | 已完成 item 不重复，失败 item 可重试 | API | P0 | Existing |
| PIPE-SCHED-001 | LLM scheduler 并发控制 | 配置 stage weights/borrowIdle | 总并发不爆，空闲可借用 | Unit + API | P1 | Existing |
| PIPE-PUBLISH-001 | rsync publish dry-run | 准备 package/audio artifacts | 输出正确 rsync 计划，不改远端 | API | P1 | Existing |
| PIPE-PUBLISH-002 | publish 合并 books.json | 远端已有其他书 | 新书写入，不覆盖其他书 | API + Ops | P0 | Existing |
| PIPE-VERIFY-001 | Gateway package verify | 发布后访问 Gateway API | 校验书籍、package、章节、覆盖率实际可见 | Ops | P0 | Existing |
| PIPE-VERIFY-002 | Gateway audio verify | 发布后访问 audio API | 抽样 MP3 可下载，duration/size 与 audio.json 一致 | API + Ops | P0 | Existing |

## 8. Gateway API

| ID | 用例 | 前置条件 | 期望结果 | 层级 | 风险 | 状态 |
|----|------|----------|----------|------|------|------|
| GW-AUTH-001 | admin/mobile token 分离 | 分别配置 admin/mobile token | admin token 不能访问 mobile，mobile token 不能访问 admin | API | P0 | Existing |
| GW-AUTH-002 | 生产环境无 token 拒绝启动 | NODE_ENV=production 缺 token | Gateway 拒绝启动 | API | P0 | Existing |
| GW-AUTH-003 | dev fallback 仅开发可用 | 开发环境缺专用 token | dev token fallback 可用；生产不可用 | API | P0 | Existing |
| GW-BOOK-001 | mobile 书库可见性 | default/trusted/hidden 书籍和不同设备角色 | 普通/受信/禁用设备看到正确书单 | API | P0 | Existing |
| GW-BOOK-002 | package 下载 | 已发布 package | 返回完整 package，book.id 与路径一致 | API | P1 | Existing |
| GW-BOOK-003 | 未知 bookId | 请求不存在书籍 | 返回稳定 `book_not_found` | API | P1 | Existing |
| GW-AUDIO-001 | audio catalog 读取 | 已发布 audio.json | 返回章节音频清单和 book-level summary | API | P1 | Existing |
| GW-AUDIO-002 | MP3 下载鉴权 | 请求受保护 MP3 | 无 token 拒绝，正确 token 下载 | API | P0 | Existing |
| GW-AUDIO-003 | 音频清理/刷新 | admin 调用清理/刷新 | 文件系统和 admin summary 同步更新 | API + Ops | P1 | Existing |
| GW-AI-001 | mobile RAG 路由鉴权 | 受信设备请求 `/ai/search`/`rag-answer` | 使用 mobile auth，按可见书库校验 bookId | API | P0 | Existing |
| GW-AI-002 | admin 上游代理鉴权 | 请求 `/ai/chat`/`embeddings` | 使用 admin auth，不暴露上游 key | API | P0 | Existing |
| GW-DOWNLOAD-001 | APK 下载 | `/downloads/ai_novel_reader.apk` 存在 | 公开可下载，content-type 正确 | API + Ops | P1 | Existing |
| GW-DOWNLOAD-002 | 下载路径穿越 | 请求 `%2e%2e/books.json` | 返回拒绝，不泄露文件 | API | P0 | Existing |
| GW-METRICS-001 | metrics 趋势桶 | 产生请求/下载事件 | `/admin/metrics` 返回真实 request/download buckets | API + Ops | P1 | Existing |
| GW-EVENTS-001 | events 空状态 | 最近无事件 | 返回空数组，Admin UI 不回退 mock | API + UI | P1 | Existing |

## 9. Gateway Admin UI

| ID | 用例 | 前置条件 | 期望结果 | 层级 | 风险 | 状态 |
|----|------|----------|----------|------|------|------|
| ADMIN-DASH-001 | 总览真实数据 | Gateway API 可用 | 内容健康、系统摘要、设备摘要来自真实 API | UI | P1 | Existing |
| ADMIN-DASH-002 | 最近事件空状态 | `/admin/events` 返回空数组 | 显示“暂无事件”，不显示 mock | UI | P1 | Existing |
| ADMIN-DASH-003 | 部分接口失败 | metrics 成功、books 失败等 | 明确展示部分失败，不整页误回退 mock | UI | P1 | Existing |
| ADMIN-AUTH-001 | 未授权状态 | admin token 缺失/错误 | 显示未授权，不吞错为 demo 数据 | UI | P0 | Existing |
| ADMIN-BOOK-001 | 书籍可见性修改 | admin 修改 visibility/labels | 保存中、成功、失败回滚、重试均可见 | UI + API | P1 | Partial |
| ADMIN-BOOK-002 | 删除书籍确认 | 删除按钮 | 必须确认；成功后 package/audio/列表同步 | UI + API | P0 | Existing |
| ADMIN-PKG-001 | 数据包覆盖率展示 | package 有 coverage 元数据 | summary/KG/embedding 覆盖率显示正确，未知显示 `-` | UI + API | P1 | Existing |
| ADMIN-PKG-002 | package 下载/重新导入 | admin 触发 package 操作 | 状态流转正确，失败可重试 | UI + API | P1 | Existing |
| ADMIN-AUDIO-001 | 音频覆盖与缺失章节 | audio.json 有部分章节 | 缺失章节、已缓存章节、ready 状态正确 | UI + API | P1 | Existing |
| ADMIN-AUDIO-002 | 音频刷新/清理 | admin 触发刷新/清理 | 保存中、成功、失败提示完整 | UI + API | P1 | Existing |
| ADMIN-DEVICE-001 | 设备角色修改 | default/trusted/disabled 切换 | 保存失败回滚；成功后移动端授权语义正确 | UI + API | P0 | Existing |
| ADMIN-REQUEST-001 | 请求日志列表 | Gateway 有请求样本 | 可按状态/路由/设备排查失败 | UI + API | P2 | Partial |

## 10. Gateway Android App

| ID | 用例 | 前置条件 | 期望结果 | 层级 | 风险 | 状态 |
|----|------|----------|----------|------|------|------|
| AND-CONN-001 | 首次连接 Gateway | 配置 baseUrl/token/deviceName | session 成功，设备登记，书库同步 | Android + Manual | P1 | Existing |
| AND-CONN-002 | token 错误 | 错误 mobile token | 显示中文 token 检查提示，不进入假成功状态 | Android | P1 | Partial |
| AND-LIB-001 | 书库可见性 | default/trusted/disabled 设备 | 显示符合角色的书籍，禁用后云端操作阻断 | Android + Ops | P0 | Existing |
| AND-PKG-001 | 单书 package 下载缓存 | 选择大包书籍 | 写入本地缓存，重启后可打开 | Android | P1 | Existing |
| AND-PKG-002 | 大包存储上限 | 妖刀记/大唐双龙传 package | 不触发 WebView quota 崩溃 | Android + Manual | P1 | Existing |
| AND-READ-001 | 按书阅读进度 | 多本书交替阅读 | 每本书章节/滚动位置独立恢复 | Android | P0 | Existing |
| AND-READ-002 | 切 Tab 保存进度 | 阅读页滚动后切设置/书库再返回 | 不跳回章节顶部 | Android | P1 | Partial |
| AND-AUDIO-001 | 音频目录按书隔离 | 切换有音频书籍 | 音频目录、缓存数、同步进度不串书 | Android | P0 | Existing |
| AND-AUDIO-002 | 单章 MP3 下载 | 当前章有音频 | 下载到原生私有目录，状态变为已缓存 | Android + Manual | P1 | Existing |
| AND-AUDIO-003 | 批量 MP3 同步停止 | 批量下载中点击停止 | 当前章节结束后不继续新章节 | Android | P1 | Partial |
| AND-AUDIO-004 | 离线 MP3 播放 | 断网且已有缓存 | 可播放本地 MP3，UI 不误称在线播放 | Android + Manual | P1 | Existing |
| AND-RAG-001 | Gateway RAG 搜索 | 受信设备、可见书籍 | 搜索成功，embedding 失败时关键词兜底不显示红底误报 | Android | P1 | Existing |
| AND-UPDATE-001 | 应用内检查更新 | Gateway 发布更高 versionCode | 显示下载并安装，系统安装确认弹出 | Android + Manual | P1 | Manual |
| AND-UPDATE-002 | 无更新状态 | versionCode 不高于本机 | 显示已是最新，不重复下载 | Android | P2 | Existing |

## 11. 运维与发布验证

| ID | 用例 | 前置条件 | 期望结果 | 层级 | 风险 | 状态 |
|----|------|----------|----------|------|------|------|
| OPS-DEPLOY-001 | Gateway 启动健康检查 | 生产 token、可信 TLS 证书和数据目录配置完成 | `/health`、`/capabilities` 正常，严格 TLS 通过，敏感环境不泄露 | Ops Script + Real Gateway | P0 | Existing |
| OPS-SEC-001 | 公网 Admin UI 禁止访问 | Nginx 公网入口 | `/admin/ui` 返回 403，内网可访问 | Ops Script + Real Gateway | P0 | Existing |
| OPS-SEC-002 | 未知 Host/IP 直连 | 公网 Nginx | 不返回 Gateway 应用内容 | Ops Script + Real Gateway | P0 | Existing |
| OPS-PUBLISH-001 | package 发布后真实可见 | production-pipeline publish 完成 | 远端 `books.json` 与 `/mobile/books` 设备可见性一致 | API + Ops | P0 | Existing |
| OPS-PUBLISH-002 | audio 发布后 admin refresh | MP3/audio.json 已 rsync | Admin audio coverage 与远端 audio.json 一致 | API + Ops | P0 | Existing |
| OPS-PUBLISH-003 | APK 发布元数据 | 发布 APK 到 downloads | `android-app.json`、latest APK、versioned APK 一致 | Ops Script + Real Gateway | P1 | Existing |
| OPS-METRIC-001 | 指标定位错误 | 制造 401/404/500/download | metrics/events 能定位路由、状态、设备和错误类别 | Ops Script + Real Gateway | P1 | Existing |
| OPS-RUNBOOK-001 | 常见故障排查 | 缺音频、缺 package、鉴权失败、模型失败 | runbook 给出检查路径和修复命令 | Manual | P1 | Existing |
| OPS-ROLLBACK-001 | 发布回滚 | 发布错误 package/audio/APK | dry-run 可验证回滚输入；`--apply` 可恢复 package/audio/APK | Ops Script + Real Exercise | P0 | Existing |

## 12. 第一批自动化建议

优先从 P0/P1 且不依赖真机的用例开始：

1. `GW-AUTH-001`：admin/mobile token 分离。
2. `GW-BOOK-001`：书库可见性与设备角色。
3. `GW-AI-001`：mobile RAG 路由鉴权和 bookId 可见性。
4. `ADMIN-AUTH-001`：Admin UI 未授权不回退 mock。
5. `ADMIN-DASH-003`：Admin UI 区分部分接口失败。
6. `AND-READ-001`：Gateway Android 按书阅读进度逻辑测试。
7. `AND-AUDIO-001`：音频缓存状态按书隔离。
8. `PIPE-PUBLISH-002`：publish 合并 books.json 不覆盖其他书。
9. `PIPE-VERIFY-001`：Gateway package verify 使用真实 API 契约。
10. `KG-ENTITY-002` / `KG-ENTITY-003`：实体合并/拆分数据一致性。

## 13. 手工/真机验证边界

以下用例不应伪装成完全自动化，必须保留手工或真实环境验收记录：

- Android 安装、系统 APK 更新确认、原生 MP3 下载目录和离线播放。
- 公网 Nginx Host 白名单、`/admin/ui` 公网阻断、内网访问管理后台。
- 真实 Gateway 上 package/audio/APK 发布后的可见性和下载。
- 真实模型服务的长时间 summary/KG/audio 生产质量与超时行为。
- 数据库恢复、发布回滚、高风险图谱操作回滚。

当前真实环境治理入口：

- [运维 Runbook](operations-runbook.md)：Gateway 健康检查、package/audio/APK 验收、公网安全和回滚路径。
- [发布检查清单](release-checklist.md)：发布前自动化、真实 Gateway 验收、真机验收和发布记录模板。
- [系统性 Code Review Checklist](code-review-checklist.md)：按模块评审契约、鉴权、数据一致性、恢复能力和可观测性。

## 14. 后续维护规则

- 新增功能必须补一条正向用例和一条失败路径用例。
- 修复 P0/P1 bug 时必须把对应回归用例编号写入 PR/进度文档。
- 自动化测试实现后，将状态从 `Planned` 改为 `Existing` 或 `Partial`，并写明对应测试文件。
- 发现运维缺口时先标为 `Ops Gap`，再进入 runbook 或指标开发任务。
