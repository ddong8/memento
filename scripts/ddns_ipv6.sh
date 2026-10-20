#!/usr/bin/env bash
# ==============================================================================
# Memento IPv6 Direct DDNS Sync Tool (Cloudflare API)
# ==============================================================================
# Usage:
#   export CF_API_TOKEN="your_cloudflare_api_token"
#   export CF_ZONE_ID="your_zone_id"
#   export RECORD_NAME="direct.example.com"
#   ./scripts/ddns_ipv6.sh
#
# Can be scheduled in crontab every 10 minutes:
#   */10 * * * * CF_API_TOKEN=xxx CF_ZONE_ID=yyy RECORD_NAME=direct.example.com /path/to/ddns_ipv6.sh >> /var/log/memento_ddns.log 2>&1
# ==============================================================================

set -euo pipefail

CF_API_TOKEN="${CF_API_TOKEN:-}"
CF_ZONE_ID="${CF_ZONE_ID:-}"
RECORD_NAME="${RECORD_NAME:-}"

if [[ -z "$CF_API_TOKEN" || -z "$CF_ZONE_ID" || -z "$RECORD_NAME" ]]; then
  echo "[-] 缺少必要环境变量。请确保设置了 CF_API_TOKEN, CF_ZONE_ID, RECORD_NAME"
  exit 1
fi

echo "[*] 获取当前主机的公网 IPv6 地址..."

# 获取全球单播 IPv6 地址（优先通过公共探活服务，备选系统网卡）
CURRENT_IPV6=$(curl -6 -s --max-time 5 https://api64.ipify.org 2>/dev/null || curl -6 -s --max-time 5 https://ipv6.icanhazip.com 2>/dev/null || true)

if [[ -z "$CURRENT_IPV6" ]]; then
  # 备选：从本机路由表中查找非链路本地地址 (fe80::) 的默认 IPv6
  if command -v ip >/dev/null 2>&1; then
    CURRENT_IPV6=$(ip -6 addr show scope global | grep inet6 | awk '{print $2}' | cut -d'/' -f1 | head -n 1 || true)
  elif command -v ifconfig >/dev/null 2>&1; then
    CURRENT_IPV6=$(ifconfig | grep "inet6 " | awk '{print $2}' | grep -v "^fe80" | grep -v "^::1" | head -n 1 || true)
  fi
fi

if [[ -z "$CURRENT_IPV6" ]]; then
  echo "[-] 未检测到有效的公网 IPv6 地址，请检查家庭光猫/路由器是否开启 IPv6 拨号与 DHCPv6/SLAAC。"
  exit 1
fi

echo "[+] 当前公网 IPv6 地址: $CURRENT_IPV6"

# 查询 Cloudflare DNS 现有 AAAA 记录
echo "[*] 查询 Cloudflare 上 $RECORD_NAME 的 DNS AAAA 记录..."
RECORD_INFO=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records?type=AAAA&name=${RECORD_NAME}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json")

RECORD_ID=$(echo "$RECORD_INFO" | grep -o '"id":"[^"]*' | head -n 1 | cut -d'"' -f4 || true)
RECORD_CONTENT=$(echo "$RECORD_INFO" | grep -o '"content":"[^"]*' | head -n 1 | cut -d'"' -f4 || true)

if [[ -n "$RECORD_CONTENT" && "$RECORD_CONTENT" == "$CURRENT_IPV6" ]]; then
  echo "[✓] Cloudflare DNS 记录已是最新 ($CURRENT_IPV6)，无需更新。"
  exit 0
fi

if [[ -z "$RECORD_ID" ]]; then
  echo "[*] 未找到现有 AAAA 记录，正在创建新记录..."
  CREATE_RES=$(curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"type\":\"AAAA\",\"name\":\"${RECORD_NAME}\",\"content\":\"${CURRENT_IPV6}\",\"ttl\":120,\"proxied\":false}")
  echo "[+] 记录创建完成: $CREATE_RES"
else
  echo "[*] 记录已变更 (旧: ${RECORD_CONTENT} -> 新: ${CURRENT_IPV6})，正在更新..."
  UPDATE_RES=$(curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${RECORD_ID}" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"type\":\"AAAA\",\"name\":\"${RECORD_NAME}\",\"content\":\"${CURRENT_IPV6}\",\"ttl\":120,\"proxied\":false}")
  echo "[+] 记录更新完成: $UPDATE_RES"
fi

echo "[✓] IPv6 直连 DDNS 同步成功。"
