#!/bin/bash
# relay 部署后冒烟测试：healthz / Range / CORS / 状态页
set -u
BASE="${1:-http://127.0.0.1:8787}"
START=$(python3 -c "import json;print(json.load(open('config.json'))['partStart'])" 2>/dev/null || echo 0)
FAIL=0
echo "[1] healthz"
curl -s --max-time 10 "$BASE/healthz" | python3 -m json.tool || FAIL=1
echo "[2] Range 请求（起点=本分区 PART_START=$START）"
curl -s -o /dev/null -D - --max-time 15 -H "Range: bytes=$START-$((START+99))" "$BASE/revcdos.bin" | head -6 || FAIL=1
echo "[3] CORS 头"
ACAO=$(curl -s -o /dev/null -D - --max-time 10 -H "Origin: https://example.com" -H "Range: bytes=$START-$((START+9))" "$BASE/revcdos.bin" | grep -i '^access-control-allow-origin' | tr -d '\r')
echo "    $ACAO"
[ -n "$ACAO" ] || { echo "    MISSING ACAO!"; FAIL=1; }
echo "[4] 状态页"
curl -s -o /dev/null -w "    HTTP %{http_code}\n" --max-time 10 "$BASE/" || FAIL=1
[ "$FAIL" = "0" ] && echo "ALL CHECKS DONE (combine with healthz ok:true to confirm readiness)" || echo "SOME CHECKS FAILED"
