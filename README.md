# web-vicecity

> GTA: Vice City（侠盗猎车手：罪恶都市）浏览器可玩版 —— [Lolendor/reVCDOS](https://github.com/Lolendor/reVCDOS) 的 Next.js Web 复刻。

打开网页即玩：无需安装、无需下载镜像，移动端自动切换触屏操作，界面默认简体中文。

## 特性

- **免安装直玩**：打开页面 → 点击开始 → 进入 1986 年的罪恶都市
- **完整的游戏体验**：主线剧情、电台音乐、过场动画全部可用（引擎为 DOSZone 的 Emscripten 移植）
- **双通道资源加载**：浏览器 Service Worker 直连静态镜像（GitHub raw 分片 Range 直读 + WASM brotli 解压 + 浏览器缓存）；镜像异常时自动回退服务器代理，永不断流
- **服务器零磁盘占用（默认）**：服务端不再下载 1.08 GB 归档——内置扁平索引（1.8 MB，31,227 个文件偏移表），资产请求实时从上游拉取对应字节段
- **分片断点续传**：游戏数据以 4 MB 分片下载，单片失败自动重试，抗代理掐流
- **浏览器缓存秒开**：约 130 MB 引擎数据首次下载后写入 Cache API，之后再次进入秒级加载
- **移动端适配**：触屏虚拟按键、刘海屏安全区、竖屏旋转提示、触控目标 ≥ 50px
- **中文界面**：启动器 UI 默认跟随浏览器语言（zh/en），俄语资源包已移除

## 架构

```
浏览器
  │  Emscripten 引擎 (WebGL + OpenAL)              public/game/*
  │  Service Worker: 索引查表 → GitHub raw 分片    public/sw.js
  │  Range 直读 → WASM brotli 解压 → Cache 缓存     public/game/brotli-dec.js
  ▼
静态镜像（archive-data 分支，12 × 96MB 分片）      gh push 分片
  revcdos.bin = 拼接全部分片（1.08 GB，28,912 文件）

回退通道（镜像故障/CDN 异常时）：
浏览器 → 服务器代理 → 上游归档实时 Range 拉取
  │  /vcsky/[...path]  /vcbr/[...path]              src/app/vcsky | vcbr
  │  三模式: 206 分片 / br 直通 / 流式解压           src/lib/archive-server.ts
  │  扁平索引 + 远程 Range 读取器（零磁盘）           src/lib/remote-archive.ts
  ▼
https://folder.morgen.qzz.io/revcdos.bin (上游，支持 Range)
```

游戏本体（`public/game/`）来自 reVCDOS 上游发行包：js-dos v8 引擎模块链 + 启动器。归档索引（`public/game/revcdos-index.json`）由 `scripts/dump-archive-index.ts` 从归档生成，记录每个文件的字节偏移与压缩长度——浏览器 SW 与服务器远程模式共用同一份索引。

## 快速开始

```bash
bun install        # 或 npm install
bun run dev        # http://localhost:3000
```

首次访问页面时，服务器会自动开始拉取 1.08 GB 归档到 `.revcdos-cache/`，页面底部胶囊条会显示进度；归档就绪后点击开始，游戏数据（约 130 MB）再由浏览器分片拉取并缓存。之后所有启动都是秒级。

> 无 Bun 环境也可以：`npm install && npx next dev -p 3000`

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REVCDOS_ARCHIVE_URL` | `https://folder.morgen.qzz.io/revcdos.bin` | 归档下载源（支持 HTTP Range 的任意镜像） |
| `REVCDOS_ARCHIVE_PATH` | `.revcdos-cache/revcdos.bin`（回退 `/tmp`） | 本地归档路径；存在且完整时自动走本地模式（秒级索引） |
| `REVCDOS_DOWNLOAD` | 未设置 | 设为 `1` 时启动后自动下载全量归档（大磁盘环境优化） |
| `REVCDOS_INDEX_PATH` | `public/game/revcdos-index.json` | 扁平索引文件路径（远程模式依赖） |
| `REVCDOS_PRELOAD` | 未设置 | 设为 `1` 时启动即预热（默认懒加载，首位访客触发） |
| `DATABASE_URL` | — | 可选，Prisma SQLite 连接串（模板遗留，游戏本身不依赖） |

## 部署

生产构建为 standalone 输出：

```bash
bun run build     # next build + 组装 .next/standalone
bun run start     # NODE_ENV=production bun .next/standalone/server.js
```

**三种服务端模式（自动选择）**：本地归档完整 → **local**（直接读盘，最快）；无本地归档 → **remote**（内置索引 + 实时 Range 拉取上游，零磁盘，适合小容器）；`REVCDOS_DOWNLOAD=1` → 先下载再 local。

**资源要求**：

- 磁盘 ≥ 2.5 GB（归档 1.08 GB + 构建产物），内存 ≥ 1 GB（推荐 2 GB）
- 出网带宽：首次拉取归档约 1.08 GB（之后不再需要）

**冷启动行为（重要）**：

- 默认零磁盘：无本地归档时自动进入远程模式（秒级就绪，无需下载 1 GB）
- 浏览器优先直连静态镜像（archive-data 分片），服务器只在镜像异常时才被使用
- 小规格容器可放心部署；大磁盘环境想极致低延迟再设 `REVCDOS_DOWNLOAD=1`
- 建议把 `REVCDOS_ARCHIVE_PATH` 指向持久卷上的路径，容器重启/重新部署后无需重新下载
- 上游 CDN 带宽有限时，可在自有对象存储/CDN 放一份 `revcdos.bin` 并通过 `REVCDOS_ARCHIVE_URL` 指向它

**平台示例（任选其一）**：

- VPS（systemd / pm2 / docker）：`bun run build && bun run start`，反向代理 3000 端口
- Fly.io / Railway：Node 或 Bun 运行时 + 挂载 2 GB 持久卷（`REVCDOS_ARCHIVE_PATH` 指向卷内路径）
- 不适用于纯静态托管（GitHub Pages / 对象存储静态站）：本项目需要 Node 服务端读取 packed 归档

## 操作

| 操作 | 键盘 | 移动端 |
| --- | --- | --- |
| 移动 / 视角 | 方向键 / 鼠标 | 左侧虚拟摇杆区 |
| 攻击 / 跳跃 / 奔跑 | 数字键区（见游戏内说明） | 右侧 ACTION / JUMP / RUN 按钮 |
| 上 / 下车 | F / Enter | GET IN 按钮 |
| 切换电台 | R | 触屏菜单 |

进入游戏后按 `Esc` 呼出菜单。启动器 `?configurable=1` 可打开配置面板（渲染精度、音量、界面语言）。

## 语言说明

- **启动器界面**：默认跟随浏览器语言（简体中文 / English），`?lang=zh` 或 `?lang=en` 可强制
- **游戏本体**：仅英文。上游 reVCDOS 只发行了英语（`vc-sky-en-v6`）与俄语（`vc-sky-ru-v6`）两个数据包，不存在中文游戏包；民间 GTA:VC 汉化补丁（GXT 文本替换）与 Emscripten 数据包格式不兼容，因此本项目固定使用英语数据包并已彻底移除俄语包

## 目录结构

```
├── public/game/               # reVCDOS 客户端（引擎模块 + 启动器 game.js）
│   ├── modules/               # Emscripten 引擎 10 模块链
│   └── game.js                # 启动器（中文翻译 / 分片下载 / 触控检测）
├── src/
│   ├── app/
│   │   ├── page.tsx           # 入口 = 游戏启动器（无落地页）
│   │   ├── vc-game.css        # 上游 85KB 内联样式提取 + 移动端增强
│   │   ├── vcsky/ vcbr/       # 归档代理 API 路由
│   │   └── api/archive/       # 归档状态查询 / 预热触发
│   ├── components/game/       # GameShell（DOM 契约）+ ArchiveNotice（进度胶囊）
│   ├── lib/
│   │   ├── packed-archive.ts  # packed 格式解析（ULEB128 / brotli / 流式解压）
│   │   └── archive-server.ts  # 归档单例：断点续传下载 / 索引 / 三模式响应
│   └── instrumentation.ts     # 冷启动钩子（默认懒加载，REVCDOS_PRELOAD 控制）
├── scripts/                   # 辅助验证脚本（语言清单 / 移动端冒烟）
└── prisma/                    # 模板遗留 schema（游戏不依赖）
```

## 致谢

- [Lolendor/reVCDOS](https://github.com/Lolendor/reVCDOS) —— 原项目（FastAPI + `--packed` 模式）
- DOSZone / js-dos 团队 —— GTA: Vice City 的 DOS Emscripten 移植与 v8 API
- [GamesVoice](https://www.gamesvoice.ru/) —— 上游俄语界面翻译

## 免责声明

本项目仅供技术与学习研究。*Grand Theft Auto: Vice City* 及其全部资产的版权归 **Rockstar Games / Take-Two Interactive** 所有。请勿将本项目用于任何商业用途；游玩完整版本请支持正版。
