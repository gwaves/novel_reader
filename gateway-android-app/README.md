# Novel Gateway Android App

这是面向 Gateway 云端服务的新 Android 客户端工程。它与现有 `mobile-app/` 分离，后续 Gateway 移动端能力都应优先在本目录开发，避免影响旧移动端。

## 当前能力

- 保存 Gateway 地址、token 和设备名。
- 使用 `GET /auth/session` 验证连接，并通过 `X-Device-Name` 登记设备。
- 使用 `GET /mobile/books` 拉取书库。
- 使用 `GET /mobile/books/:bookId/package` 读取并缓存单书移动数据包。
- 使用 Gateway 音频清单、MP3 下载和 manifest timeline 播放章节音频，并在正文中高亮当前播放片段。

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
gateway-android-app/android/app/build/outputs/apk/debug/novel_gateway.apk
```

该 App 使用独立包名 `com.gwaves.novelreader.gateway`，不会覆盖旧 `mobile-app/` 生成的 Android 应用。
