# web-vicecity

> GTA: Vice City（侠盗猎车手：罪恶都市）浏览器可玩版 —— [Lolendor/reVCDOS](https://github.com/Lolendor/reVCDOS) 的 Next.js Web 复刻。

打开网页即玩：无需安装、无需下载镜像，移动端自动切换触屏操作，界面默认简体中文。

## 特性

- **免安装直玩**：打开页面 → 点击开始 → 进入 1986 年的罪恶都市
- **完整的游戏体验**：主线剧情、电台音乐、过场动画全部可用（引擎为 DOSZone 的 Emscripten 移植）
- **服务端归档直读**：1.08 GB packed 游戏归档（28,912 个文件）由 Node 按字节偏移流式提供，不在浏览器占用整包内存
- **分片断点续传**：游戏数据以 4 MB 分片下载，单片失败自动重试，抗代理掐流
- **浏览器缓存秒开**：约 130 MB 引擎数据首次下载后写入 Cache API，之后再次进入秒级加载
- **移动端适配**：触屏虚拟按键、刘海屏安全区、竖屏旋转提示、触控目标 ≥ 50px
- **中文界面**：启动器 UI 默认跟随浏览器语言（zh/en），俄语资源包已移除

## 架构

```
浏览器
  │  Emscripten 引擎 (WebGL + OpenAL)          public/game/*
  │  4MB Range 分片下载 / 探针 / 多级回退        game.js
  ▼
Next.js API 路由 (Node runtime)
  │  /vcsky/[...path]  /vcbr/[...path]          src/app/vcsky | vcbr
  │  三模式响应: 206 分片 / br 直通 / 流式解压    src/lib/archive-server.ts
  │  packed 归档: ULEB128 索引 + brotli 内容     src/lib/packed-archive.ts
  ▼
revcdos.bin (1.08 GB, 28,912 文件, 10 文件夹)
  ▲ 首次运行自动从上游 CDN 下载（支持断点续传、失败重试）
```

游戏本体（`public/game/`）来自 reVCDOS 上游发行包：js-dos v8 引擎模块链 + 启动器。服务端以 `--packed` 模式工作（与上游 Docker 推荐方案一致），按需从归档读取任意游戏资产（模型 `.dff`、音效 `.raw`、贴图等）。

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
| `REVCDOS_ARCHIVE_PATH` | `.revcdos-cache/revcdos.bin`（回退 `/tmp`） | 本地归档存放路径，建议指向持久卷 |
| `REVCDOS_PRELOAD` | 未设置 | 设为 `1` 时服务器启动即预热归档；小内存容器**不要开启** |
| `DATABASE_URL` | — | 可选，Prisma SQLite 连接串（模板遗留，游戏本身不依赖） |

## 部署

生产构建为 standalone 输出：

```bash
bun run build     # next build + 组装 .next/standalone
bun run start     # NODE_ENV=production bun .next/standalone/server.js
```

**资源要求**：

- 磁盘 ≥ 2.5 GB（归档 1.08 GB + 构建产物），内存 ≥ 1 GB（推荐 2 GB）
- 出网带宽：首次拉取归档约 1.08 GB（之后不再需要）

**冷启动行为（重要）**：

- 默认懒加载：服务器启动本身是轻量的，第一位访客打开页面时才开始拉取归档（页面有进度提示，`game.js` 会轮询等待归档就绪后再下载数据）
- 如果部署在小规格容器（内存 < 1 GB / 磁盘紧张），请保持默认懒加载模式，避免 `REVCDOS_PRELOAD=1`（启动即拉 1 GB 会把小容器直接打挂）
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
