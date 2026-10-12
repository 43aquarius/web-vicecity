# web-vicecity · 归档中继 relay-b（分片 b）

> GTA: Vice City Web 版（[43aquarius/web-vicecity](https://github.com/43aquarius/web-vicecity)）的**辅助中继服务器**。
> 本服务负责缓存与分发 1.08 GB 游戏归档六分片中的**分片 b**：字节区间 `[361454906, 542182359)` ≈ 172.4 MB。

六分片中的**中段**。注意：现有 relay-b 部署已缓存旧整段 361 MB（是其新子区间的超集），
**无需重新部署即可直接服务本分片**——本分支供未来重建/新部署使用。
（提醒：换用本分支会因 part.bin 尺寸校验触发删档重播 173 MB，非必要不折腾。）

## 六分片架构

主项目把 1.08 GB 的 `revcdos.bin` 归档按字节切成六段，由六台中继分担，主站退化为纯兜底：

| 分片 | 中继 | 分区 `[start, end)` | 播种量 | 分支 |
| --- | --- | --- | --- | --- |
| a | relay-a | `[0, 180727453)` | ≈173 MB | `relay-a` |
| a2 | relay-a2 | `[180727453, 361454906)` | ≈173 MB | `relay-a2` |
| b | relay-b | `[361454906, 542182359)` | ≈173 MB | `relay-b` |
| b2 | relay-b2 | `[542182359, 722909812)` | ≈173 MB | `relay-b2` |
| c | relay-c | `[722909812, 987212548)` | ≈252 MB | `relay-c` |
| d | relay-d | `[987212548, 1084364719)` | ≈93 MB | `relay-d` |
| — | 主服务器 | 全区间兜底（中继失败才接管） | — | `main` |

设计要点：**c/d 边界 `987212548` 特意切在引擎大文件 `vc-sky-en-v6.data.br [956754376, 1017670720)` 的正中**，初次进入游戏的 ≈62.7 MB 引擎数据由 c、d 并行各拉一半，而不是压在一台。任何一层故障都不影响游戏——玩家请求自动降级：**中继 → 主站 → 上游**。

### 工作原理

```
玩家浏览器 ──Range: bytes=xxx-yyy──▶ relay-b（本服务，CORS 开放）
                                      │ 命中本分区 → data/part.bin 磁盘切片直读（206）
                                      │ 越界请求 → 实时回源上游（默认开启）
                                      ▼
                      https://folder.morgen.qzz.io/revcdos.bin（上游归档）
```

- **零依赖**：纯 Node.js（≥18），无需 `npm install`
- **自动播种**：首次启动自动从上游下载本分区（172.4 MB，8 MB 分片、断点续传、自动重试），期间照常服务（未覆盖区间实时回源）
- **续传感知磁盘预检**：只要求「剩余下载量 + 64 MB 余量」的空闲磁盘，`part.bin.tmp` 前缀直接续传复用
- **上游 200 抽风防护**：上游间歇忽略 Range 回 200 全量流时，有界排水（≤64 KB 后 cancel）+ 快速失败，绝不缓冲整个 1.08 GB（曾把容器 OOM 的坑）
- **CORS 全开**：`Access-Control-Allow-Origin: *` + 标准 206 Range 语义（全局坐标）

## 部署步骤

### 前置要求

- 可用磁盘 ≥ 300 MB（播种 172.4 MB + 写入余量）
- Node.js ≥ 18（`node -v` 确认）
- 对外 HTTPS（浏览器禁止混合内容）——平台网关或 Caddy / Nginx 反代均可

### 方式一：直接运行（最快）

```bash
git clone -b relay-b https://github.com/43aquarius/web-vicecity.git
cd web-vicecity
node server.js          # 默认 0.0.0.0:8787，自动开始播种 172.4 MB
curl http://127.0.0.1:8787/healthz   # 观察播种进度
```

> `config.json` 已内置本分片区间 `[361454906, 542182359)`——**无需任何环境变量**即可正确运行。

播种完成（`"state": "ready"`）后即可对外。辅助命令：

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
docker build -t web-vicecity-relay-b .
docker run -d --name relay-b -p 8787:8787 -v relay-b-data:/app/data web-vicecity-relay-b
```

### HTTPS 反代示例（Caddy）

```caddyfile
relay-b.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Nginx 注意：**不要开启 gzip/brotli 压缩**（破坏 Range 语义），保留 `Range` / `Content-Range` 头透传。

## 配置

`config.json` 已内置本分支的分区参数，一切均可用环境变量覆盖：

| 变量 | 默认值（本分支） | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 绑定地址 |
| `PART_START` | `361454906` | 分区起始字节（含） |
| `PART_END` | `542182359` | 分区结束字节（不含） |
| `ARCHIVE_URL` | `https://folder.morgen.qzz.io/revcdos.bin` | 上游归档 |
| `ARCHIVE_TOTAL` | `1084364719` | 归档总大小（Content-Range 用） |
| `DATA_DIR` | `./data` | `part.bin` 存放目录（≈172.4 MB） |
| `LIVE_FALLBACK` | `1` | 越界/未播种请求实时回源（`0` = 严格拒绝） |
| `RELAY_TOKEN` | 空（关闭） | 共享密钥；设置后 `/revcdos.bin` 需带 `?token=` 或 `X-Relay-Token` 头 |
| `MAX_LIVE_CONC` | `8` | 回源并发上限 |
| `SEED_CHUNK` | `8388608` | 播种分片大小 |

## 部署后验证

```bash
# 1. 健康（state 应为 ready，part 应为 {"start":361454906,"end":542182359,"size":180727453}）
curl http://<你的地址>/healthz

# 2. Range 请求（本分片内偏移，应返回 206 + 全局坐标 Content-Range）
curl -s -D - -o /dev/null -H "Range: bytes=400000000-$((400000000+99))" http://<你的地址>/revcdos.bin | head -8

# 3. 字节完整性（与上游逐字节一致）
curl -s -r 400000000-$((400000000+99)) http://<你的地址>/revcdos.bin | sha256sum
curl -s -r 400000000-$((400000000+99)) https://folder.morgen.qzz.io/revcdos.bin | sha256sum

# 4. CORS 头（应看到 access-control-allow-origin: *）
curl -s -D - -o /dev/null -H "Origin: https://example.com" -H "Range: bytes=400000000-$((400000000+9))" http://<你的地址>/revcdos.bin | grep -i access-control

# 5. 冒烟脚本（自动读本分支 config.json 的 partStart）
bash verify.sh http://<你的地址>

# 6. 浏览器打开 http://<你的地址>/ 有人类可读状态页
```

## 部署完成后：接入主服务器

把本服务对外地址汇报给主站侧（格式：`b=https://relay-b.你的域名/revcdos.bin:361454906-542182359`）。六台就位后，主站 `public/relay.config.json` 的 `REVCDOS_RELAYS` 将是（域名按实际替换）：

```text
a=https://vicecity-relay-a.space-z.ai/revcdos.bin:0-180727453,a2=https://vicecity-relay-a2.space-z.ai/revcdos.bin:180727453-361454906,b=https://vicecity-relay-b.space-z.ai/revcdos.bin:361454906-542182359,b2=https://vicecity-relay-b2.space-z.ai/revcdos.bin:542182359-722909812,c=https://vicecity-relay-c.space-z.ai/revcdos.bin:722909812-987212548,d=https://vicecity-relay-d.space-z.ai/revcdos.bin:987212548-1084364719
```

设置后：

- 玩家浏览器的 Service Worker 按路由表**直连六台中继并行拉取**（中继完整覆盖的大文件也直连，主站出流量归零）
- 中继挂掉自动降级：**中继 → 主站 → 上游**，游戏不断流

## 常见问题

**Q: 磁盘不足 172.4 MB？**
A: `DATA_DIR` 指到别处；或清理构建产物/缓存。修复版代码在磁盘不足时降级为实时代理（`state=error` 但 `ok=true`，仍正确服务 206），但会失去加速意义。

**Q: 想改分区边界？**
A: `PART_START`/`PART_END` 覆盖即可，但必须与主服务器 `REVCDOS_RELAYS` 里的数值**严格一致**（六段无缝衔接、不重叠）。注意：`part.bin` 尺寸与 PART_SIZE 不符会触发删档重播。

**Q: 被盗链？**
A: 设置 `RELAY_TOKEN`（主服务器 URL 里带 `?token=xxx` 会自动透传）。

**Q: 上游归档将来更新？**
A: 停服 → 删除 `data/part.bin` → 重启（自动重播）。主站与镜像需同步更新，否则字节区间错位。

## 与主项目的关系

- 主项目（Next.js 站点，纯兜底）：[`main` 分支](https://github.com/43aquarius/web-vicecity)
- 六个分片中继分支：`relay-a` / `relay-a2` / `relay-b` / `relay-b2` / `relay-c` / `relay-d`
- 静态镜像分片（浏览器直连回退）：[`archive-data` 分支](https://github.com/43aquarius/web-vicecity/tree/archive-data)

本服务基于 [Lolendor/reVCDOS](https://github.com/Lolendor/reVCDOS) 的游戏归档分发架构实现，游戏本体版权归 Rockstar Games 所有，仅供学习研究。
