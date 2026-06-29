# Gateway 管理后台与书库可见性设计

## 背景

Gateway 现在已经能向移动端提供书库、单书数据包、音频清单、音频文件和 AI/RAG 接口。下一阶段需要新增一个仅限内网/运维访问的管理后台，用来管理书籍、数据包、设备授权和网关运行状态。

同时，Gateway 书库中会存在不同可见范围的书。普通移动端只能看到默认书单；被管理后台授权的受信设备可以看到默认书单和受限书单；管理后台可以看到全部书籍，包括隐藏、测试和只供运维检查的内容。

## 目标

- 用管理后台维护书籍标签、可见范围、数据包状态和音频状态。
- 用管理后台识别移动端设备，并设置设备角色。
- 移动端继续使用同一套 Gateway API，但 Gateway 根据设备角色过滤书库。
- 记录网关负载、请求数、错误率、P95 响应时间、数据包下载和音频下载频次。
- 所有行为先有测试契约，再做实现。

## 非目标

- 第一版不做完整账号体系、家庭成员体系或多租户计费。
- 第一版不从手机系统读取手机号、通讯录或不可稳定获取的系统身份。
- 第一版不把少儿不宜直接做成硬编码逻辑；书籍内容标签和可见范围保持分离。
- 第一版管理后台只面向内网/运维，不作为普通用户产品页面。

## 角色与可见范围

### 设备角色

| 角色 | 说明 | 可见书籍 |
| --- | --- | --- |
| `default` | 普通设备，使用普通 token 连接后默认获得 | `default` |
| `trusted` | 管理后台手动授权后的受信设备 | `default`、`trusted` |
| `disabled` | 被禁用设备 | 不能访问受保护移动端 API |

第一版通过 token 区分调用方语义：管理端使用 admin token，移动端和 `/auth/session` 使用 mobile token。Token 只证明“可以调用对应 API 面”，设备角色仍然决定移动端“能看到什么”。

### 书籍可见范围

| 可见范围 | 说明 | 移动端可见性 |
| --- | --- | --- |
| `default` | 默认书单 | 普通设备、受信设备可见 |
| `trusted` | 受限书单 | 仅受信设备可见 |
| `admin` | 只供后台查看 | 移动端不可见 |
| `hidden` | 隐藏/归档/测试 | 移动端不可见 |

### 内容标签

内容标签只描述内容属性，不直接决定访问权限。建议第一版内置常用标签，但允许管理员输入自定义标签。

- `adult`
- `violence`
- `private`
- `test`
- `archived`

后台展示时应使用中文标签名，例如“少儿不宜”“暴力”“私有”“测试”“归档”。

## 数据模型

### 书籍摘要

`GATEWAY_DATA_DIR/books.json` 中的每本书新增字段：

```json
{
  "id": "book-id",
  "title": "书名",
  "author": "作者",
  "chapterCount": 120,
  "wordCount": 600000,
  "summaryCoverage": 0.8,
  "kgCoverage": 0.6,
  "embeddingCoverage": 0.9,
  "audioChapterCount": 12,
  "updatedAt": "2026-06-29T00:00:00.000Z",
  "visibility": "trusted",
  "labels": ["adult", "private"]
}
```

兼容规则：

- 缺少 `visibility` 时按 `default` 处理。
- 缺少 `labels` 时按空数组处理。
- 未知 `visibility` 在读取时降级为 `default` 并记录事件；写入时必须拒绝。
- `labels` 只接受非空字符串，读取时去重、排序。

### 设备注册表

`GATEWAY_DATA_DIR/devices.json` 升级为以稳定设备 ID 为主键：

```json
{
  "schemaVersion": 1,
  "devices": [
    {
      "id": "device-uuid",
      "name": "小米平板",
      "model": "Xiaomi Pad",
      "platform": "android",
      "appVersion": "0.1.0",
      "pairingCode": "428193",
      "role": "trusted",
      "firstSeenAt": "2026-06-29T12:00:00.000Z",
      "lastSeenAt": "2026-06-29T12:10:00.000Z",
      "lastIp": "192.168.88.23"
    }
  ]
}
```

兼容规则：

- 旧记录只有 `name` 时，读取时生成稳定迁移 ID：`legacy:<normalized-name>`。
- 缺少 `role` 时按 `default` 处理。
- 缺少 `pairingCode` 时由 Gateway 在下次 `touch` 时生成 6 位数字码。
- 管理后台展示 `id`，但主要用设备名、型号、最近 IP、首次连接、最近连接和验证码帮助识别设备。

## 移动端请求头

移动端受保护请求继续带 bearer token，并增加稳定设备信息：

```text
Authorization: Bearer <GATEWAY_MOBILE_ACCESS_TOKEN>
X-Device-Id: <stable-device-id>
X-Device-Name: <user-visible-device-name>
X-Device-Model: <model>
X-Device-Platform: android
X-App-Version: <version>
```

第一版移动端本地生成并保存 `deviceId`。如果用户清除 App 数据或重装，设备会被视为新设备，需要重新在后台识别和授权。

## API 设计

### 鉴权与设备

支持三类静态 token 配置：

- `GATEWAY_ADMIN_ACCESS_TOKEN`：管理端 `/admin/*` 和后台 AI/RAG 操作使用。
- `GATEWAY_MOBILE_ACCESS_TOKEN`：`/auth/*` 和 `/mobile/*` 使用。
- `GATEWAY_DEV_ACCESS_TOKEN`：开发兼容回退；未设置 admin/mobile token 时分别作为对应 token 使用。

当 admin/mobile token 都独立设置后，admin token 不能调用 mobile/session API，mobile token 也不能调用 admin API。

```text
GET /auth/session
```

返回当前设备身份和角色：

```json
{
  "authenticated": true,
  "auth": {
    "mode": "development-static-token",
    "deviceId": "device-uuid",
    "deviceName": "小米平板",
    "role": "default",
    "allowedVisibilities": ["default"],
    "pairingCode": "428193"
  }
}
```

如果设备角色是 `disabled`，受保护移动端 API 返回：

```json
{
  "error": {
    "code": "device_disabled",
    "message": "This device is disabled.",
    "statusCode": 403
  }
}
```

### 移动端书库

```text
GET /mobile/books
GET /mobile/books/:bookId
GET /mobile/books/:bookId/package
GET /mobile/books/:bookId/package/download
GET /mobile/books/:bookId/audio
GET /mobile/books/:bookId/audio/:chapterId/download
GET /mobile/books/:bookId/audio/:chapterId/manifest
```

这些接口都必须先解析设备角色，并按书籍 `visibility` 过滤：

- `default` 设备只能访问 `default` 书籍。
- `trusted` 设备可访问 `default` 和 `trusted` 书籍。
- `admin`、`hidden` 书籍不会出现在移动端。
- 设备无权访问某本书时，返回 `404 book_not_found`，避免向普通设备泄露隐藏书籍存在。

### 管理端书籍接口

```text
GET /admin/books
GET /admin/books/:bookId
PATCH /admin/books/:bookId/visibility
PATCH /admin/books/:bookId/labels
PUT /admin/books/:bookId/package
GET /admin/books/:bookId/package/download
```

`PATCH /admin/books/:bookId/visibility` 请求：

```json
{
  "visibility": "trusted"
}
```

`PATCH /admin/books/:bookId/labels` 请求：

```json
{
  "labels": ["adult", "private"]
}
```

管理端接口返回全量书籍，不按移动端可见性过滤。

### 管理端数据包、音频和请求日志接口

```text
GET /admin/packages
GET /admin/audio
POST /admin/books/:bookId/audio/refresh
DELETE /admin/books/:bookId/audio
GET /admin/requests
```

`GET /admin/packages` 返回每本书的数据包状态，用于后台判断哪些书可以发布、哪些缺包或包损坏：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-29T12:00:00.000Z",
  "packages": [
    {
      "bookId": "book-id",
      "title": "书名",
      "chapterCount": 120,
      "packageChapterCount": 120,
      "status": "imported",
      "importStatus": "imported",
      "sizeBytes": 42949672,
      "updatedAt": "2026-06-29T11:58:00.000Z",
      "importedAt": "2026-06-29T11:50:00.000Z"
    }
  ]
}
```

`GET /admin/audio` 返回每本书的 MP3 覆盖率、缺失章节和总大小：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-29T12:00:00.000Z",
  "audio": [
    {
      "bookId": "book-id",
      "title": "书名",
      "chapterCount": 120,
      "audioChapterCount": 96,
      "missingChapterCount": 24,
      "missingChapterIds": ["chapter-097"],
      "coverage": 0.8,
      "totalSizeBytes": 1887436800,
      "updatedAt": "2026-06-29T11:40:00.000Z"
    }
  ]
}
```

`POST /admin/books/:bookId/audio/refresh` 不触发真实 TTS 生产，只重新读取当前音频清单、包章节和文件状态，返回单书 summary：

```json
{
  "schemaVersion": 1,
  "refreshedAt": "2026-06-29T12:00:00.000Z",
  "audio": {
    "bookId": "book-id",
    "title": "书名",
    "chapterCount": 120,
    "audioChapterCount": 96,
    "missingChapterCount": 24,
    "missingChapterIds": ["chapter-097"],
    "coverage": 0.8,
    "totalSizeBytes": 1887436800
  }
}
```

`DELETE /admin/books/:bookId/audio` 清理该书 `GATEWAY_AUDIO_DIR/books/<bookId>/audio.json` 音频清单/文件索引，不删除实际 MP3 文件，并返回清理结果以及清理后的单书音频 summary：

```json
{
  "schemaVersion": 1,
  "clearedAt": "2026-06-29T12:00:00.000Z",
  "cleanup": {
    "bookId": "book-id",
    "removed": true,
    "deletedFileCount": 1,
    "deletedFiles": ["audio.json"]
  },
  "audio": {
    "bookId": "book-id",
    "audioChapterCount": 0,
    "missingChapterCount": 120
  }
}
```

`GET /admin/requests` 返回进程内最近请求窗口，供后台请求日志页展示方法、路径、状态码、耗时和下载类型：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-29T12:00:00.000Z",
  "requests": [
    {
      "requestId": "req-id",
      "time": "2026-06-29T11:59:30.000Z",
      "method": "GET",
      "url": "/mobile/books/book-id/package",
      "statusCode": 200,
      "durationMs": 138,
      "bookId": "book-id",
      "downloadKind": "package"
    }
  ]
}
```

### 管理端设备接口

```text
GET /admin/devices
PATCH /admin/devices/:deviceId
```

`PATCH /admin/devices/:deviceId` 请求：

```json
{
  "name": "客厅平板",
  "role": "trusted"
}
```

### 管理端指标接口

```text
GET /admin/metrics
GET /admin/events
GET /admin/requests
```

`GET /admin/metrics` 返回滚动窗口统计：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-29T12:00:00.000Z",
  "process": {
    "uptimeSeconds": 3600,
    "rssBytes": 268435456,
    "heapUsedBytes": 67108864
  },
  "requests": {
    "lastMinute": 120,
    "last15Minutes": 1200,
    "last24Hours": 24000,
    "errorRate": 0.003,
    "p95Ms": 180
  },
  "downloads": {
    "packageLast24Hours": 8,
    "audioLast24Hours": 842,
    "topBooks": [
      {
        "bookId": "book-id",
        "title": "书名",
        "audioDownloads": 120,
        "packageDownloads": 2
      }
    ]
  }
}
```

第一版指标可先使用进程内环形窗口；重启后清零。后续如需长期趋势，再接 SQLite、Prometheus 或日志聚合。

## 管理后台交互设计

### 导航

左侧窄导航：

- 总览
- 书籍
- 数据包
- 音频
- 设备
- 请求日志
- 设置

顶部栏：

- 当前环境
- 服务状态
- 刷新频率
- 管理员连接状态

### 总览

首屏回答“网关是否健康，内容是否完整，流量是否异常”。

```text
┌────────────────────────────────────────────────────────────┐
│ Novel Reader Gateway                状态: 健康   刷新: 5s   │
├────────────────────────────────────────────────────────────┤
│ 请求数 今日 12,430 │ 错误率 0.3% │ P95 180ms │ 下载 842 次 │
├────────────────────────────────────────────────────────────┤
│ CPU/内存/磁盘摘要       在线设备 3       受信设备 1          │
├──────────────────────────────┬─────────────────────────────┤
│ 请求趋势                     │ 下载趋势                    │
│ 请求 / 错误 / P95            │ package / audio             │
├──────────────────────────────┴─────────────────────────────┤
│ 内容健康                                                     │
│ 书籍 12 本 | 受限 3 | 隐藏 1 | 缺音频章节 28 | 异常数据包 1 │
├────────────────────────────────────────────────────────────┤
│ 最近事件                                                     │
│ 10:22 导入《xxx》成功                                        │
│ 10:18 /mobile/books/1/audio 404                             │
│ 10:10 设备“小米平板”连接，验证码 428193                     │
└────────────────────────────────────────────────────────────┘
```

### 书籍

主区域使用表格：

- 书名
- 作者
- 可见范围
- 内容标签
- 章节数
- 数据包更新时间
- summary/kg/embedding 覆盖率
- 音频覆盖率
- 最近下载

点击行打开右侧详情抽屉：

- 基础信息
- 可见范围选择
- 标签多选/输入
- package 校验摘要
- 音频缺失摘要
- 最近请求/下载
- 操作：下载 package、上传替换、隐藏、恢复默认

### 数据包

上传流程三步：

1. 选择文件或粘贴 JSON。
2. 预校验并展示差异：新书/覆盖、章节数变化、覆盖率变化、包大小、更新时间。
3. 确认导入，导入完成后写入事件记录并可下载当前版本。

第一版可以暂不实现完整回滚，但接口和 UI 预留“导入历史”区域。

### 音频

按书展示：

- 已有音频章节数 / 总章节数
- 缺失章节
- manifest 覆盖率
- 总大小
- 近 24 小时下载次数
- 热门章节

点击书籍打开右侧详情，列出缺失章节、文件异常和 manifest 异常。

### 设备

设备列表：

```text
┌──────────────┬──────────┬────────────┬────────────┬──────────┐
│ 设备名        │ 验证码    │ 角色        │ 最近 IP     │ 最近连接  │
├──────────────┼──────────┼────────────┼────────────┼──────────┤
│ 小米平板      │ 428193    │ 普通        │ 192.168... │ 2分钟前   │
│ My Tablet    │ 913802    │ 受信        │ 10.0...    │ 昨天      │
└──────────────┴──────────┴────────────┴────────────┴──────────┘
```

点击设备打开详情抽屉：

- 设备 ID
- 设备名、型号、平台、App 版本
- 首次连接、最近连接、最近 IP
- 验证码
- 角色选择：普通、受信、禁用
- 最近请求数、下载数

后台授权流程：

1. 移动端设置页显示设备名和 6 位验证码。
2. 后台“待识别设备”列表显示相同验证码。
3. 管理员确认后把角色改为 `trusted`。
4. 移动端下一次刷新会话或书库后看到受限书单。

### 请求日志

默认展示元数据，不展示 token、正文或完整签名 URL：

- 时间
- 方法
- 路径模板
- 状态码
- 响应时间
- 设备名/设备 ID
- 书籍 ID
- 错误码

筛选：

- 错误请求
- 慢请求
- 下载请求
- 指定设备
- 指定书籍

## Gateway Mobile App 交互设计

设置页新增设备身份区：

- 设备名输入框。
- 设备 ID 的短显示，例如末尾 8 位。
- 配对验证码。
- 当前角色：普通/受信/禁用。
- 可见范围提示：普通设备只能看到默认书单；受信设备可看到受限书单。
- “刷新授权状态”按钮。

首次启动：

1. 本地生成 `deviceId`。
2. 默认设备名可从平台能力读取；读不到时使用 “Android Phone”。
3. 连接 Gateway 后调用 `/auth/session`，展示 pairing code 和角色。
4. 同步书库时无需额外选择范围，Gateway 返回当前设备可见书籍。

如果设备被禁用：

- 设置页显示“此设备已被禁用”。
- 书库同步停止，保留本地已缓存书籍但不再下载新数据。

## 测试驱动计划

### Gateway 单元/接口测试

先补失败测试，再实现：

- 读取旧 `devices.json` 时兼容只有 `name` 的设备记录。
- `GET /auth/session` 返回 `deviceId`、`role`、`allowedVisibilities` 和 `pairingCode`。
- 默认设备只能看到 `visibility: default` 的书。
- 受信设备能看到 `default` 和 `trusted` 书。
- 普通设备访问受限书籍 package/audio 时返回 `404 book_not_found`。
- 禁用设备访问移动端受保护 API 时返回 `403 device_disabled`。
- 管理端 `GET /admin/books` 能看到全部书籍。
- 管理端 `PATCH /admin/books/:bookId/visibility` 能更新书籍可见范围。
- 管理端 `PATCH /admin/books/:bookId/labels` 能更新并规范化标签。
- 管理端 `GET /admin/devices` 返回设备列表。
- 管理端 `PATCH /admin/devices/:deviceId` 能更新角色和名称。
- 下载 package/audio 后指标计数增加。
- 错误请求计入错误率，慢请求参与 P95。

### Gateway Mobile App 测试

- `gatewayFetch` 会带上 `X-Device-Id`、`X-Device-Name`、`X-Device-Model`、`X-Device-Platform`、`X-App-Version`。
- 首次加载设置时生成并持久化 `deviceId`。
- `/auth/session` 响应中的角色和配对码会显示在设置页。
- 被禁用设备的错误会显示为明确状态，不进入无限重试。

### 管理后台 UI 测试

- 书籍列表能展示可见范围和标签。
- 修改可见范围后表格和详情抽屉同步更新。
- 设备列表能展示 pairing code 和角色。
- 修改设备角色后设备详情同步更新。
- 总览页能展示指标卡片和最近事件。

## 并发开发拆分

可以并发的边界：

1. Gateway 数据模型和 API：主要修改 `gateway/src/*` 与 `gateway/src/app.test.ts`。
2. Gateway Mobile App 设备身份：主要修改 `gateway-android-app/src/App.tsx` 和样式，必要时新增小工具函数测试。
3. 管理后台 UI：可先新增独立 `gateway/admin-ui/` 或 `gateway/src/admin-ui/*`，通过 mock API 开发静态页面。

需要串行或小心合并的部分：

- `gateway/src/app.ts` 路由注册会被 Gateway API 和后台 UI 同时修改，先由 Gateway API 任务落地基础路由，再让 UI 任务挂静态资源。
- `gateway-android-app/src/App.tsx` 是大文件，应尽量把新逻辑抽成小模块，降低冲突。
- 指标采集会包裹所有请求，应在核心路由稳定后加入。

## 第一版验收标准

- `npm --prefix gateway run test` 通过。
- `npm --prefix gateway run typecheck` 通过。
- `npm --prefix gateway-android-app run build` 通过。
- 普通设备只能看到默认书单。
- 管理后台把设备改为受信后，移动端刷新书库能看到受限书单。
- 后台能修改书籍可见范围和标签。
- 后台总览能看到请求数、错误率、P95、数据包下载和音频下载统计。
