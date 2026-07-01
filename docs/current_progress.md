2026-07-01 更新：Let's Encrypt 证书与小米真机 Gateway 联网验收通过，并修复设备并发写入 bug。
- 复测真实 Gateway 证书：`novel.gwaves.net:8888` 当前证书 issuer 为 Let's Encrypt `YE2`，严格 TLS `curl -I https://novel.gwaves.net:8888/health` 返回 200；`npm run gateway:security-smoke` 与 `npm run gateway:apk-metadata-smoke -- --gateway-url https://novel.gwaves.net:8888` 均通过。
- 小米真机 `23127PN0CC` 安装临时 build 238 测试包后，`/auth/session` 返回 200，`/mobile/books` 返回 5 本 default 可见书籍，红楼梦/三国演义/西游记等 audio catalog 返回 200；证书替换前的 `Trust anchor for certification path not found` 已消失。
- 真机并发拉取多个 audio catalog 时发现真实 Gateway bug：多个请求同时更新 `devices.json`，`writeDeviceRegistry()` 的临时文件名只含 `pid + Date.now()`，同毫秒冲突会导致 `rename ... devices.json.tmp-* -> devices.json` 的 ENOENT 500。
- 修复 `gateway/src/device-store.ts`：设备注册表写入临时文件名追加 `randomUUID()`，避免并发写入 tmp 文件碰撞；新增 `handles concurrent mobile device touches without temp file collisions` 回归，12 个并发 `/auth/session` 均返回 200。
- 已运行 `npm --prefix gateway run build`、目标 Vitest、`npm --prefix gateway run test`（60 个 Gateway 用例全部通过）；已同步并重建 192.168.88.100 Gateway，复测 5 个 default 书籍 audio catalog 并发请求均为 200，真机重启 App 后不再出现 `devices.json.tmp` 500。
- `OPS-DEPLOY-001` 已从 Partial 收口为 Existing；证书部署约定已写入 `gateway/.env.example`、`gateway/docker-compose.yml`、`gateway/nginx/gateway-https.conf` 和 `gateway/docs/deployment.md`。

2026-07-01 更新：88.100 Gateway 已切换到 Let's Encrypt 证书。
- 根据真机“检查更新”报错 `Trust anchor for certification path not found`，修正 `gateway-https` 的证书挂载和部署说明，避免继续使用 `tls/gateway.crt` 自签证书。
- 真实 Gateway 部署目录仍为 `/home/gwaves/novel-reader-gateway`；公网 HTTPS 证书来源改为 `/home/gwaves/letsencrypt/config`，Compose 将该目录挂载到容器内 `/etc/letsencrypt`。
- Nginx 现在固定读取 `/etc/letsencrypt/live/novel.gwaves.net/fullchain.pem` 与 `/etc/letsencrypt/live/novel.gwaves.net/privkey.pem`；`gateway/docker-compose.yml`、`gateway/nginx/gateway-https.conf`、`gateway/.env.example` 和 `gateway/docs/deployment.md` 已同步更新。
- 已同步配置到 192.168.88.100 并重建 `gateway-https`；远端 `docker compose exec gateway-https nginx -t` 通过，仅保留 Nginx `listen ... http2` deprecation warning。
- 严格 TLS 验收已通过：`openssl s_client -connect novel.gwaves.net:8888 -servername novel.gwaves.net -verify_return_error` 返回 Let's Encrypt 链和 `Verify return code: 0 (ok)`；`curl -I https://novel.gwaves.net:8888/health` 返回 HTTP/2 200；`/downloads/android-app.json` 可严格 HTTPS 读取。

2026-07-01 更新：OPS 回滚演练、公网安全和小米真机首轮验收推进。
- `OPS-ROLLBACK-001` 已在临时测试 Gateway 完成受控演练：使用独立 `GATEWAY_DATA_DIR/GATEWAY_AUDIO_DIR/GATEWAY_DOWNLOADS_DIR` 和 `rollback-book` 构造错误版本，再对 package/audio/APK 分别执行 dry-run 与 `--apply`。
- package 回滚通过测试 Gateway admin `PUT /admin/books/rollback-book/package` 恢复，验证 `/admin/books` 与 `/admin/books/rollback-book/package/download` 均显示备份版本书名、章节和正文。
- audio 回滚将错误目录替换为备份目录，验证 `audio.json` 恢复为 `good.mp3`、`durationMs=2222`；APK 回滚将 versioned APK 恢复为 `ai_novel_reader.apk`，并写入带 `rolledBackAt` 的 `android-app.json`。
- 公网安全实测：真实 Gateway `http://novel.gwaves.net:8888/downloads/ai_novel_reader.apk` 已返回 302 到 HTTPS；公网 `/admin/ui` 返回 403；未知 Host 直连返回空响应/非 200；内网 `health/capabilities/adminBooks/mobileSession` 均为 200。
- 发现部署健康阻断：当前 8888 TLS 证书为自签 `CN=novel.gwaves.net`，严格 TLS 下 `npm run gateway:apk-metadata-smoke` 与新增严格 TLS security smoke 均失败；关闭 TLS 校验后 APK metadata 本身仍全部通过。
- 小米真机 `23127PN0CC`（Android 14）已安装 APK `0.2.0+build.237.g0da2d9e01844` / `versionCode=2000237` 并能启动进程；真机连接 Gateway 被同一证书问题阻断，日志为 `SSLHandshakeException: Trust anchor for certification path not found`。
- `gateway/scripts/security-smoke.sh` 已新增严格 TLS `/health` 检查，避免自签证书再次绕过公网安全门禁；部署说明、Runbook 和发布清单已把可信 TLS 证书列为公网/真机验收标准。

2026-07-01 更新：8888 明文 HTTP 跳 HTTPS 固化为部署标准。
- `gateway/docs/deployment.md` 已把 `http://novel.gwaves.net:8888/...` 返回 `302 Location: https://novel.gwaves.net:8888/...` 写入公网 HTTPS 入口部署标准，并明确不要求本服务接管 80 端口。
- `docs/release-checklist.md` 已把 8888 明文到 HTTPS 的 302 作为公网与安全发布必检项。
- `docs/operations-runbook.md` 已补充对应 curl 验收命令和期望结果。

2026-07-01 更新：真实 Gateway 8888 明文访问已自动 302 到 HTTPS。
- 根据真机下载入口体验反馈，只处理 `http://novel.gwaves.net:8888/...` 这种明文 HTTP 打到 8888 TLS 端口的场景，不新增或接管 80 端口。
- `gateway/nginx/gateway-https.conf` 为两个 8443 server 增加 nginx `error_page 497 =302 ...`：`novel.gwaves.net` Host 会跳转到 `https://$host:8888$request_uri`，默认 server 会跳转到 `https://novel.gwaves.net:8888$request_uri`。
- 已同步配置到 `192.168.88.100:/home/gwaves/novel-reader-gateway/nginx/gateway-https.conf`，并重启 `gateway-https` 容器。
- 重启时发现远端 `tls/` 目录只有 `gateway.crt/gateway.key`，而 nginx 配置引用 `fullchain.pem/privkey.pem`；已在远端 `tls/` 补充兼容 symlink：`fullchain.pem -> gateway.crt`、`privkey.pem -> gateway.key`，服务恢复正常。
- 远端本机验证：`curl -I -H "Host: novel.gwaves.net" http://127.0.0.1:8888/downloads/ai_novel_reader.apk` 返回 `302 Location: https://novel.gwaves.net:8888/downloads/ai_novel_reader.apk`；HTTPS 同一路径返回 200，APK content-type 与大小正常。

2026-07-01 更新：当前版本已部署到真实 Gateway，并发布 Android APK build 237 供真机验证。
- 已在本地完成当前版本编译：`gateway` build、`gateway-android-app` Web build、`gateway/admin-ui` build，以及 Gateway Android debug APK build。
- 已将 `gateway/` 同步到 `192.168.88.100:/home/gwaves/novel-reader-gateway`，同步时保留远端 `.env`、`data/`、`audio/`、`backups/`、`tls/` 等运行数据；随后执行 `docker compose build gateway && docker compose up -d gateway` 完成服务更新。
- 更新后真实 Gateway smoke 通过：`/health`、`/mobile/capabilities`、`/admin/books`、`/mobile/session` 均返回 200；token 只从远端 `.env` 读取到进程内使用，未写入文档。
- 首次生成 build 234 时发现远端已是相同 `versionCode=2000234`，为避免客户端不触发升级，最终以 `GATEWAY_ANDROID_BUILD_NUMBER=237` 构建 clean APK。
- 已发布 APK 到真实 Gateway downloads：`versionCode=2000237`，固定 latest 为 `/downloads/ai_novel_reader.apk`，版本化文件以远端 `android-app.json` 为准。
- 远端 manifest 与文件校验通过：`android-app.json` 指向 build 237，latest/versioned APK 均存在且大小一致。
- 已运行 `npm run gateway:apk-metadata-smoke -- --gateway-url https://novel.gwaves.net:8888`，全部断言通过；本轮更新前的下载目录已备份到远端 `backups/apk-20260701-115001`。
- 真实设备安装和升级体验由用户继续验证；剩余真实 Gateway 治理缺口仍是：在测试 Gateway 上执行发布回滚 `--apply` 演练并记录 package/audio/APK 恢复结果。

2026-07-01 更新：真实 Gateway APK 发布元数据 smoke 验收完成。
- 根据 `docs/test-case-matrix.md` 收口 `OPS-PUBLISH-003`：真实 Gateway `https://novel.gwaves.net:8888` 的 `android-app.json`、固定 latest APK 和 versioned APK 必须一致。
- 新增 `gateway/scripts/apk-metadata-smoke.mjs` 与 npm 入口 `gateway:apk-metadata-smoke`：校验 `/downloads/android-app.json` schema、versionName/versionCode/buildNumber/gitCommit、固定 `latestFileName/latestUrl`、`versionedFileName/versionedUrl` 对齐，以及 latest/versioned APK 的 HTTP 200、Android APK content-type、content-length 大于 0 且大小一致。
- 修复根项目 `gateway:ops-metrics-smoke` 与新增 `gateway:apk-metadata-smoke` 的 npm 参数透传，确保 `npm run ... -- --gateway-url ...` 能正确传入 gateway 子包脚本。
- 已在真实 Gateway 运行 `npm run gateway:apk-metadata-smoke -- --gateway-url https://novel.gwaves.net:8888`，全部断言通过；现场 manifest 为 `versionName=0.2.0+build.234.g3fd08e7fe041.dirty`、`versionCode=2000234`，latest/versioned APK 均返回 200，大小均为 4,270,272 bytes。
- `docs/operations-runbook.md` 和 `docs/release-checklist.md` 已补充 APK metadata smoke 命令。
- `docs/test-case-matrix.md` 已把 `OPS-PUBLISH-003` 标记为 Existing。
- 剩余真实 Gateway 治理缺口仍是：在测试 Gateway 上执行发布回滚 `--apply` 演练并记录 package/audio/APK 恢复结果。

2026-07-01 更新：PC EPUB spine 顺序导入回归测试补齐。
- 根据 `docs/test-case-matrix.md` 补齐 `PC-IMPORT-004`：EPUB manifest 顺序与 OPF spine 顺序不一致时，导入章节必须按照 spine 顺序排列，正文内容可读。
- 扩展 `tests/e2e/core-flows.spec.ts`：新增最小未压缩 EPUB ZIP fixture 生成器，包含 `META-INF/container.xml`、`OEBPS/content.opf` 和 3 个 XHTML 章节；manifest 故意按第一/第三/第二章声明，spine 按第二/第一/第三章声明。
- 新增 `imports EPUB chapters in OPF spine order` Playwright 用例：导入 `spine-order-sample.epub` 后，先看到“第二章 先行章节”，连续点击“下一章”依次进入“第一章 后到章节”和“第三章 终章线索”，并断言各章正文可见。
- 已运行 `npx playwright test tests/e2e/core-flows.spec.ts --grep "EPUB chapters in OPF spine order"`，目标用例通过。
- 已运行 `npx playwright test tests/e2e/core-flows.spec.ts`，结果 1 个测试文件、11 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `PC-IMPORT-004` 标记为 Existing。

2026-07-01 更新：真实 Gateway 运维指标 smoke 验收完成。
- 根据 `docs/test-case-matrix.md` 收口 `OPS-METRIC-001`：在真实 Gateway `https://novel.gwaves.net:8888` 上制造 401、404、package download 和 audio download，并验证 `/admin/metrics`、`/admin/events`、`/admin/requests` 能定位 route、status、bookId 和 downloadKind。
- 真实环境来源：`192.168.88.100:/home/gwaves/novel-reader-gateway/.env`；执行时只读取 token 到进程内使用，文档和日志不记录 token 值。
- 真实验收书籍：`9679077f-2288-4bc7-9080-854784fc7f94`（妖刀记，trusted 可见性）；使用受信设备 `7c6bd6bb-e097-4c6c-9422-ec4b6d1d5632` / `LT pad`，音频章节 `1-第1卷第1章：寄魂妖刀，四大剑门`。
- 修复 `gateway/scripts/ops-metrics-smoke.mjs`：`jsonRequest()` 不再复用已读取 body 的 `request()`，避免真实 smoke 读取 admin JSON 时触发 `Body is unusable`；新增 `--device-id` 与 `--device-name` 参数，支持 trusted 书籍验收。
- 已运行真实 smoke，全部断言通过：requests last24Hours/errorRate、package download topBooks、request/download 趋势桶、events 401/404/package/audio、requests package/audio downloadKind 与 bookId 均定位成功。
- `docs/operations-runbook.md` 和 `docs/release-checklist.md` 已补充 trusted 书籍 smoke 的设备参数说明。
- `docs/test-case-matrix.md` 已把 `OPS-METRIC-001` 标记为 Existing。
- 剩余真实 Gateway 治理缺口仍是：在测试 Gateway 上执行发布回滚 `--apply` 演练并记录 package/audio/APK 恢复结果。

2026-07-01 更新：PC 超长单章导入与滚动展示回归测试补齐。
- 根据 `docs/test-case-matrix.md` 补齐 `PC-IMPORT-005`：单章超长 TXT 导入后，阅读器必须能打开章节、渲染首尾正文，并且阅读容器可稳定滚动到底部。
- 扩展 `tests/e2e/core-flows.spec.ts`：新增 `imports and scrolls a very long single-chapter TXT novel`，构造 260 段单章文本，导入 `long-single-chapter.txt` 后断言章节标题、书名、首段和末段正文均可见于 DOM。
- 该用例直接操作 `.chapter-reader` 滚动容器，断言 `scrollHeight > clientHeight`，再滚到底部并确认 `scrollTop + clientHeight` 接近 `scrollHeight`，覆盖超长章节展示和滚动能力。
- 已运行 `npx playwright test tests/e2e/core-flows.spec.ts --grep "very long single-chapter"`，目标用例通过。
- 已运行 `npx playwright test tests/e2e/core-flows.spec.ts`，结果 1 个测试文件、10 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `PC-IMPORT-005` 标记为 Existing。
- 剩余真实 Gateway 治理缺口仍是：在测试 Gateway 上执行回滚 `--apply` 演练并记录 package/audio/APK 恢复结果。

2026-07-01 更新：PC 阅读偏好刷新持久化回归测试补齐。
- 根据 `docs/test-case-matrix.md` 补齐 `PC-READ-002`：修改阅读页字号、行高、内容宽度、段距和主题后，刷新页面再继续阅读时，控件值和阅读区样式必须保持上次偏好。
- 增强 `tests/e2e/core-flows.spec.ts` 的本地 SQLite mock：`/api/state` 现在会在测试进程内记住 `PUT` 写入的 state，reload 后按真实本地数据库语义返回；针对该用例补充 `/api/books/:id/chapters` 与 `library-state` mock，覆盖刷新水合路径。
- 新增 `persists reader preferences after page reload` Playwright 用例：导入 TXT、通过真实阅读页控件修改偏好、等待保存 payload 确认包含最终偏好和书籍，再 reload、点击“继续阅读”，断言 range/select 值、夜间主题 class 和正文 `font-size`。
- 已运行 `npx playwright test tests/e2e/core-flows.spec.ts --grep "persists reader preferences"`，目标用例通过。
- 已运行 `npx playwright test tests/e2e/core-flows.spec.ts`，结果 1 个测试文件、9 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `PC-READ-002` 标记为 Existing。
- 剩余真实 Gateway 治理缺口仍是：带真实 URL/token/bookId 执行 `gateway:ops-metrics-smoke`，以及在测试 Gateway 上执行回滚 `--apply` 演练并记录结果。

2026-07-01 更新：Gateway Android RAG 搜索成功与兜底回归测试补齐。
- 根据 `docs/test-case-matrix.md` 补齐 `AND-RAG-001`：受信设备访问可见书籍时，Android 端必须能调用 Gateway embedding 搜索/答案生成；embedding 失败时改用本地关键词兜底，并显示中文状态而不是红底误报。
- 导出 `gateway-android-app/src/App.tsx` 中既有 `searchGatewayRag()` 与 `gatewayGenerateRagAnswer()` helper，便于单元测试直接覆盖 Gateway 调用契约，不改变运行时业务逻辑。
- 扩展 `gateway-android-app/src/App.audioPlayback.test.ts`：新增 `/ai/search` 成功路径测试，断言 mobile token/device headers、`bookId/query/limit` 请求体、结果归一化和无效 `chapterId` 过滤。
- 同文件新增 `/ai/rag-answer` 成功路径测试，断言答案生成请求体、鉴权 headers、答案文本和 citation 过滤；保留既有 token 失败时 `ragFallbackStatus()` 中文兜底提示测试。
- 已运行 `npm --prefix gateway-android-app run test`，结果 5 个测试文件、32 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `AND-RAG-001` 标记为 Existing。
- 剩余真实 Gateway 治理缺口仍是：带真实 URL/token/bookId 执行 `gateway:ops-metrics-smoke`，以及在测试 Gateway 上执行回滚 `--apply` 演练并记录结果。

2026-07-01 更新：TXT GB18030 导入自动识别回归测试补齐。
- 根据 `docs/test-case-matrix.md` 补齐 `PC-IMPORT-002`：GB18030 编码 TXT 导入时，系统必须自动 fallback 解码，不需要用户手动选择编码，章节标题和正文不能出现乱码。
- `decodeTextFile()` 优先使用现代 `File.arrayBuffer()`，旧环境再回退 `FileReader`；解码逻辑抽到 `decodeTextBuffer()`，保留 UTF-16 BOM 识别、UTF-8 fatal 校验和 GB18030 fallback。
- 导出 `parseImportedBook()` 供单元测试直接覆盖真实导入解析路径。
- 扩展 `tests/unit/useReaderState.test.ts`：使用真实 GB18030 字节构造 TXT `File`，断言导入标题、两章标题和中文正文均正确。
- 已运行 `npx vitest run tests/unit/useReaderState.test.ts --reporter=dot`，结果 1 个测试文件、21 个用例全部通过。
- 已运行 `npm run test:unit`，结果 2 个测试文件、23 个用例全部通过。
- 已运行 `npm run build`，TypeScript 与 Vite build 通过；仅保留既有 chunk size 提示。
- `docs/test-case-matrix.md` 已把 `PC-IMPORT-002` 标记为 Existing。

2026-07-01 更新：Admin UI 数据包覆盖率未知显示回归测试补齐。
- 根据 `docs/test-case-matrix.md` 补齐 `ADMIN-PKG-001`：数据包页必须正确显示 summary/KG/embedding 覆盖率；当 Gateway package 缺少 coverage 元数据时，UI 必须显示 `-`，不能误当成 0% 或缺失章节。
- 扩展 `gateway/admin-ui/src/App.test.tsx`：在真实 API mock 的数据包页中定位“旧数据包”行，断言覆盖率显示 `S - · KG - · E -`，并且缺失章节显示“无”。
- 已运行 `npm --prefix gateway/admin-ui run test`，结果 1 个测试文件、17 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `ADMIN-PKG-001` 标记为 Existing。

2026-07-01 更新：Production Pipeline doctor 缺配置聚合回归测试补齐。
- 根据 `docs/test-case-matrix.md` 补齐 `PIPE-JOB-001`：job doctor 遇到缺 `bookId`、`stages`、模型配置、publish target 或 verify token 时，必须在一次 preflight 中尽量聚合输出明确缺项，而不是因为首个 parse/hydrate 错误提前停止。
- 增强 `production-pipeline/src/cli.mjs`：doctor 使用宽松的 `hydrateDoctorJobConfig()`，只在 import source 文件真实存在时推导 bookId；缺 source 或缺 bookId 时继续进入 preflight，收集后续 stage/publish/verify 缺项。
- doctor 的 `job.stages` 检查改为基于原始 job 是否显式声明 stages，不受 run 阶段历史默认 `package` 的行为影响。
- 扩展 `production-pipeline/test/import.test.mjs`：新增缺配置 doctor 回归，断言文本输出和 JSON 输出都包含 `job.bookId`、`job.stages`、`stage.summary.config`、`publish.target`、`verify.gatewayToken` 等失败项。
- 复核同一测试套件中已有 LLM scheduler 回归，覆盖并发权重、排队、borrowIdle 禁用和 audio 共享池调度；`docs/test-case-matrix.md` 已把 `PIPE-SCHED-001` 一并校正为 Existing。
- 已运行 `node --test --test-name-pattern="reports missing job fields" production-pipeline/test/import.test.mjs`，目标用例通过。
- 已运行 `node --test --test-name-pattern="preflights|merges gateway defaults" production-pipeline/test/import.test.mjs`，doctor/gateway merge 相关 3 个用例通过。
- 已运行 `node --test production-pipeline/test/import.test.mjs`，结果 1 个测试套件、35 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `PIPE-JOB-001` 与 `PIPE-SCHED-001` 标记为 Existing。

2026-07-01 更新：Gateway audio catalog book-level summary 回归测试补齐。
- 根据 `docs/test-case-matrix.md` 补齐 `GW-AUDIO-001`：mobile audio catalog 除章节音频清单外，还必须返回 book-level summary，便于移动端和运维判断音频覆盖率、缺失章节和总大小。
- 增强 `/mobile/books/:bookId/audio`：响应保留原有 `chapters`，新增 `summary`，包含 `bookId`、`chapterCount`、`audioChapterCount`、`missingChapterCount`、`missingChapterIds`、`coverage` 和 `totalSizeBytes`。
- `readBookPackageChapterIds()` 对 package 文件缺失降级为空数组，避免“有书但暂未发布 package”的 audio catalog 请求被 summary 计算误伤为 500。
- 扩展 `gateway/src/app.test.ts`：构造 2 章 package 和 1 章音频，断言 audio catalog summary 报告缺失 `chapter-2`、覆盖率 0.5 和真实 MP3 大小。
- 顺手修复 `gateway/src/app.test.ts` 中既有 fetch mock 类型问题，移除 `RequestInfo` 和错误的三参 `jsonResponse()` 调用，使 Gateway build 重新成为可用门禁。
- 已运行 `npm --prefix gateway run build`，TypeScript 编译通过。
- 已运行 `npm --prefix gateway run test`，结果 1 个测试文件、59 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `GW-AUDIO-001` 标记为 Existing。

2026-07-01 更新：Gateway package 下载与未知书籍错误回归测试补齐。
- 根据 `docs/test-case-matrix.md` 补齐 `GW-BOOK-002` 与 `GW-BOOK-003`：mobile package download 必须受 mobile token 保护，返回完整 package JSON、正确下载文件名和 content length；未知 bookId 的 package download 必须返回稳定 `book_not_found`。
- 扩展 `gateway/src/app.test.ts`：新增 protected mobile package download 回归，确认未授权返回 401、授权后返回 `book-a-package-full.json`，且完整 JSON 保留 embeddings/chunks；新增 unknown package download 回归，确认 404 error code 为 `book_not_found`。
- 已运行 `npm --prefix gateway run test`，结果 1 个测试文件、59 个用例全部通过。
- 曾尝试 `npm --prefix gateway run test -- --runInBand`，Vitest 不支持该 Jest 参数，命令被拒绝；后续以项目标准 Gateway test 命令作为有效验证。
- `docs/test-case-matrix.md` 已把 `GW-BOOK-002` 与 `GW-BOOK-003` 标记为 Existing。
- 剩余真实 Gateway 治理缺口仍是：带真实 URL/token/bookId 执行 `gateway:ops-metrics-smoke`，以及在测试 Gateway 上执行回滚 `--apply` 演练并记录结果。

2026-07-01 更新：Gateway 发布回滚脚本落地。
- 根据 `docs/test-case-matrix.md` 推进 `OPS-ROLLBACK-001`：新增 `gateway/scripts/rollback-release.mjs`，统一覆盖 package、audio、APK 三类发布回滚。
- 脚本默认 dry-run；只有追加 `--apply` 才会写入 Gateway 或替换本地 Gateway 目录，避免误触生产回滚。
- package 回滚会校验备份 package 的 `schemaVersion` 和 `book.id`，再通过 Gateway admin `PUT /admin/books/:bookId/package` 恢复。
- audio 回滚会校验备份 book audio 目录存在 `audio.json`，再替换 `GATEWAY_AUDIO_DIR/books/<bookId>`；执行后仍需 admin audio refresh 和 coverage 验收。
- APK 回滚会把 versioned APK 恢复为 `ai_novel_reader.apk`，并恢复或改写 `android-app.json` 的 latest/versioned 元数据。
- 新增 npm 入口：根项目 `npm run gateway:rollback-release` 与 `gateway/` 内 `npm run rollback-release`。
- `docs/operations-runbook.md` 的“回滚”章节已改成 package/audio/APK 可执行命令；`docs/release-checklist.md` 要求发布前 dry-run 对应回滚命令。
- `docs/test-case-matrix.md` 已把 `OPS-ROLLBACK-001` 标记为 `Ops Script + Real Exercise | Partial`；剩余缺口是真实 Gateway 回滚演练记录。
- 本轮检查当前 shell 与仓库内 Gateway env 文件，只发现 `gateway/.env.example`，没有可用的真实 Gateway URL/token；因此未执行真实 Gateway 指标 smoke 或回滚 `--apply` 演练。
- 下一步建议执行一次受控演练：先 dry-run package/audio/APK 回滚输入，再在测试 Gateway 上追加 `--apply` 并记录 verify、audio refresh、APK 元数据/真机结果。

2026-07-01 更新：Gateway 运维指标定位 smoke 脚本落地。
- 根据 `docs/test-case-matrix.md` 推进 `OPS-METRIC-001`：新增 `gateway/scripts/ops-metrics-smoke.mjs`，用于真实 Gateway 上制造 401、404、package download、可选 audio download 和可选 5xx，再检查 `/admin/metrics`、`/admin/events`、`/admin/requests` 是否能定位 route、status、bookId 和 downloadKind。
- 新增 npm 入口：根项目 `npm run gateway:ops-metrics-smoke` 与 `gateway/` 内 `npm run ops-metrics-smoke`。
- `docs/operations-runbook.md` 新增“指标定位验收”，给出真实 Gateway smoke 命令、可选 5xx 参数和验收点；`docs/release-checklist.md` 的 Gateway 发布验收改为要求运行该 smoke。
- 已运行 `node --check gateway/scripts/ops-metrics-smoke.mjs`，脚本语法检查通过。
- 已运行 `npm run gateway:ops-metrics-smoke`（无参数），确认脚本返回 Usage 并以失败码退出，避免误打真实环境。
- 已运行 `npm --prefix gateway run test`，结果 1 个测试文件、57 个用例全部通过。
- 曾运行 `npm --prefix gateway run typecheck`，当前失败在既有 `src/app.test.ts` 的 `RequestInfo`/参数类型问题，和本次脚本变更无关；未作为本轮通过项。
- `docs/test-case-matrix.md` 已把 `OPS-METRIC-001` 从 Ops Gap 推进为 Partial；剩余缺口是真实 Gateway 带真实 token/bookId 的 smoke 执行记录。
- 下一步建议继续补治理项：真实 Gateway 执行 `gateway:ops-metrics-smoke` 并记录结果，或补发布回滚脚本/演练记录。

2026-07-01 更新：RAG 跨章节检索 UI 回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `RAG-SEARCH-001`：跨章节 RAG 搜索必须在 UI 返回多个相关章节、原文片段、匹配类型和实体增强结果。
- 扩展 `tests/e2e/core-flows.spec.ts`：测试内 mock `/api/rag/search` 返回第 1 章和第 3 章两条结果，并返回 `entityMatches` 中的“林青”；UI 断言覆盖“识别到实体”、`相关章节（2）`、两个章节按钮、`混合/实体`匹配类型、两章概要和原文 snippet。
- 已运行 `npx playwright test tests/e2e/core-flows.spec.ts --grep "cross-chapter RAG"`，结果 chromium 目标用例通过。
- 已运行 `npm run test:unit`，结果 2 个测试文件、22 个用例全部通过。
- 已运行 `npm run build`，TypeScript 与 Vite build 通过；仅保留既有 chunk size 提示。
- `docs/test-case-matrix.md` 已把 `RAG-SEARCH-001` 标记为 Existing。
- 下一步建议转向剩余治理项：运维指标真实接入，或发布回滚脚本/演练记录。

2026-07-01 更新：AI 当前页概要生成失败项可见回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `AI-SUMMARY-002`：当前分页范围内可以批量生成缺失概要；部分章节生成失败时，成功章节继续写入，失败章节名称必须留在页面上可见。
- `runMissingSummaryBatch()` 新增可选 `onFailure` 回调，不改变原返回结构；当前页生成路径用它收集失败章节标题。
- `useReaderState()` 新增 `generateMissingSummariesForCurrentPage()`、`generatingPageSummaries`、`pageSummaryProgress` 和 `pageSummaryFailures`；阅读页章节分页栏新增“生成当前页概要”按钮、进度文案和失败章节列表。
- 扩展 `tests/unit/useReaderState.test.ts`：批量概要单章失败测试现在断言 `onFailure` 收到失败章节 `c2`。
- 扩展 `tests/e2e/core-flows.spec.ts`：当前页 3 章中 mock 第 2 次 `/api/generate` 返回 503，验证页面显示“当前页生成结束，成功 2 章，失败 1 章。”和“失败章节：第二章 雨夜传书”，并确认第 1/3 章标记“已概要”、第 2 章未误标。
- 已运行 `npx playwright test tests/e2e/core-flows.spec.ts --grep "failed chapters"`，结果 chromium 目标用例通过。
- 已运行 `npx vitest run tests/unit/useReaderState.test.ts --reporter=dot`，结果 1 个测试文件、20 个用例全部通过。
- 已运行 `npm run test:unit`，结果 2 个测试文件、22 个用例全部通过。
- 已运行 `npm run build`，TypeScript 与 Vite build 通过；仅保留既有 chunk size 提示。
- `docs/test-case-matrix.md` 已把 `AI-SUMMARY-002` 标记为 Existing。
- 下一步建议继续补 P1/P2：RAG 跨章节检索 UI 覆盖，或运维指标/回滚演练记录。

2026-07-01 更新：RAG 成功答案来源展示回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `RAG-ANSWER-001`：基于 mocked 检索结果生成答案时，页面必须展示 AI 回答，并继续保留相关章节来源。
- 扩展 `tests/e2e/core-flows.spec.ts`：智能搜索先返回 mocked RAG 结果，再 mock Ollama `/api/generate` 成功返回引用“第 1 章”的答案；测试同时验证 prompt 包含召回章节和概要上下文。
- 浏览器断言覆盖“AI 回答”区块、答案正文、`相关章节（1）`、来源章节按钮和原召回概要仍可见，避免答案生成后丢失来源。
- 已运行 `npx playwright test tests/e2e/core-flows.spec.ts --grep "generates a RAG answer"`，结果 chromium 目标用例通过。
- 已运行 `npm run test:unit`，结果 2 个测试文件、22 个用例全部通过。
- 已运行 `npm run build`，TypeScript 与 Vite build 通过；仅保留既有 chunk size 提示。
- `docs/test-case-matrix.md` 已把 `RAG-ANSWER-001` 标记为 Existing。
- 下一步建议继续补 P1/P2：AI 当前页概要失败项可见，或 RAG 跨章节检索 UI 覆盖。

2026-07-01 更新：AI 全书缺失概要批量生成回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `AI-SUMMARY-003`：全书缺失概要批量生成必须从书架入口触发，按章节调用 mocked LLM，写回全部缺失概要；大批量生成前必须有确认文案。
- 新增 `buildMissingSummaryBatchConfirmation()`：50 章以内不弹确认，超过 50 章时返回包含总章数、缺失章数、模型调用次数和 token 成本提示的确认文案；`generateMissingSummariesForBook()` 复用该 helper。
- 扩展 `tests/unit/useReaderState.test.ts`：验证 50 章不确认、51 章会生成确认文案，并保留既有“默认跳过已有概要”的覆盖策略测试。
- 扩展 `tests/e2e/core-flows.spec.ts`：导入 3 章 TXT，回到书架点击当前书“生成概要 (3)”，mock Ollama 对 3 次 `/api/generate` 返回概要 JSON，验证按钮收敛为“概要已生成”、书卡概要数为 3 章，并确认三次 prompt 分别对应第一/二/三章。
- 已运行 `npx playwright test tests/e2e/core-flows.spec.ts --grep "generates missing summaries"`，结果 chromium 目标用例通过。
- 已运行 `npx vitest run tests/unit/useReaderState.test.ts --reporter=dot`，结果 1 个测试文件、20 个用例全部通过。
- 已运行 `npm run test:unit`，结果 2 个测试文件、22 个用例全部通过。
- 已运行 `npm run build`，TypeScript 与 Vite build 通过；仅保留既有 chunk size 提示。
- `docs/test-case-matrix.md` 已把 `AI-SUMMARY-003` 标记为 Existing。
- 下一步建议继续补 P1/P2：AI 当前页概要失败项可见，或 RAG 成功答案来源展示。

2026-07-01 更新：AI 单章概要生成回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `AI-SUMMARY-001`：已配置 mocked LLM 时，当前阅读章节可以单独生成概要，并写回当前书的章节概要状态。
- 新增 `applyChapterSummary()`：把单章概要写入指定书籍，并同步当前 active book 的 `summaries`；批量概要写回也复用该 helper，避免单章/批量路径分叉。
- `useReaderState()` 新增 `generateSummaryForChapter()` 与 `generatingChapterId`；阅读页 AI 辅助栏在当前章缺概要时显示“生成本章概要”按钮，生成中禁用。
- 导出并测试 `generateWithOpenAICompatible()`：mock `/chat/completions` 返回 summary JSON，验证请求携带模型、Bearer token、`response_format: json_object`、禁用 thinking 参数，并解析为 `generatedBy: openai` 的 Summary。
- 扩展 `tests/unit/useReaderState.test.ts`：验证单章概要只写入目标书目标章节，不影响其他书同名章节。
- 扩展 `tests/e2e/core-flows.spec.ts`：导入 TXT 后点击“生成本章概要”，mock Ollama `/api/generate` 返回 Summary JSON，验证侧栏展示一句话、详细概要、要点和跳读建议。
- 已运行 `npx playwright test tests/e2e/core-flows.spec.ts --grep "generates the current chapter summary"`，结果 chromium 目标用例通过。
- 已运行 `npx vitest run tests/unit/useReaderState.test.ts --reporter=dot`，结果 1 个测试文件、19 个用例全部通过。
- 已运行 `npm run test:unit`，结果 2 个测试文件、21 个用例全部通过。
- 已运行 `npm run build`，TypeScript 与 Vite build 通过；仅保留既有 chunk size 提示。
- `docs/test-case-matrix.md` 已把 `AI-SUMMARY-001` 标记为 Existing。
- 下一步建议继续补 P1/P2：AI 概要当前页/全书批量主流程，或 RAG 成功答案来源展示。

2026-07-01 更新：AI 概要覆盖策略回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `AI-SUMMARY-005`：章节已有概要时，批量概要默认不能覆盖已有结果；只有显式传入覆盖选项时才允许重跑已有章节。
- 新增 `selectSummaryGenerationChapters()`：默认只选择缺失概要的章节，`overwriteExisting: true` 时选择全量章节；`generateMissingSummariesForBook()` 继续使用默认安全策略。
- 扩展 `tests/unit/useReaderState.test.ts`：构造 3 章和 1 条既有概要，验证默认只返回 `c2/c3`，显式覆盖才返回 `c1/c2/c3`。
- 已运行 `npx vitest run tests/unit/useReaderState.test.ts --reporter=dot`，结果 1 个测试文件、17 个用例全部通过。
- 已运行 `npm run test:unit`，结果 2 个测试文件、19 个用例全部通过。
- 已运行 `npm run build`，TypeScript 与 Vite build 通过；仅保留既有 chunk size 提示。
- `docs/test-case-matrix.md` 已把 `AI-SUMMARY-005` 标记为 Existing。
- 下一步建议继续补 P1：AI 概要单章/全书批量主流程，或 RAG 成功答案来源展示。

2026-07-01 更新：RAG 答案生成失败状态回归测试落地。
- 根据 `docs/test-case-matrix.md` 推进 `RAG-ANSWER-002`：LLM 生成答案失败时，必须提示错误，同时保留已经召回的章节结果和实体匹配。
- 新增 `src/ragAnswer.ts`：抽出 RAG 搜索结果/实体类型、答案 prompt 构建、OpenAI/Ollama answer 调用，以及 `createRagAnswerUpdate()` 状态 helper。
- `src/App.tsx` 的 RAG “生成答案”按钮改为调用 `createRagAnswerUpdate()`；失败时写入 `ragError`，但继续回填原 `ragResults` 与 `ragEntityMatches`，避免检索结果被清空。
- 新增 `tests/unit/ragAnswer.test.ts`：mock OpenAI answer generator 抛出 `503 upstream timeout`，验证返回错误文案、answer 为空、检索结果和实体匹配引用保持不变；同时验证 prompt 按章节顺序包含 snippet 和相关实体别名。
- 扩展 `tests/e2e/core-flows.spec.ts`：智能搜索拿到 mocked RAG 结果后点击“生成答案”，mock Ollama `/api/generate` 返回 503，验证页面同时保留错误提示、相关章节标题和结果列表。
- 已运行 `npx vitest run tests/unit/ragAnswer.test.ts --reporter=dot`，结果 1 个测试文件、2 个用例全部通过。
- 已运行 `npx playwright test tests/e2e/core-flows.spec.ts --grep "opens smart search"`，结果 chromium 目标用例通过。
- 已运行 `npm run test:unit`，结果 2 个测试文件、18 个用例全部通过。
- 已运行 `npm run build`，TypeScript 与 Vite build 通过；仅保留既有 chunk size 提示。
- `docs/test-case-matrix.md` 已把 `RAG-ANSWER-002` 标记为 Existing。
- 下一步建议继续补 P1：RAG 成功答案来源展示，或 AI 概要单章/批量覆盖策略。

2026-07-01 更新：RAG summary/chunk embedding 生成回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `RAG-EMB-002`：批量生成 embedding 时必须同时写入章节概要向量和正文 chunk 向量，并保留模型与维度信息。
- 扩展 `tests/api/local-db-server.test.mjs`：准备两章概要，调用 `/api/rag/embeddings/batch` 的 OpenAI-compatible mocked embedding 服务，验证 summary completed、chunk completed、provider 请求模型名和无失败项。
- 测试继续调用 `/api/rag/embeddings/status` 并直接读取 SQLite，确认 `summary_embeddings` 与 `chapter_chunk_embeddings` 各写入 2 条，维度为 3，缺失章节和缺失 chunk 均为 0。
- 已运行 `npm run local-db:test`，结果 3 个测试套件、15 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `RAG-EMB-002` 标记为 Existing。
- 下一步建议继续补 P1：RAG 答案失败路径，或 AI 概要单章/批量覆盖策略。

2026-07-01 更新：RAG 图谱实体增强回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `RAG-SEARCH-002`：查询命中实体别名时，RAG 搜索结果必须返回对应章节证据，并在 `entityMatches` 与章节 `matchedEntities` 中映射回主实体。
- 扩展 `tests/api/local-db-server.test.mjs`：准备两章概要、mock OpenAI-compatible embedding 服务和章节 KG extraction，用“少年林青”别名发起搜索，验证主实体“林青”、别名、第一章结果、snippet 与 graph/entity match type。
- 搜索前先调用 `/api/rag/embeddings/batch` 生成 summary/chunk embedding，覆盖 RAG readiness 门槛后的正常图谱增强路径。
- 已运行 `npm run local-db:test`，结果 3 个测试套件、14 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `RAG-SEARCH-002` 标记为 Existing。
- 下一步建议继续补 P1：RAG embedding 生成、RAG 答案失败路径，或 AI 概要单章/批量覆盖策略。

2026-07-01 更新：AI 批量概要单章失败回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `AI-SUMMARY-004`：批量生成概要时，单章 LLM 失败不能中断整批任务，已成功章节必须继续写入，并向 UI 进度报告成功/失败数量。
- 重构 `src/hooks/useReaderState.ts`：抽出 `runMissingSummaryBatch()`，保留原有并发调度和进度文案，hook 继续负责写入对应书籍的 summaries。
- 扩展 `tests/unit/useReaderState.test.ts`：构造 3 个缺失章节、并发 2，其中第 2 章 mock 失败；测试验证 3 章都被尝试，成功章节 1/3 被写入，失败计数为 1，最终进度显示“失败 1 章”。
- 已运行 `npx vitest run tests/unit/useReaderState.test.ts --reporter=dot`，结果 1 个测试文件、16 个用例全部通过。
- 已运行 `npm run test:unit`，结果 1 个测试文件、16 个用例全部通过。
- 已运行 `npm run build`，TypeScript 与 Vite build 通过；仅保留既有 chunk size 提示。
- `docs/test-case-matrix.md` 已把 `AI-SUMMARY-004` 标记为 Existing。
- 下一步建议继续补 P1：RAG 图谱增强，或 AI 概要单章/批量覆盖策略。

2026-07-01 更新：AI 模型配置成功路径回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `AI-CONFIG-001` 与 `AI-CONFIG-002`：保存模型配置前必须分别验证 LLM 与 embedding 配置，成功时才能进入保存流程。
- 扩展 `tests/unit/useReaderState.test.ts`：新增 Ollama 成功路径，验证 `validateModelConfig()` 会调用本地 Ollama `/api/generate`，并继续调用 embedding validate，且请求体会 trim 模型名和 baseUrl。
- 新增 OpenAI-compatible 成功路径，验证 chat `/chat/completions` 会携带 Bearer token、`response_format: json_object`、禁用 thinking 的参数，并继续验证 embedding 模型。
- 已运行 `npx vitest run tests/unit/useReaderState.test.ts --reporter=dot`，结果 1 个测试文件、15 个用例全部通过。
- 已运行 `npm run test:unit`，结果 1 个测试文件、15 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `AI-CONFIG-001` 与 `AI-CONFIG-002` 标记为 Existing。
- 下一步建议继续补 P1：RAG 图谱增强，或 AI 概要单章/批量覆盖策略。

2026-07-01 更新：AI 模型配置错误提示回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `AI-CONFIG-003`：错误 URL、错误 token、embedding 维度不匹配时，保存模型配置前必须给出明确阶段和原因，不能把不可用配置当成成功。
- 增强 `src/hooks/useReaderState.ts`：LLM Ollama/OpenAI-compatible 网络失败现在包装为 `[LLM]` 前缀的中文连接错误；embedding 验证服务网络失败包装为 `[Embedding]` 前缀的中文连接错误。
- 扩展 `tests/unit/useReaderState.test.ts`：mock `fetch` 覆盖 OpenAI-compatible Base URL 连接失败、token 401、embedding 维度不匹配三种失败路径，并确认 token 失败不会继续进入 embedding 校验。
- 验证过程中发现当前 `node_modules/vite` 缺少 `misc/true.js`，导致 Vitest 启动失败；已用 `npm ci --ignore-scripts` 干净重装依赖恢复工具链，未改动 lockfile。
- 已运行 `npx vitest run tests/unit/useReaderState.test.ts --reporter=dot`，结果 1 个测试文件、13 个用例全部通过。
- 已运行 `npm run test:unit`，结果 1 个测试文件、13 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `AI-CONFIG-003` 标记为 Existing。
- 下一步建议继续补 P1：AI 配置成功路径/概要失败路径，或 RAG 图谱增强。

2026-07-01 更新：Production Pipeline audio 独立 stage 回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `PIPE-STAGE-004`：job 只配置 `audio` stage 时，流水线必须能用 mocked TTS director 独立产出 MP3、manifest 和 Gateway `audio.json`，并正确记录 parent/child run 元数据。
- 扩展 `production-pipeline/test/import.test.mjs`：导入两章样例书后运行仅包含 `audio` 的 job，使用 fake director 生成两章音频和 manifest。
- 测试验证 stdout、parent `run.json`、audio child `run.json`、child log、Gateway audio catalog、timeline version、duration、MP3 文件和 TTS source root。
- 已运行 `node --test --test-name-pattern="runs audio as an independent job stage" production-pipeline/test/import.test.mjs`，目标用例通过。
- 已运行 `node --test production-pipeline/test/import.test.mjs`，结果 1 个测试套件、34 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `PIPE-STAGE-004` 标记为 Existing；production-pipeline summary/KG/embedding/audio 独立 stage P1 自动化已全部补齐。
- 下一步建议继续补 P1：AI 配置/概要失败路径，或 RAG 图谱增强。

2026-07-01 更新：Production Pipeline embedding 独立 stage 回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `PIPE-STAGE-003`：job 只配置 `embedding` stage 时，流水线必须展开为 `chunkEmbedding` 与 `summaryEmbedding`，并分别记录 child run 与 embedding report。
- 扩展 `production-pipeline/test/import.test.mjs`：导入两章样例书并预置概要后，运行仅包含 `embedding` 的 job，使用 mock OpenAI-compatible embedding 服务生成 summary/chunk 向量。
- 测试验证 stdout、parent `run.json`、chunk/summary child `run.json`、两份 `artifacts/embedding-report.json` 的 mode/计数，并直接读取 SQLite 确认 summary 与 chunk embedding 各写入 2 条。
- 已运行 `node --test --test-name-pattern="runs embedding as independent job stages" production-pipeline/test/import.test.mjs`，目标用例通过。
- 已运行 `node --test --test-name-pattern="runs audio with initial parallel stages even when it follows embedding in the job" production-pipeline/test/import.test.mjs`，用于复核一次既有偶发失败的并行 audio 用例，结果通过。
- 已运行 `node --test production-pipeline/test/import.test.mjs`，结果 1 个测试套件、33 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `PIPE-STAGE-003` 标记为 Existing。
- 下一步建议继续补 P1：production-pipeline audio 独立 stage，或 AI 配置/概要失败路径。

2026-07-01 更新：Production Pipeline KG 独立 stage 回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `PIPE-STAGE-002`：job 只配置 `kg` stage 时，流水线必须能独立完成知识图谱生成，并正确记录 parent/child run 元数据和 KG report。
- 扩展 `production-pipeline/test/import.test.mjs`：导入两章样例书后运行仅包含 `kg` 的 job，使用 mock OpenAI-compatible chat 服务返回实体和关系 JSON。
- 测试验证 stdout、parent `run.json`、KG child `run.json`、child log 元数据和 `artifacts/kg-report.json`，并直接读取 SQLite 确认两章 extraction、实体和关系已写入。
- 已运行 `node --test --test-name-pattern="runs kg as an independent job stage" production-pipeline/test/import.test.mjs`，目标用例通过。
- 已运行 `node --test production-pipeline/test/import.test.mjs`，结果 1 个测试套件、32 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `PIPE-STAGE-002` 标记为 Existing。
- 下一步建议继续补 P1：production-pipeline embedding/audio 独立 stage，或 AI 配置/概要失败路径。

2026-07-01 更新：Production Pipeline summary 独立 stage 回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `PIPE-STAGE-001`：job 只配置 `summary` stage 时，流水线必须能独立完成概要生成，并正确记录 parent/child run 元数据。
- 扩展 `production-pipeline/test/import.test.mjs`：导入两章样例书后运行仅包含 `summary` 的 job，使用 mock OpenAI-compatible chat 服务生成概要。
- 测试验证 stdout、parent `run.json`、summary child `run.json`、child log 元数据和 `artifacts/summary-report.json`，并直接读取 SQLite `summaries` 表确认两章概要已写入。
- 已运行 `node --test --test-name-pattern="runs summary as an independent job stage" production-pipeline/test/import.test.mjs`，目标用例通过。
- 已运行 `node --test production-pipeline/test/import.test.mjs`，结果 1 个测试套件、31 个用例全部通过。
- 曾尝试运行 `npm run production-pipeline:test`，`book-ingest`、`embedding-utils`、`import` 三个套件已通过，但全量命令在 `production-pipeline/test/service.test.mjs` 无进一步输出后悬挂，已结束该测试进程；本次新增用例不依赖该 service 套件。
- `docs/test-case-matrix.md` 已把 `PIPE-STAGE-001` 标记为 Existing。
- 下一步建议继续补 P1：production-pipeline KG/embedding/audio 独立 stage，或 AI 配置/概要失败路径。

2026-07-01 更新：RAG embedding 覆盖率不足阻断搜索回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `RAG-EMB-003`：embedding 覆盖率不足时，RAG 搜索必须明确提示先生成 embedding，不能继续调用 embedding provider 或返回误导性搜索结果。
- 扩展 `tests/api/local-db-server.test.mjs`：新增 `local RAG search readiness API` suite，使用真实本地 API 保存一本 2 章样例书，但不生成任何 summary embedding。
- 测试调用 `POST /api/rag/search` 时传入 mock OpenAI-compatible embedding 服务，验证响应为 409、`code=EMBEDDINGS_NOT_READY`、`embeddedCount=0`、`totalChapters=2`，并断言 mock embedding 服务没有收到任何请求。
- 已运行 `npm run local-db:test`，结果 3 个测试套件、13 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `RAG-EMB-003` 标记为 Existing。
- 下一步建议继续补 P1：production-pipeline KG/embedding/audio 独立 stage，或 AI 配置/概要失败路径。

2026-07-01 更新：知识图谱全局共指候选回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `KG-COREF-001`：存在疑似同一人物实体时，`/api/kg/coreference/components` 必须正确生成候选组件，且不把无关人物或组织混入候选。
- 扩展 `tests/api/local-db-server.test.mjs`：复用“南宫婉/精灵少女/韩立/掩月宗”场景，单独调用 coreference components API，不启动 LLM resolve job。
- 测试验证候选组件只有一组，成员为“南宫婉 + 精灵少女”，双方 aliases 互相指向；“韩立”和“掩月宗”不会进入该组件。
- 已运行 `npm run local-db:test`，结果 2 个测试套件、12 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `KG-COREF-001` 标记为 Existing。
- 下一步建议继续补 P1：production-pipeline KG/embedding/audio 独立 stage，或 AI 配置/概要失败路径。

2026-07-01 更新：知识图谱 saved JSON 重放回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `KG-SCAN-006`：已有 raw extraction 时，系统必须能不调用模型，直接用保存的 JSON 重建局部章节图谱。
- 扩展 `tests/api/local-db-server.test.mjs`：先保存一章 KG extraction，再删除“林青”实体制造局部图谱缺失，确认相关关系同步消失但 raw extraction 仍可读取。
- 测试随后把 `GET /api/kg/chapters/:chapterId/extraction` 返回的 saved JSON 重新 `PUT` 回同一章节，验证“林青/白衣客/阿梨/青州”和两条关系全部恢复，raw extraction 内容保持一致，model 更新为重放来源标识。
- 测试继续用 `node:sqlite` 检查 entity mention、relation mention 和 relation endpoint 无孤儿引用。
- 已运行 `npm run local-db:test`，结果 2 个测试套件、11 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `KG-SCAN-006` 标记为 Existing。
- 下一步建议继续补 P1：production-pipeline KG/embedding/audio 独立 stage，或 AI 配置/概要失败路径。

2026-07-01 更新：正规化治理文档与 Android 更新 P2 自动化补齐。
- 新增 `docs/code-review-checklist.md`，把 PC/API、知识图谱、production-pipeline、Gateway、Admin UI、Gateway Android 的系统性 review 重点固化为可执行 checklist。
- 新增 `docs/operations-runbook.md`，覆盖真实 Gateway 健康检查、package/audio/APK 发布后验收、公网安全、常见故障分诊和回滚记录模板。
- 新增 `docs/release-checklist.md`，把发布前自动化、真实 Gateway 验收、APK 真机验收、公网安全和回滚准备串成固定发布流程。
- Gateway Android 更新逻辑抽出 `normalizeAppUpdateManifest()`、`resolveAppUpdateManifest()` 和 `appUpdateStatusLabel()`，新增 `gateway-android-app/src/App.update.test.ts` 覆盖 `AND-UPDATE-002`：线上 `versionCode` 等于或低于本机时显示“已是最新”，只有严格更高才提供安装入口。
- `docs/test-case-matrix.md` 已把 `AND-UPDATE-002` 与 `OPS-RUNBOOK-001` 标记为 Existing，把 `OPS-ROLLBACK-001` 从 Ops Gap 推进为 Partial；`docs/quality-ops-roadmap.md` 已标记 Code Review checklist、runbook 和 release checklist 第一版完成。
- 下一步建议继续把剩余 P1 Planned 自动化往前推：AI 配置/概要失败、production-pipeline KG/embedding/audio 独立 stage、RAG 图谱增强；运维侧继续把 `OPS-METRIC-001` 和 `OPS-ROLLBACK-001` 从文档治理推进到真实指标/演练。

2026-07-01 更新：Production Pipeline verify 增加发布后书库可见性校验。
- 补齐最后一个 P0 Planned `OPS-PUBLISH-001` 的可执行验证路径：publish 完成后，verify 会交叉校验 Admin 书目、mobile session 可见范围和 `/mobile/books` 书库结果。
- 增强 `production-pipeline/src/cli.mjs`：提供 `--gateway-admin-token` 时，verify 会读取 `GET /admin/books`，用它代表远端 `books.json` 的 HTTP 权威视图；同时读取 `GET /auth/session` 获取当前 mobile token 的 `allowedVisibilities`。
- verify 报告新增 `adminBooks.bookListed`、`mobileSession.allowedVisibilities`、`library.visibilityConsistent` 检查，确认远端 catalog 已包含目标书，并且目标书 visibility 与当前设备在 `/mobile/books` 中的可见/不可见状态一致。
- fake Gateway 回归已模拟 Admin 书目、mobile session、mobile library、package、audio、admin refresh 全链路；目标 verify 用例现在断言 29 个检查全部通过。
- 已运行 `npm run production-pipeline:test`，结果 4 个测试套件、48 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `OPS-PUBLISH-001` 标记为 Existing；真实远端执行时需要使用目标设备对应的 mobile token 和 admin token。

2026-07-01 更新：Production Pipeline verify 增加 Admin audio refresh 运维校验。
- 在 `PIPE-VERIFY-002` 的基础上继续推进 `OPS-PUBLISH-002`：发布 audio 后，提供 admin token 的 verify 会主动调用 Gateway admin refresh，并校验 Admin 音频汇总与本次 run 的 `audio.json` 一致。
- 增强 `production-pipeline/src/cli.mjs`：新增 `--gateway-admin-token` / `verify.gatewayAdminToken` 可选参数；传入后执行 `POST /admin/books/:bookId/audio/refresh` 与 `GET /admin/audio`。
- verify 报告新增 `adminAudio.refresh.*` 与 `adminAudio.list.*` 检查，覆盖 bookId、audioChapterCount、missingChapterCount、totalSizeBytes 和 Admin 列表可见性。
- 扩展 fake Gateway 回归，模拟 mobile/admin 双 token，确认 verify 同时访问 mobile audio manifest/download 和 admin audio refresh/list。
- 已运行 `npm run production-pipeline:test`，结果 4 个测试套件、48 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `OPS-PUBLISH-002` 标记为 Existing；真实远端执行时仍需要提供真实 `--gateway-url`、mobile token 与 admin token。

2026-07-01 更新：Production Pipeline Gateway audio verify 回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `PIPE-VERIFY-002` 的自动化契约层：verify 阶段发布后访问 Gateway audio API 时，必须校验 audio catalog 章节、manifest、MP3 下载、duration 和 size。
- 增强 `production-pipeline/src/cli.mjs`：`verify` 现在逐章比较远端 `/mobile/books/:bookId/audio` 返回的 `durationMs`、`sizeBytes` 与本次 run 产出的 `audio.json` 是否一致；抽样下载 MP3 后继续校验实际下载字节数等于 `sizeBytes`。
- 扩展 `production-pipeline/test/import.test.mjs` 的 fake Gateway verify 回归：记录 `/manifest` 与 `/download` 请求，报告中断言 `audio.durationMs.*`、`audio.sizeBytes.*`、`audio.manifestTimelineVersion.*`、`audio.download.*`、`audio.downloadSize.*` 全部通过。
- 已运行 `node --test --test-name-pattern="verifies Gateway package output" production-pipeline/test/import.test.mjs`，目标用例通过。
- 已运行 `npm run production-pipeline:test`，结果 4 个测试套件、48 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `PIPE-VERIFY-002` 标记为 Existing；真实远端 audio rsync 后的 Admin refresh 一致性仍保留在 `OPS-PUBLISH-002`。

2026-07-01 更新：知识图谱 LLM 共指合并回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `KG-COREF-002`：共指合并必须只合并 mocked LLM 明确判断为同一身份的实体，不能误合并其他人物，并且合并后关系冲突要可控收敛。
- 扩展 `tests/api/local-db-server.test.mjs`：启动本地 mock OpenAI-compatible `/chat/completions` 服务，驱动真实 `/api/kg/coreference/resolve` 异步 job、JSON 响应解析和事务合并路径。
- 测试构造“南宫婉/精灵少女”共享别名形成候选组件，同时保留“韩立”作为不应合并的人物；mock LLM 只返回“南宫婉 + 精灵少女” cluster。
- 测试验证 job 完成、LLM 请求携带 Bearer token 与 json_object response_format；合并后实体只剩“南宫婉/掩月宗/韩立”，“南宫婉” aliases 包含“精灵少女”，mentions 覆盖两章。
- 测试继续验证“南宫婉 -> 掩月宗”冲突关系合并为一条并保留两章 evidence，“韩立 -> 掩月宗”独立保留，底层 KG 表无孤儿引用。
- 已运行 `npm run local-db:test`，结果 2 个测试套件、10 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `KG-COREF-002` 标记为 Existing。

2026-07-01 更新：知识图谱覆盖重扫预览回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `KG-SCAN-005`：覆盖重扫前必须先展示新增/删除/不变 diff，预览阶段不能写入实体、关系或 raw extraction，只有确认应用后才替换章节图谱。
- 扩展 `tests/api/local-db-server.test.mjs`：先保存一章初始 KG extraction，再向 `/api/kg/chapters/:chapterId/extraction/diff` 提交替换 extraction。
- 测试验证 diff summary 正确报告实体新增 1、删除 2、不变 2，关系新增 1、删除 1、不变 1，并列出新增“夜枭”、删除“阿梨/青州”、新增“夜枭 -> 林青”、删除“阿梨 -> 青州”。
- 测试继续验证 diff 调用后图谱实体/关系列表和已保存 raw extraction/model 完全不变；随后 PUT 应用同一 extraction 后，图谱才替换为“林青/白衣客/夜枭”和两条新关系。
- 已运行 `npm run local-db:test`，结果 2 个测试套件、9 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `KG-SCAN-005` 标记为 Existing。

2026-07-01 更新：知识图谱复审队列批量操作回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `KG-REVIEW-002`：复审队列批量 approved/ignored/delete 必须正确改变状态或删除对象，且删除实体/关系后不能留下 KG 坏引用。
- 扩展 `tests/api/local-db-server.test.mjs`：通过真实本地 API 写入低置信度、描述缺失、单章出现和可疑别名的 KG extraction，生成实体与关系复审队列。
- 测试验证批量标记 entity approved 与 relation ignored 后，对象仍可访问但从复审队列消失，底层 `review_status` 分别写为 `approved` / `ignored`。
- 测试继续验证批量删除 relation 后详情返回 404，批量删除 entity 后详情返回 404，并用 `node:sqlite` 检查 entity mention、relation mention 和 relation endpoint 无孤儿引用。
- 已运行 `npm run local-db:test`，结果 2 个测试套件、8 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `KG-REVIEW-002` 标记为 Existing。

2026-07-01 更新：知识图谱实体拆分数据一致性回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `KG-ENTITY-003`：实体拆分后，新旧实体的 aliases、章节提及、first/last seen 和关系证据必须保持一致，且底层 KG 表不能留下孤儿引用。
- 扩展 `tests/api/local-db-server.test.mjs`：通过真实本地 API 写入两章 KG extraction，让“林青”拥有跨章出现与跨章关系，再把第二章 mention、源别名“青衣少年”和连接“白衣客”的关系拆到新实体。
- 测试验证源实体只保留第一章且移除被拆别名，新实体只拥有第二章 mention 与新别名，关系端点整体迁移到新实体，关系 evidence 仍覆盖两章。
- 测试继续用 `node:sqlite` 检查 entity mention、relation mention 和 relation endpoint 无坏引用。
- 已运行 `npm run local-db:test`，结果 2 个测试套件、7 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `KG-ENTITY-003` 标记为 Existing。

2026-06-30 更新：知识图谱实体合并数据一致性回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `KG-ENTITY-002`：实体合并后必须迁移 aliases、章节提及和相关关系，且不能留下孤儿数据。
- 扩展 `tests/api/local-db-server.test.mjs`：通过真实本地 API 写入两章 KG extraction，再把“少年林青”合并到“林青”。
- 测试验证合并响应返回目标实体，目标 aliases 包含源实体名和源别名，源实体详情变为 404，目标实体提及覆盖 `c1`/`c2`，目标到“白衣客”的关系保留并带有两章证据。
- 测试继续用 `node:sqlite` 检查底层 KG 表无坏引用。
- 已运行 `npm run local-db:test`，结果 2 个测试套件、6 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `KG-ENTITY-002` 标记为 Existing。

2026-06-30 更新：知识图谱关系端点切换完整性回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `KG-REL-002`：修改关系 source/target 时必须拒绝自环、拒绝跨书端点，并在变更后与既有关系冲突时合并证据。
- 扩展 `tests/api/local-db-server.test.mjs`：同一真实本地 API 场景中写入两本书的 KG extraction，验证自环关系更新返回 400，跨书端点返回 400。
- 新增冲突合并回归：把“林青 -> 白衣客”关系改为“阿梨 -> 青州”且类型与既有关系相同，API 返回既有关系 id，旧关系变为 404，合并后的关系保留两条 evidence。
- 测试继续用 `node:sqlite` 检查底层表无 entity mention、relation mention 或 relation endpoint 孤儿引用。
- 已运行 `npm run local-db:test`，结果 2 个测试套件、5 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `KG-REL-002` 标记为 Existing。

2026-06-30 更新：知识图谱实体删除级联完整性回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `KG-ENTITY-004`：删除实体后，实体提及、连接关系、关系证据和关系端点都不能留下孤儿引用。
- 扩展 `tests/api/local-db-server.test.mjs`：通过真实本地 API 写入一章 KG extraction，生成 4 个实体和 2 条关系；删除“林青”实体后，API 只保留无关的“阿梨 -> 青州”关系。
- 测试进一步用 `node:sqlite` 直接检查底层表：被删实体的 mention 计数为 0，连接该实体的 relation 计数为 0，`kg_entity_mentions`、`kg_relation_mentions`、`kg_relations` 均无坏引用。
- 已运行 `npm run local-db:test`，结果 2 个测试套件、4 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `KG-ENTITY-004` 标记为 Existing。

2026-06-30 更新：PC 本地数据库备份/恢复安全回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `PC-DATA-001`、`PC-DATA-002`、`PC-DATA-003`：本地 SQLite 必须可完整导出，恢复前必须备份当前库，非法 SQLite 上传不能进入待恢复状态。
- 新增 `tests/api/local-db-server.test.mjs`，通过临时数据目录和随机端口启动真实 `scripts/local-db-server.mjs`，用 HTTP 调用 `/api/database/export` 与 `/api/database/import`。
- 导出回归会先写入包含书籍、章节和概要的样例 state，再下载 `.sqlite`，用 `node:sqlite` 打开导出文件并校验 `PRAGMA integrity_check`、`books`、`chapters`、`summaries` 数据。
- 恢复回归使用有效 SQLite 上传，校验响应 `requiresRestart: true`，当前数据库备份文件存在，`novel_reader.restore-pending.sqlite` 已创建且可通过 SQLite integrity check。
- 非法恢复回归上传非 SQLite 字节，校验返回 400、不创建 pending restore，当前 `/api/state` 仍能读到原书架。
- 新增 `npm run local-db:test` 脚本；已运行 `npm run local-db:test`，结果 1 个测试套件、3 个用例全部通过；已运行 `npm run build`，TypeScript 与 Vite build 通过。
- `docs/test-case-matrix.md` 已把 `PC-DATA-001`、`PC-DATA-002`、`PC-DATA-003` 标记为 Existing。

2026-06-30 更新：PC 阅读器多书阅读进度隔离回归落地。
- 根据 `docs/test-case-matrix.md` 补齐 `PC-READ-001`：PC 本地阅读器在两本书章节 ID 相同的情况下，章节滚动位置必须按书隔离。
- 新增 `chapterScrollPositionKey()` 与 `readChapterScrollPosition()`，读写统一使用 `bookId:chapterId`；读取时保留旧版单 `chapterId` key 的兼容回退，避免升级后丢失历史阅读位置。
- 新增 unit 回归：同为 `c1` 的 `book-a` 与 `book-b` 分别恢复 120/240，第三本书可回退旧 key，缺失章节返回 0。
- 新增 E2E 回归：导入两本章节标题相同的 TXT，分别滚到不同位置，切回两本书后各自恢复独立 scrollTop。
- 已运行 `npm run test:unit`，结果 1 个测试文件、10 个用例全部通过；已运行 `npm run test:e2e`，结果 3 个 Chromium 用例全部通过；已运行 `npm run build`，TypeScript 与 Vite build 通过。
- `docs/test-case-matrix.md` 已把 `PC-READ-001` 标记为 Existing。

2026-06-30 更新：Production Pipeline Gateway package verify 状态对齐。
- 复核 `PIPE-VERIFY-001`：`production-pipeline/test/import.test.mjs` 已有 `verifies Gateway package output against a published Gateway API` 回归，使用本地假 Gateway 校验 verify 命令的 API 契约。
- 该测试覆盖 `/health`、`/mobile/books`、`/mobile/books/:bookId/package?include=full`、章节顺序、summary 数量、embedding coverage、knowledgeGraph 数量、verify report 和 run.json verify 状态。
- 本轮已运行 `npm run production-pipeline:test`，结果 4 个测试套件、48 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `PIPE-VERIFY-001` 标记为 Existing；真实远端发布可见性仍由 `OPS-PUBLISH-001` 保留为独立 Ops 验证项。

2026-06-30 更新：Production Pipeline publish 合并目录回归测试补强。
- 根据 `docs/test-case-matrix.md` 补齐 `PIPE-PUBLISH-002`：本地 Gateway publish 写入 `books.json` 时必须保留其他书，并替换同 `bookId` 的旧条目。
- 扩展 production-pipeline job/resume 回归：目标 Gateway data 目录预置 `old-book` 和旧版 `sample-book`；真实本地 publish 后，artifact 与目标目录中的 `books.json` 都只保留一个 `sample-book`，标题更新为新 package 的“样书”，`old-book` 不被覆盖。
- 同一用例还确认 `books/sample-book/package.json` 被实际写入目标目录，避免只验证 dry-run artifact。
- 已运行 `node --test --test-name-pattern="runs a job config and resumes|resumes a failed job" production-pipeline/test/import.test.mjs`，2 个相关用例通过。
- 已运行 `npm run production-pipeline:test`，结果 4 个测试套件、48 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `PIPE-PUBLISH-002` 标记为 Existing。

2026-06-30 更新：Production Pipeline 失败续跑回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `PIPE-RESUME-001`：生产流水线阶段失败后，resume 必须跳过已完成阶段，只重试失败阶段。
- 新增 production-pipeline 回归：`package` 阶段先完成，`publish` 因目标 `gatewayDataDir` 被占用为普通文件而失败；修复目标目录后执行 `resume`，断言输出 `skip: package already completed`、不再次 `completed: package`、`publish` 重试成功并写出 Gateway package。
- 测试同时校验失败 run 的 `run.json` 状态为 failed、package child run 路径保持不变、resume 后父 run 变为 completed。
- 已运行 `node --test --test-name-pattern="resumes|skipping completed" production-pipeline/test/import.test.mjs`，2 个 resume 用例通过。
- 已运行 `npm run production-pipeline:test`，结果 4 个测试套件、48 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `PIPE-RESUME-001` 标记为 Existing。

2026-06-30 更新：Gateway Android 音频状态按书隔离测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `AND-AUDIO-001`：Android 音频目录、缓存数和同步进度必须按当前 `bookId` 隔离，避免不同书同名章节互相串状态。
- 新增音频缓存存储回归：同为 `chapter-1` 的 `book-a` 与 `book-b` 会分别写入 `bookId:chapterId` 缓存 key，读取音频元数据、章节元数据和已缓存章节数时只返回目标书的数据。
- 收紧缓存索引读取：空 `filePath` 或结构损坏的记录不会进入 `loadAudioCacheIndexFromStorage()`，避免 UI 把不可播放的残留记录计为已缓存。
- 已运行 `npm --prefix gateway-android-app run test`，结果 4 个测试文件、24 个用例全部通过；已运行 `npm --prefix gateway-android-app run build`，TypeScript 与 Vite build 通过。
- `docs/test-case-matrix.md` 已把 `AND-AUDIO-001` 标记为 Existing。
- 下一步建议继续 Android 更新/连接类测试，或转向 `PIPE-RESUME-001` 补生产流水线失败续跑。

2026-06-30 更新：Gateway Android 按书阅读进度测试状态对齐。
- 复核 `AND-READ-001`：`gateway-android-app/src/App.audioPlayback.test.ts` 已覆盖旧版单书进度读取、多本书章节/滚动位置隔离、删除单书只清理该书进度。
- 当前实现使用 `novel-reader-gateway-reading-progress` 的 `schemaVersion: 2` 多书进度表，`openBook()` 会按 `bookId` 读取对应章节和滚动位置，避免多书混读互相覆盖。
- 已运行 `npm --prefix gateway-android-app run test`，结果 4 个测试文件、22 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `AND-READ-001` 标记为 Existing。
- 下一步建议继续 Android P0：`AND-AUDIO-001`，验证音频目录、缓存数和同步进度按书隔离。

2026-06-30 更新：小说 App 下载二维码生成。
- 生成独立矢量二维码 `docs/novel-app-download-qr.svg`，编码固定下载地址 `https://novel.gwaves.net:8888/downloads/ai_novel_reader.apk`，可用于文档粘贴、打印或手机扫码。
- 已用 `curl -L -I` 验证下载地址当前返回 `200`，`content-type` 为 `application/vnd.android.package-archive`，并带 `content-disposition: attachment; filename="ai_novel_reader.apk"`。

2026-06-30 更新：Admin 音频覆盖与操作状态回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `ADMIN-AUDIO-001` 与 `ADMIN-AUDIO-002`：Admin UI 音频页必须正确映射完整、部分缺失、全缺失状态，并完整展示刷新/清理操作成功与失败状态。
- 新增 Admin UI 音频映射回归：真实 `/admin/audio` 返回 ready/partial/missing 三类 summary 时，音频页显示平均覆盖率、缺音频章节、章节进度、缺失章节列表、大小、声音和下载数。
- 扩展音频操作回归：刷新成功后行状态变为完整；清理前必须确认，清理成功后行状态变为缺失；后续刷新失败显示 `刷新失败：服务不可用`，按钮恢复可再次操作。
- 已运行 `npm --prefix gateway/admin-ui run test`，结果 1 个测试文件、17 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `ADMIN-AUDIO-001`、`ADMIN-AUDIO-002` 标记为 Existing。
- 下一步建议转向 Android 或生产流水线用例：`AND-READ-001` / `AND-AUDIO-001` 或 `PIPE-RESUME-001`，补齐移动端和生产恢复的 P0 自动化。

2026-06-30 更新：Admin 数据包下载/重新导入回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `ADMIN-PKG-002`：Admin UI 数据包行需要覆盖下载、重新导入、成功刷新、失败提示和管理员 Token 携带。
- 新增 `importBookPackage` 管理端 API helper，Admin UI 数据包页新增 package JSON 文件重新导入入口；上传后调用 `PUT /admin/books/:bookId/package`，成功后刷新完整 dashboard 数据并保留行级“重新导入完成”状态，失败时显示 `重新导入失败`。
- 修正重新导入成功后 package 版本变化导致操作状态丢失的问题：重新导入状态以稳定 `bookId` 作为 key，刷新后的新 package 行仍能显示成功/失败状态。
- 扩展 Admin UI 回归：验证下载成功/失败状态和管理员 Token；验证重新导入成功后 package 行刷新到新版本；验证无效 JSON 显示 `重新导入失败：JSON 无效`。
- 已运行 `npm --prefix gateway/admin-ui run test`，结果 1 个测试文件、16 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `ADMIN-PKG-002` 标记为 Existing。
- 下一步建议转向 Android 或生产流水线用例：`AND-READ-001` / `AND-AUDIO-001` 或 `PIPE-RESUME-001`，补齐移动端和生产恢复的 P0 自动化。

2026-06-30 更新：Admin 总览真实数据回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `ADMIN-DASH-001`：Gateway API 可用时，Admin UI 总览必须使用真实 metrics、events、books、devices、packages 和 audio 数据，不混入 mock 总览内容。
- 扩展 Admin UI 回归：真实 `/admin/metrics` 返回请求/下载趋势后，总览渲染 5 分钟 bucket 的请求、错误、P95、package/audio 下载数据；系统摘要显示真实 uptime/heap/RSS/dataDir；设备摘要显示真实设备数、受信数、禁用数；内容健康来自真实书籍、数据包和音频覆盖；最近事件显示接口事件且不显示 mock 事件。
- 已运行 `npm --prefix gateway/admin-ui run test`，结果 1 个测试文件、15 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `ADMIN-DASH-001` 标记为 Existing。
- 下一步建议转向 Android 或生产流水线用例：`AND-READ-001` / `AND-AUDIO-001` 或 `PIPE-RESUME-001`，补齐移动端和生产恢复的 P0 自动化。

2026-06-30 更新：Gateway metrics/events 可观测性回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `GW-METRICS-001` 与 `GW-EVENTS-001`：Gateway 必须从真实请求、下载和错误事件生成 `/admin/metrics` 趋势桶与 `/admin/events` 事件列表。
- 扩展 Gateway API 回归：产生 package 下载、MP3 下载和 404 请求后，`/admin/metrics` 返回 12 个 5 分钟 request/download buckets，最后一个 bucket 统计 package/audio 下载和错误请求；`downloads.topBooks` 同时包含 package/audio 下载计数。
- 新增空事件回归：新的 Gateway 实例在没有值得记录的请求前，`/admin/events` 返回空数组；结合 Admin UI 既有空事件测试，`ADMIN-DASH-002` 也已具备端到端回归证据。
- 已运行 `npm --prefix gateway run test`，结果 1 个测试文件、57 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `GW-METRICS-001`、`GW-EVENTS-001`、`ADMIN-DASH-002` 标记为 Existing。
- 下一步建议转向 Android 或生产流水线用例：`AND-READ-001` / `AND-AUDIO-001` 或 `PIPE-RESUME-001`，补齐移动端和生产恢复的 P0 自动化。

2026-06-30 更新：Gateway 音频刷新/清理运维回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `GW-AUDIO-003`：admin 音频刷新/清理接口必须同时反映文件系统变化和 `/admin/audio` 汇总状态。
- 扩展 Gateway API 回归：`POST /admin/books/:bookId/audio/refresh` 返回缺失章节和音频大小；`DELETE /admin/books/:bookId/audio` 删除 `audio.json` 与 MP3 文件，并返回清理明细；清理后再次 refresh 与 `/admin/audio` 都显示音频章节数为 0、缺失章节为全量章节、覆盖率为 0、总大小为 0。
- 已运行 `npm --prefix gateway run test`，结果 1 个测试文件、56 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `GW-AUDIO-003` 标记为 Existing。
- 下一步建议转向 Android 或生产流水线用例：`AND-READ-001` / `AND-AUDIO-001` 或 `PIPE-RESUME-001`，补齐移动端和生产恢复的 P0 自动化。

2026-06-30 更新：Gateway 生产 token 与 dev fallback 边界回归测试落地。
- 根据 `docs/test-case-matrix.md` 补齐 `GW-AUTH-002` 与 `GW-AUTH-003`：生产环境必须显式配置 admin/mobile token，开发 token fallback 只能用于非生产环境。
- 扩展 Gateway 配置回归：`GATEWAY_ENV=production` 时缺 admin token、缺 mobile token、或只给 `GATEWAY_DEV_ACCESS_TOKEN` 都会拒绝启动。
- 新增生产 scoped-auth 回归：生产环境即使配置了 `GATEWAY_DEV_ACCESS_TOKEN`，admin/mobile 路由也只接受专用 token，dev token 返回 `invalid_token`；非生产环境仍允许 dev token 同时覆盖 admin/mobile scoped auth。
- 已运行 `npm --prefix gateway run test`，结果 1 个测试文件、56 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `GW-AUTH-002`、`GW-AUTH-003` 标记为 Existing。
- 下一步建议转向 Android 或生产流水线用例：`AND-READ-001` / `AND-AUDIO-001` 或 `PIPE-RESUME-001`，补齐移动端和生产恢复的 P0 自动化。

2026-06-30 更新：Admin 删除书籍联动回归测试落地。
- 根据 `docs/test-case-matrix.md` 继续补齐 `ADMIN-BOOK-002`：管理后台删除整本书必须确认，并且成功后书籍列表、数据包列表和音频列表同步移除。
- 扩展 Admin UI 回归：删除前先确认数据包页和音频页存在目标书；在书籍详情确认删除后，书籍列表移除目标书并保留其他书；切换到数据包和音频页后目标书行也不存在，摘要变为 0。
- Gateway 后端已有 `deletes a catalog book together with its package and audio files` 回归，覆盖 DELETE 鉴权、目录清理、catalog 移除和移动端不可见。
- 已运行 `npm --prefix gateway/admin-ui run test`，结果 1 个测试文件、15 个用例全部通过；已运行 `npm --prefix gateway run test`，结果 1 个测试文件、54 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `ADMIN-BOOK-002` 标记为 Existing。
- 下一步建议转向 Android 或生产流水线用例：`AND-READ-001` / `AND-AUDIO-001` 或 `PIPE-RESUME-001`，补齐移动端和生产恢复的 P0 自动化。

2026-06-30 更新：Gateway admin AI 代理安全回归测试落地。
- 根据 `docs/test-case-matrix.md` 继续补齐 `GW-AI-002`：`/ai/chat` 与 `/ai/embeddings` 属于 admin 上游代理接口，只允许 admin token 调用，并且不能在错误响应中暴露上游 API key。
- 新增 Gateway API 回归：mobile token 调用 `/ai/chat` 和 `/ai/embeddings` 均返回 `invalid_token`；admin token 触发上游 401 时，Gateway 返回稳定的 `ai_upstream_error` / `embedding_upstream_error`，响应体不包含 `GATEWAY_AI_API_KEY` 或 `GATEWAY_EMBEDDING_API_KEY` 对应密钥。
- 已运行 `npm --prefix gateway run test`，结果 1 个测试文件、54 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `GW-AI-002` 标记为 Existing。
- 下一步建议转向 Android 或生产流水线用例：`AND-READ-001` / `AND-AUDIO-001` 或 `PIPE-RESUME-001`，补齐移动端和生产恢复的 P0 自动化。

2026-06-30 更新：Admin 设备角色修改回归测试落地。
- 根据 `docs/test-case-matrix.md` 继续补齐 `ADMIN-DEVICE-001`：管理后台修改设备角色时必须有保存中状态、失败回滚、重试入口，并和移动端授权语义保持一致。
- 新增 Admin UI 回归：设备角色从普通改为禁用时先进入保存中并禁用选择框；第一次 PATCH 失败后列表和详情都回滚到普通；点击“重试保存设备角色”后第二次 PATCH 成功，列表和详情同步显示禁用，并校验请求携带管理员 Token。
- Gateway 后端已有 `enforces patched device roles on mobile APIs` 回归，覆盖 Admin PATCH 为 trusted 后移动书库可见 trusted/default，PATCH 为 disabled 后移动 API 返回 `device_disabled`。
- 已运行 `npm --prefix gateway/admin-ui run test`，结果 1 个测试文件、15 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `ADMIN-DEVICE-001` 标记为 Existing。
- 下一步建议转向 Android 或生产流水线用例：`AND-READ-001` / `AND-AUDIO-001` 或 `PIPE-RESUME-001`，补齐移动端和生产恢复的 P0 自动化。

2026-06-30 更新：Gateway MP3 下载鉴权回归测试落地。
- 根据 `docs/test-case-matrix.md` 继续补齐 `GW-AUDIO-002`：受保护 MP3 下载必须走 mobile auth，并受设备角色和书籍可见性约束。
- 新增 Gateway API 回归：无 token 和 admin token 访问 mobile MP3 下载返回 401；普通设备访问 trusted 书音频返回 `book_not_found`；受信设备可下载 trusted 书 MP3；禁用设备返回 `device_disabled`。
- 已运行 `npm --prefix gateway run test`，结果 1 个测试文件、53 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `GW-AUDIO-002` 标记为 Existing。
- 下一步建议继续补 `ADMIN-AUDIO-001` 或 `ADMIN-AUDIO-002`：收紧音频覆盖/缺失章节 UI 映射和刷新/清理操作状态。

2026-06-30 更新：第二批 Gateway Admin UI 自动化测试落地。
- 根据 `docs/test-case-matrix.md` 继续补齐不依赖真机的管理后台状态用例：`ADMIN-AUTH-001` 与 `ADMIN-DASH-003`。
- Admin UI 现在在管理员未授权时显示安全失败状态，不再伪装成 mock/demo 数据；部分后台接口失败时只保留成功接口的真实数据，失败分区保持为空并通过顶部状态明确提示。
- 修正 `gateway/admin-ui/src/api.ts` 的部分失败回退策略：只有全部接口不可用时才进入 mock 演示数据，未授权和部分失败都不混入 `initial*` 样例数据。
- 已运行 `npm --prefix gateway/admin-ui run test`，结果 1 个测试文件、14 个用例全部通过。
- `docs/test-case-matrix.md` 已把 `ADMIN-AUTH-001`、`ADMIN-DASH-003` 标记为 Existing。
- 下一步建议转向 Android 或生产流水线用例：`AND-READ-001` / `AND-AUDIO-001` 或 `PIPE-RESUME-001`，补齐移动端和生产恢复的 P0 自动化。

2026-06-30 更新：第一批 Gateway API P0 自动化测试开始落地。
- 根据 `docs/test-case-matrix.md`，优先补齐不依赖真机的安全边界用例：`GW-AUTH-001`、`GW-BOOK-001` 和 `GW-AI-001`。
- Gateway 现有测试已覆盖 admin/mobile token audience 分离、生产环境必须显式配置 admin/mobile token、dev token 仅开发 fallback、移动书库 default/trusted/hidden/disabled 可见性。
- 本轮新增 `/ai/search` 与 `/ai/rag-answer` 的设备可见性回归：普通设备访问 trusted 书返回 `book_not_found`，受信设备可搜索并生成 RAG answer，禁用设备返回 `device_disabled`，admin token 调 mobile AI 路由仍被拒绝。
- `docs/test-case-matrix.md` 已把 `GW-AUTH-001`、`GW-BOOK-001`、`GW-AI-001` 标记为 Existing。
- 已运行 `npm --prefix gateway run test`，结果 1 个测试文件、52 个用例全部通过。
- 下一步建议转向 `AND-READ-001`、`AND-AUDIO-001` 与 `PIPE-RESUME-001`：继续扩大 P0/P1 自动化覆盖。

2026-06-30 更新：旧移动端目录已移除。
- 删除旧 `mobile-app/` 局域网同步客户端目录，以及根 Web 的 `/mobile` 路由组件 `src/MobileApp.tsx` / `src/MobileApp.css`。
- 根 Web 入口现在只加载桌面阅读器；当前 Android 移动端统一由 `gateway-android-app/` 维护。
- README、开发文档、Gateway 文档和产品规格已同步说明：旧实现不再保留在工作树中，历史实现通过 Git 记录追溯。

2026-06-30 更新：进入正规化测试与可运维性建设阶段。
- 快速功能开发阶段基本收束，后续主线调整为“产品功能规格 -> 测试用例矩阵 -> 系统性 Code Review -> 可观测性/运维能力 -> 发布治理”。
- 新增 `docs/product-spec.md`，把 PC 阅读器、AI 概要、知识图谱、RAG、production-pipeline、Gateway、Admin UI、Gateway Android App 和历史移动端边界整理为正式产品功能说明书。
- 新增 `docs/quality-ops-roadmap.md`，记录正规化阶段的里程碑、交付物、验收标准和推荐执行顺序。
- 新增 `docs/test-case-matrix.md`，按 PC 阅读器、AI 概要、知识图谱、RAG、production-pipeline、Gateway API、Admin UI、Gateway Android、运维发布拆出第一版测试用例矩阵，标注风险等级、测试层级、覆盖状态和真机/真实 Gateway 边界。
- 新增 `docs/development-history-visual.md`，根据 GitHub PR、tag 和 Git 提交历史整理开发进展时间线、主线 PR 演进图和能力版图演进图。
- README 已增加产品规格、测试与运维规划入口，并补充下一阶段质量建设重点。
- 下一步优先从测试矩阵中挑选不依赖真机的 P0/P1 自动化用例落地：Gateway admin/mobile 鉴权分离、设备角色/书籍可见性、mobile RAG 路由鉴权、Admin UI 未授权不回退 mock、部分接口失败状态、Gateway Android 按书阅读进度和音频状态按书隔离。

2026-06-29 更新：Gateway 管理后台与书库可见性大 feature 已开分支设计。
- 新增分支 `codex/gateway-admin-visibility`，用于集中开发 Gateway 管理后台、设备角色授权、书籍标签/可见范围和移动端设备识别。
- 新增设计文档 `gateway/docs/admin-visibility-design.md`，明确普通/受信/禁用设备角色，默认/受信/管理员/隐藏书籍可见范围，以及书籍内容标签和可见范围分离的原则。
- 接口设计已约定：移动端继续走 `/mobile/books` 等原 API，由 Gateway 按设备角色过滤；管理端新增 `/admin/books`、`/admin/devices`、`/admin/metrics`、`/admin/events` 等接口。
- 交互设计已约定：后台包含总览、书籍、数据包、音频、设备、请求日志和设置；移动端设置页显示设备 ID、配对验证码、角色和刷新授权状态。
- 开发策略确定为测试驱动：先补 Gateway 接口测试、移动端设备身份测试和后台 UI 测试，再实现功能；可并发拆分为 Gateway API、Gateway Mobile App 设备身份、管理后台 UI 三条线。
- 当前已完成第一轮落地并提交：Gateway 管理 API、移动端设备身份、管理后台 UI 骨架和生产流水线 v2 收束已合并到 `b2843545`。
- 管理后台继续推进：Gateway 现在从 `/admin/ui` 服务 `gateway/admin-ui/dist`，避免覆盖 `/admin/books` JSON API；后台 UI 已接入 `/admin/books` 和 `/admin/devices`，API 不可用时回退 mock 数据。
- Gateway 公网安全整改已落地：生产环境不再使用 dev token fallback，匿名 `/capabilities`/`/version` 去除认证与环境细节，新增公网 Nginx Host 白名单模板和 `gateway:security-smoke` 验证脚本。
- Gateway 总览指标继续推进：新增进程内 `/admin/metrics` 和 `/admin/events`，统计最近请求数、错误率、P95、package/audio 下载次数、热门书籍和最近下载/错误事件；后台总览页已接入这些真实 API。
- Gateway Android 修正 MP3 计数串书：本机缓存章节数与可缓存音频总数已分离，下载三国演义时不会再把进度/缓存数显示到妖刀记；MP3 批量同步新增停止按钮，停止后当前章节完成即不再继续后续章节。
- Gateway Android 修正已缓存 MP3 的播放面板显示：当前章音频现在会优先匹配服务端音频目录，并在目录未加载或离线时回退到本机 MP3 缓存索引，避免已下载章节仍显示“当前章节暂无缓存 MP3”；播放引擎文案已从“云端 MP3”改为“缓存 MP3”，避免误解为在线播放。
- Gateway Android 的 MP3 管理面板新增章节缓存明细，逐章显示“已缓存 / 未缓存 / 无音频”并高亮当前章节，避免只能看到缓存总数却无法判断具体哪些章节已下载；未缓存但有音频的章节现在可单独加入后台下载队列，实现选集缓存。
- Gateway Android 移动端版本号统一到 `0.2.0`：Web App 内版本、Gateway 请求头、Android `versionName/versionCode` 和 APK 文件名都从移动端 `package.json` 派生，安装和发包时可以区分不同版本。
- Gateway Android 版本号管理升级：新增自动构建信息生成，`versionName` 统一为 `baseVersion+build.<buildNumber>.g<commit>`，`versionCode` 按基础版本和构建号计算；设置页顶部展示版本、构建号、Version Code、commit 和构建时间，APK 发布元数据也写入同一套信息。
- Gateway Android 安装显示名称改为“AI小说助手”，Android 资源名和 Capacitor `appName` 已同步。
- Gateway Android 搜索页修正 embedding 失败后的错误展示：Gateway embedding 鉴权失败但本地关键词兜底成功时，不再显示红色底层错误；`Bearer token is invalid.` 会转换为中文 Token 检查提示。
- Gateway AI RAG 路由鉴权修正：移动端实际使用的 `/ai/search` 和 `/ai/rag-answer` 改为 mobile device auth，并按设备可见书库校验 `bookId`；保留 `/ai/chat` 和 `/ai/embeddings` 为 admin 上游代理接口，避免受信移动设备在生成 RAG 答案时被 admin token 校验误挡。
- Gateway Android 修正书库到阅读页的选中态：在书库选中一本书后点击底部“阅读”，如果当前还没有加载该书数据包，会自动打开选中的本地书，避免阅读页显示“请选择一本书”。
- 移动端维护入口已收束到 `gateway-android-app/`：旧 `mobile-app/` 局域网同步客户端目录已删除；README、开发文档、贡献指南和 Gateway 计划默认指向 Gateway Android。
- 本轮按 TDD 多 Agent 并行推进：Gateway 后端新增 `/admin/packages`、`/admin/audio`、`/admin/requests` 并补测试；admin-ui 的数据包、音频、请求日志页已从占位改为真实表格视图并兼容真实后端字段；Gateway Android 设置/书库页补强设备 ID、Pairing Code、角色/授权、可见范围和禁用态阻断提示。
- 下一轮开发计划：继续采用测试驱动和多 Agent 并行，目标做到真实验证前的三步闭环。第一步补后台操作闭环，包含 package 下载/重新导入状态、音频清理/刷新状态、书籍/设备操作的保存中/失败回滚/确认提示；第二步补真实安全边界，将 admin 与 mobile 鉴权语义分开，并让 admin-ui 区分未授权、服务不可用和单接口失败，避免误回退 mock；第三步补移动端角色变化体验，明确 default/trusted/disabled 变化后的书库刷新、缓存可读策略和禁用态错误提示。最终真机和真实部署验证由用户执行。
- 三步开发已按测试驱动完成：Gateway 后端新增后台 package 下载、音频刷新和音频清单清理接口，并引入 `GATEWAY_ADMIN_ACCESS_TOKEN` / `GATEWAY_MOBILE_ACCESS_TOKEN` 与 dev token fallback；admin-ui 增加数据包下载、音频刷新/清理、书籍/设备保存中/失败回滚/重试，以及未授权/不可用/部分失败状态；Gateway Android 增加角色变化提示，禁用后阻断云端操作但保留本地缓存阅读和清理能力。代码层面已通过 Gateway、admin-ui、Gateway Android 测试和构建，剩余真实部署/真机验证由用户执行。

2026-06-29 更新：内容生产方向已收束到 `production-pipeline/`。
- `production-pipeline/` 是当前唯一的正式生产流水线目录；旧的内容生产目录已删除，避免 v1 manifest 编排和 v2 生产模型并存造成混淆。
- 有用能力已迁入 v2：TXT/EPUB/MOBI/AZW/AZW3 导入解析器现在位于 `production-pipeline/src/book-ingest.mjs`，`production-pipeline import/run` 会直接复用它写入主 SQLite。
- 本地控制台也已迁入 v2：`npm run production-pipeline:console` 启动 `production-pipeline/src/service.mjs`，用于选择 job JSON、启动 v2 run、查看 `run.json`、阶段状态、子 run 和日志。
- 根脚本保留 `npm run production-pipeline`、`npm run production-pipeline:test`、`npm run production-pipeline:console`、`npm run production-pipeline:console:test`；旧 manifest CLI、smoke 脚本和旧服务入口不再作为当前工作流维护。
- 当前生产闭环仍以 job JSON 为事实合同：`import -> summary -> kg -> embedding -> audio -> package -> publish -> verify`，运行状态写入 `tmp/production-pipeline/runs/<bookId>/<runId>/run.json`。
- 后续优先在 `production-pipeline/` 内继续补强真实整书生产、远端发布、失败恢复和 Gateway 上传任务化，不再开新的平行内容生产目录。

2026-06-26 更新：Gateway Android 真机连接与大数据包缓存继续修复。
- Gateway Android 客户端的单书 package 缓存从 `localStorage` 改为优先写入 IndexedDB，避免 Android WebView 在《妖刀记》这类大包上触发 `Storage exceeded the quota` 后中断打开书籍。
- package 写入 IndexedDB 成功后会清理同书旧版 localStorage 缓存；若 IndexedDB 不可用，仍保留 localStorage 降级，但失败不会回滚已经拉到内存里的书籍数据。
- 本机 Gateway 继续通过 LaunchAgent `com.gwaves.novel-reader-gateway` 监听 `0.0.0.0:6180`，测试 token 为 `123456`；手机调试通过 `adb reverse tcp:6180 tcp:6180` 访问 `http://127.0.0.1:6180`。
- Gateway Android 客户端开始按旧移动端样式拆分主栏目：底部新增“阅读 / 设置”导航，阅读页聚焦书库、详情、章节正文和音频播放；设置页集中 Gateway 地址、Token、设备名、连接与同步书库操作。
- Gateway Android 客户端继续拆分为“书库 / 阅读 / 设置”三栏：书库页负责选书、加载 package 和查看元数据；阅读页改为纯正文阅读界面，支持左侧点击上翻、右侧点击下翻、中间双击触发当前章节音频播放。
- Gateway Android 阅读页修正章节导航体验：顶部章节栏不再固定遮挡正文，会随阅读内容自然滚走；正文底部新增上一章/章节/下一章；中间双击改为打开章节切换面板，可直接上一章、下一章或选择任意章节。
- Gateway Android 阅读控制面板改为紧凑下拉式：双击中间区域打开阅读控制抽屉，章节选择改为 select 下拉，并整合当前章节音频播放、字号调节和纸张/暖色/护眼/夜间背景切换，阅读偏好会持久化。
- Gateway Android 书库页新增 Audio 同步进度与本地缓存统计：章节 MP3 会写入 IndexedDB，播放时优先使用本地缓存；覆盖安装同包名同签名 APK 应保留缓存，卸载/清除应用数据/更换包名或签名会删除缓存。
- Gateway Android 启动后会在 Gateway 地址和 Token 已配置时自动连接后端并同步书库；设置页的连接/刷新按钮改为兜底操作。默认 token 保持测试用 `123456`，默认 Gateway 地址可通过 `VITE_GATEWAY_DEFAULT_BASE_URL` 在构建时注入公有域名。
- Gateway Android 新增阅读进度恢复：阅读页滚动时会保存当前书、章节和滚动位置；下次启动自动连接并同步书库后，会优先打开上次阅读的书和章节并恢复到对应滚动位置。
- Gateway Android 修正阅读页切换 Tab 时的进度覆盖问题：离开阅读页前会主动保存真实滚动位置，回到阅读页会恢复该位置，避免进入设置页后再返回时跳到章节顶部。
- Gateway Android 优化 Audio 批量同步：真机上新增原生下载插件，MP3 会通过 Android 原生 HTTP 流式写入 APP 私有文件目录，IndexedDB 只保存本地路径和元数据，避免几十 MB 章节经过 JS/base64/Blob 后导致同步越下越慢；浏览器环境仍保留 Blob 缓存兜底。
- Gateway Android 移除 Audio 对 IndexedDB 的依赖：音频缓存状态改用轻量 localStorage 索引，MP3 继续存放在 Android 私有文件目录；旧版本 `chapter-audio` IndexedDB store 会在启动时清理，真机调试时也可直接清空 WebView IndexedDB 后重新拉取 package。
- Gateway Android 修正切换书籍后的 Audio 状态串书问题：音频目录、缓存数量和同步进度都会记录所属书籍，详情页与同步按钮只显示当前选中书籍的数据，避免《三国演义》误显示《妖刀记》的 27 章音频。
- 今日 Gateway Android 真机开发复盘已记录到 `docs/development-experience.md`，重点沉淀 WebView 存储边界、大文件音频同步、阅读进度恢复、异步状态归属和真机验证经验。

2026-06-25 更新：Gateway 移动书库索引 API 已进入最小可用形态。
- 产品边界补充：当时决定为 Gateway Android 单独新建应用目录/工程，与旧 `mobile-app/` 隔离，避免影响当时已可用的局域网/离线移动端。
- 新增独立 `gateway-android-app/` 客户端工程骨架，使用 Capacitor-ready React/Vite；第一版支持配置 Gateway 地址、token、设备名，验证会话，拉取书库并读取单书 package。
- `gateway-android-app/` 已支持将单书 package 缓存到本地，离线/请求失败时优先回退到缓存；可从 package 中识别章节列表，选择章节并阅读正文。
- `gateway-android-app/` 已接入 Gateway 音频接口：打开书籍时同步 `/mobile/books/:bookId/audio`，当前章节有音频时可通过受保护下载接口加载并播放 MP3。
- 新增 Gateway Docker 部署材料：`gateway/Dockerfile`、`gateway/docker-compose.yml` 和 `gateway/docs/deployment.md`，优先支持云服务器/VPS 或家里机器公网映射部署。
- 新增第一版设备名记录：受保护请求可携带 `X-Device-Name`，`GET /auth/session` 会登记设备到 `GATEWAY_DATA_DIR/devices.json`，`GET /auth/devices` 可查看已登记设备。
- 新增 `GATEWAY_DATA_DIR` 配置，默认使用用户目录下的 `.novel_reader_gateway`，第一版从 `books.json` 读取书库索引。
- `GET /mobile/books` 已从占位接口升级为受保护的书库列表接口；缺少 `books.json` 时返回空书库，存在时校验 schema 并按更新时间排序。
- 新增 `GET /mobile/books/:bookId`，从同一书库索引返回单书摘要，未知书籍返回稳定 `book_not_found` 错误。
- 新增 `GET /mobile/books/:bookId/package`，从 `GATEWAY_DATA_DIR/books/<bookId>/package.json` 返回完整移动数据包；当前只校验 `schemaVersion` 和 `book.id`，其余内容先透明透传。
- 新增 `PUT /admin/books/:bookId/package`，支持 PC 端或工具上传移动数据包到 Gateway，并自动维护 `books.json` 书库索引。
- 新增 OpenAI-compatible 转发入口：`POST /ai/chat` 和 `POST /ai/embeddings`，移动端只访问 Gateway，服务端负责注入上游 API Key 和默认模型。
- 新增本地 MP3 受保护访问：`GET /mobile/books/:bookId/audio` 读取 `GATEWAY_AUDIO_DIR/books/<bookId>/audio.json`，`GET /mobile/books/:bookId/audio/:chapterId/download` 负责鉴权后下载音频文件。
- `/capabilities` 现在会标记 books API 可用；README 补充了 `books.json` 第一版格式。

2026-06-25 更新：Gateway 开始补齐开发期鉴权与受保护路由基础。
- 新增 Gateway 结构化 HTTP 错误与 dev bearer token 鉴权模块，`GATEWAY_DEV_ACCESS_TOKEN` 可用于保护后续移动端数据、AI 和音频接口。
- 新增 `GET /auth/session` 作为鉴权验证入口，新增受保护占位接口 `GET /mobile/books`，确保移动数据 API 在真实实现前也不会裸露。
- Gateway 测试覆盖未配置鉴权、缺少 token、错误 token、正确 token，以及受保护移动数据路由的占位行为。

2026-06-24 更新：云端 Gateway 方向已启动，新增 `codex/cloud-gateway` 分支与 `gateway/` 工作目录。
- 目标：让移动客户端默认连接固定公有域名，通过云端 Gateway 获取书籍数据、阅读进度、AI 检索、embedding 转发和 MP3 播放资源，减少用户手动配置局域网 IP、LLM、embedding 与音频后端的成本。
- 架构原则：Gateway 作为独立云端服务，不直接把现有本地 SQLite API 暴露到公网；公网接口默认鉴权、限流和审计，移动端不保存上游模型或对象存储密钥。
- 已新增 `gateway/README.md` 与 `gateway/docs/development-plan.md`，记录产品目标、模块边界、API 草案、安全要求、阶段计划和近期任务。
- 后续优先级：先搭建最小 Gateway 服务骨架（健康检查、版本、能力接口、配置加载、统一错误格式），再接入鉴权、移动端默认域名、书库同步、AI/embedding 转发和 MP3 资源分发。

2026-06-23 更新：PC 端离线多角色 TTS 方向已启动，先落地本地 Node.js 目录与文档。
- Android App 高质量 MP3 播放方向已另立 `codex/mobile-mp3-playback` 分支开发：PC Web 端新增当前书“章节 MP3 目录”配置入口，本地服务持久化目录并通过 `/api/mobile/books/:bookId/audio` 暴露移动端音频清单。
- PC 端章节 MP3 目录规范：推荐根目录直接放 `ch001.mp3`、`ch002.mp3`；兼容 `001-章节标题.mp3`；兼容现有 TTS 批量产物 `ch001/audio/chapter.mp3` 或 `ch001-full/audio/chapter.mp3`。
- Android App 语音阅读新增播放引擎选择：可在“本地 TTS”和“云端 MP3”之间切换；同步页可刷新 PC 音频清单并下载当前章节 MP3 到 IndexedDB `chapterAudio` 缓存。
- Android App 章节 MP3 下载 UI 已优化：按章节显示“已下载 / 未下载 / 需更新”状态，移除前 8 条截断，新增“全部下载”入口，可一次下载所有可下载但尚未缓存的章节，并在下载过程中显示章节进度。
- PC Web 端章节 MP3 目录预览已改为完整滚动列表，不再截断前 10 条，便于确认最新生成的章节音频。
- Android 云端 MP3 播放已同步语速设置：启动播放与播放中调整倍速都会更新 HTMLAudioElement 的播放速度。
- Android 语音阅读设置已按播放引擎分菜单：本地 TTS 显示语言、音色、音调和系统语音检测；云端 MP3 显示倍速和章节 MP3 同步下载。
- Android MP3 播放已接入章节正文高亮/滚动：使用整章 MP3 播放，按语音片段文本长度估算时间轴，`timeupdate` 驱动当前片段高亮、自动滚动和独立语音进度保存。
- 新增 `offline-tts/` 作为独立工作目录，集中放置多角色 TTS 的设计文档、开发计划、示例配置和 Node.js CLI 脚本。
- 技术选型确定：主流程使用 Node.js，本地程序通过配置文件调用第三方 OpenAI-compatible 模型生成导演脚本 JSON；Codex 不参与批量大模型推理。
- 第一阶段目标不是直接合成整章音频，而是先把小说章节转换为可检查的导演脚本，严格分离旁白、对白、内心独白，并结合知识图谱与角色音色绑定做 speaker 判定。
- 初始脚本 `offline-tts/scripts/tts-director.mjs` 已具备配置读取、列书、章节检查、规则预切分、KG 候选角色读取和 `draft-script` 调用形态。
- 补充音频输出策略：离线多角色 TTS 可用 WAV 作为中间缓存，但最终章节/整书音频默认编码为 MP3，减少磁盘占用。
- 移动端线上朗读倍速扩展：系统 TTS 语速支持到 3x，设置页新增 0.75x、1x、1.25x、1.5x、2x、3x 快捷档位。
- 已接入可用第三方模型配置：`http://192.168.88.24:30000/v1` + `qwen3.6-27b`，API key 为空时不带鉴权头。
- `draft-script` 已完成第一轮功能验证：对《妖刀记》第 1 章前约 1000 字生成导演脚本，输出 16 个片段，校验 0 错误 0 警告；旁白、采蓝、黄缨和黄缨内心独白均能分离。
- 预切分规则已修正：短名称引号（如「黄缨」「水月停轩」）不再误拆为对白；`心里想` 和括号心理活动会单独切为 `thought`；切片边界会避开未闭合对白引号。
- `synth` 命令已接入初版 MIMO TTS：读取导演脚本逐段合成 WAV 缓存，使用 ffmpeg 标准化、插入停顿、拼接并默认输出 `chapter.mp3`。
- TTS 合成已支持 `director.performanceStyle` 公共表演提示，用于统一中文有声小说语速、节奏和角色表演风格。
- 根据试听反馈，女性角色音色提示已加强“少女声线、清亮轻盈、避免成熟御姐感”的约束，用于改善采蓝和黄缨的年龄感。
- TTS 合成已支持并发控制：`tts.concurrency` 或 `synth --concurrency` 控制缺失缓存片段的并发合成，拼接与 MP3 编码仍保持顺序串行。
- 并发 3 已完成实测：16 个片段完整合成、拼接、MP3 编码约 27 秒，输出 `tmp/tts/yaodao/ch001/audio-concurrency-3/chapter.mp3`。
- 已确认 MIMO `mimo-v2.5-tts-voicedesign` 可用于音色设计实验，但不是当前预置音色 voice id 的直接替代；后续应先做采蓝/黄缨小样本 A/B，验证跨片段声线一致性。
- 整章导演脚本生成已改为分批模式：`director.segmentBatchSize` 或 `draft-script --batch-size` 控制每批预切分片段数，避免整章单请求超时。
- 《妖刀记》第 1 章完整功能验证已跑通：分批生成 206 段导演脚本，校验 0 错误 0 警告；TTS 并发 3 合成并编码为 MP3，用时约 325 秒，输出 `tmp/tts/yaodao/ch001-full/audio/chapter.mp3`，成品约 55 分钟、39.6 MB、96 kbps。
- 导演脚本生成已支持 LLM 批次并发：`director.concurrency` 或 `draft-script --concurrency` 控制并发数，结果按原始批次顺序合并。第 20 章实测并发 10 时 7 个批次约 66 秒生成 188 段脚本，校验 0 错误 0 警告。
- 《妖刀记》第 20 章完整语音已生成：TTS 并发 3 合成并编码为 MP3，用时约 263 秒，输出 `tmp/tts/yaodao/ch020-full/audio/chapter.mp3`，成品约 40 分 50 秒、29.4 MB、96 kbps。
- 多 agent 并发生成第 19、21、22、23、24 章时观察到：多个章节同时进入高并发 LLM 阶段会造成内网模型超时或卡顿；已新增 `batch-pipeline` 命令，采用章节级流水线，LLM 阶段串行、TTS 阶段并行，推荐后续批量生成整本时使用。

2026-06-21 最新状态：main 已同步到 PR #21 和 PR #22。

2026-06-21 更新：`mobile-app-dev` 分支已推进到可安装 Android 调试包。
- `mobile-app` 已生成 Capacitor Android 工程，并可通过 Gradle 编译 `app-debug.apk`。
- 本机 Android 构建环境已验证：Homebrew `openjdk@21`、`android-commandlinetools`、Android 36 platform/build tools。
- PC 端 `/api/mobile/*` 同步接口已可返回真实书架和单书完整数据包；后端可用 `NOVEL_READER_API_HOST=0.0.0.0 npm run api` 监听局域网。
- Android App 已修复 LAN HTTP 同步限制和系统状态栏覆盖问题：允许 cleartext HTTP，并通过 Capacitor StatusBar + CSS safe-area 处理顶部布局。

2026-06-21 更新：独立 Android 移动端方向已确定，并新增 PC 端配套计划。
- 移动端将作为独立 `mobile-app` workspace 开发，定位为离线可用的完整数据消费端，而不是 PC 局域网 API 的实时面板。
- PC 端继续负责书籍导入、概要、知识图谱、正文 chunk embedding 和概要 embedding 生成；移动端不生成书籍/章节/chunk embedding。
- PC 端后续需要提供 `/api/mobile/manifest`、`/api/mobile/books`、`/api/mobile/books/:bookId/package` 等同步接口，导出单书完整移动数据包。
- 第一版移动数据包使用 JSON 验证端到端流程，包含章节、概要、图谱证据和 PC 端已生成 embedding；不包含 LLM API Key 或桌面端敏感模型配置。
- 移动端离线 RAG 第一版应优先使用本地 FTS/摘要/图谱匹配构造上下文，再调用移动端配置的公共 LLM 生成回答。

本轮合入内容：
- PR #21：离线扫描数据包导入闭环完成。离线扫描器可按书导出 JSON 数据包，首页可导入单书概要与知识图谱数据；导入时有阶段提示和忙碌进度，章节扫描 UI 改为更紧凑的范围选择和并发 worker 进度列表。
- PR #22：长章节 RAG embedding 策略完成 v1。新增 `chapter_chunk_embeddings`，搜索融合章节概要向量、正文 chunk 向量和知识图谱实体召回，避免 2 万字长章节被压成单个向量。

进入后续阶段：质量评估、审计与回滚。
- 目标 1：建立可重复的质量评估面板，覆盖概要、知识图谱抽取、实体共指、RAG 搜索命中率和耗时。
- 目标 2：为高风险图谱操作建立审计日志和回滚能力，覆盖共指合并、实体/关系批量删除、覆盖重扫、离线数据包导入。
- 目标 3：继续增强搜索体验，在 chunk RAG 基础上增加召回解释、章节范围过滤、实体类型过滤，并评估是否引入 FTS5。

2026-06-20 更新：开始 Reader UX polish 分支开发（`codex/reader-ux-polish`）。

采纳的阅读交互方向：
- 阅读设置面板：主题、字号、行高、段距、正文宽度等长期阅读参数。
- 阅读进度与恢复：显示章节内进度，并持久化每章滚动位置，回到章节时恢复上次读到的位置。
- 正文手势与快捷键：桌面扩展 Space/J/K/PageUp/PageDown/`[`/`]`，移动端增加正文左右点击翻屏。
- 阅读中轻量 AI：优先做选中文本后的轻量操作入口，将文本带入智能搜索；后续再扩展为段落解释、人物/道具追踪和本段关联图谱。

本分支第一批实现目标：
- 扩展共享阅读偏好状态，并让桌面/移动端共用。
- 桌面阅读页增加主题、行高、正文宽度、段距控件和章节进度条。
- 桌面/移动端保存并恢复章节内滚动位置。
- 移动端阅读页增加进度条、主题样式和正文点击翻屏。
- 桌面端选中文本后提供“搜索”入口，作为轻量 AI 的第一步。

2026-06-20 更新：EPUB 导入 v1 已开始。
- 目标：在现有本地书架中直接导入 `.epub`，复用已有阅读、概要、RAG 和知识图谱流程。
- 实现策略：浏览器端解析 EPUB zip，不新增运行时依赖；读取 `META-INF/container.xml` 定位 OPF，按 manifest/spine 顺序读取 XHTML 章节。
- 当前范围：先将 XHTML 正文转为纯文本章节导入，不保留原 EPUB 图片、CSS、脚注跳转和复杂排版。
- UI：桌面端和移动端文件选择器支持 `.txt` / `.epub`。

2026-06-20 最新状态：main 已同步到 PR #18 之后，知识图谱/RAG 的核心闭环已进入可用增强阶段。

已完成并合入 main：
- Phase 3 图可视化：实体一跳关系图、全局筛选图、实体名称/别名定位、核心节点数量控制、图例和节点可读性优化。
- Phase 4 图谱维护：实体编辑/合并/批量合并/拆分/删除，关系类型和源/目标端点修正，低置信度复审队列。
- Phase 4+ 共指清洗：新增全局 LLM coreference pass，按疑似人物组件调用模型判断同一身份并自动合并实体、别名、证据和冲突关系。
- Phase 5 图谱搜索与导出：证据搜索、JSON/GraphML 导出。
- RAG 搜索：章节概要 embedding、正文 chunk embedding、向量召回 + 图谱实体增强、搜索结果答案生成。
- RAG 配置：embedding 配置已从生成模型配置中解耦，保存配置时分别校验 LLM 与 embedding；embedding 校验改由本地后端代理，避免浏览器 CORS 问题，并记录向量维度。
- 数据管理：完整 SQLite 数据库备份/恢复，书名可在书架和当前书详情中编辑。
- 复审队列：支持批量标记已审/忽略，也支持按实体或关系批量删除。

当前建议的下一步：
1. 优先做“质量评估与回归测试面板”：为概要、图谱抽取、重扫、共指合并和 RAG 搜索建立可重复的样例书/章节测试集，记录准确率、误合并、漏合并、搜索命中率和耗时。
2. 然后做“图谱/RAG 操作审计与回滚”：共指合并、批量删除、重扫覆盖都已经具备较大破坏力，下一步应给这些操作增加变更记录和一键撤销/恢复能力。
3. 再考虑“搜索体验增强”：把图谱证据 LIKE 搜索升级为 FTS5，RAG 搜索增加按章节范围/实体类型过滤，并展示召回解释。

2026-06-20 更新：长章节 embedding 策略 v1 已完成。
- 后端：新增 `chapter_chunk_embeddings`，正文按段落切为约 1200 字 chunk 并带少量 overlap，避免 2 万字长章节被压成单个向量。
- RAG：搜索时融合章节概要向量、每章最佳正文 chunk 向量和知识图谱实体召回，结果片段优先展示命中的正文 chunk。
- UI：桌面端和移动端 embedding 覆盖率增加正文片段计数，生成进度显示已处理章节和 chunk 数。

判断：继续堆新功能前，最值得开发的是测试评估 + 可回滚的清洗流程。现在图谱维护能力已经很强，下一阶段的风险不在“能不能改”，而在“改错了能不能发现和恢复”。

按路线文档对照，现在我们已经超出 Phase 1，进入 Phase 2 后段了。
已完成：
SQLite 图谱表
图谱 API
章节级 extraction 保存
当前章节/范围/全书扫描
并发控制（默认并发 10）
跳过已扫描章节
已扫描章节列表
实体列表 + 名称/别名搜索 + 类型筛选
实体详情（出现次数、关系数、first/last seen、证据章节跳转）
关系列表 + 类型筛选
关系详情（源/目标实体、证据章节列表、跳转阅读器）
扫描任务持久化与刷新后恢复
实体编辑（名称、类型、别名、描述）
实体合并（选择主实体、合并别名和关系）
实体删除
关系删除
实体拆分（支持拆到新实体/已有实体、迁移别名/出现章节/关系）
启动后自动检查并恢复 pending 扫描任务
关系类型编辑（支持从关系详情修改类型和描述，含冲突检测）
批量合并实体（实体列表多选后一次性合并到主实体）
低置信度标记与复审队列（自动标记可疑实体/关系，支持批量审核）
阅读器批量生成全书缺失概要

接下来最该做的是 Phase 4 的实体消歧/纠错补完：
实体按类型筛选：人物、门派、道具、功法、地点、灵兽（已完成）
实体名称/别名搜索（已完成）
关系按类型筛选（已完成）
实体详情里显示 first/last seen、出现次数、关系次数（已完成）
实体编辑/合并/删除 v1（已完成）
实体拆分（已完成）
启动后自动恢复 pending 扫描任务（已完成）
关系类型编辑（已完成）
批量合并实体（已完成）

然后可以继续做：
低置信度标记与复审队列 ✅ 已完成
关系源/目标实体切换 ✅ 已完成

现在 Phase 4 的清洗与纠错闭环已经补齐，可以开始 Phase 3 图可视化。优先做实体一跳关系图，暂不渲染全书大图。

2026-06-18 更新：低置信度标记与复审队列已合并到 main。
- DB：kg_entities / kg_relations 新增 review_status 列（NULL/approved/ignored）。
- API：新增 GET /api/kg/review-queue、POST /api/kg/review-queue/mark。
- 启发规则：实体置信度 < 0.6、类型为 other、名称过短、别名可疑、缺少描述；关系置信度 < 0.6、类型为 related_to、缺少描述、自环。
- UI：知识图谱页面新增“待复审”统计按钮与复审队列面板，支持按实体/关系筛选、批量选择、标记已审/忽略/删除/编辑。
- 编辑/合并实体或关系后会自动重置 review_status 为 NULL，以便重新评估。

2026-06-18 更新：性能优化与 bug 修复（已提交 PR，待合并）。
- PR #5：为 kg_entity_mentions、kg_relation_mentions 增加 chapter_id 索引，并为 kg_chapter_extractions 增加 book_id 索引。知识图谱“已扫描章节”接口从 ~8.3s 降至 ~0.02s。
- PR #6：阅读器切换章节后自动滚动到章节顶部，修复方向键/按钮翻页后阅读位置不重置的问题。
- PR #7：修复自动恢复扫描时会重复扫描已完成章节的 bug。恢复前会先拉取最新已扫描章节列表，确保只扫真正 pending 的章节。

2026-06-18 更新：修复恢复扫描仍从已扫描章节重复开始的问题，并新增停止扫描按钮。
- 修复根因：`resumeKnowledgeGraphScan` 调用 `fetchKgScannedChapters()` 后，旧代码立即读取 `kgScannedChapters` 这个 React state 闭包，导致拿到的是刷新前的空数组，从而把全书都当成 pending。现在 `fetchKgScannedChapters()` 返回最新已扫描章节列表，恢复扫描时直接用返回结果计算 pending 章节。
- 新增停止扫描：扫描过程中显示「停止扫描」按钮，设置 `shouldStopScanningRef` 标志让并发 worker 在处理完当前章节后退出，任务状态记为 `cancelled`，UI 显示「已停止」。
- 清理了数据库中遗留的 `running` 扫描任务，避免启动后仍显示旧任务。

2026-06-18 更新：阅读器新增「批量生成全书缺失概要」。
- `useReaderState` 新增 `handleBatchGenerateAllMissingSummaries()`：过滤全书中没有概要的章节，使用现有并发设置批量调用 AI 生成，并逐章保存到 state/summaries 表。
- 缺失章节 >50 时弹出确认对话框，避免误触产生大量模型调用。
- 单个章节失败不会中断整批任务，最后会报告成功/失败数量。
- 桌面端 AI 面板和移动端概要页均新增按钮，状态栏同时显示全书和本页概要进度。

当前已知问题（非本功能引入）：
- npm run lint 存在 7 个 pre-existing error/warning，集中在 useReaderState.ts 和 App.tsx 的 useEffect 依赖/setState 模式。TypeScript 编译和 vite build 均通过。

已完成：
- 关系源/目标实体切换（关系纠错）
现在可以在关系详情中把 source 或 target 改成另一个实体，解决抽取时端点错误的问题。

2026-06-19 更新：修复离线扫描器偶发 `fetch failed` 并支持断点续传时重试失败章节。
- `scripts/offline-scanner/llm.mjs`：新增 `fetchWithRetry`，对 `TypeError: fetch failed`、`AbortError`、`ECONNRESET`、`ETIMEDOUT`、`ECONNREFUSED` 等瞬态网络错误最多重试 3 次，退避间隔 500ms/1000ms/2000ms；单次请求默认超时 5 分钟（可通过 `OFFLINE_REQUEST_TIMEOUT_MS` 覆盖）。
- `scripts/offline-scanner/scanner.mjs` + `db.mjs`：`resume` 恢复任务时自动将 `failed` 章节重置为 `pending`，避免失败章节被跳过。
- 更新 `README.md`、新增 `README.zh-CN.md`，新增 `docs/development.md`、`docs/development.zh-CN.md` 完善开发文档。

2026-06-19 更新：关系源/目标实体切换已完成。
- API：`PUT /api/kg/relations/:id` 支持同时更新 `sourceId`、`targetId`、`type`、`description`。
- 冲突处理：如果新端点 + 关系类型已存在，会把当前关系的证据迁移到已有关系，删除旧关系，并重新计算关系 first/last seen。
- 校验：禁止自环端点，禁止跨书实体作为关系端点，端点实体不存在时返回错误。
- UI：关系编辑弹窗新增源实体/目标实体搜索选择，保存后刷新关系列表、关系详情和复审队列。
- 复审：关系编辑或端点切换后会重置 review_status，方便重新进入启发式复审判断。

接下来建议：
- 章节重扫与图谱重建
允许对单章或章节范围重新抽取，并从保存的 raw extraction 重放图谱写入。这样可以在提示词、模型或人工修正策略变更后，有控制地刷新局部图谱数据。

2026-06-19 更新：Phase 3 图可视化 v1 已完成。
- 目标：先做实体一跳关系图，不渲染全书大图。
- 后端：新增实体 neighborhood 查询，返回中心实体、邻居实体和一跳关系。
- UI：实体详情新增“关系图”，使用 React Flow 展示一跳关系，并支持实体类型/关系类型过滤。

2026-06-19 更新：Phase 3 全局筛选图 v1 已完成。
- 后端：新增 `GET /api/kg/graph`，按书籍、实体类型、关系类型和限量返回可控规模的关系图。
- UI：知识图谱统计区新增“图谱视图”，默认展示人物图，可切换人物、门派、道具、功法、地点、灵兽、事件和关系类型。
- 渲染策略：仍避免无限全书大图，按高证据关系限量取图，并支持点击节点/边跳转实体详情或关系详情。

2026-06-19 更新：Phase 5 图谱证据搜索 v1 已完成。
- 后端：新增 `GET /api/kg/search`，支持搜索实体出现证据、关系证据、实体/关系描述、实体名称和章节标题。
- UI：知识图谱统计区新增“证据搜索”，可搜索全部/实体/关系证据，并从结果跳转实体详情、关系详情或阅读器章节。
- 策略：先使用 SQLite LIKE 查询，不新增迁移；后续数据量继续扩大时可替换为 FTS5。

2026-06-19 更新：Phase 5 图谱导出 v1 已完成。
- 后端：新增 `GET /api/kg/export`，支持导出完整知识图谱 JSON 或 GraphML。
- JSON：包含书籍信息、实体、关系和章节级证据 mentions，便于备份或后续二次处理。
- GraphML：导出节点/边及 label、type、description、confidence、mentionCount、first/last chapter 等属性，可导入 Gephi 等图分析工具。

2026-06-19 更新：数据库整体备份/恢复 v1 已完成。
- 后端：新增 `GET /api/database/export`，使用 SQLite `VACUUM INTO` 生成一致性 `.sqlite` 备份下载。
- 后端：新增 `POST /api/database/import`，上传 `.sqlite` 后校验完整性和关键表，先备份当前数据库，再把恢复文件排队到下次服务启动替换。
- UI：首页新增“数据库备份”，支持备份完整数据库和选择备份文件恢复；恢复会提示重启本地数据库服务后生效。

2026-06-20 更新：离线扫描单书数据包导入 v1 已完成。
- CLI：`node scripts/offline-scanner.mjs bundle <bookId> [path]` 可把某本书的概要、章节级 KG extraction、实体、关系和证据导出为 JSON 数据包。
- 后端：新增 `POST /api/offline/import`，校验数据包格式、书籍 ID 与章节归属后，将该书概要 upsert，并全量替换该书知识图谱数据。
- UI：首页新增“离线扫描数据”入口，可选择单书 JSON 数据包导入，导入后刷新书架概要快照和当前图谱统计。

2026-06-19 更新：章节图谱 diff 预览 v1 已完成。
- 后端：新增章节 extraction diff 预览接口，对比当前章节已写入图谱证据和候选 extraction JSON。
- UI：手动保存当前章节 JSON 前会先显示新增/移除/不变实体和关系证据，确认后才写入。
- UI：覆盖重扫 10 章以内会先生成 extraction 并汇总 diff，确认后应用，避免局部重建直接覆盖。

2026-06-19 更新：章节重扫与 raw extraction 重放已完成。
- 后端：`PUT /api/kg/chapters/:id/extraction` 覆盖保存时会重写该章节图谱证据，并重新计算受影响实体/关系的 first/last seen。
- 后端：新增 `POST /api/kg/chapters/:id/replay`，可从 `kg_chapter_extractions.extraction_json` 重放写入图谱，不重新调用模型。
- 清理：重写章节后会删除没有证据的空关系，以及没有出现章节和关系的空实体，避免局部重建后留下陈旧节点。
- UI：章节扫描面板新增“覆盖已完成章节”，可对当前章节/当前页/指定范围/全书重新抽取。
- UI：章节扫描面板新增“重放已保存 JSON”，用于按当前选择范围从已有 raw extraction 重建图谱。
- 验证：`npm run build` 通过；使用临时 SQLite 数据库走通保存 extraction、replay、覆盖为空后清理旧实体/关系。`npm run lint` 仍为既有 7 个 error/10 个 warning，集中在 React hooks 和正则 escape。

2026-06-19 更新：实体拆分已完成。
- API：新增 `POST /api/kg/entities/:id/split`，可从源实体拆出新实体，或拆到已有实体。
- 数据迁移：支持迁移选中的 `kg_entity_mentions`，并重新计算源实体和新实体 first/last seen。
- 关系迁移：支持迁移选中的相关关系，把关系端点从源实体切到新实体；如果迁移后撞到已有同类型同端点关系，会合并证据并删除旧关系。
- 别名迁移：支持把源实体的选中别名迁到新实体或已有实体，并从源实体别名中移除。
- 校验：新实体名称不能为空，不能与同书同类型实体重名；已有目标实体不能是源实体且必须同书；被迁移的出现章节和关系必须属于源实体。
- UI：实体详情新增“拆分”按钮，弹窗内可选择拆到新实体或已有实体，填写新实体信息/搜索已有实体，并勾选要迁出的别名、出现章节和关系。
- 复审：拆分后重置源实体、新实体和迁移关系的 review_status，便于后续重新复审。

2026-06-19 更新：图谱视图展示优化已完成。
- UI：全书图谱新增实体名称/别名定位，命中后只展示匹配实体及其一跳邻居，便于从大图中快速聚焦。
- UI：全书图谱新增核心节点数量控制，默认展示核心 80 个节点，可切换核心 40/140 或全部。
- 渲染：节点宽度和关系线宽会按出现次数调整，匹配节点高亮，图例展示当前可见节点/关系数量。
- 视觉：图谱节点支持自动换行、阴影和更稳定的尺寸，减少长名称挤压和大图混乱感。
- 页面：移除底部重复实体列表，将当前章节手动 JSON 保存入口收进章节扫描的折叠高级操作，减少主页面干扰。

2026-06-26 更新：Gateway 数据发布脚本已完成。
- 新增 `gateway/scripts/publish-package.mjs`，可从 PC 本地 `/api/mobile/books/:bookId/package` 读取移动端完整数据包，并上传到 Gateway 的 `PUT /admin/books/:bookId/package`。
- 根脚本新增 `npm run gateway:publish-package`，支持 `GATEWAY_BASE_URL`、`GATEWAY_DEV_ACCESS_TOKEN`、`NOVEL_READER_API_BASE_URL`、`NOVEL_READER_SYNC_TOKEN` 等环境变量，也支持 `--source-file` 和 `--dry-run`。
- Gateway 导入移动端数据包时兼容本地 API 的数字 book id，并在 package 缺少 `book.updatedAt` 时用 `generatedAt` 或 `book.importedAt` 回填书库索引更新时间。
- README 与 Gateway 开发计划已补充脚本发布路径，PC 端暂不新增发布 UI，后续 MP3 产物也优先按脚本化发布路线推进。

2026-06-26 更新：Gateway MP3 发布链路与新安卓端音频体验已推进。
- 新增 `gateway/scripts/publish-audio.mjs`，可扫描 offline-tts 输出目录下的 `chNNN-full/audio/chapter.mp3` 与 `manifest.json`，按移动数据包章节序号匹配真实 `chapterId`，复制到 `GATEWAY_AUDIO_DIR/books/<bookId>/` 并生成 `audio.json`。
- 根脚本新增 `npm run gateway:publish-audio`；该路径是发布到 Gateway 音频目录，不是发布到 Git 目录。
- Gateway 音频清单新增 `manifestFileName` 与 `timelineVersion`，并提供受保护的 `/mobile/books/:bookId/audio/:chapterId/manifest` 接口供移动端读取 timeline。
- 新 `gateway-android-app/` 已显示当前章节音频时长、大小和时间轴状态；播放时会拉取 manifest，并根据当前播放时间在正文中高亮对应片段。

2026-06-26 更新：Gateway 独立 Android 工程已生成。
- `gateway-android-app/android/` 已通过 Capacitor 生成独立 Android 原生工程，包名为 `com.gwaves.novelreader.gateway`，不再需要兼容旧 `mobile-app/`。
- 新增根脚本 `npm run gateway-android:android:build`，用于构建 Gateway Android debug APK。
- Android Manifest 已显式允许 HTTP cleartext，便于连接自建 Gateway、公网映射或开发期内网地址。
- APK 输出名已改为带版本号的 `novel_gateway-v<version>-debug.apk`，产物路径为 `gateway-android-app/android/app/build/outputs/apk/debug/novel_gateway-v<version>-debug.apk`。

2026-06-26 更新：Gateway Android 真机连接问题已修复。
- 新 `gateway-android-app/` 在 Android 真机上访问 `http://127.0.0.1:6180` 时已改用 Capacitor 原生 `CapacitorHttp`，避免 WebView `fetch` 对 HTTP/localhost 的限制导致 `fail to fetch`。
- Gateway 本机测试 token 已改为 `123456`，便于手机端验证。
- 本机 Gateway 已通过 macOS LaunchAgent `com.gwaves.novel-reader-gateway` 保活，配置监听 `0.0.0.0:6180`，数据目录为 `~/.novel_reader_gateway`。
- 真机通过 `adb reverse tcp:6180 tcp:6180` 访问 Gateway，日志已确认 `/auth/session` 和 `/mobile/books` 返回 200，手机端可看到《妖刀记》和《三国演义》。

2026-06-30 更新：Gateway Android 阅读进度改为按书保存。
- 移动端阅读进度从单个“当前书”记录升级为按 `bookId` 分开的进度表，每本书独立保存章节和滚动位置，支持多本书混读。
- 旧版单书进度会在读取/写入时兼容迁移，不会丢失用户原有的最近阅读位置。
- 删除本地书籍时只清理该书的阅读进度，不影响其他书的章节恢复。

2026-06-30 更新：Gateway 增加 Android APK 下载发布能力。
- Gateway 新增公开 `/downloads/*` 静态下载目录，默认目录为 `GATEWAY_DATA_DIR/downloads`，可通过 `GATEWAY_DOWNLOADS_DIR` 覆盖。
- 新增 `gateway/scripts/publish-android-apk.mjs` 和根脚本 `npm run gateway:publish-android-apk`，会把最新 Android APK 发布为固定文件名 `ai_novel_reader.apk`，同时保留版本化文件与 `android-app.json`。
- 访问 `/downloads/ai_novel_reader.apk` 即可下载当前编译发布的最新版 Android 安装包。

2026-06-30 更新：Gateway Android 应用内检查更新已完成。
- 设置页底部新增“应用更新”区域，展示当前版本、线上版本、Version Code，并支持手动检查更新。
- App 会读取 Gateway `/downloads/android-app.json`，当线上 `versionCode` 大于本机 `versionCode` 时显示“下载并安装”。
- Android 原生插件新增 APK 下载与系统安装确认能力，下载固定使用 Gateway `/downloads/ai_novel_reader.apk`；系统仍会要求用户确认安装，符合 Android 安全限制。
- 已发布线上 build 230 到 Gateway 下载目录，并在测试设备保留 build 229，用于从 App 内验证检查更新链路。

2026-06-30 更新：Gateway Admin 数据包覆盖率显示已修复。
- `/admin/packages` 现在会返回 summary、KG、embedding 覆盖率；缺少显式字段时会从 package 的 summaries、knowledgeGraph mentions、embeddings.coverage 或旧格式 embeddings 数组派生。
- `/admin/books` 也会复用同一套 package 覆盖率结果，避免书籍页继续读取 `books.json` 的陈旧覆盖率。
- Admin UI 书籍列表和数据包列表不再把缺失覆盖率字段误显示为 0%，未知值显示为 `-`，真实 0% 仍保留。
- 已部署到 192.168.88.100，并验证线上 `/admin/books` 和 `/admin/packages` 返回金麟外传、大唐双龙传、妖刀记、三国演义和西游记为 S/KG/E 全 100%。

2026-06-30 更新：Gateway Admin 首屏加载优化已完成。
- Gateway 后端为 package 元数据增加按文件 size/mtime 的内存缓存，并复用并发中的解析 Promise，避免 `/admin/books`、`/admin/packages`、`/admin/audio` 在同一次刷新中重复解析大型 embedding package JSON。
- Admin UI 首屏先加载总览依赖的 `/admin/metrics` 和 `/admin/events`，总览可先显示，再后台补齐书籍、数据包、音频和请求日志明细。
- 线上验证：冷缓存下重接口约 1.16s，热缓存下 `/admin/books` 约 6ms、`/admin/packages` 约 3ms、`/admin/audio` 约 17ms；总览依赖接口约 1-20ms。

2026-06-30 更新：Gateway Admin 总览趋势图改为真实数据。
- `/admin/metrics` 新增最近 60 分钟、每 5 分钟一桶的请求趋势和下载趋势数据。
- Admin UI 移除总览页硬编码趋势柱状图，改为渲染真实请求数、错误数、P95、package 下载和 audio 下载；无数据时显示暂无数据。
- 已部署到 192.168.88.100，并验证线上 `/admin/metrics` 返回 12 个真实 request/download buckets。

2026-06-30 更新：Gateway Admin 最近事件去除真实接口下的 mock 回退。
- Admin UI 的最近事件列表在 `/admin/events` 返回空数组时显示“最近 30 分钟暂无事件”，不再回退到演示 mock 事件。
- mock 事件仅保留在 API 完全不可用的 demo fallback 场景。
- 已部署到 192.168.88.100，并验证线上 `/admin/events` 当前返回空数组。

2026-06-30 更新：Gateway Admin 内容健康改为真实数据。
- Admin UI 总览页“内容健康”不再使用 `mockData` 静态值，改为根据实时 `/admin/books`、`/admin/packages`、`/admin/audio` 结果计算。
- 当前计算口径：书籍总数、非 default 可见范围书籍数、hidden 书籍数、缺音频章节总数、非 ready 数据包数。
- 已部署到 192.168.88.100，并验证线上当前值为 8 本、受限 3 本、隐藏 0 本、缺音频章节 348、异常数据包 0。

2026-06-30 更新：Gateway Admin 系统和设备摘要改为真实数据。
- `/admin/metrics` 新增 `process.dataDirBytes`，由 Gateway 实时扫描数据目录大小；Admin UI 不再显示硬编码 CPU/磁盘示例值。
- 总览页“运行 / 内存 / 数据目录”改为显示 Gateway uptime、heap、RSS 和数据目录大小；“在线设备”改为根据 `/admin/devices` 统计总设备、受信设备和禁用设备。
- 已部署到 192.168.88.100，并验证线上当前返回 `dataDirBytes=357949331`、设备 3 台、受信 2 台、禁用 0 台。
