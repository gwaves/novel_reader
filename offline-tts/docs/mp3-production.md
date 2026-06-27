# 章节 MP3 生产说明

本文记录正式生产章节 MP3 的推荐流程，以及生产完成后移动端同步需要的目录结构。

## 总览

生产链路分三步：

```text
章节正文 -> 导演脚本 director-script.json -> TTS 片段 WAV -> chapter.mp3 + manifest.json
```

移动端 MP3 播放依赖 `manifest.json` 里的真实时间轴。不要只拷贝 `chapter.mp3`，否则 Android 端无法做可靠的文字高亮和定位播放。

## 前置条件

需要本机有：

- Novel Reader 主数据库，默认在 `~/.novel_reader/novel_reader.sqlite`。
- `ffmpeg` 和 `ffprobe`。
- 可访问的 OpenAI-compatible LLM 服务，用于生成导演脚本。
- MIMO TTS API key，用于合成音频。

建议把配置放到用户目录：

```bash
cp offline-tts/config.example.json ~/.novel_reader/tts-director.config.json
```

MIMO key 使用环境变量：

```bash
export MIMO_API_KEY='你的 MIMO API key'
```

如果 key 已写入 `~/.zshenv`，新开的 zsh 会自动读取。

## 推荐目录

以《妖刀记》为例，建议统一输出到：

```text
tmp/tts/yaodao
```

每章使用一个独立目录：

```text
tmp/tts/yaodao/
  ch001-full/
    director-script.json
    director-script.audit.json
    audio/
      chapter.mp3
      manifest.json
      segments/
      work/
  ch002-full/
    director-script.json
    director-script.audit.json
    audio/
      chapter.mp3
      manifest.json
      segments/
      work/
```

移动端配置时填父目录：

```text
/Users/gwaves/Documents/novel_reader/tmp/tts/yaodao
```

不要填到 `ch001-full` 或 `audio`。PC 本地服务会在父目录下扫描：

```text
<父目录>/ch001-full/audio/chapter.mp3
<父目录>/ch001-full/audio/manifest.json
```

## 单章生产

先生成导演脚本：

```bash
node offline-tts/scripts/tts-director.mjs \
  --config ~/.novel_reader/tts-director.config.json \
  draft-script \
  --book-id 9679077f-2288-4bc7-9080-854784fc7f94 \
  --chapter 19 \
  --batch-size 10 \
  --concurrency 3 \
  --out tmp/tts/yaodao/ch019-full/director-script.json
```

校验导演脚本：

```bash
node offline-tts/scripts/tts-director.mjs \
  --config ~/.novel_reader/tts-director.config.json \
  validate-script \
  --script tmp/tts/yaodao/ch019-full/director-script.json
```

抽查角色和音色：

```bash
node offline-tts/scripts/tts-director.mjs \
  --config ~/.novel_reader/tts-director.config.json \
  audit-script \
  --script tmp/tts/yaodao/ch019-full/director-script.json
```

合成 MP3：

```bash
node offline-tts/scripts/tts-director.mjs \
  --config ~/.novel_reader/tts-director.config.json \
  synth \
  --script tmp/tts/yaodao/ch019-full/director-script.json \
  --out-dir tmp/tts/yaodao/ch019-full/audio \
  --concurrency 8
```

合成完成后，至少应有：

```text
tmp/tts/yaodao/ch019-full/audio/chapter.mp3
tmp/tts/yaodao/ch019-full/audio/manifest.json
```

## 批量生产

正式批量生产推荐用 `batch-pipeline`：

```bash
node offline-tts/scripts/tts-director.mjs \
  --config ~/.novel_reader/tts-director.config.json \
  batch-pipeline \
  --book-id 9679077f-2288-4bc7-9080-854784fc7f94 \
  --chapters 1-293 \
  --batch-size 10 \
  --director-concurrency 3 \
  --min-batch-size 6 \
  --tts-concurrency 16 \
  --tts-chapters 2 \
  --resume \
  --out-root tmp/tts/yaodao
```

参数建议：

- `--resume`：断点续跑，跳过已完成的 `chapter.mp3`，复用已有导演脚本和 TTS 片段缓存。
- `--batch-size 10 --director-concurrency 3`：当前比高并发更稳。
- `--tts-concurrency 16`：当前推荐的单章内 TTS 片段并发；脚本默认开启自适应降档。
- `--tts-chapters 2`：最多两章同时进入 TTS 阶段。
- 不要在正式生产里使用 `--limit`。新版脚本默认处理整章；`--limit` 只用于小样调试，并且必须同时传 `--allow-partial`，否则脚本会拒绝生成部分章节音频。`synth` 也会默认拒绝部分章节脚本，调试合成 partial 脚本时同样需要传 `--allow-partial`。

### TTS 并发建议

2026-06-28 对《西游记》前三章做过一轮隔离 benchmark：复用同一批 `director-script.json`，只调整 TTS 片段并发，`--tts-chapters` 固定为 2。

| 配置 | 总 TTS wall time | 第 1 章 | 第 2 章 | 第 3 章 | 结论 |
| --- | ---: | ---: | ---: | ---: | --- |
| `--tts-concurrency 4` | 678s | 197s | 327s | 364s | 基线，明显偏慢 |
| `--tts-concurrency 8` | 335s | 111s | 175s | 335s | 常规推荐，约 2.0x 提升 |
| `--tts-concurrency 16` | 261s | 85s | 166s | 261s | 高性能档，边际收益下降 |
| `--tts-concurrency 16` + metrics | 233s | 124s | 90s | 233s | 6/681 片段重试，全部恢复 |

推荐策略：

- 默认使用 `--tts-concurrency 16 --tts-chapters 2`，总并发约 32 路 TTS 请求；脚本默认开启自适应降档，出现失败或高重试率时会自动降低单章片段并发。
- `--tts-concurrency 8 --tts-chapters 2` 可作为保守档，用于 MIMO 服务波动、网络不稳定或排查异常时对照。
- 暂时不要继续盲目提高到 32。当前瓶颈已经开始转向异常片段重试、ffprobe 校验和最终拼接，而不是单纯 TTS 请求数量。
- 如果出现大量 `音频时长异常`、`含异常长静音` 或 HTTP 错误，优先降回 `--tts-concurrency 8`。
- 两轮带 metrics 的重试片段没有 ID 重叠，异常更像 MIMO 偶发返回超长音频，而不是固定文本片段有问题；保留时长校验和自动重试很重要。

### 异常响应识别

当前脚本已经能识别两类异常 TTS 产物：

- 音频时长异常：用 `ffprobe` 读取生成 WAV 时长，若超过 `max(12s, 字数 * tts.maxSecondsPerCharacter)`，删除并重试。
- 长静音异常：用 `ffmpeg silencedetect` 检查静音段，若超过 `tts.maxSilenceSeconds`，删除并重试。

每章 `audio/tts-metrics.json` 会输出片段级 telemetry，便于判断异常是否和服务响应有关：

- `requestMs`：MIMO HTTP 请求响应耗时。
- `audioDurationSeconds`：生成 WAV 的实际时长。
- `textLength` 和 `durationPerChar`。
- `attempt`、`maxAttempts` 和最终状态。
- `errorType`：`http_error`、`missing_audio`、`duration_outlier`、`long_silence` 等。
- 章节级 p50/p90/p95/p99 `requestMs`、重试次数和失败次数。批量生产的 summary 也会汇总这些指标。

这些字段也会驱动自适应 TTS 并发：无重试时可升档，出现失败或重试率升高时降档。

调试小样可以这样跑：

```bash
node offline-tts/scripts/tts-director.mjs \
  --config ~/.novel_reader/tts-director.config.json \
  draft-script \
  --book-id 9679077f-2288-4bc7-9080-854784fc7f94 \
  --chapter 19 \
  --allow-partial \
  --limit 2000 \
  --batch-size 10 \
  --concurrency 3 \
  --out tmp/tts/yaodao/ch019-partial/director-script.json
```

调试小样合成时：

```bash
node offline-tts/scripts/tts-director.mjs \
  --config ~/.novel_reader/tts-director.config.json \
  synth \
  --script tmp/tts/yaodao/ch019-partial/director-script.json \
  --out-dir tmp/tts/yaodao/ch019-partial/audio \
  --allow-partial
```

流水线行为：

1. 每章先生成并校验 `director-script.json`。
2. 校验通过后生成 `director-script.audit.json`。
3. 该章进入 TTS 合成，同时下一章可以开始 LLM 阶段。
4. TTS 片段按脚本顺序标准化、插入静音、拼接，再编码为 `chapter.mp3`。
5. 最后写入 `audio/manifest.json`。

## manifest 时间轴

新版 `manifest.json` 是移动端 MP3 同步的关键文件。它包含：

- `version: 2`
- `timelineVersion: 1`
- `duration`：整章 MP3 时长。
- `segments`：每个 TTS 片段的源信息和缓存 WAV。
- `timeline`：每个 TTS 片段在整章 MP3 中的真实时间。

`timeline` 里的关键字段：

```json
{
  "id": "ch019-s0012",
  "speaker": "深溪虎",
  "voice": null,
  "text": "巫峡猿也未到，还要再等么？都等个把时辰啦，要不先散了？",
  "sourceStart": 1795,
  "sourceEnd": 1822,
  "startTime": 718.41,
  "endTime": 724.65,
  "speechDuration": 6.24,
  "trailingSilence": 0.35,
  "nextStartTime": 725.0
}
```

说明：

- `sourceStart/sourceEnd` 对应章节正文字符区间。
- `startTime/endTime` 是有声片段本身在 MP3 中的位置。
- `trailingSilence` 是该片段后插入的静音。
- `nextStartTime` 已经把段后静音算进去。移动端会在 `startTime..nextStartTime` 保持这一段高亮。

因此段落中间的静音必须算进时间轴。不要用文本长度估算 MP3 时间。

## 移动端同步

1. 启动本地 API：

```bash
NOVEL_READER_API_HOST=0.0.0.0 node --no-warnings scripts/local-db-server.mjs
```

2. PC Web 端为当前书配置章节 MP3 目录，填父目录：

```text
/Users/gwaves/Documents/novel_reader/tmp/tts/yaodao
```

3. 点击检测，应能看到已生产章节。

4. Android App 设置同步地址，例如：

```text
http://192.168.88.22:5174
```

5. 在 App 同步页刷新音频并下载本章或全部章节。

注意：

- 服务端只接受新版结构，也就是 `audio/chapter.mp3` 和同目录 `audio/manifest.json` 同时存在。
- 旧的散装 `ch001.mp3`、`001-章节标题.mp3` 不再作为正式 MP3 同步格式。
- 重新生产 MP3 后，`manifest.json` 更新时间会参与缓存版本判断，Android 端会提示更新章节音频。

## 验证

检查 manifest 是否包含时间轴：

```bash
node - <<'NODE'
const fs = require('fs')
const manifest = JSON.parse(fs.readFileSync('tmp/tts/yaodao/ch019-full/audio/manifest.json', 'utf8'))
console.log({
  version: manifest.version,
  timelineVersion: manifest.timelineVersion,
  duration: manifest.duration,
  timelineEntries: manifest.timeline?.length,
  first: manifest.timeline?.[0],
})
NODE
```

检查 MP3 是否可被 ffprobe 读取：

```bash
ffprobe -v error \
  -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 \
  tmp/tts/yaodao/ch019-full/audio/chapter.mp3
```

如果 Android 播放时出现高亮和声音不一致，优先确认：

- App 已下载最新章节 MP3。
- 本章缓存对应的 `manifest.json` 是新版 `version: 2`。
- PC Web 的章节 MP3 目录填的是父目录，不是某一章目录。
- 本地 API 是重启后的新版代码。

## 清理与保留

正式生产后建议保留：

- `director-script.json`
- `director-script.audit.json`
- `audio/chapter.mp3`
- `audio/manifest.json`
- `audio/segments/`

`audio/work/` 是标准化、静音和整章 WAV 等中间文件，占用较大。确认 `chapter.mp3` 和 `manifest.json` 正常后，可以按需清理；如果还要排查拼接问题，先保留。
