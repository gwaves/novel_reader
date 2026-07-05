# Gateway 部署说明

Gateway 第一版面向两种部署方式：

- 云服务器/VPS 上运行 Docker 容器，通过 Nginx、Caddy 或云厂商负载均衡提供 HTTPS。
- 家里或办公室机器运行 Docker 容器，通过公网映射、反向代理或隧道服务暴露 HTTPS 域名。

公网环境不要直接暴露未加 HTTPS 的接口。建议外层统一终止 TLS，再反代到容器内的 `http://127.0.0.1:6180` 或 Docker 网络地址。

如果 Gateway 跑在 Nginx、Caddy、负载均衡或 Docker 反向代理后，必须开启 `GATEWAY_TRUST_PROXY=true`，并让代理传递 `X-Real-IP` / `X-Forwarded-For`。否则 Gateway 只能看到 Docker bridge 或代理容器地址，例如 `172.18.x.x`，设备列表和请求日志里的 IP 就不是客户端真实地址。

生产流水线如果跑在内网另一台机器上，可以同时保留两个入口：

- 内部生产流水线访问 Gateway 应用 HTTP 端口，例如 `http://192.168.88.100:6180`。
- 手机或外部客户端访问 Nginx HTTPS 入口，例如 `https://novel.gwaves.net:8888`。

这样生产流水线不会因为 HTTPS 证书域名和内网 IP 不匹配而失败；HTTPS 证书只由 Nginx 入口负责。

## Docker Compose

在 `gateway/` 目录准备 `.env`：

```bash
GATEWAY_PUBLIC_BASE_URL=https://reader.example.com
GATEWAY_TRUST_PROXY=true
GATEWAY_DEV_ACCESS_TOKEN=
GATEWAY_ADMIN_ACCESS_TOKEN=replace-with-a-long-random-admin-token
GATEWAY_MOBILE_ACCESS_TOKEN=replace-with-a-long-random-mobile-token
# 浏览器跨域白名单，移动 App 原生请求通常不需要。生产如果不需要浏览器跨域，保持空；不要配置 *。
GATEWAY_CORS_ORIGINS=
GATEWAY_DOWNLOADS_DIR=
GATEWAY_AI_BASE_URL=https://api.openai.com/v1
GATEWAY_AI_API_KEY=
GATEWAY_AI_MODEL=gpt-4.1-mini
GATEWAY_EMBEDDING_PROVIDER=ollama
GATEWAY_EMBEDDING_BASE_URL=http://192.168.88.100:11434
GATEWAY_EMBEDDING_API_KEY=
GATEWAY_EMBEDDING_MODEL=qwen3-embedding:8b
```

启动：

```bash
docker compose up -d --build
```

默认挂载：

- `gateway/data` -> 容器 `/data`，保存 `books.json` 和单书 `package.json`。
- `gateway/audio` -> 容器 `/audio`，只读提供本地 MP3 清单和音频文件。
- Android APK 下载目录默认使用 `gateway/data/downloads`，由 Gateway 公开为 `/downloads/*`。如果需要把下载文件放在独立磁盘或目录，可以设置 `GATEWAY_DOWNLOADS_DIR`，并在 Compose 中额外挂载该目录。

独立下载目录示例：

```yaml
services:
  gateway:
    environment:
      GATEWAY_DOWNLOADS_DIR: /downloads
    volumes:
      - ./data:/data
      - ./audio:/audio
      - ./downloads:/downloads
```

如果生产流水线运行在 Mac 等内网机器上，需要让 Gateway 应用端口对局域网开放：

```yaml
services:
  gateway:
    expose:
      - "6180"
    ports:
      - "6180:6180"
```

如果生产流水线也运行在 Gateway 宿主机上，可以只绑定本机：

```yaml
services:
  gateway:
    ports:
      - "127.0.0.1:6180:6180"
```

对外 HTTPS 入口仍由 Nginx 或其他反向代理暴露，不需要让移动端直连 `6180`。

## 目录格式

移动数据包：

```text
gateway/data/
├── books.json
└── books/
    └── <bookId>/
        └── package.json
```

本地 MP3：

```text
gateway/audio/
└── books/
    └── <bookId>/
        ├── audio.json
        └── chapter-1.mp3
```

Android APK 下载：

```text
gateway/data/downloads/
├── novel_gateway.apk
├── novel_gateway-v<versionName>-debug.apk
└── android-app.json
```

- `novel_gateway.apk` 是固定最新版文件名，供手机浏览器直接下载安装。
- `novel_gateway-v<versionName>-debug.apk` 是版本归档文件，`versionName` 包含基础版本、构建号和 commit。
- `android-app.json` 记录当前版本、versionCode、构建号、commit、文件名、URL 和发布时间。

## 发布 Android APK

先在项目根目录编译 Gateway Android APK：

```bash
npm run gateway-android:android:build
```

发布到本机 Gateway 默认下载目录：

```bash
npm run gateway:publish-android-apk
```

脚本默认读取 `gateway-android-app/android/app/build/outputs/apk/debug/novel_gateway-v<versionName>-debug.apk`，并发布到 `GATEWAY_DOWNLOADS_DIR`；未设置时使用 `GATEWAY_DATA_DIR/downloads`，再未设置时使用 `~/.novel_reader_gateway/downloads`。`versionName` 由 `gateway-android-app/scripts/generate-build-info.mjs` 自动生成，格式类似 `0.7.0+build.228.g3fcfd98db346`。

如果 Gateway 部署在远端机器，推荐先在本机发布到临时目录，再同步到远端 Compose 挂载的下载目录。例如网关机器 `192.168.88.100` 使用 `~/novel-reader-gateway/data:/data`：

```bash
npm run gateway:publish-android-apk -- --downloads-dir /tmp/novel-reader-downloads
rsync -az /tmp/novel-reader-downloads/ \
  gwaves@192.168.88.100:/home/gwaves/novel-reader-gateway/data/downloads/
```

如果要直接指定 APK 或版本：

```bash
npm run gateway:publish-android-apk -- \
  --source-apk 'gateway-android-app/android/app/build/outputs/apk/debug/novel_gateway-v0.7.0+build.228.g3fcfd98db346-debug.apk' \
  --version '0.7.0+build.228.g3fcfd98db346' \
  --downloads-dir gateway/data/downloads
```

发布后固定下载地址：

```text
https://novel.gwaves.net:8888/downloads/novel_gateway.apk
```

## 192.168.88.100 证书部署约定

真实 Gateway 部署目录固定为 `gwaves@192.168.88.100:/home/gwaves/novel-reader-gateway`。公网 HTTPS 证书由 88.100 上的 Certbot/Let's Encrypt 目录提供，当前路径为 `/home/gwaves/letsencrypt/config`。自动化部署同步 `gateway/` 时不得覆盖该目录，也不要把旧的 `tls/gateway.crt` 自签证书重新接回公网 Nginx。

当前 Compose 内置 Nginx 容器把 `${GATEWAY_LETSENCRYPT_CONFIG_DIR:-/home/gwaves/letsencrypt/config}` 挂载到容器内 `/etc/letsencrypt`，Nginx 配置固定读取：

```text
/etc/letsencrypt/live/novel.gwaves.net/fullchain.pem
/etc/letsencrypt/live/novel.gwaves.net/privkey.pem
```

远端有效证书目录应类似：

```text
/home/gwaves/letsencrypt/config/
├── live/
│   └── novel.gwaves.net/
│       ├── fullchain.pem -> ../../archive/novel.gwaves.net/fullchain<N>.pem
│       └── privkey.pem -> ../../archive/novel.gwaves.net/privkey<N>.pem
└── archive/
    └── novel.gwaves.net/
```

`fullchain.pem` 必须是公网 CA 签发的完整证书链，也就是 leaf certificate 加中间证书链；不能只放自签证书，不能只放 leaf certificate。Android 真机检查更新或下载安装 APK 时如果看到 `java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.`，优先按证书链错误处理，不要先改 App 下载逻辑。

证书文件放置或续期后，在 192.168.88.100 上执行：

```bash
cd /home/gwaves/novel-reader-gateway
docker compose --profile https up -d gateway-https
docker compose exec gateway-https nginx -t
```

发布脚本或手工同步代码到 192.168.88.100 时，必须排除远端运行数据和证书目录：

```bash
rsync -az --delete \
  --exclude '.env' \
  --exclude 'data/' \
  --exclude 'audio/' \
  --exclude 'backups/' \
  --exclude 'tls/' \
  --exclude 'letsencrypt/' \
  gateway/ gwaves@192.168.88.100:/home/gwaves/novel-reader-gateway/
```

上线前必须做严格 TLS 校验，不能用 `curl -k` 作为公网或真机验收依据：

```bash
openssl s_client -connect novel.gwaves.net:8888 -servername novel.gwaves.net -verify_return_error </dev/null
curl -I https://novel.gwaves.net:8888/health
curl https://novel.gwaves.net:8888/downloads/android-app.json
```

`openssl s_client` 必须返回 `Verify return code: 0 (ok)`；`curl -I` 不能出现 certificate verify failed。如果 `openssl x509 -in /home/gwaves/letsencrypt/config/live/novel.gwaves.net/fullchain.pem -noout -subject -issuer` 显示 `subject` 和 `issuer` 都是 `CN = novel.gwaves.net`，说明仍是自签证书，Android 系统默认不会信任。

## 反向代理

Nginx 示例：

```nginx
server_tokens off;

server {
    listen 443 ssl http2 default_server;
    server_name _;
    return 444;
}

server {
    listen 443 ssl http2;
    server_name reader.example.com;

    client_max_body_size 50m;

    location ^~ /admin/ui {
        return 403;
    }

    location / {
        proxy_pass http://127.0.0.1:6180;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Compose 内置 Nginx 容器时，可以使用同一 Docker 网络里的服务名反代：

```nginx
server_tokens off;

server {
    listen 8443 ssl http2 default_server;
    server_name _;

    ssl_certificate /etc/nginx/tls/fullchain.pem;
    ssl_certificate_key /etc/nginx/tls/privkey.pem;

    return 444;
}

server {
    listen 8443 ssl http2;
    server_name novel.gwaves.net;

    ssl_certificate /etc/nginx/tls/fullchain.pem;
    ssl_certificate_key /etc/nginx/tls/privkey.pem;

    client_max_body_size 512m;
    proxy_read_timeout 1800s;
    proxy_send_timeout 1800s;
    proxy_connect_timeout 30s;
    proxy_buffering off;
    proxy_request_buffering off;

    location ^~ /admin/ui {
        return 403;
    }

    location / {
        proxy_pass http://gateway:6180;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

`/admin/ui` 是管理后台静态入口。如果公网入口经过家庭路由器 DNAT/SNAT，Nginx 看到的来源地址可能已经变成内网地址，基于 `allow`/`deny` 的内网 ACL 可能失效。推荐在公网 Nginx 入口直接禁止 `/admin/ui`，管理后台改走家里内网直连 `http://192.168.88.100:6180/admin/ui`。上面的 `location ^~ /admin/ui` 必须放在通用 `location /` 前面；管理 API 仍由 Gateway 的 admin bearer token 保护。

注意：内网直连 `http://192.168.88.100:6180` 不经过 Nginx，Docker bridge 模式下容器仍可能只能看到 `172.18.0.1`。如果管理后台本身也必须显示浏览器真实 IP，应让后台走一个带转发头的内网 Nginx 入口，或把 Gateway 改为 host network / host 级反向代理部署。

对应端口关系：

```text
手机/外部客户端
  -> https://novel.gwaves.net:8888
  -> nginx 容器 8443
  -> http://gateway:6180

手机/外部客户端误用 HTTP 访问 8888
  -> http://novel.gwaves.net:8888
  -> nginx 容器 8443
  -> 302 Location: https://novel.gwaves.net:8888$request_uri

内网生产流水线
  -> http://192.168.88.100:6180
  -> Gateway 应用
```

公网 HTTPS 入口的部署标准：

- `8888` 是对外 TLS 入口，正常访问必须使用 `https://novel.gwaves.net:8888`。
- 对外 TLS 证书必须能被 Android 系统、Node.js 和常规浏览器信任；自签证书只能用于本地或受控测试，不得作为真机/公网验收通过条件。
- 如果用户或浏览器误用 `http://novel.gwaves.net:8888/...`，Nginx 必须返回 `302`，并保留原始 path/query 跳转到 `https://novel.gwaves.net:8888/...`。
- 不要求 Gateway 自身接管公网 `80` 端口；是否处理 `http://novel.gwaves.net` 由外层网络或额外反代决定。
- Nginx 可用 `error_page 497 =302 https://$host:8888$request_uri;` 处理“明文 HTTP 打到 HTTPS 端口”的场景；默认 server 应跳转到 canonical host，避免未知 Host 暴露应用内容。

## 验证

```bash
curl https://reader.example.com/health
curl -H "Authorization: Bearer $GATEWAY_MOBILE_ACCESS_TOKEN" \
  https://reader.example.com/auth/session

curl http://192.168.88.100:6180/health
curl -H "Authorization: Bearer $GATEWAY_ADMIN_ACCESS_TOKEN" \
  http://192.168.88.100:6180/capabilities

curl -kI https://novel.gwaves.net:8888/admin/ui
curl -I http://192.168.88.100:6180/admin/ui
curl -I http://novel.gwaves.net:8888/downloads/novel_gateway.apk
curl -I https://novel.gwaves.net:8888/health
curl -I https://novel.gwaves.net:8888/downloads/novel_gateway.apk
curl https://novel.gwaves.net:8888/downloads/android-app.json
npm run gateway:security-smoke
```

`/health` 可公开访问，且严格 TLS 校验必须通过；公网 Nginx 入口的 `/admin/ui` 应返回 403；未知 Host 或 IP 直连不应返回 Gateway 应用内容；内网直连 `6180` 可访问管理后台；`http://novel.gwaves.net:8888/downloads/novel_gateway.apk` 应返回 `302 Location: https://novel.gwaves.net:8888/downloads/novel_gateway.apk`；HTTPS `/downloads/novel_gateway.apk` 应返回 `200` 和 `application/vnd.android.package-archive`；`/admin/*` 和后台 AI/RAG 接口使用 admin bearer token，`/auth/*`、`/mobile/*` 和 MP3 接口使用 mobile bearer token。生产环境未设置 `GATEWAY_ADMIN_ACCESS_TOKEN` 或 `GATEWAY_MOBILE_ACCESS_TOKEN` 时，Gateway 会拒绝启动。
