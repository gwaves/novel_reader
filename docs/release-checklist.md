# 发布检查清单

更新时间：2026-07-01

本文档把正规化测试、真实 Gateway 验收和回滚治理串成固定发布流程。

## 1. 发布前

- 确认范围：PC Web、本地 API、Gateway、Admin UI、Gateway Android、production-pipeline、内容 package/audio/APK。
- 确认风险：是否涉及鉴权、visibility、数据删除、package/audio 发布、APK 安装、模型调用或数据库恢复。
- 更新文档：涉及用例矩阵、runbook、部署方式或用户可见行为时，同步更新对应文档。
- 检查工作树：用 `git diff --stat` 和 `git ls-files --others --exclude-standard` 确认只包含本次范围。

## 2. 自动化回归

按影响范围选择：

```bash
npm run test:unit
npm run test:e2e
npm run local-db:test
npm run production-pipeline:test
npm --prefix gateway run test
npm --prefix gateway/admin-ui run test
npm --prefix gateway-android-app run test
npm run build
npm --prefix gateway run build
npm --prefix gateway/admin-ui run build
npm --prefix gateway-android-app run build
```

失败处理：

- P0/P1 失败不得发布。
- 与本次无关的既有失败必须记录原因和负责人。
- 跳过真机或真实 Gateway 验收时必须写明边界。

## 3. Gateway 发布验收

- 运行 production-pipeline verify，带 mobile token 和 admin token。
- 确认 Admin 书目、mobile session 可见性、`/mobile/books` 一致。
- 确认 package 章节、summary/KG/embedding coverage 与 run artifact 一致。
- 确认 audio manifest、抽样 MP3 下载、Admin audio refresh 一致。
- 运行 `npm run gateway:ops-metrics-smoke -- --gateway-url "$GATEWAY_URL" --admin-token "$ADMIN_TOKEN" --mobile-token "$MOBILE_TOKEN" --book-id "<bookId>" --audio-chapter-id "<chapterId>"`，确认 `/admin/metrics`、`/admin/events`、`/admin/requests` 能定位本次 401/404/download smoke。

## 4. APK 发布验收

- 构建 Gateway Android App 并生成 build info。
- 运行 `npm run gateway:publish-android-apk`。
- 校验 `android-app.json`、固定 latest APK、versioned APK 三者一致。
- 真机检查更新：高版本显示下载并打开系统安装确认；同版本或低版本显示已是最新。

## 5. 公网与安全

- `/admin/ui` 公网禁止访问。
- 未知 Host/IP 直连不返回 Gateway 应用内容。
- admin token 不能访问 mobile API，mobile token 不能访问 admin API。
- 错误响应不得泄露上游 API key、数据目录或生产 token。

## 6. 回滚准备

- package/audio 发布前确认上一版 artifact 或远端快照存在。
- APK 发布前保留上一版 versioned APK 和 `android-app.json`。
- 发布前 dry-run 对应回滚命令：`npm run gateway:rollback-release -- --target package|audio|apk ...`。
- Gateway 配置发布前备份 Nginx、compose、环境变量文件。
- 回滚后重新执行健康检查、package/audio verify 和必要真机检查。

## 7. 发布记录

```text
发布日期：
发布人：
commit/branch：
PR：
发布对象：
自动化命令和结果：
真实 Gateway 验收：
真机验收：
未覆盖风险：
回滚点：
线上观察：
结论：
```
