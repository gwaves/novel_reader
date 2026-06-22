# 移动端 TTS 开发方案

## 目标

为 Android 移动端增加离线优先的语音阅读能力。

移动端在离开家庭局域网、无法连接 PC 后端时，仍然必须能朗读已经同步到本地的小说。PC 侧 TTS 只作为后续的高质量音频预生成能力，不应成为语音阅读的必需运行路径。

## 首要适配设备

第一期优先适配用户实机：

- 设备：小米 17 Pro。
- 系统：小米当前最新正式系统，实机 Android 版本为 Android 16。
- 适配策略：以实机验证结果为准，优先解决小米 17 Pro 上的 TTS 可用性、滚动同步、播放控制和前台稳定性问题。

工程实现上不要绑定过窄的系统版本判断。第一期按“小米 17 Pro + Android 16”做验证，同时保持 Android 系统 TTS API 的通用实现，避免依赖 Android 17 或更高版本的专属能力。

实机测试时需要记录：

- HyperOS 版本号。
- Android 版本号。
- 当前默认 TTS 引擎。
- 是否已安装中文离线语音包。
- `zh-CN` 语言可用性检测结果。
- 可选 voice 列表及是否标记为 `requiresNetwork`。

## 产品原则

- 普通语音阅读必须在书籍完成同步后完全离线可用。
- 第一期优先通过一个很薄的 Capacitor 原生桥调用 Android 系统 Text-to-Speech。
- PC/后端 TTS 作为后续高质量预生成和同步能力，不进入第一期主链路。
- “语音阅读”本身不需要 ASR。ASR 应归入后续的语音控制或语音问答能力。
- 语音进度、视觉阅读进度和文本内容要彼此独立，避免听书进度覆盖正常阅读位置。
- 语音播放过程中，页面中的小说正文必须跟随当前朗读片段高亮和滚动。

## 运行优先级

用户点击“语音阅读”后，按以下优先级处理：

1. 如果当前片段已有本地缓存音频，直接播放缓存音频。
2. 否则，如果 Android 系统 TTS 支持当前语言和音色，使用本机 TTS 朗读。
3. 否则，给出明确提示，引导用户安装或启用中文 TTS 引擎/语音包。

第一期只需要完成第 2 和第 3 步。本地缓存音频留到后续阶段。

## 第一期范围

第一期目标是打通一个可用的离线语音阅读闭环：

- 在阅读页增加“语音阅读”入口。
- 支持播放、暂停、继续和停止。
- 使用 Android 系统 TTS 朗读当前章节。
- 将章节正文切分为稳定的句子级或短段落级语音片段。
- 高亮当前正在朗读的片段。
- 播放过程中平滑滚动，让当前片段保持可见。
- 按书籍、章节和片段保存独立语音进度。
- 提供基础语音设置：语言、音色、语速和音调。
- 检测中文 TTS 是否可用，并在不可用时给出可操作的错误信息。

第一期不做：

- 不依赖后端实时合成。
- 不要求云端 TTS。
- 不做 ASR。
- 不承诺锁屏控制或后台播放。
- 不做逐字 karaoke 高亮。
- 不做整本书预生成。

## 第二期范围

第二期可以增强听书体验：

- 当前章节结束后自动进入下一章。
- 增加跨阅读页、搜索页、书架页可见的迷你播放器。
- 用户手动滚动离开当前朗读位置时，提供“跟随朗读”控制。
- 通过更细片段切分提升暂停/继续精度。
- 增加定时停止。
- 处理 Android 音频焦点，例如来电、耳机、其他媒体播放。
- 评估后台播放和 MediaSession 支持。

## 第三期范围

第三期可以加入高质量音频和预生成能力：

- PC 后端为选中的书籍/章节创建 TTS 合成任务。
- 将生成的音频包同步到移动端。
- 增加本地音频缓存空间限制和清理策略。
- 优先播放缓存的高质量音频，缺失时回退到 Android 系统 TTS。
- 如果系统 TTS 质量不足，再评估移动端离线模型 TTS。

## 文本切片

语音同步滚动依赖稳定的文本片段。阅读器不应该一次把整章正文提交给 TTS。

从当前章节生成 `SpeechSegment[]`：

```ts
export type SpeechSegment = {
  id: string
  bookId: string
  chapterId: string
  chapterIndex: number
  paragraphIndex: number
  sentenceIndex: number
  text: string
  startChar: number
  endChar: number
}
```

推荐切片规则：

- 保留段落顺序。
- 中文按 `。！？；` 等标点切分。
- 英文或混合文本按 `.?!;` 等标点切分。
- 很短的碎片合并到相邻片段。
- 第一期每个片段控制在大约 40 到 300 个中文字符。
- 使用 `chapterId`、`paragraphIndex`、`sentenceIndex` 生成稳定确定的片段 ID。

同一份 `SpeechSegment[]` 同时驱动页面渲染和 TTS 播放队列。

## 阅读器渲染

章节正文渲染时，每个语音片段都要包成可定位元素：

```tsx
<span
  className={segment.id === activeSpeechSegmentId ? 'speech-segment active' : 'speech-segment'}
  data-speech-segment-id={segment.id}
>
  {segment.text}
</span>
```

进入新片段时：

1. 设置 `activeSpeechSegmentId`。
2. 高亮该片段。
3. 调用 `scrollIntoView({ block: 'center' })` 将片段滚动到视野中间附近。
4. 保存语音进度。

第一期目标是句子级高亮和滚动同步。逐字高亮延后处理，因为 Android 系统 TTS 在不同设备和不同引擎上的字级回调并不稳定。

## 用户手动滚动

自动滚动不能和用户抢控制权。

推荐行为：

- TTS 播放时默认跟随当前朗读片段。
- 如果用户手动滚动，暂停自动跟随 5 到 8 秒。
- 显示或启用“跟随朗读”操作。
- 用户点击“跟随朗读”后，立即滚回当前朗读片段，并重新启用自动跟随。

## 语音进度

语音进度必须和视觉阅读进度分开保存。

```ts
export type SpeechProgress = {
  bookId: string
  chapterId: string
  segmentId: string
  segmentIndex: number
  voiceId: string | null
  rate: number
  pitch: number
  updatedAt: string
}
```

不要复用 `reading_progress.scrollY`。用户视觉阅读的位置和听书位置天然可能不同。

移动端 IndexedDB 需要增加 `speechProgress` object store。后续如果移动端存储层从 IndexedDB 迁移到 SQLite，再用 SQLite 表结构镜像这份数据。

## Android TTS 原生桥

新增一个很薄的 Capacitor 插件，用来调用 Android 系统 TTS。

建议 TypeScript API：

```ts
export type TtsVoice = {
  id: string
  name: string
  locale: string
  quality?: number
  latency?: number
  requiresNetwork?: boolean
}

export type TtsAvailability = {
  available: boolean
  languageAvailable: boolean
  engine: string | null
  voices: TtsVoice[]
  error?: string
}

export type SpeakRequest = {
  text: string
  utteranceId: string
  locale: string
  voiceId?: string
  rate: number
  pitch: number
}

export interface NovelReaderTtsPlugin {
  getAvailability(options: { locale: string }): Promise<TtsAvailability>
  speak(request: SpeakRequest): Promise<void>
  stop(): Promise<void>
  setRate(options: { rate: number }): Promise<void>
  setPitch(options: { pitch: number }): Promise<void>
  addListener(
    eventName: 'utteranceStart' | 'utteranceDone' | 'utteranceError',
    listener: (event: { utteranceId: string; error?: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>
}
```

暂停/继续建议在 React 播放队列层实现：

- 暂停：调用原生 `stop()`，并记录当前片段 index。
- 继续：从当前片段重新调用 `speak()`。

Android 系统 TTS 不同引擎对真正的 pause/resume 支持不一致，用播放队列模拟暂停会更稳。

## React 播放状态

推荐的高层状态：

```ts
type SpeechPlaybackState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'playing'; segmentIndex: number; segmentId: string }
  | { status: 'paused'; segmentIndex: number; segmentId: string }
  | { status: 'error'; message: string }
```

播放控制器负责：

- 基于当前章节生成语音片段。
- 如果存在已保存的语音进度，从该进度开始。
- 每次只向原生 TTS 提交一个片段。
- 收到 `utteranceDone` 后推进到下一个片段。
- 当前章读完后停止，跨章节连续朗读留到后续阶段。
- 用户切换章节或离开阅读页时干净取消当前播放。

## 设置项

在移动端设置页增加 TTS 设置组：

- 语言，默认 `zh-CN`。
- 音色，默认使用系统选择。
- 语速，默认 `1.0`。
- 音调，默认 `1.0`。
- 朗读时自动跟随正文，默认开启。
- 从上次语音进度继续，默认开启。

TTS 设置只保存在移动端本地，不进入 PC 同步的书籍包。

## 后端 TTS 后续方案

后端 TTS 必须是可选且显式的能力，因为它可能把小说正文发送给外部服务。

后续可考虑的接口：

```text
GET  /api/mobile/tts/voices
POST /api/mobile/tts/jobs
GET  /api/mobile/tts/jobs/:jobId
GET  /api/mobile/tts/audio/:audioId
```

后续行为：

- 手机能连接 PC 后端时，用户手动启动预生成。
- PC 后端按内容 hash、音色、语速、provider 缓存音频。
- 移动端同步选中的音频文件。
- 移动端优先播放缓存音频，缺失时回退到 Android 系统 TTS。

隐私提示需要明确区分：

- 本机 Android TTS：章节正文留在设备本地，除非用户选择的系统语音引擎本身使用网络音色。
- PC/云端 TTS：选中的章节正文可能会发送给配置的合成服务。

## ASR 后续方案

ASR 应作为单独功能设计：

- 语音控制：暂停、继续、下一章、上一章、跟随朗读。
- 语音问答：把用户语音转成文字，再走本地检索和可用的 LLM 回答链路。

ASR 不应该阻塞 TTS 开发。

## 实施任务

建议按以下顺序开发：

1. 增加文本切片 helper 和单元测试。
2. 更新阅读器渲染，输出稳定的 speech segment。
3. 增加本地语音进度持久化。
4. 增加 Android Capacitor TTS 插件。
5. 增加 React 播放控制器和原生事件绑定。
6. 增加阅读页播放、暂停、继续、停止 UI。
7. 增加当前片段高亮和跟随滚动行为。
8. 增加 TTS 设置和可用性检测。
9. 用一本中文书在无 PC 后端连接的 Android 环境中验证。

## 验收标准

满足以下条件时，第一期完成：

- 小米 17 Pro 当前最新正式系统上完成实机验证。
- 离线状态下可以打开已同步书籍。
- 点击“语音阅读”后，当前章节能通过 Android 系统 TTS 朗读。
- 当前朗读的句子或短片段会高亮。
- 阅读器会滚动，让当前朗读片段保持可见。
- 暂停会停止朗读，并保留当前片段。
- 继续会从保留的片段重新开始。
- 停止会清空当前播放状态。
- 语音进度和视觉阅读进度分开保存。
- 中文 TTS 不可用时，应用给出明确设置错误，而不是静默失败。
- 现有书架同步、阅读、搜索和 RAG 页面仍然能正常构建。
