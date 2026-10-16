#!/usr/bin/env bash
#
# deploy-racelive.sh — сайт RaceLive (github.com/oINCLUDEo/RaceLive) за Reality на ноде.
#
#   посетитель -> 443 Xray -> (не Reality-клиент) -> nginx 127.0.0.1:STUB_PORT -> RaceLive
#        /              -> 127.0.0.1:3000  Next.js
#        /connection/   -> 127.0.0.1:8001  Centrifugo (websocket)
#
# Нужна нода, уже поднятая provision-node.sh в режиме 1 или 2 (nginx + LE-серт домена).
# Обычно вызывается оттуда при SITE=racelive, но можно запускать и отдельно на готовой ноде.
#
# Что делает:
#   1. ставит Docker (если нет), открывает в nftables forward для Docker-сетей, ip_forward=1
#   2. клонирует/обновляет репо в APP_DIR (/opt/racelive)
#   3. готовит .env: секреты генерит один раз, домен и wss-URL проставляет
#   4. выключает их Caddy (443 держит Xray, TLS делает наш nginx)
#   5. собирает и поднимает compose (на RAM < 3.5 ГБ временно добавляет swap под сборку)
#   6. если сайт ответил — переключает nginx со статики на прокси; если нет — статика остаётся
#
# Запуск:
#   sudo DOMAIN=tensory.ulya.space bash deploy-racelive.sh
#   sudo DOMAIN=... PROXY_PROTOCOL=1 bash deploy-racelive.sh
#       ^ настоящие IP посетителей в приложении, НО в Config Profile ноды нужен xver: 1,
#         иначе сайт будет отдавать ошибку.
#
# Обновить сайт позже:  cd /opt/racelive && git pull && docker compose up -d --build
#
set -euo pipefail

DOMAIN="${DOMAIN:-}"
MODE="${MODE:-}"
STUB_PORT="${STUB_PORT:-}"
PROXY_PROTOCOL="${PROXY_PROTOCOL:-0}"
APP_DIR="${APP_DIR:-/opt/racelive}"
REPO_URL="${REPO_URL:-https://github.com/oINCLUDEo/RaceLive.git}"
YES="${YES:-0}"
NGX_CONF=/etc/nginx/sites-available/decoy.conf
NFT_CONF=/etc/nftables.conf
WEBROOT=/var/www/certbot
BUILD_SWAP=/swapfile-build
BUILD_SWAP_CREATED=0
BACKUP_DIR="/root/rw-racelive-backup/$(date +%Y%m%d-%H%M%S)"

log(){  printf '\033[1;36m[*]\033[0m %s\n' "$*"; }
ok(){   printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
err(){  printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

cleanup(){
  if [ "$BUILD_SWAP_CREATED" = 1 ]; then
    swapoff "$BUILD_SWAP" 2>/dev/null || true
    rm -f "$BUILD_SWAP"
  fi
}
trap cleanup EXIT

[ "$(id -u)" -eq 0 ] || err "Запусти от root:  sudo DOMAIN=... bash deploy-racelive.sh"
if [ -z "$DOMAIN" ]; then read -r -p "    Домен сайта (как у ноды, напр. tensory.ulya.space): " DOMAIN; fi
[ -n "$DOMAIN" ] || err "Не задан DOMAIN."
[ -f "$NGX_CONF" ] || err "Нет $NGX_CONF — сначала подними ноду provision-node.sh (режим 1 или 2)."
[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ] || err "Нет LE-серта для $DOMAIN — сначала provision-node.sh с DOMAIN=$DOMAIN."

if [ -z "$STUB_PORT" ]; then
  STUB_PORT="$(grep -oE 'listen 127\.0\.0\.1:[0-9]+' "$NGX_CONF" | head -1 | cut -d: -f2 || true)"
  STUB_PORT="${STUB_PORT:-8081}"
fi
if [ -z "$MODE" ]; then
  if grep -qE 'listen 443 ' "$NGX_CONF"; then MODE=2; else MODE=1; fi
fi
mkdir -p "$BACKUP_DIR"
log "Домен=$DOMAIN  режим ноды=$MODE  nginx-стаб=127.0.0.1:$STUB_PORT  PROXY_PROTOCOL=$PROXY_PROTOCOL"

### 0. Ресурсы
MEM_MB="$(awk '/^MemTotal/{print int($2/1024)}' /proc/meminfo)"
SWAP_MB="$(awk '/^SwapTotal/{print int($2/1024)}' /proc/meminfo)"
DISK_MB="$(df -Pm / | awk 'NR==2{print $4}')"
[ "$DISK_MB" -lt 6000 ] && warn "Свободно на диске ${DISK_MB} МБ — образам и сборке нужно ~5–6 ГБ."
if [ "$MEM_MB" -lt 3500 ]; then
  warn "RAM ${MEM_MB} МБ: сборка Next.js тут на грани (рекомендую 4 ГБ). Работать сайт потом будет нормально."
  if [ $(( MEM_MB + SWAP_MB )) -lt 4096 ]; then
    ADD_MB=$(( 4096 - MEM_MB - SWAP_MB )); [ "$ADD_MB" -lt 1024 ] && ADD_MB=1024
    if [ "$DISK_MB" -gt $(( ADD_MB + 4096 )) ]; then
      log "Временно добавляю swap ${ADD_MB} МБ на время сборки (уберу в конце)..."
      rm -f "$BUILD_SWAP"
      { dd if=/dev/zero of="$BUILD_SWAP" bs=1M count="$ADD_MB" status=none && chmod 600 "$BUILD_SWAP" \
        && mkswap "$BUILD_SWAP" >/dev/null 2>&1 && swapon "$BUILD_SWAP" 2>/dev/null && BUILD_SWAP_CREATED=1; } \
        || { rm -f "$BUILD_SWAP"; warn "Временный swap не поднялся — продолжаю без него."; }
    else
      warn "Мало места на диске для временного swap."
    fi
  fi
  if [ "$YES" != 1 ] && [ -t 0 ]; then
    A=y; read -r -p "Продолжить сборку? [Y/n]: " A || A=y
    case "$A" in n|N|no) err "Отменено." ;; esac
  fi
fi

### 1. Docker, git
export DEBIAN_FRONTEND=noninteractive
command -v git >/dev/null 2>&1 || apt-get install -y git >/dev/null
if ! command -v docker >/dev/null 2>&1; then
  log "Ставлю Docker (официальный скрипт get.docker.com)..."
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || err "Нет плагина docker compose (docker compose version)."
ok "Docker: $(docker --version | cut -d, -f1)"

### 2. Сеть для контейнеров: forward в nftables + ip_forward (до сборки — ей тоже нужен интернет)
if nft list table inet filter >/dev/null 2>&1; then
  if ! nft list chain inet filter forward 2>/dev/null | grep -q 'iifname "br-\*"'; then
    nft add rule inet filter forward ct state established,related accept
    nft add rule inet filter forward iifname "docker0" accept
    nft add rule inet filter forward iifname "br-*" accept
  fi
  ok "nftables: forward для Docker-сетей открыт."
fi
# чтобы правило пережило перезагрузку: чиним nftables.conf, если он старого формата
if [ -f "$NFT_CONF" ] && ! grep -q 'iifname "br-\*"' "$NFT_CONF"; then
  NFT_BAK="$BACKUP_DIR/nftables.conf"; cp "$NFT_CONF" "$NFT_BAK"
  sed -i 's|^  chain forward { type filter hook forward priority 0; policy drop; }$|  chain forward {\n    type filter hook forward priority 0; policy drop;\n    ct state established,related accept\n    iifname "docker0" accept\n    iifname "br-*" accept\n  }|' "$NFT_CONF"
  sed -i 's|^flush ruleset$|table inet filter\ndelete table inet filter|' "$NFT_CONF"
  if grep -q 'iifname "br-\*"' "$NFT_CONF" && nft -c -f "$NFT_CONF" >/dev/null 2>&1; then
    ok "$NFT_CONF обновлён (forward для Docker переживёт перезагрузку)."
  else
    cp "$NFT_BAK" "$NFT_CONF"
    warn "Не смог поправить $NFT_CONF автоматически (нестандартный формат). Добавь в chain forward вручную:"
    warn '    iifname "docker0" accept;  iifname "br-*" accept'
  fi
fi
sysctl -w net.ipv4.ip_forward=1 >/dev/null
if [ -f /etc/sysctl.d/99-rw-node.conf ]; then
  sed -i 's/^net\.ipv4\.ip_forward = 0$/net.ipv4.ip_forward = 1/' /etc/sysctl.d/99-rw-node.conf
fi
ok "ip_forward=1 (контейнерам нужен выход в интернет)."

### 3. Код
if [ -d "$APP_DIR/.git" ]; then
  log "Обновляю $APP_DIR..."
  git -C "$APP_DIR" pull --ff-only || warn "git pull не прошёл — собираю текущую версию."
else
  log "Клонирую $REPO_URL -> $APP_DIR..."
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

### 4. .env
ENV_FILE="$APP_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then cp "$APP_DIR/.env.example" "$ENV_FILE"; fi
chmod 600 "$ENV_FILE"
get_kv(){ grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
set_kv(){
  if grep -qE "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi
}
# секреты — только если там ещё плейсхолдер (иначе Postgres перестанет пускать по старому паролю)
case "$(get_kv POSTGRES_PASSWORD)" in ""|change_me_in_production) set_kv POSTGRES_PASSWORD "$(openssl rand -hex 24)" ;; esac
case "$(get_kv CENTRIFUGO_API_KEY)" in ""|dev_centrifugo_api_key) set_kv CENTRIFUGO_API_KEY "$(openssl rand -hex 24)" ;; esac
set_kv SITE_DOMAIN "$DOMAIN"
set_kv SITE_URL "https://$DOMAIN"
set_kv API_CORS_ORIGINS "https://$DOMAIN"
set_kv NEXT_PUBLIC_API_URL "https://$DOMAIN"
set_kv NEXT_PUBLIC_CENTRIFUGO_URL "wss://$DOMAIN/connection/websocket"   # вшивается при сборке!
ok ".env готов (секреты сгенерированы, домен $DOMAIN)."

### 5. Их Caddy не нужен: 443 держит Xray, TLS делает наш nginx
cat > "$APP_DIR/docker-compose.override.yml" <<'EOF'
# Создано Sepia/deploy-racelive.sh. На ноде 443 занят Xray (Reality), а TLS для сайта
# делает nginx ноды, поэтому Caddy из основного compose не запускаем.
services:
  caddy:
    profiles: ["disabled"]
EOF

### 6. Сборка и запуск
log "Сборка и запуск RaceLive (первый раз 5–15 минут, дальше быстрее)..."
( cd "$APP_DIR" && docker compose up -d --build ) || err "docker compose упал — смотри вывод выше."

log "Жду, пока сайт ответит на 127.0.0.1:3000..."
UP=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3000/; then UP=1; break; fi
  sleep 5
done
cleanup; BUILD_SWAP_CREATED=0

### 7. nginx: статика -> прокси (только если сайт живой)
if [ "$UP" != 1 ]; then
  warn "Сайт не ответил за 5 минут. nginx НЕ переключаю — нода продолжает отдавать статику «Сепия»."
  warn "Разберись: cd $APP_DIR && docker compose ps && docker compose logs --tail 50 web api"
  warn "Потом просто запусти этот скрипт ещё раз."
  exit 1
fi
ok "Next.js отвечает."

PP=""; REALIP=""
if [ "$PROXY_PROTOCOL" = 1 ]; then
  PP=" proxy_protocol"
  REALIP="set_real_ip_from 127.0.0.1; real_ip_header proxy_protocol;"
fi
LOCS='
  location /connection/ {
    proxy_pass http://127.0.0.1:8001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 3600s;
  }
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
  }'
PUB443=""
if [ "$MODE" = 2 ]; then
  PUB443="
server { listen 443 ssl http2; server_name $DOMAIN;
  ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
$LOCS
}"
fi

NGX_BAK="$BACKUP_DIR/decoy.conf"; cp "$NGX_CONF" "$NGX_BAK"
cat > "$NGX_CONF" <<EOF
# Создано Sepia/deploy-racelive.sh. Статика-заглушка в бэкапе: $NGX_BAK
server { listen 80; server_name $DOMAIN;
  location /.well-known/acme-challenge/ { root $WEBROOT; }
  location / { return 301 https://\$host\$request_uri; } }
server { listen 127.0.0.1:$STUB_PORT ssl http2$PP; server_name $DOMAIN;
  ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  $REALIP
$LOCS
}$PUB443
EOF
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
  ok "nginx переключён на RaceLive."
else
  cp "$NGX_BAK" "$NGX_CONF"
  nginx -t 2>&1 | tail -5
  err "nginx -t не прошёл — вернул статику. Конфиг с ошибкой не применён."
fi

### 8. Итоги
cat <<EOF

========================================================================
 RaceLive работает за Reality: https://$DOMAIN
------------------------------------------------------------------------
  код и .env       : $APP_DIR   (секреты в .env, права 600)
  статус           : cd $APP_DIR && docker compose ps
  логи             : cd $APP_DIR && docker compose logs -f web api
  обновить сайт    : cd $APP_DIR && git pull && docker compose up -d --build
  вернуть статику  : cp $NGX_BAK $NGX_CONF && nginx -t && systemctl reload nginx
$( [ "$PROXY_PROTOCOL" = 1 ] && echo "  !!! PROXY_PROTOCOL=1: в Config Profile ноды поставь xver: 1, иначе сайт сломается" )
  проверка снаружи : curl -sI https://$DOMAIN | head -3
========================================================================
EOF
ok "Готово."
