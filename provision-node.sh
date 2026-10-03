#!/usr/bin/env bash
#
# provision-node.sh — подъём VLESS+Reality selfsteal-ноды (Remnawave).
#
# Ставит и настраивает ВСЁ, кроме самого remnanode:
#   - nginx-заглушку (decoy «Сепия») + сертификат Let's Encrypt (HTTP-01 webroot)
#   - nftables-фаервол (наружу только 80/443; NODE_PORT только с панели;
#     SSH только с ADMIN_IP; остальное -> RST) с безопасным авто-откатом
#   - генерацию ключей X25519 + shortId для вставки в панель
#
# ДВА РЕЖИМА:
#   STANDALONE (по умолчанию, REALITY_PORT=443):
#     Reality слушает 443 (настраивается в панели), nginx — только fallback на 127.0.0.1:8081.
#   МЕЖНОДОВЫЙ/МОСТ (REALITY_PORT!=443, напр. 8443, + PREV_NODE_IP):
#     Reality слушает нестандартный порт, открытый ТОЛЬКО с IP предыдущего узла;
#     на публичном 443 nginx отдаёт сайт-заглушку (маскировка при прямом скане).
#
# Примеры:
#   sudo DOMAIN=grade.ulya.space ./provision-node.sh
#   sudo DOMAIN=rus-dc.ulya.space REALITY_PORT=8443 PREV_NODE_IP=188.225.57.108 ./provision-node.sh
#
set -euo pipefail

### ===================== КОНФИГ (переопределяется через env) =====================
DOMAIN="${DOMAIN:-}"                           # ОБЯЗАТЕЛЬНО: домен ноды (= SNI)
EMAIL="${EMAIL:-ulya-tech@yandex.com}"         # e-mail для Let's Encrypt
PANEL_IP="${PANEL_IP:-51.89.110.208}"          # IP панели Remnawave (доступ к NODE_PORT)
ADMIN_IP="${ADMIN_IP:-95.104.206.188}"         # твой IP для SSH (динамический — обнови при смене!)
NODE_PORT="${NODE_PORT:-2222}"                 # control-порт remnanode (панель -> нода)
STUB_PORT="${STUB_PORT:-8081}"                 # локальный порт nginx-заглушки (Reality target)
SSH_PORT="${SSH_PORT:-22}"
REALITY_PORT="${REALITY_PORT:-443}"            # порт Reality-инбаунда: 443=standalone, иное=межнодовый мост
PREV_NODE_IP="${PREV_NODE_IP:-}"               # межнодовый режим: IP предыдущего узла (кому открыт REALITY_PORT)
WEBROOT="/var/www/certbot"
DECOY="/var/www/decoy"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
### ==============================================================================

log(){  printf '\033[1;36m[*]\033[0m %s\n' "$*"; }
ok(){   printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
err(){  printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || err "Запусти от root:  sudo DOMAIN=... ./provision-node.sh"
[ -n "$DOMAIN" ]     || err "Не задан DOMAIN. Пример:  sudo DOMAIN=grade.ulya.space ./provision-node.sh"

BRIDGE=0
if [ "$REALITY_PORT" != "443" ]; then
  BRIDGE=1
  [ -n "$PREV_NODE_IP" ] || err "Межнодовый режим (REALITY_PORT=$REALITY_PORT) требует PREV_NODE_IP=<IP предыдущего узла>."
  log "Режим: МЕЖНОДОВЫЙ. Reality на $REALITY_PORT только с $PREV_NODE_IP; публичный 443 = сайт-заглушка."
else
  log "Режим: STANDALONE. Reality на 443 (в панели), nginx — fallback на 127.0.0.1:$STUB_PORT."
fi
log "Домен=$DOMAIN  Панель=$PANEL_IP  SSH-с=$ADMIN_IP  NODE_PORT=$NODE_PORT"

### 1. Пакеты
log "Устанавливаю пакеты..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx certbot nftables curl dnsutils openssl ca-certificates

### 2. Проверка DNS
RESOLVED="$(dig +short A "$DOMAIN" | tail -1 || true)"
MYIP="$(curl -fsS4 https://api.ipify.org 2>/dev/null || true)"
log "A($DOMAIN)=${RESOLVED:-<нет>}   этот сервер=${MYIP:-<?>}"
if [ -n "$RESOLVED" ] && [ -n "$MYIP" ] && [ "$RESOLVED" != "$MYIP" ]; then
  warn "A-запись НЕ указывает на этот сервер — Let's Encrypt не выпустит серт (reg.ru, DNS-only)."
fi

### 3. Decoy-сайт
log "Разворачиваю decoy-сайт в $DECOY ..."
mkdir -p "$DECOY" "$WEBROOT"
if [ -d "$SCRIPT_DIR/site" ]; then
  cp -rT "$SCRIPT_DIR/site" "$DECOY"; ok "Сайт скопирован из $SCRIPT_DIR/site"
else
  warn "Папка site/ не найдена — ставлю минимальную заглушку."
  printf '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Сепия</title></head><body><h1>Сепия</h1><p>Цветокоррекция видео в браузере.</p></body></html>\n' > "$DECOY/index.html"
fi
grep -rl 'your-domain\.com' "$DECOY" 2>/dev/null | xargs -r sed -i "s/your-domain\.com/$DOMAIN/g"
chown -R www-data:www-data "$DECOY" 2>/dev/null || true

### 4. nginx — фаза 1: только :80 (ACME + redirect)
log "nginx: фаза 1 (ACME/redirect на :80)..."
cat > /etc/nginx/sites-available/decoy.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 301 https://\$host\$request_uri; }
}
EOF
ln -sf /etc/nginx/sites-available/decoy.conf /etc/nginx/sites-enabled/decoy.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t; systemctl enable nginx >/dev/null 2>&1 || true; systemctl restart nginx

### 5. Сертификат (HTTP-01 webroot)
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  log "Выпускаю сертификат Let's Encrypt для $DOMAIN ..."
  certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --agree-tos -m "$EMAIL" -n \
    || err "certbot не смог выпустить серт. Проверь: A-запись -> этот IP, порт 80 открыт, домен DNS-only."
  ok "Серт выпущен."
else
  ok "Серт уже существует — пропускаю."
fi

### 6. nginx — фаза 2: ssl-заглушка (+ публичный 443 в межнодовом режиме)
PUB443=""
if [ "$BRIDGE" -eq 1 ]; then
  PUB443="
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security \"max-age=31536000\" always;
    root $DECOY; index index.html;
    error_page 404 /404.html; location = /404.html { internal; }
    location / { try_files \$uri \$uri/ =404; }
}"
fi
log "nginx: фаза 2 (заглушка 127.0.0.1:$STUB_PORT; публичный 443: $([ "$BRIDGE" -eq 1 ] && echo да || echo нет))..."
cat > /etc/nginx/sites-available/decoy.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 301 https://\$host\$request_uri; }
}
server {
    listen 127.0.0.1:$STUB_PORT ssl http2;
    server_name $DOMAIN;
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=31536000" always;
    root $DECOY; index index.html;
    error_page 404 /404.html; location = /404.html { internal; }
    location / { try_files \$uri \$uri/ =404; }
}$PUB443
EOF
nginx -t; systemctl reload nginx
ok "nginx готов."

### 7. Ключи Reality (openssl, без установки xray)
log "Генерирую X25519 + shortId..."
TMPK="$(mktemp)"; openssl genpkey -algorithm X25519 -out "$TMPK" 2>/dev/null
b64url(){ base64 | tr '+/' '-_' | tr -d '='; }
PRIV="$(openssl pkey -in "$TMPK" -outform DER 2>/dev/null | tail -c 32 | b64url)"
PUB="$(openssl pkey -in "$TMPK" -pubout -outform DER 2>/dev/null | tail -c 32 | b64url)"
rm -f "$TMPK"; SHORTID="$(openssl rand -hex 8)"

### 8. nftables — с безопасным авто-откатом
log "Готовлю nftables..."
[ -f /etc/nftables.conf ] && cp -f /etc/nftables.conf "/etc/nftables.conf.bak.$(date +%s)"
BRIDGE_RULE=""
[ "$BRIDGE" -eq 1 ] && BRIDGE_RULE="    tcp dport $REALITY_PORT ip saddr $PREV_NODE_IP accept         # Reality только с предыдущего узла"
cat > /etc/nftables.conf <<EOF
#!/usr/sbin/nft -f
flush ruleset
table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;

    ct state established,related accept
    iif "lo" accept
    ct state invalid drop
    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept

    tcp dport $SSH_PORT ip saddr $ADMIN_IP accept          # SSH только с твоего IP
    tcp dport { 80, 443 } accept                           # сайт / ACME / Reality(443 в standalone)
$BRIDGE_RULE
    tcp dport $NODE_PORT ip saddr $PANEL_IP accept         # remnanode только с панели

    meta l4proto tcp reject with tcp reset                 # прочий TCP -> RST
  }
  chain forward { type filter hook forward priority 0; policy drop; }
  chain output  { type filter hook output priority 0; policy accept; }
}
EOF

rm -f /tmp/fw_ok
log "Применяю фаервол. Если потеряешь SSH — он сам откатится через 120с."
( sleep 120; [ -f /tmp/fw_ok ] || nft flush ruleset ) & RB=$!
nft -f /etc/nftables.conf
warn "ОТКРОЙ НОВЫЙ SSH-СЕАНС и проверь, что заходит (старый не закрывай!)."
ANS=""; read -r -t 110 -p "SSH в новом окне работает? введи 'yes' для закрепления: " ANS || true
if [ "${ANS:-}" = "yes" ]; then
  touch /tmp/fw_ok; kill "$RB" 2>/dev/null || true
  systemctl enable --now nftables >/dev/null 2>&1 || true
  ok "Фаервол закреплён и включён в автозагрузку."
else
  warn "Не подтверждено — правила откатятся автоматически (nft flush) по таймеру. Проверь SSH/ADMIN_IP и запусти снова."
fi

### 9. Итоги
cat <<EOF

========================================================================
 ГОТОВО. Данные для Remnawave (Config Profile -> Inbound -> Host):
------------------------------------------------------------------------
  port         : $REALITY_PORT $([ "$BRIDGE" -eq 1 ] && echo "(межнодовый; 443 = сайт-заглушка)" || echo "(standalone)")
  network      : raw        security: reality       flow: xtls-rprx-vision
  target       : 127.0.0.1:$STUB_PORT
  serverNames  : ["$DOMAIN"]
  privateKey   : $PRIV
  publicKey    : $PUB
  shortIds     : ["$SHORTID"]
  Host.address : $DOMAIN     <-- ДОМЕН, не голый IP
$([ "$BRIDGE" -eq 1 ] && echo "  Доступ к $REALITY_PORT открыт ТОЛЬКО с $PREV_NODE_IP (предыдущий узел)")
------------------------------------------------------------------------
 Дальше:
  1) Установи remnanode (NODE_PORT=$NODE_PORT, SECRET_KEY из панели).
  2) Впиши значения выше в Config Profile (inbound на порт $REALITY_PORT), привяжи Host к ноде, добавь в Squad.

 Проверка снаружи:
  curl -skI https://$DOMAIN | head -5
  nmap -Pn -p $SSH_PORT,80,443,$REALITY_PORT,$NODE_PORT <THIS_IP>
========================================================================
EOF
ok "Скрипт завершён."
