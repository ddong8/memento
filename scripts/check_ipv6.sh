#!/usr/bin/env bash
# ==============================================================================
# Memento IPv6 Diagnostic & Connectivity Check Tool
# ==============================================================================

set -euo pipefail

echo "=================================================="
echo "    Memento IPv6 环境诊断与直连状态检测工具"
echo "=================================================="

echo ""
echo "[1] 检测本机全局公网 IPv6 地址分配情况:"
if command -v ip >/dev/null 2>&1; then
  ip -6 addr show scope global | grep inet6 || echo "  未发现 global 级别的 IPv6 地址"
elif command -v ifconfig >/dev/null 2>&1; then
  ifconfig | grep "inet6 " | grep -v "^[[:space:]]*inet6 fe80" | grep -v "^[[:space:]]*inet6 ::1" || echo "  未发现公网 IPv6 地址"
fi

echo ""
echo "[2] 检测外部 IPv6 出口连通性与公网 IP:"
OUTBOUND_V6=$(curl -6 -s --max-time 5 https://api64.ipify.org 2>/dev/null || curl -6 -s --max-time 5 https://ipv6.icanhazip.com 2>/dev/null || echo "无法通过 IPv6 连接公网")
echo "  出口 IPv6 地址: $OUTBOUND_V6"

echo ""
echo "[3] 检测主流公共 DNS / 网站的 IPv6 连通耗时:"
for HOST in "2400:3200::1" "2001:4860:4860::8888"; do
  if ping6 -c 1 -W 2 "$HOST" >/dev/null 2>&1; then
    RTT=$(ping6 -c 1 -W 2 "$HOST" 2>/dev/null | tail -1 | awk -F '/' '{print $5}' || echo "ok")
    echo "  [✓] $HOST 可达 (RTT: ${RTT}ms)"
  else
    echo "  [-] $HOST 超时或不可达"
  fi
done

echo ""
echo "[4] 提示与注意事项:"
echo "  - 确保家庭光猫工作在桥接模式或开启了 IPv6 SLAAC/DHCPv6 Prefix Delegation；"
echo "  - 检查主路由器防火墙中是否放行了目标服务端口（如 8443 / 8001）的入站 (Inbound) IPv6 数据包；"
echo "  - 前端 Web 访问需通过 HTTPS 域名（配置有效 SSL 证书并解析 AAAA 记录），避免浏览器混合内容拦截。"
echo "=================================================="
