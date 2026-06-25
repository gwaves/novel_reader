# Novel Gateway Android App

这是面向 Gateway 云端服务的新 Android 客户端工程。它与现有 `mobile-app/` 分离，后续 Gateway 移动端能力都应优先在本目录开发，避免影响旧移动端。

## 当前能力

- 保存 Gateway 地址、token 和设备名。
- 使用 `GET /auth/session` 验证连接，并通过 `X-Device-Name` 登记设备。
- 使用 `GET /mobile/books` 拉取书库。
- 使用 `GET /mobile/books/:bookId/package` 读取单书移动数据包摘要。

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
