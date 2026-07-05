# Gateway Android 版本管理规则

Gateway Android App 使用同一份构建信息驱动 App 内展示、Gateway 请求头、Android 安装版本和 APK 发布元数据。

## 版本字段

- `baseVersion`：产品基础版本，来自 `gateway-android-app/package.json` 的 `version`，应与项目根 `package.json` 的 release 版本保持一致，例如 `0.7.0`。
- `buildNumber`：自动累计构建号。默认取当前 Git 仓库的 commit count；CI 或手动发布可以用 `GATEWAY_ANDROID_BUILD_NUMBER` 覆盖，覆盖值必须是正整数。
- `gitCommit`：构建时的 12 位 Git commit。
- `dirty`：构建时工作区是否有未提交改动。正式发布应尽量为 `false`。
- `versionName`：用户可见版本，格式为 `baseVersion+build.<buildNumber>.g<gitCommit>`，dirty 构建追加 `.dirty`。
- `versionCode`：Android 用于判断安装包新旧的递增整数，计算规则为 `major * 100000000 + minor * 1000000 + patch * 10000 + buildNumber`。

示例：

```text
0.7.0+build.228.g3fcfd98db346
versionCode: 7000228
```

## 自动生成

每次运行以下命令前都会自动生成 `gateway-android-app/build-info.json` 和 `gateway-android-app/src/generated/buildInfo.ts`：

```bash
npm --prefix gateway-android-app run dev
npm --prefix gateway-android-app run test
npm --prefix gateway-android-app run build
npm run gateway-android:android:build
```

这两个生成文件不提交到 Git。它们只反映当前构建环境。

## 展示与发布

- App 设置页顶部显示 `versionName`、`buildNumber`、`versionCode`、`gitCommit` 和构建时间。
- Gateway 请求头 `X-App-Version` 使用同一个 `versionName`。
- Android `versionName` 和 `versionCode` 从 `build-info.json` 读取，因此安装系统里显示的版本和 App 内一致。
- `npm run gateway:publish-android-apk` 会把同一份构建信息写入 `/downloads/android-app.json`，并发布：
  - `/downloads/novel_gateway.apk`
  - `/downloads/novel_gateway-v<versionName>-debug.apk`

## 发布建议

常规发布建议先提交代码，再构建 APK。这样 `dirty=false`，并且每次 commit 都会自然产生新的 `buildNumber`。

如果需要同一 commit 上多次发布可区分的构建，使用：

```bash
GATEWAY_ANDROID_BUILD_NUMBER=<递增整数> npm run gateway-android:android:build
```
