# Novel Gateway Android App

这是面向 Gateway 云端服务的当前 Android 客户端工程。后续 Gateway 移动端能力都应优先在本目录开发；旧 `mobile-app/` 局域网同步客户端目录已删除，历史实现可从 Git 记录查阅。

## 当前能力

- 保存 Gateway 地址、token、设备名和稳定设备信息。
- 使用 `GET /auth/session` 验证连接，并通过 `X-Device-*` 请求头登记设备。
- 根据 Gateway 返回的 default/trusted/disabled 设备角色处理云端访问和本地缓存策略。
- 使用 `GET /mobile/books` 拉取书库，展示概要、知识图谱、RAG、package 和音频覆盖率。
- 使用 `GET /mobile/books/:bookId/package` 与 `/mobile/books/:bookId/package/download` 读取并缓存单书移动数据包。
- 支持章节阅读、阅读进度、阅读偏好、概要查看、知识图谱/RAG 搜索。
- 支持本地系统 TTS，也支持 Gateway 音频清单、MP3 下载和 manifest timeline 播放章节音频，并在正文中高亮当前播放片段。
- 支持按书/章节管理 MP3 缓存，避免缓存状态串书。
- 支持检查 Gateway 发布的 Android APK 更新，并交由 Android 系统确认安装。
- 日志避免输出 bearer token、上游模型密钥和设备敏感标识。

## 本地开发

```bash
npm --prefix gateway-android-app install
npm --prefix gateway-android-app run dev
```

## Android

首次生成原生工程：

```bash
npm --prefix gateway-android-app run android:add
```

同步 Web 构建到 Android：

```bash
npm --prefix gateway-android-app run android:sync
```

构建 debug APK：

```bash
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH" \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
npm run gateway-android:android:build
```

产物路径：

```text
gateway-android-app/android/app/build/outputs/apk/debug/novel_gateway-v<version>-debug.apk
```

发布到 Gateway 下载目录：

```bash
npm run gateway:publish-android-apk
```

发布后固定下载名为 `novel_gateway.apk`，对应 URL 为 `/downloads/novel_gateway.apk`。

版本号规则见 [docs/versioning.md](docs/versioning.md)。App 内、Android 安装信息、Gateway 请求头和 `/downloads/android-app.json` 都使用同一份构建信息。

该 App 使用独立包名 `com.gwaves.novelreader.gateway`。
