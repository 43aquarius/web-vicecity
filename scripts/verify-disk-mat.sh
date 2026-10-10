#!/usr/bin/env bash
# Disk-materialisation end-to-end verification (standalone, :3100).
# Simulates the published container: cwd = standalone dir, remote archive mode.
set -uo pipefail

PORT=3100
SA=/home/z/my-project/.next/standalone
MAT_DIR="$SA/.revcdos-mat"
LOG=/tmp/standalone-3100.log

echo "== 1. 清理旧物化目录, 冷启动 standalone :$PORT =="
rm -rf "$MAT_DIR"
cd "$SA" || exit 1
(PORT=$PORT NODE_ENV=production nohup bun server.js > "$LOG" 2>&1 &)
for i in $(seq 1 20); do
  sleep 2
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://localhost:$PORT/" 2>/dev/null)
  [ "$code" = "200" ] && { echo "✓ server ready (第${i}轮)"; break; }
done

echo
echo "== 2. 触发 warm 并等待两个引擎文件完成 =="
curl -s -m 5 -X POST "http://localhost:$PORT/api/archive/warm" > /dev/null 2>&1 || true
for i in $(seq 1 60); do
  sleep 3
  phases=$(curl -s -m 5 "http://localhost:$PORT/api/archive/status" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    w = d.get('warm') or {}
    print((w.get('data') or {}).get('phase','?'), (w.get('wasm') or {}).get('phase','?'))
except Exception:
    print('parse-err')
" 2>/dev/null)
  echo "  warm: $phases"
  [ "$phases" = "done done" ] && break
done

echo
echo "== 3. 磁盘物化文件检查 =="
ls -la "$MAT_DIR" 2>/dev/null | tail -4 || echo "✗ 物化目录不存在"
for f in "$MAT_DIR"/vcbr_vc-sky-en-v6.data "$MAT_DIR"/vcbr_vc-sky-en-v6.wasm; do
  [ -f "$f" ] && echo "✓ $(basename "$f") $(du -h "$f" | cut -f1)" || echo "✗ 缺 $f"
done

echo
echo "== 4. Range 206 字节校验 (两个窗口对照源站解压基准) =="
check() {
  local s=$1 e=$2 label=$3
  local got ref
  got=$(curl -s -m 60 -H "Range: bytes=$s-$e" "http://localhost:$PORT/vcbr/vc-sky-en-v6.data.br" | sha256sum | cut -d' ' -f1)
  ref=$(node /home/z/my-project/scripts/mat-ref.js "$s" "$e" 2>/dev/null)
  [ "$got" = "$ref" ] && echo "✓ $label [$s-$e] sha 一致 (${got:0:16}…)" || echo "✗ $label 不一致 got=${got:0:16} ref=${ref:0:16}"
}
check 1000000 2000999 "窗口A(头段)"
check 130000000 130009999 "窗口B(尾段)"
check 67000000 68000999 "窗口C(中段)"

echo
echo "== 5. 小文件(wasm.br, 内存路径) 206 =="
curl -s -o /dev/null -w "  wasm.br Range: %{http_code} (%{size_download}B)\n" -m 30 \
  -H "Range: bytes=0-65535" "http://localhost:$PORT/vcbr/vc-sky-en-v6.wasm.br"

echo
echo "== 6. 二次请求延迟 (disk 命中应 <50ms) =="
curl -s -o /dev/null -w "  2nd hit: %{time_total}s\n" -m 30 \
  -H "Range: bytes=5000000-5099999" "http://localhost:$PORT/vcbr/vc-sky-en-v6.data.br"
curl -s -o /dev/null -w "  3rd hit: %{time_total}s\n" -m 30 \
  -H "Range: bytes=5000000-5099999" "http://localhost:$PORT/vcbr/vc-sky-en-v6.data.br"

echo
echo "== 7. Mode2 (br 透传) / Mode3 (流式解压) 回归 =="
curl -s -o /dev/null -w "  br透传: %{http_code} encoding=%{header_json}" -m 60 \
  -H "Accept-Encoding: br" "http://localhost:$PORT/vcbr/vc-sky-en-v6.wasm.br" 2>/dev/null | head -c 200; echo
curl -s -o /dev/null -w "  流式解压: %{http_code} (%{size_download}B)\n" -m 120 \
  "http://localhost:$PORT/vcbr/vc-sky-en-v6.wasm.br"

echo
echo "== 8. 进程 RSS =="
ps aux | rg "[b]un server.js" | awk '{printf "  RSS: %.0f MB\n", $6/1024}'

echo
echo "== 9. 服务器日志关键行 =="
rg "archive" "$LOG" | head -12

echo
echo "== 清理 =="
pkill -f "bun server.js" 2>/dev/null
sleep 1
echo "✓ standalone :3100 已关闭 (dev:3000 不受影响)"
