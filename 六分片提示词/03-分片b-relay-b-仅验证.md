# 分片 b 提示词（relay-b · 仅验证，无需重做）

> 粘贴对象：**vicecity-relay-b 应用沙箱里的 AI 助手**。
> 目标：确认现有部署健康、可正确服务新子区间 [361454906, 542182359)，然后汇报。
> **重要：现有部署就是分片 b 的答案——不要重做、不要重启、不要同步代码。**

```text
这台服务器上的 web-vicecity relay-b 是六分片架构的「分片 b」。它**现有部署无需任何重做**：磁盘上缓存的 361 MB 旧整段是其新子区间 [361454906, 542182359) 的超集，主站切换六分片路由后本服务直接从磁盘命中应答。你的任务只有三件事：健康快照、一轮 206/CORS/字节抽查、汇报。请按步骤执行，不要重启服务、不要改代码、不要动 data/ 数据。

【背景知识】
- 游戏归档 revcdos.bin 共 1084364719 字节（约 1.08 GB），上游 https://folder.morgen.qzz.io/revcdos.bin，已按字节切成六段、六台中继分担，主站只做兜底。
- 本服务承担分片 b：[361454906, 542182359)，约 173 MB。磁盘上的 part.bin 缓存了整个旧中段 [361454906, 722909812)（361 MB），新子区间是它的前半——无论主站按旧区间还是新区间路由，请求全部命中本地磁盘。
- （说明：GitHub relay-b 分支上的新 config.json 是窄区间版本，供未来重建用。现在同步它会触发 part.bin 尺寸校验、删掉 361 MB 缓存重播 173 MB——没有必要，千万不要做。）

【第一步：健康快照】
curl -s http://127.0.0.1:8787/healthz（端口按实际部署）
预期：ok=true、state=ready、part 覆盖 [361454906, 722909812)（旧区间，属预期状态，无需调整）、served.bytesServed 数值正常。
把完整 JSON 记下来放进汇报。

【第二步：验证（全部用新子区间内的偏移）】
1. 206 全局坐标（对外地址）：
   curl -s -D - -o /dev/null -H "Range: bytes=400000000-400000099" https://vicecity-relay-b.space-z.ai/revcdos.bin
   预期：HTTP/1.1 206、Content-Range: bytes 400000000-400000099/1084364719、Content-Length: 100。
2. CORS：加请求头 -H "Origin: https://example.com"，预期响应头含 Access-Control-Allow-Origin: *。
3. 字节完整性（与上游逐字节对比，必须一致；再抽 450000000、542000000 附近各复验一次）：
   curl -s -r 400000000-400000099 https://vicecity-relay-b.space-z.ai/revcdos.bin | sha256sum
   curl -s -r 400000000-400000099 https://folder.morgen.qzz.io/revcdos.bin | sha256sum
   （应从本地磁盘秒回——X-Relay-Source 类标记应为本地缓存，而非实时回源。）

【第三步：汇报】
1. /healthz 完整 JSON
2. 第二步各项验证结果（206 响应头 + 两个 sha256）
3. df -h 磁盘余量（确认 361 MB 缓存 + 系统仍有余量）
4. 对外地址确认（应为 https://vicecity-relay-b.space-z.ai/revcdos.bin，若实际不同请如实汇报）

【边界（重要）】
- 不要执行 git reset / 重启 / 删除 data/ 任何文件：现有部署已满足分片 b 的全部要求。
- 仅当发现服务异常（第二步任何一项不过）才如实汇报错误详情，等待主站侧指示；如最终确认需要彻底重建，流程是：git clone -b relay-b https://github.com/43aquarius/web-vicecity.git 后按其 README 部署（会重新播种 173 MB），重建前必须先告知主站侧。
```
