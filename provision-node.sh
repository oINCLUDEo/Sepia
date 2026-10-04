#!/usr/bin/env bash
#
# provision-node.sh — подъём/закалка VLESS+Reality ноды (Remnawave).
# Интерактивный: запусти без аргументов — спросит режим, домен и прочее.
# Любой параметр можно задать через env, тогда вопрос не задаётся.
#
# РЕЖИМЫ:
#   1  standalone selfsteal — Reality на 443, свой сайт-заглушка + LE-серт.      (grade, shade)
#   2  межнодовый мост      — Reality на нестандартном порту ТОЛЬКО с IP входа,   (rus-dc)
#                             на публичном 443 сайт-заглушка.
#   3  вход x5-маска        — Reality на 443 целится во внешний домен (ads.x5.ru),(RU-TW)
#                             без nginx/серта. Только фаервол + ключи (закалка).
#
# Во всех режимах: закрывает NODE_PORT (кроме IP панели), SSH (кроме ADMIN_IP),
# остальное -> RST. Авто-откат фаервола через 120с, если потеряешь SSH.
# remnanode НЕ ставит.
#
# Примеры:
#   sudo bash provision-node.sh
#   sudo MODE=1 DOMAIN=grade.ulya.space bash provision-node.sh
#   sudo MODE=2 DOMAIN=rus-dc.ulya.space REALITY_PORT=8443 PREV_NODE_IP=188.225.57.108 bash provision-node.sh
#   sudo MODE=3 MASK_DOMAIN=ads.x5.ru bash provision-node.sh
#
set -euo pipefail

### дефолты (env-overridable) ###
EMAIL="${EMAIL:-ulya-tech@yandex.com}"
PANEL_IP="${PANEL_IP:-51.89.110.208}"
ADMIN_IP="${ADMIN_IP:-95.104.206.188}"
NODE_PORT="${NODE_PORT:-2222}"
STUB_PORT="${STUB_PORT:-8081}"
SSH_PORT="${SSH_PORT:-22}"
# заполняются интерактивно или через env:
MODE="${MODE:-}"
DOMAIN="${DOMAIN:-}"
MASK_DOMAIN="${MASK_DOMAIN:-}"
REALITY_PORT="${REALITY_PORT:-}"
PREV_NODE_IP="${PREV_NODE_IP:-}"
WEBROOT="/var/www/certbot"
DECOY="/var/www/decoy"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log(){  printf '\033[1;36m[*]\033[0m %s\n' "$*"; }
ok(){   printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
err(){  printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# ask VARNAME "подсказка" ["дефолт"] — спрашивает, только если переменная пуста
ask(){ local var="$1" prompt="$2" def="${3:-}" val; [ -n "${!var:-}" ] && return
  if [ -n "$def" ]; then read -r -p "    $prompt [$def]: " val; val="${val:-$def}"
  else read -r -p "    $prompt: " val; fi
  printf -v "$var" '%s' "$val"; }

[ "$(id -u)" -eq 0 ] || err "Запусти от root:  sudo bash provision-node.sh"

### выбор режима ###
if [ -z "$MODE" ]; then
  echo "Выбери режим ноды:"
  echo "  1) standalone selfsteal  — свой сайт на 443 (grade/shade)"
  echo "  2) межнодовый мост       — Reality на нестанд. порту с IP входа (rus-dc)"
  echo "  3) вход x5-маска         — Reality 443 -> внешний домен, без серта (RU-TW)"
  ask MODE "Режим (1/2/3)"
fi
case "$MODE" in 1|2|3) ;; *) err "Неизвестный режим: $MODE" ;; esac

ask ADMIN_IP "Твой IP для SSH" "$ADMIN_IP"

if [ "$MODE" = 3 ]; then
  ask MASK_DOMAIN "Домен-маска (serverNames/target, напр. ads.x5.ru)" "ads.x5.ru"
  REALITY_PORT=443
else
  ask DOMAIN "Домен ноды (= SNI, напр. grade.ulya.space)"
  [ -n "$DOMAIN" ] || err "Домен обязателен для режимов 1/2."
fi
if [ "$MODE" = 2 ]; then
  ask REALITY_PORT "Порт Reality (нестандартный)" "8443"
  ask PREV_NODE_IP "IP предыдущего узла (кому открыт $REALITY_PORT)"
  [ -n "$PREV_NODE_IP" ] || err "Для моста нужен PREV_NODE_IP."
fi
[ "$MODE" = 1 ] && REALITY_PORT=443

log "Режим=$MODE  Reality-порт=$REALITY_PORT  Панель=$PANEL_IP  SSH-с=$ADMIN_IP"

### 1. Пакеты ###
log "Устанавливаю пакеты..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
PKGS="nftables curl openssl ca-certificates"
[ "$MODE" != 3 ] && PKGS="$PKGS nginx certbot dnsutils"
apt-get install -y $PKGS

### 2-6. Сайт/серт/nginx — только режимы 1 и 2 ###
if [ "$MODE" != 3 ]; then
  RESOLVED="$(dig +short A "$DOMAIN" | tail -1 || true)"
  MYIP="$(curl -fsS4 https://api.ipify.org 2>/dev/null || true)"
  log "A($DOMAIN)=${RESOLVED:-<нет>}   этот сервер=${MYIP:-<?>}"
  [ -n "$RESOLVED" ] && [ -n "$MYIP" ] && [ "$RESOLVED" != "$MYIP" ] && \
    warn "A-запись НЕ указывает на этот сервер — серт не выпустится."

  log "Разворачиваю decoy-сайт..."
  mkdir -p "$DECOY" "$WEBROOT"
  if [ -d "$SCRIPT_DIR/site" ]; then cp -rT "$SCRIPT_DIR/site" "$DECOY"; ok "Сайт из $SCRIPT_DIR/site"
  else warn "site/ не найдена — минимальная заглушка."
    printf '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Сепия</title></head><body><h1>Сепия</h1></body></html>\n' > "$DECOY/index.html"; fi
  grep -rl 'your-domain\.com' "$DECOY" 2>/dev/null | xargs -r sed -i "s/your-domain\.com/$DOMAIN/g"
  chown -R www-data:www-data "$DECOY" 2>/dev/null || true

  log "nginx: фаза 1 (ACME/redirect на :80)..."
  cat > /etc/nginx/sites-available/decoy.conf <<EOF
server { listen 80; listen [::]:80; server_name $DOMAIN;
  location /.well-known/acme-challenge/ { root $WEBROOT; }
  location / { return 301 https://\$host\$request_uri; } }
EOF
  ln -sf /etc/nginx/sites-available/decoy.conf /etc/nginx/sites-enabled/decoy.conf
  rm -f /etc/nginx/sites-enabled/default
  nginx -t; systemctl enable nginx >/dev/null 2>&1 || true; systemctl restart nginx

  if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    log "Выпускаю серт Let's Encrypt для $DOMAIN ..."
    certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --agree-tos -m "$EMAIL" -n \
      || err "certbot не смог. Проверь A-запись -> этот IP, порт 80, DNS-only."
    ok "Серт выпущен."
  else ok "Серт уже есть — пропускаю."; fi

  PUB443=""
  [ "$MODE" = 2 ] && PUB443="
server { listen 443 ssl http2; listen [::]:443 ssl http2; server_name $DOMAIN;
  ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  root $DECOY; index index.html;
  error_page 404 /404.html; location = /404.html { internal; }
  location / { try_files \$uri \$uri/ =404; } }"
  log "nginx: фаза 2 (заглушка 127.0.0.1:$STUB_PORT$([ "$MODE" = 2 ] && echo ' + публичный 443'))..."
  cat > /etc/nginx/sites-available/decoy.conf <<EOF
server { listen 80; listen [::]:80; server_name $DOMAIN;
  location /.well-known/acme-challenge/ { root $WEBROOT; }
  location / { return 301 https://\$host\$request_uri; } }
server { listen 127.0.0.1:$STUB_PORT ssl http2; server_name $DOMAIN;
  ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  root $DECOY; index index.html;
  error_page 404 /404.html; location = /404.html { internal; }
  location / { try_files \$uri \$uri/ =404; } }$PUB443
EOF
  nginx -t; systemctl reload nginx; ok "nginx готов."
fi

### 7. Ключи Reality ###
log "Генерирую X25519 + shortId..."
TMPK="$(mktemp)"; openssl genpkey -algorithm X25519 -out "$TMPK" 2>/dev/null
b64url(){ base64 | tr '+/' '-_' | tr -d '='; }
PRIV="$(openssl pkey -in "$TMPK" -outform DER 2>/dev/null | tail -c 32 | b64url)"
PUB="$(openssl pkey -in "$TMPK" -pubout -outform DER 2>/dev/null | tail -c 32 | b64url)"
rm -f "$TMPK"; SHORTID="$(openssl rand -hex 8)"

### 8. nftables (с авто-откатом) ###
log "Готовлю nftables..."
[ -f /etc/nftables.conf ] && cp -f /etc/nftables.conf "/etc/nftables.conf.bak.$(date +%s)"
if [ "$MODE" = 3 ]; then OPEN_TCP="443"; else OPEN_TCP="80, 443"; fi
BRIDGE_RULE=""
[ "$MODE" = 2 ] && BRIDGE_RULE="    tcp dport $REALITY_PORT ip saddr $PREV_NODE_IP accept         # Reality только с входа"
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
    tcp dport { $OPEN_TCP } accept
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
if [ "${ANS:-}" = "yes" ]; then touch /tmp/fw_ok; kill "$RB" 2>/dev/null || true
  systemctl enable --now nftables >/dev/null 2>&1 || true; ok "Фаервол закреплён."
else warn "Не подтверждено — правила откатятся (nft flush) по таймеру. Проверь ADMIN_IP и запусти снова."; fi

### 9. Итоги ###
if [ "$MODE" = 3 ]; then SN="$MASK_DOMAIN"; TGT="$MASK_DOMAIN:443"; else SN="$DOMAIN"; TGT="127.0.0.1:$STUB_PORT"; fi
cat <<EOF

========================================================================
 ГОТОВО (режим $MODE). Данные для Config Profile в Remnawave:
------------------------------------------------------------------------
  port         : $REALITY_PORT
  security     : reality   network: $([ "$MODE" = 3 ] && echo 'raw или grpc (в панели)' || echo raw)   flow: xtls-rprx-vision
  target       : $TGT
  serverNames  : ["$SN"]
  privateKey   : $PRIV
  publicKey    : $PUB
  shortIds     : ["$SHORTID"]
$([ "$MODE" = 2 ] && echo "  Доступ к $REALITY_PORT — ТОЛЬКО с $PREV_NODE_IP")
$([ "$MODE" = 3 ] && echo "  (нода уже в панели? ключи выше ИГНОРИРУЙ — фаервол главное)")
------------------------------------------------------------------------
 Проверка снаружи:
  nmap -Pn -p $SSH_PORT,80,443,$REALITY_PORT,$NODE_PORT <THIS_IP>
$([ "$MODE" != 3 ] && echo "  curl -skI https://$DOMAIN | head -5")
========================================================================
EOF
ok "Скрипт завершён."
