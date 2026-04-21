#!/bin/bash
# ============================================================
# 在阿里云服务器 (120.77.237.135) 上执行此脚本
# 配置 nginx + certbot，反向代理 mem.ihasy.com 到 Mac mini
#
# 从 report.ihasy.com 迁移而来:
# - 前置条件:DNS 已将 mem.ihasy.com 的 A 记录指向本 VPS 公网 IP
# - 本脚本会:申请 mem.ihasy.com 的 Let's Encrypt 证书、配 nginx 反代
# - 可选:保留 report.ihasy.com 配置做 301 跳转,让旧书签/旧 collector
#   自动转到新域名(若 DNS 仍指向本机);两周后可注释掉该段并 certbot
#   delete 掉旧证书
# ============================================================

set -e

DOMAIN="mem.ihasy.com"
# 旧域名 — 做 301 跳转的兼容窗口。完全弃用后可删
LEGACY_DOMAIN="report.ihasy.com"
# Mac mini 的 Tailscale 内网 IP
BACKEND_IP="100.93.186.128"
WEB_PORT=3001
API_PORT=8001

# ── 可选:清理旧域名的 nginx 配置,避免和新配冲突 ─────────────
if [ -f /etc/nginx/sites-enabled/${LEGACY_DOMAIN} ]; then
    echo "=== 0. 移除旧 ${LEGACY_DOMAIN} nginx 配置 (证书保留,后续 certbot delete) ==="
    rm -f /etc/nginx/sites-enabled/${LEGACY_DOMAIN}
    # 不删 sites-available 副本,留底
fi

echo "=== 1. 安装 nginx 和 certbot ==="
apt update
apt install -y nginx certbot python3-certbot-nginx

echo "=== 2. 创建 nginx 配置 ==="
cat > /etc/nginx/sites-available/mem.ihasy.com << NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    # certbot 验证用
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # 其余全部跳转 HTTPS
    location / {
        return 301 https://\$host\$request_uri;
    }
}
NGINX

# 先启用 HTTP 配置（certbot 需要）
ln -sf /etc/nginx/sites-available/mem.ihasy.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

echo "=== 3. 申请 SSL 证书 ==="
certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos -m admin@ihasy.com

echo "=== 4. 配置 HTTPS 反向代理 ==="
cat > /etc/nginx/sites-available/mem.ihasy.com << 'NGINX'
# HTTP -> HTTPS redirect
server {
    listen 80;
    server_name mem.ihasy.com;
    return 301 https://$host$request_uri;
}

# HTTPS
server {
    listen 443 ssl;
    server_name mem.ihasy.com;

    # SSL (managed by certbot)
    ssl_certificate /etc/letsencrypt/live/mem.ihasy.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mem.ihasy.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # 前端 (Next.js on port 3001)
    location / {
        proxy_pass http://100.93.186.128:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    # API (FastAPI on port 8001)
    location /api/ {
        proxy_pass http://100.93.186.128:8001/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE support
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 86400;
    }

    # API health (no /api prefix)
    location /health {
        proxy_pass http://100.93.186.128:8001/health;
    }

    # API docs
    location /docs {
        proxy_pass http://100.93.186.128:8001/docs;
    }
    location /openapi.json {
        proxy_pass http://100.93.186.128:8001/openapi.json;
    }

    # One-click installer bootstrap
    location ^~ /install {
        proxy_pass http://100.93.186.128:8001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Upload size limit (for large JSONL files)
    client_max_body_size 50M;
}
NGINX

echo "=== 5. (可选) 旧域名 301 跳转到新域名 ==="
# 让 report.ihasy.com 的历史访问者自动跳到 mem.ihasy.com。
# 前提:旧证书 /etc/letsencrypt/live/${LEGACY_DOMAIN} 还存在
# 当 DNS 上 report 撤掉、或过了过渡期,直接 certbot delete --cert-name ${LEGACY_DOMAIN}
# 并删本段即可。
if [ -f /etc/letsencrypt/live/${LEGACY_DOMAIN}/fullchain.pem ]; then
cat > /etc/nginx/sites-available/${LEGACY_DOMAIN}-redirect << LEGACY
server {
    listen 80;
    server_name ${LEGACY_DOMAIN};
    return 301 https://${DOMAIN}\$request_uri;
}
server {
    listen 443 ssl;
    server_name ${LEGACY_DOMAIN};
    ssl_certificate /etc/letsencrypt/live/${LEGACY_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${LEGACY_DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    return 301 https://${DOMAIN}\$request_uri;
}
LEGACY
    ln -sf /etc/nginx/sites-available/${LEGACY_DOMAIN}-redirect /etc/nginx/sites-enabled/
    echo "  → 旧域名 301 跳转启用"
else
    echo "  → 旧证书不存在,跳过 legacy 301 配置"
fi

echo "=== 6. 验证并重启 nginx ==="
nginx -t && systemctl reload nginx

echo "=== 7. 设置证书自动续期 ==="
# certbot 自动安装了 cron/systemd timer，验证一下
certbot renew --dry-run

echo ""
echo "============================================"
echo "  Setup complete!"
echo "  新域名: https://${DOMAIN}"
echo "          https://${DOMAIN}/api/tools"
echo "          https://${DOMAIN}/health"
if [ -f /etc/letsencrypt/live/${LEGACY_DOMAIN}/fullchain.pem ]; then
echo "  旧域名: https://${LEGACY_DOMAIN} → 301 → https://${DOMAIN}"
echo "          过渡期结束后清理:"
echo "            rm /etc/nginx/sites-enabled/${LEGACY_DOMAIN}-redirect"
echo "            certbot delete --cert-name ${LEGACY_DOMAIN}"
echo "            systemctl reload nginx"
fi
echo "============================================"
