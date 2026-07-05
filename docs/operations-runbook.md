# 运维 Runbook

更新时间：2026-07-01

本文档面向真实 Gateway、production-pipeline 和 Gateway Android 发布验收。命令中的 token、主机和路径应从实际部署环境读取，不要写入仓库。

## 1. 快速分诊

| 现象 | 首查 | 常见根因 | 修复入口 |
|------|------|----------|----------|
| 手机看不到书 | `/auth/session`、`/mobile/books`、Admin 书籍 visibility | mobile token 对应设备不是 trusted；书是 hidden/trusted；`books.json` 未包含目标书 | 调整设备角色或书籍 visibility；重新 publish/verify |
| package 缺失或旧版本 | `/admin/books`、`/mobile/books/:bookId/package?include=full` | rsync 未完成；`books.json` 合并失败；旧 package 未替换 | 重跑 publish，确认 package 文件和 catalog |
| 音频显示缺章 | 远端 `audio.json`、`/admin/audio`、admin refresh | MP3 未 rsync；`audio.json` 未合并早期章节；refresh 未执行 | 补传 MP3/audio.json，执行 admin audio refresh |
| APK 更新不可见 | `/downloads/android-app.json`、`/downloads/novel_gateway.apk` | versionCode 未升高；latest/versioned APK 不一致 | 重跑 APK build/publish，校验元数据 |
| Admin UI 未授权 | admin token、Nginx 入口、`/admin/*` 响应 | token 错误；公网入口被禁止；生产 token 未配置 | 使用内网入口和 admin token |
| RAG/AI 失败 | Gateway events、上游模型日志 | 设备不可见该书；上游 key/baseUrl/model 错误 | 先确认 book visibility，再检查模型配置 |
| Android 日志出现敏感参数 | APK 内 `capacitor.config.json`、logcat 采集脚本 | Capacitor debug logging 开启；采集了未脱敏 methodData | 设置 `android.loggingBehavior=none`，重新构建 APK；不得外发未脱敏日志 |

## 2. Gateway 健康检查

```bash
curl -fsS "$GATEWAY_URL/health"
curl -fsS "$GATEWAY_URL/capabilities"
curl -fsS -H "Authorization: Bearer $MOBILE_TOKEN" "$GATEWAY_URL/auth/session"
curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" "$GATEWAY_URL/admin/books"
```

期望：

- `/health` 可用。
- `/capabilities` 不泄露敏感环境细节。
- mobile token 只能访问 `/auth/*`、`/mobile/*`、mobile RAG/AI 和 MP3 下载。
- admin token 只能访问 `/admin/*` 和后台 AI 代理，不能作为 mobile token 使用。

## 3. 发布后 package 验收

优先使用 production-pipeline verify：

```bash
npm run production-pipeline -- verify \
  --run <run.json|runDir|runId> \
  --gateway-url "$GATEWAY_URL" \
  --gateway-token "$MOBILE_TOKEN" \
  --gateway-admin-token "$ADMIN_TOKEN"
```

验收点：

- `adminBooks.bookListed` 为通过。
- `mobileSession.allowedVisibilities` 与目标设备角色一致。
- `library.visibilityConsistent` 为通过。
- package 章节顺序、summary/KG/embedding coverage 与本次 run artifact 一致。

## 4. 发布后 audio 验收

```bash
curl -fsS -H "Authorization: Bearer $MOBILE_TOKEN" "$GATEWAY_URL/mobile/books/<bookId>/audio"
curl -fsS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$GATEWAY_URL/admin/books/<bookId>/audio/refresh"
curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" "$GATEWAY_URL/admin/audio"
```

验收点：

- `/mobile/books/<bookId>/audio` 中章节数与远端 `audio.json` 一致。
- 抽样 MP3 下载返回 200，`sizeBytes` 与 manifest/report 一致。
- Admin refresh 后 `audioChapterCount`、`missingChapterCount`、`totalSizeBytes` 与实际文件一致。

## 5. APK 发布验收

```bash
npm run gateway:publish-android-apk
curl -fsS "$GATEWAY_URL/downloads/android-app.json"
curl -fsSI "$GATEWAY_URL/downloads/novel_gateway.apk"
npm run gateway:apk-metadata-smoke -- --gateway-url "$GATEWAY_URL"
```

验收点：

- `android-app.json` 的 `versionName`、`versionCode`、`buildNumber`、`gitCommit` 与 `gateway-android-app/build-info.json` 一致。
- `latestUrl` 指向 `/downloads/novel_gateway.apk`。
- versioned APK 文件存在，固定 latest APK 与 versioned APK 大小一致。
- APK 内 `assets/capacitor.config.json` 包含 `android.loggingBehavior=none`，logcat 不输出 Authorization、mobile/admin token 或 Capacitor methodData 下载参数。
- 手机端只有线上 `versionCode` 高于本机时显示“下载并安装”。

## 6. 公网安全验收

```bash
curl -i "$PUBLIC_GATEWAY_URL/admin/ui"
curl -i "$PUBLIC_GATEWAY_URL/health"
curl -i "https://<public-ip>:8888/health"
curl -i "http://novel.gwaves.net:8888/downloads/novel_gateway.apk"
npm run gateway:security-smoke -- --gateway-url "$PUBLIC_GATEWAY_URL"
```

期望：

- 公网 `/admin/ui` 返回 403 或被 Nginx 阻断。
- `$PUBLIC_GATEWAY_URL/health` 在严格 TLS 校验下返回 200；若出现 self-signed certificate 或 trust anchor 错误，真机和 Node smoke 都不得视为通过。
- 明文 HTTP 访问 8888 必须返回 302，并跳转到同 path/query 的 HTTPS 8888 地址；这是 Gateway HTTPS 入口部署标准，不要求同时接管 80 端口。
- 未知 Host/IP 直连不返回 Gateway 应用内容。
- 内网或受控入口可以访问 Admin UI。

## 7. 指标定位验收

```bash
npm run gateway:ops-metrics-smoke -- \
  --gateway-url "$GATEWAY_URL" \
  --admin-token "$ADMIN_TOKEN" \
  --mobile-token "$MOBILE_TOKEN" \
  --book-id "<bookId>" \
  --device-id "<trustedDeviceId>" \
  --device-name "<trustedDeviceName>" \
  --audio-chapter-id "<chapterId>"
```

可选：如果验证默认可见书籍，可以省略 `--device-id` 和 `--device-name`；如果验证 trusted 书籍，必须传入受信设备信息。若有安全的测试 5xx 路由，可追加 `--error-url "/path-that-returns-500"`。

验收点：

- `/admin/metrics` 的请求数、错误率、下载计数和最新趋势桶能反映本次 smoke。
- `/admin/events` 能定位 401、404、package/audio 下载的 route、status、bookId；提供 `--error-url` 时也要定位 5xx。
- `/admin/requests` 能定位 package/audio 的 `downloadKind` 和 `bookId`。

## 8. 回滚

默认先 dry-run；确认路径、bookId、version 和 token 后再追加 `--apply`。

package：

```bash
npm run gateway:rollback-release -- \
  --target package \
  --book-id "<bookId>" \
  --package-file "<backup-package.json>" \
  --gateway-url "$GATEWAY_URL" \
  --gateway-token "$ADMIN_TOKEN"
```

audio：

```bash
npm run gateway:rollback-release -- \
  --target audio \
  --book-id "<bookId>" \
  --backup-audio-dir "<backup-audio/books/bookId>" \
  --gateway-audio-dir "$GATEWAY_AUDIO_DIR"
```

APK：

```bash
npm run gateway:rollback-release -- \
  --target apk \
  --downloads-dir "$GATEWAY_DOWNLOADS_DIR" \
  --version "<version>"
```

验收点：

- package 回滚后重新执行 production-pipeline verify，确认 Admin 书目、mobile 可见性和 package coverage。
- audio 回滚后执行 admin audio refresh，确认 `audio.json`、Admin 汇总和抽样 MP3 下载一致。
- APK 回滚后确认 `/downloads/android-app.json`、`novel_gateway.apk`、versioned APK 一致，并做必要真机更新检查。
- 配置：生产 token、Nginx 配置、docker compose 修改前先备份；配置回滚不走本脚本，按目标机器备份恢复。

## 9. 记录模板

```text
日期：
发布对象：
版本/runId：
验证命令：
自动化结果：
真实 Gateway 结果：
真机结果：
发现问题：
回滚方式：
结论：
```
