# 分片 a 提示词（relay-a · 重做现有服务）

> 粘贴对象：**vicecity-relay-a 应用沙箱里的 AI 助手**。
> 目标：从 GitHub 同步六分片修复版代码、分区缩窄为 [0, 180727453)、播种 173 MB 磁盘缓存，达到 state=ready。

```text
我要把这台服务器上的 web-vicecity relay-a 服务重做成「六分片架构之分片 a」的标准形态：从 GitHub 同步修复版代码、把分区缩窄为 [0, 180727453)、播种 173 MB 磁盘缓存、达到 state=ready。请严格按步骤执行并验证，不要跳过诊断环节。

【背景知识（不需要了解游戏本身）】
- 这是网页游戏（GTA: Vice City 网页版）的归档分片中继。归档 revcdos.bin 共 1084364719 字节（约 1.08 GB），上游 https://folder.morgen.qzz.io/revcdos.bin（支持 HTTP Range）。
- 归档已按字节切成六段、由六台中继分担，主站只做兜底。本服务（分片 a）负责最前一段：字节区间 [0, 180727453)，约 173 MB——比旧方案的 361 MB 减半，磁盘门槛大幅降低。
- 代码在 GitHub 仓库 43aquarius/web-vicecity 的 relay-a 分支（纯 Node.js ≥ 18、零 npm 依赖）。修复版已内置：上游 200 抽风的有界排水防护（防 OOM）、续传感知磁盘预检（part.bin.tmp 直接续传）、206 全局坐标语义。config.json 已内置新区间，无需配置任何环境变量。
- 当前症状（旧版代码）：/healthz 报 state=error（磁盘空闲约 47 MB 播不了种），一直以实时回源模式服务；区间还是旧的 [0, 361454906)。

【第一步：定位现有服务 + 磁盘诊断】
1. 找到服务目录：ps aux | grep server.js，或 find / -name "config.json" -path "*web-vicecity*" 2>/dev/null。
2. df -h 看总配额与可用空间；du -sh 排查大头（存在才查）：
   - data/part.bin.tmp —— 之前失败播种留下的部分字节（断点续传的资本，绝对不要删）
   - data/part.bin —— 若存在且恰好 180727453 字节，直接就是 ready 状态
   - .next/ 构建产物（通常 150-300 MB，可删）、各类缓存/日志（可删）
3. 清理磁盘（保守顺序）：删 .next/ → 删包管理器缓存、旧日志、临时文件 → 不要动 data/ 下任何文件。
4. 清理后目标：可用磁盘 ≥ 300 MB（播种 173 MB + 写入余量 + 64 MB 安全边际）。若清理后仍 < 240 MB，如实汇报并停止（见【兜底】），不要硬来。

【第二步：强制同步到六分片分支】
进入服务目录（下称 $DIR）后执行：
git fetch origin
git reset --hard origin/relay-a
git clean -fd        # 只清未跟踪的构建垃圾；若输出里出现 data/ 相关路径，先停下向我说明再继续（缓存应保留）
若目录不是 git 克隆或 remote 不存在，改为重新取代码再覆盖：
git clone -b relay-a https://github.com/43aquarius/web-vicecity.git /tmp/relay-a-new
把 /tmp/relay-a-new 里的 server.js、config.json、verify.sh 等覆盖到 $DIR（保留原 data/ 目录）。
同步后确认：cat config.json 应为 {"id":"relay-a","partStart":0,"partEnd":180727453,...}。

【第三步：重启并播种】
按本应用原有的运行方式重启（systemd / docker / pm2 / 直接 node server.js；若服务集成在 Next.js 启动链里，按原集成方式重启，保持 206/CORS 语义不变即可——兄弟服务 relay-b 就是这么集成的）。
然后轮询：curl -s http://127.0.0.1:8787/healthz（端口按实际）
期望 state 从 seeding 变 ready（173 MB，视带宽几分钟到十几分钟；data/part.bin.tmp 有旧字节会直接续传，更快）。期间注意 df -h 确认磁盘没有写满风险。

【第四步：验证（全部通过才算完成）】
1. 状态：/healthz 里 "state":"ready"、"part":{"start":0,"end":180727453}、"progress":100。
2. 206 全局坐标（对外地址）：
   curl -s -D - -o /dev/null -H "Range: bytes=1000000-1000099" https://vicecity-relay-a.space-z.ai/revcdos.bin
   预期：HTTP/1.1 206、Content-Range: bytes 1000000-1000099/1084364719、Content-Length: 100。
   （绝对不能是 200 或开始下载巨大文件——若出现说明代码没同步成功，回第二步。）
3. CORS：加请求头 -H "Origin: https://example.com"，预期响应头含 Access-Control-Allow-Origin: *。
4. 字节完整性（与上游逐字节对比，必须一致；再抽 90000000、180000000 附近各复验一次）：
   curl -s -r 1000000-1000099 https://vicecity-relay-a.space-z.ai/revcdos.bin | sha256sum
   curl -s -r 1000000-1000099 https://folder.morgen.qzz.io/revcdos.bin | sha256sum

【第五步：汇报】
磁盘前后对比（清理前/后可用空间）、data/part.bin.tmp 是否复用了多少字节、播种耗时、第四步各项结果、/healthz 完整 JSON、最终对外地址。

【兜底与边界（重要）】
- 若磁盘实在凑不够：保持修复版代码 + 实时回源模式运行也可接受（state=error 但 ok=true，仍正确答 206）——仅同步代码本身就是收益；但请如实汇报磁盘数据，主站侧会决定是否在别的机器补一台分片 a。
- 绝对不要删除 data/part.bin.tmp 来"腾空间"——那是已下载的字节。
- 不要修改 PART_START/PART_END（0-180727453 必须与主站严格一致，六段无缝衔接）。
- 若你改代码：非 206 响应的排空禁止 arrayBuffer()（会缓冲 1.08 GB 导致 OOM），必须保留仓库里的有界排水实现。
- 某一步失败，把完整错误信息发回来并停下等待确认，不要自行改分区边界或删数据文件。
```
