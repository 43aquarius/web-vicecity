# 分片 a2 提示词（relay-a2 · 全新部署）

> 粘贴对象：**新服务器 / 新建应用沙箱里的 AI 助手**。
> 目标：部署六分片架构的分片 a2 中继：区间 [180727453, 361454906)，播种 ≈173 MB。

```text
我要在这台服务器上部署 web-vicecity 的归档分片中继 relay-a2（六分片架构之一），请你完成部署并验证。这是 GTA: Vice City 网页版的分片资源服务器，请严格按步骤执行，不要跳过验证环节。

【背景知识（不需要了解游戏本身，只需做对字节区间和 HTTP 语义）】
- 游戏归档 revcdos.bin 共 1084364719 字节（约 1.08 GB），上游 https://folder.morgen.qzz.io/revcdos.bin（支持 HTTP Range）。
- 归档已按字节切成六段、由六台中继分担，主站只做兜底。本服务（分片 a2）负责第 2 段：字节区间 [180727453, 361454906)，约 173 MB。
- 本段承担「进游戏后」的随机小文件访问（3.1 万个资产文件均匀散布全档）——玩家进图后的资产加载会摊到本服务，优先级低于首载主力 c/d，可第二批部署。
- 玩家浏览器会直接向本服务发跨域 Range 请求（CORS 预检 + 206），CORS 与 Range 语义必须正确。
- 代码在 GitHub 仓库 43aquarius/web-vicecity 的 relay-a2 分支：git clone -b relay-a2 https://github.com/43aquarius/web-vicecity.git。纯 Node.js（≥18）、零 npm 依赖；config.json 已内置本分片区间，无需配置任何环境变量；代码含上游 200 抽风的有界排水防护（防 OOM，已根治的历史坑）。

【第一步：环境检查】
1. node -v 确认 Node.js ≥ 18（没有就先装 Node 20 LTS）。
2. df -h . 确认可用磁盘 ≥ 300 MB（播种 173 MB + 写入余量）；不够就清构建产物/缓存后再确认。
3. 出网检查：curl -sI https://folder.morgen.qzz.io/revcdos.bin -H "Range: bytes=180727453-180727453" 应返回 206。

【第二步：获取代码并启动】
git clone -b relay-a2 https://github.com/43aquarius/web-vicecity.git && cd web-vicecity
node server.js
（默认监听 0.0.0.0:8787；首次启动自动从上游下载本分区 173 MB，8 MB 分片、断点续传；下载期间即可对外服务，未覆盖区间实时回源上游，不影响可用性。）
（若你的平台要求应用以 Next.js 方式启动：把 server.js 挂进启动链即可——兄弟服务 relay-b 就是这么集成的；务必保持 206/CORS 语义不变。）

【第三步：等待播种完成并验证】
1. 轮询 curl -s http://127.0.0.1:8787/healthz，直到 JSON 里 "state":"ready"（"progress" 到 100）。约 173 MB，视带宽几分钟到十几分钟。
2. 206 全局坐标：
   curl -s -D - -o /dev/null -H "Range: bytes=200000000-200000099" http://127.0.0.1:8787/revcdos.bin
   预期：HTTP/1.1 206、Content-Range: bytes 200000000-200000099/1084364719、Content-Length: 100。
3. CORS：
   curl -s -D - -o /dev/null -H "Origin: https://example.com" -H "Range: bytes=180727453-180727462" http://127.0.0.1:8787/revcdos.bin
   预期：响应头包含 Access-Control-Allow-Origin: *。
4. 字节完整性（与上游逐字节对比，必须一致；再抽 270000000、361000000 附近各复验一次）：
   curl -s -r 200000000-200000099 http://127.0.0.1:8787/revcdos.bin | sha256sum
   curl -s -r 200000000-200000099 https://folder.morgen.qzz.io/revcdos.bin | sha256sum
5. 运行仓库自带冒烟脚本：bash verify.sh http://127.0.0.1:8787

【第四步：常驻运行（三选一，按本机习惯）】
- systemd（推荐，仓库自带 unit 文件）：
  sudo cp systemd/web-vicecity-relay.service /etc/systemd/system/
  按需修改 unit 里的工作目录，然后 sudo systemctl daemon-reload && sudo systemctl enable --now web-vicecity-relay
- Docker：docker build -t web-vicecity-relay-a2 . && docker run -d --name relay-a2 -p 8787:8787 -v relay-a2-data:/app/data --restart unless-stopped web-vicecity-relay-a2
- pm2/screen 亦可，保证开机自启即可。
（注意：数据目录 data/ 里的 part.bin 是 173 MB 缓存，务必放在持久磁盘上，重启后不要删除，否则要重新播种。）

【第五步：对外 HTTPS（关键，不要省略）】
主站是 HTTPS，浏览器禁止从 HTTPS 页面加载 HTTP 资源（混合内容限制），本服务必须以 HTTPS 对外：
- 平台网关已提供 HTTPS 域名 → 直接使用（预期形如 https://vicecity-relay-a2.space-z.ai/revcdos.bin）。
- 自管服务器 → 用 Caddy 反代最简单（自动证书）：a2.你的域名.com { reverse_proxy 127.0.0.1:8787 }。
- 只有 HTTP 裸 IP → 在汇报里明确说明"无法提供 HTTPS"，主站侧会改用服务器中转模式接入（功能不受影响）。
- 反代注意事项：绝对不要开启 gzip/brotli 压缩（破坏 Range 分片语义）；保留 Range/Content-Range/Accept-Ranges 头透传。

【第六步：汇报】
完成后汇报（主站侧要用它们更新路由配置）：
1. 最终对外地址（形如 https://vicecity-relay-a2.space-z.ai/revcdos.bin，含 /revcdos.bin 路径）
2. 是否 HTTPS（是/否）
3. /healthz 完整 JSON（确认 state=ready、part={"start":180727453,"end":361454906}）
4. 常驻方式（systemd/docker/pm2）与开机自启是否已配置
5. 对外验证结果：一条 206 响应头文本或截图

【边界（重要）】
- 不要修改 PART_START/PART_END（180727453-361454906 必须与主站严格一致，六段无缝衔接不重叠）。
- 若你改代码：非 206 响应的排空禁止 arrayBuffer()（会缓冲 1.08 GB 导致 OOM），必须保留仓库里的有界排水实现。
- 某一步失败，把完整错误信息发回来并停下等待确认，不要自行改分区边界或删数据文件。
```
