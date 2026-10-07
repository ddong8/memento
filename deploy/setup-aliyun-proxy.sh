#!/bin/bash
# ============================================================
# Generic VPS front-proxy template: nginx (HTTPS via Let's Encrypt)
# reverse-proxying to a backend Mac / workstation over Tailscale or LAN.
#
# Usage:
#   sudo DOMAIN=memento.example.com BACKEND_IP=100.x.x.x EMAIL=you@example.com \
#     bash setup-aliyun-proxy.sh
#
# Required env vars (no secret-by-default values committed to git):
#   DOMAIN       — public domain that users hit (must have an A record → this VPS)
#   BACKEND_IP   — reachable-from-VPS IP of the Mac/workstation running the stack
#                  (typically a Tailscale 100.x.x.x address)
#   EMAIL        — contact email for Let's Encrypt expiry notices
#
# Optional env vars:
#   WEB_PORT         — backend Next.js port (default 3001)
#   API_PORT         — backend FastAPI port (default 8001)
#   LEGACY_DOMAIN    — old domain to 301 → DOMAIN during a rename (e.g. during
#                      report.ihasy.com → mem.ihasy.com transition). If unset,
#                      no legacy redirect is written.
# ============================================================

set -euo pipefail

: "${DOMAIN:?Set DOMAIN=your-domain.example.com}"
: "${BACKEND_IP:?Set BACKEND_IP=<Tailscale or LAN IP of your workstation>}"
: "${EMAIL:?Set EMAIL=you@example.com (for Let's Encrypt notices)}"
WEB_PORT="${WEB_PORT:-3001}"
API_PORT="${API_PORT:-8001}"
LEGACY_DOMAIN="${LEGACY_DOMAIN:-}"

# ── Optional: clean up an old-domain vhost before writing the new one ──
if [ -n "$LEGACY_DOMAIN" ] && [ -L "/etc/nginx/sites-enabled/${LEGACY_DOMAIN}" ]; then
    echo "=== 0. Remove old ${LEGACY_DOMAIN} nginx symlink (cert kept for 301 below) ==="
    rm -f "/etc/nginx/sites-enabled/${LEGACY_DOMAIN}"
fi

echo "=== 1. Install nginx + certbot (skip if already present) ==="
if ! command -v nginx >/dev/null 2>&1 || ! command -v certbot >/dev/null 2>&1; then
    apt update
    apt install -y nginx certbot python3-certbot-nginx
else
    echo "  → nginx + certbot already installed"
fi

echo "=== 2. Write HTTP scaffold for certbot HTTP-01 challenge ==="
cat > /etc/nginx/sites-available/${DOMAIN} <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}
NGINX
ln -sf /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

echo "=== 3. Request SSL cert for ${DOMAIN} ==="
certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos -m ${EMAIL}

echo "=== 4. Write full HTTPS reverse-proxy config ==="
# 确保缓存目录存在
mkdir -p /var/cache/nginx/memento_media
chown -R www-data:www-data /var/cache/nginx/memento_media 2>/dev/null || true

cat > /etc/nginx/sites-available/${DOMAIN} <<NGINX
proxy_cache_path /var/cache/nginx/memento_media levels=1:2 keys_zone=memento_media_cache:20m max_size=20g inactive=7d use_temp_path=off;

server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name ${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Next.js frontend
    location / {
        proxy_pass http://${BACKEND_IP}:${WEB_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }

    # 针对媒体流与大文件开启 Range 切片缓存加速，减轻公网穿透回源延迟
    location ~* ^/api/devices/.+/files/stream {
        proxy_pass http://${BACKEND_IP}:${API_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # 启用媒体本地缓存与 HTTP 206 Partial Content 支持
        proxy_cache memento_media_cache;
        proxy_cache_key \$uri\$is_args\$args;
        proxy_cache_valid 200 206 7d;
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
        proxy_cache_lock on;
        proxy_cache_lock_timeout 5s;
        proxy_force_ranges on;
        add_header X-Cache-Status \$upstream_cache_status;
        proxy_read_timeout 86400;
    }

    # FastAPI backend
    location /api/ {
        proxy_pass http://${BACKEND_IP}:${API_PORT}/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # SSE support
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 86400;
    }

    location /health      { proxy_pass http://${BACKEND_IP}:${API_PORT}/health; }
    location /docs        { proxy_pass http://${BACKEND_IP}:${API_PORT}/docs; }
    location /openapi.json { proxy_pass http://${BACKEND_IP}:${API_PORT}/openapi.json; }

    # One-click installer bootstrap
    location ^~ /install {
        proxy_pass http://${BACKEND_IP}:${API_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    client_max_body_size 50M;
}
NGINX

# ── Optional: 301 redirect from legacy domain to new ──
if [ -n "$LEGACY_DOMAIN" ] && [ -f "/etc/letsencrypt/live/${LEGACY_DOMAIN}/fullchain.pem" ]; then
    echo "=== 5. 301 redirect ${LEGACY_DOMAIN} → ${DOMAIN} ==="
    cat > /etc/nginx/sites-available/${LEGACY_DOMAIN}-redirect <<LEGACY
server {
    listen 80;
    server_name ${LEGACY_DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://${DOMAIN}\$request_uri; }
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
fi

echo "=== 6. Validate + reload nginx ==="
nginx -t
systemctl reload nginx

echo "=== 7. Verify auto-renewal ==="
certbot renew --dry-run 2>&1 | tail -5

echo ""
echo "============================================"
echo "  Setup complete!"
echo "  https://${DOMAIN}"
echo "  https://${DOMAIN}/health"
echo "  https://${DOMAIN}/docs"
if [ -n "$LEGACY_DOMAIN" ]; then
    echo "  https://${LEGACY_DOMAIN} → 301 → https://${DOMAIN}"
    echo ""
    echo "  When the transition window is over, clean up:"
    echo "    rm /etc/nginx/sites-enabled/${LEGACY_DOMAIN}-redirect"
    echo "    certbot delete --cert-name ${LEGACY_DOMAIN}"
    echo "    systemctl reload nginx"
fi
echo "============================================"
