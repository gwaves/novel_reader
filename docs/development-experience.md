# 开发经验记录

## 2026-06-26：Gateway Android 真机开发复盘

今天主要围绕 `gateway/` 与新的 `gateway-android-app/` 推进云端 Gateway 方案，并在真机上连续修复了连接、缓存、阅读体验和音频同步相关问题。整体结论是：移动端 WebView + Capacitor 的状态、存储、网络和原生能力边界，需要比普通浏览器页面更早纳入设计；不能只按“Web 页面能跑”来判断 Android 真机体验。

### 1. 大 package 不能继续塞进 localStorage

问题表现：
- 《妖刀记》这类大书包加载后，Android WebView 报 `Storage exceeded the quota`。
- 页面已经拿到数据，但写缓存失败会影响用户打开书籍的信心。

根因：
- `localStorage` 适合小配置和轻量状态，不适合保存大 JSON package。
- Android WebView 的 quota 和行为与桌面浏览器不完全一致，不能用桌面调试结果推断真机表现。

处理：
- 单书 package 缓存改为优先写入 IndexedDB。
- `localStorage` 只保留降级路径，并且缓存失败不能阻断内存里的书籍数据展示。

经验：
- 大 JSON、二进制、长文本缓存必须先判断数据量级，再选存储介质。
- 缓存是体验增强，不应轻易成为主流程失败点。

### 2. Audio 不能用 JS Blob/IndexedDB 做批量大文件缓存

问题表现：
- 局域网 WiFi 下同步 MP3，前两章还可以，第三章开始明显变慢。
- 本机 `curl` 直接拉 Gateway 的 39MB 音频非常快，说明服务端流式接口不是瓶颈。

根因：
- 章节 MP3 单个通常 30MB 到 50MB，27 章接近 1GB。
- 旧实现通过 Capacitor/JS 获取二进制，再转 Blob 写 IndexedDB。连续处理大文件时，JS 内存、base64/Blob 转换和 IndexedDB 写入都会成为瓶颈。
- IndexedDB 适合 package 这类结构化缓存，但不适合在 WebView 里批量写入大 MP3。

处理：
- 新增 Android 原生插件 `GatewayAudioPlugin`，用 `HttpURLConnection` 流式下载 MP3 到 APP 私有文件目录。
- Audio 缓存状态只保留轻量 `localStorage` 索引，记录书籍、章节、本地文件路径和大小。
- 移除 Audio 对 IndexedDB 的依赖，并清理旧 `chapter-audio` store。

经验：
- 大文件下载应走原生流式文件写入，JS 只管调度和索引。
- IndexedDB 不应成为音频、视频这类大二进制批量缓存的默认选择。
- 遇到“局域网也慢”，要先拆分服务端吞吐、传输层、客户端解码/写盘三个环节分别测量。

### 3. 阅读进度必须在切换 UI 前主动保存

问题表现：
- 在阅读页翻了几页，点击“设置”再回到“阅读”，页面跳回章节顶部。

根因：
- 旧逻辑依赖 React effect cleanup 保存滚动位置。
- 切到设置页时阅读 DOM 被替换，页面高度变化后 `window.scrollY` 可能已经被浏览器夹到 0，再把 0 写回进度。

处理：
- 所有底部 Tab 切换收口到 `switchTab`。
- 离开阅读页前立即保存当前真实滚动位置。
- 返回阅读页时按保存的书、章节、滚动位置恢复。

经验：
- 导航切换、路由切换、条件渲染会改变页面高度，滚动位置不能只靠卸载时读取。
- 对阅读器这类强状态界面，离开前保存、回来后恢复应是显式流程。

### 4. 多 Tab/多书籍状态必须带归属

问题表现：
- 《妖刀记》有 27 个音频，同步后点击《三国演义》，详情页仍显示 `22/27` 或同步按钮显示 27 个 Audio。

根因：
- `audioChapters`、`cachedAudioIds`、`audioSyncProgress` 是全局状态。
- 切换书籍时，新书 package 已切换，但音频目录和同步进度还沿用上一本文。

处理：
- 给音频目录、缓存数量、同步进度分别增加所属书籍 ID。
- UI 只显示当前选中书籍匹配的 Audio 状态。
- 切换书籍时立即清空上一本文的 Audio 显示状态。

经验：
- 只要状态来自异步请求，并且页面允许切换实体，就必须记录状态归属。
- 列表详情页不要用“最近一次请求结果”直接渲染，应该校验它是否属于当前实体。

### 5. 移动端栏目结构要先服务主要场景

问题表现：
- 书库、同步、设置、阅读内容混在一个界面里，视觉和操作都拥挤。
- 阅读顶部章节栏固定后遮挡正文，控制区占用正文空间。

处理：
- 新客户端拆成“书库 / 阅读 / 设置”三栏。
- 阅读页保持正文优先，左右点击翻页，中间双击打开紧凑控制面板。
- 章节选择、上一章/下一章、音频播放、字号和背景设置放进双击面板。

经验：
- 移动端阅读器的第一原则是正文沉浸，配置和同步都应退到独立栏目。
- 控制面板可以强功能，但默认阅读状态要克制。

### 6. 真机验证要成为每个移动端改动的默认步骤

今天多次出现桌面构建通过但真机才暴露的问题，包括：
- WebView 存储 quota。
- Android cleartext/LAN 连接。
- 大 MP3 同步速度。
- 覆盖安装后缓存保留行为。
- 屏幕安全区和顶部遮挡。
- 书籍切换后的异步状态串书。

建议后续移动端改动的最小验证流程：
- `npm run gateway-android:build`
- `npm run gateway-android:android:build`
- `adb install -r gateway-android-app/android/app/build/outputs/apk/debug/novel_gateway-v<version>-debug.apk`
- 真机至少验证：启动自动连接、书库切换、阅读进度、Audio 列表、当前章节播放。
- 涉及缓存时额外验证：覆盖安装、强停重启、清数据或清 WebView 缓存后的表现。

### 7. 后续开发原则

- Package 缓存可以继续使用 IndexedDB，但 Audio 不再使用 IndexedDB。
- 移动端持久化按数据类型分层：设置和轻量索引用 `localStorage`，结构化大 JSON 用 IndexedDB，大二进制用原生文件系统。
- 所有“当前书籍”相关状态都要带 `bookId`，包括 package、audio catalog、audio cache、sync progress、reading progress。
- 所有异步请求返回后，渲染前要确认结果仍属于当前选中的书籍。
- Gateway 服务端接口要保持流式和轻量，移动端性能问题优先从客户端存储与桥接层排查。
- 开发时先追求可用，但发现状态串扰或存储边界问题后，要及时收口成明确的状态模型，而不是继续补局部判断。
