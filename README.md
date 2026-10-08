# web-vicecity · 归档中继 A（relay-a）

> GTA: Vice City Web 版（[43aquarius/web-vicecity](https://github.com/43aquarius/web-vicecity)）的**辅助中继服务器**。
> 本服务负责缓存并分发 1.08 GB 游戏归档的**前 1/3 分区**：`[0, 361,454,906)` 字节 ≈ 361 MB。

## 这是什么？

主项目把 1.08 GB 的 `revcdos.bin` 游戏归档按字节均分为三份，由三台服务器分担：

| 服务器 | 分区 | 大小 | 职责 |
| --- | --- | --- | --- |
| **relay-a（本服务）** | `[0, 361454906)` | ≈361 MB | 缓存到本地磁盘，直接响应玩家浏览器的 Range 请求 |
| relay-b（另一个分支） | `[361454906, 722909812)` | ≈361 MB | 同上，负责中段 |
| 主服务器（main 分支） | `[722909812, 1084364719)` | ≈361 MB | 中心节点：Next.js 站点 + 尾段按需回源 + 全量兜底 |

任何一层故障都不影响游戏——玩家请求会自动降级：**relay → GitHub 镜像 → 主服务器**。

### 工作原理

```
玩家浏览器 ──Range: bytes=xxx-yyy──▶ relay-a（本服务，CORS 开放）
                                       │ 命中本分区 → data/part.bin 磁盘切片直读（206）
                                       │ 越界请求 → 实时回源上游（可选，默认开启）
                                       ▼
                       https://folder.morgen.qzz.io/revcdos.bin（上游归档）
```

- **零依赖**：纯 Node.js（≥18），无需 `npm install`
- **自动播种**：首次启动自动从上游下载本分区（约 361 MB，8 MB 分片、断点续传、自动重试），期间也能对外服务（未覆盖区间实时回源）
- **CORS 全开**：`Access-Control-Allow-Origin: *` + 标准 206 Range 语义（全局坐标）——玩家浏览器可直连
- **熔断保护**：上游不可达时播种自动重试，服务不中断

## 部署步骤

### 前置要求

- 一台约 400 MB 可用磁盘的服务器（VPS / 容器 / 家宽 NAS 均可）
- Node.js ≥ 18（`node -v` 确认）
- 若主站点是 **HTTPS**，本服务也必须以 **HTTPS** 对外（浏览器禁止混合内容）——用 Caddy / Nginx / 宝塔反代均可，见下文

### 方式一：直接运行（最快）

```bash
git clone -b relay-a https://github.com/43aquarius/web-vicecity.git
cd web-vicecity

node server.js          # 启动（默认端口 8787，自动开始播种 361 MB）
# 观察播种进度：
curl http://127.0.0.1:8787/healthz
```

播种完成（`"state": "ready"`）后即可对外。完整日志：

```bash
node server.js --seed   # 只播种不服务（部署前预下载用）
node server.js --status # 打印健康状态 JSON
```

### 方式二：systemd 常驻

```bash
sudo cp systemd/web-vicecity-relay.service /etc/systemd/system/
# 按需修改 unit 文件里的路径 / 端口
sudo systemctl daemon-reload
sudo systemctl enable --now web-vicecity-relay
journalctl -u web-vicecity-relay -f      # 看播种进度
```

### 方式三：Docker

```bash
docker build -t web-vicecity-relay-a .
docker run -d --name relay-a -p 8787:8787 -v relay-a-data:/app/data web-vicecity-relay-a
```

### HTTPS 反代示例（Caddy）

```caddyfile
relay-a.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Nginx 注意事项：**不要开启 gzip/brotli 压缩**（会破坏 Range 语义），保留 `Range` / `Content-Range` 头透传即可。

## 配置

`config.json` 已内置本分支的分区参数，一切均可用环境变量覆盖：

| 变量 | 默认值（本分支） | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 绑定地址 |
| `PART_START` | `0` | 分区起始字节（含） |
| `PART_END` | `361454906` | 分区结束字节（不含） |
| `ARCHIVE_URL` | `https://folder.morgen.qzz.io/revcdos.bin` | 上游归档 |
| `ARCHIVE_TOTAL` | `1084364719` | 归档总大小（Content-Range 用） |
| `DATA_DIR` | `./data` | `part.bin` 存放目录（≈361 MB） |
| `LIVE_FALLBACK` | `1` | 越界/未播种请求实时回源（`0` = 严格拒绝） |
| `RELAY_TOKEN` | 空（关闭） | 共享密钥；设置后 `/revcdos.bin` 需带 `?token=` 或 `X-Relay-Token` 头 |
| `MAX_LIVE_CONC` | `8` | 回源并发上限 |
| `SEED_CHUNK` | `8388608` | 播种分片大小 |

## 部署后验证

```bash
# 1. 健康（state 应为 ready，part 应为 [0, 361454906)）
curl http://<你的地址>/healthz

# 2. Range 请求（应返回 206 + 正确的 Content-Range）
curl -s -D - -H "Range: bytes=1000000-1000999" http://<你的地址>/revcdos.bin | head -8

# 3. CORS 头（应看到 access-control-allow-origin: *）
curl -s -D - -o /dev/null -H "Origin: https://example.com" -H "Range: bytes=0-99" http://<你的地址>/revcdos.bin | rg -i "access-control"

# 4. 浏览器打开 http://<你的地址>/ 有人类可读的状态页
```

## 部署完成后：接入主服务器

在**主服务器**（main 分支）设置环境变量后重启即可生效（把域名换成你的实际地址）：

```bash
REVCDOS_RELAYS="a=https://relay-a.example.com/revcdos.bin:0-361454906,b=https://relay-b.example.com/revcdos.bin:361454906-722909812"
```

设置后：
- 主服务器的 `/vcsky` `/vcbr` 代理会按分区把请求路由到两台 relay，relay 挂掉自动回源
- 玩家浏览器的 Service Worker 会通过 `/api/archive/sources` 拿到路由表，**直接从你的 relay 拉取资产**（不经主服务器）

主服务器负责尾段 `[722909812, 1084364719)`（含游戏引擎数据包），并承担全量兜底。

## 常见问题

**Q: 磁盘不足 361 MB？**
A: `DATA_DIR` 指到别处；或设 `LIVE_FALLBACK=1` 且不播种（`--seed` 前不启动会一直实时回源——不推荐，失去中继意义）。

**Q: 想改分区边界？**
A: `PART_START`/`PART_END` 覆盖即可，但必须与主服务器 `REVCDOS_RELAYS` 里的数值**严格一致**（字节区间无缝衔接）。

**Q: 被盗链？**
A: 设置 `RELAY_TOKEN`（主服务器 URL 里带 `?token=xxx` 会自动透传）。

**Q: 如何更新上游归档版本？**
A: 停服 → 删除 `data/part.bin` → 重启（自动重新播种）。注意主服务器与 GitHub 镜像分片也要同步更新，否则字节区间会错位。

## 与主项目的关系

- 主项目（Next.js 站点）：[`main` 分支](https://github.com/43aquarius/web-vicecity)
- 兄弟中继（B 分区）：[`relay-b` 分支](https://github.com/43aquarius/web-vicecity/tree/relay-b)
- 静态镜像分片（浏览器直连回退）：[`archive-data` 分支](https://github.com/43aquarius/web-vicecity/tree/archive-data)

本服务基于 [Lolendor/reVCDOS](https://github.com/Lolendor/reVCDOS) 的游戏归档分发架构实现，游戏本体版权归 Rockstar Games 所有，仅供学习研究。
