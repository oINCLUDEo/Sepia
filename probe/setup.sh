#!/usr/bin/env bash
#
# probe/setup.sh — поставить пробник для раздела «Рынок» на отдельный (пустой) сервер.
#   bash probe/setup.sh IP_ПАНЕЛИ [ПОРТ]        (повторный запуск — обновить агента и Xray, токен и сертификат остаются;
#   bash probe/setup.sh IP_ПАНЕЛИ [ПОРТ] --new   с --new — новый токен и сертификат)
#
# Ставит: Xray (последний релиз с GitHub), python3, curl; агента — в /opt/sepia-probe, службу sepia-probe (systemd,
# отдельный пользователь без прав), самоподписанный сертификат. Пускает только IP панели (в самом агенте и, если есть,
# в фаерволе nftables/ufw). В конце печатает три строки для stats/.env на сервере панели.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Запусти от root: sudo bash $0 $*"; exit 1; }
PANEL=${1:-}; PORT=${2:-8898}; NEW=0; [ "${3:-}" = --new ] || [ "${2:-}" = --new ] && NEW=1; [ "$PORT" = --new ] && PORT=8898
[[ "$PANEL" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(,[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)*$ ]] || { echo "Укажите IP сервера панели: bash $0 203.0.113.10"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
D=/etc/sepia-probe
ok(){ printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
log(){ printf '\033[1;36m[*]\033[0m %s\n' "$*"; }

log "Пакеты: python3, curl, openssl, unzip…"
export DEBIAN_FRONTEND=noninteractive
printf 'DPkg::Lock::Timeout "900";\n' > /etc/apt/apt.conf.d/90-rw-lock-wait 2>/dev/null || true
command -v python3 >/dev/null && command -v curl >/dev/null && command -v openssl >/dev/null && command -v unzip >/dev/null \
  || { apt-get update -qq && apt-get install -y -qq python3 curl openssl unzip ca-certificates >/dev/null; }

log "Xray — последний релиз с GitHub…"
case "$(uname -m)" in x86_64|amd64) A=64 ;; aarch64|arm64) A=arm64-v8a ;; *) echo "Неизвестная архитектура $(uname -m)"; exit 1 ;; esac
T=$(mktemp -d)
curl -fsSL -o "$T/x.zip" "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-$A.zip"
unzip -qo "$T/x.zip" xray -d "$T" && install -m 755 "$T/xray" /usr/local/bin/xray
rm -rf "$T"
ok "$(/usr/local/bin/xray version | head -1)"

log "Агент — /opt/sepia-probe…"
install -d -m 755 /opt/sepia-probe && install -m 644 "$HERE/agent.py" /opt/sepia-probe/agent.py
install -d -m 700 "$D"
if [ "$NEW" = 1 ] || [ ! -s "$D/probe.conf" ] || [ ! -s "$D/cert.pem" ]; then
  TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 -subj "/CN=sepia-probe" \
    -keyout "$D/key.pem" -out "$D/cert.pem" >/dev/null 2>&1
else
  TOKEN=$(sed -n 's/^TOKEN=//p' "$D/probe.conf")
fi
printf 'TOKEN=%s\nPANEL=%s\nPORT=%s\nXRAY=/usr/local/bin/xray\n' "$TOKEN" "$PANEL" "$PORT" > "$D/probe.conf"
chmod 600 "$D"/*

cat > /etc/systemd/system/sepia-probe.service <<UNIT
[Unit]
Description=sepia-probe: пробник для раздела «Рынок» дашборда Sepia
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/python3 -I /opt/sepia-probe/agent.py
EnvironmentFile=$D/probe.conf
LoadCredential=cert.pem:$D/cert.pem
LoadCredential=key.pem:$D/key.pem
DynamicUser=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now sepia-probe >/dev/null 2>&1
systemctl restart sepia-probe
sleep 1
systemctl is-active --quiet sepia-probe || { journalctl -u sepia-probe -n 20 --no-pager; echo "Служба не запустилась — журнал выше"; exit 1; }
ok "Служба sepia-probe работает на порту $PORT"

# фаервол: порт только для панели (агент и сам пускает только её — это второй замок)
if nft list chain inet filter input >/dev/null 2>&1 && grep -q 'meta l4proto tcp reject' /etc/nftables.conf 2>/dev/null; then
  for ip in ${PANEL//,/ }; do
    grep -q "dport $PORT ip saddr $ip accept" /etc/nftables.conf || sed -i "0,/meta l4proto tcp reject/s//tcp dport $PORT ip saddr $ip accept         # sepia-probe только с панели\n    meta l4proto tcp reject/" /etc/nftables.conf
  done
  nft -c -f /etc/nftables.conf && nft -f /etc/nftables.conf && ok "Фаервол Sepia: порт $PORT — только с $PANEL"
elif command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  for ip in ${PANEL//,/ }; do ufw allow from "$ip" to any port "$PORT" proto tcp >/dev/null; done; ok "ufw: порт $PORT — только с $PANEL"
else
  echo "Фаервола нет — порт $PORT открыт всем, но агент пускает только $PANEL и только с токеном."
fi

IP=$(curl -4 -s --max-time 6 https://api.ipify.org || hostname -I | awk '{print $1}')
FP=$(openssl x509 -in "$D/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f')
echo
echo "Готово. Добавьте в stats/.env на сервере панели и выполните: docker compose up -d --force-recreate setup"
echo "PROBE_URL=https://$IP:$PORT"
echo "PROBE_TOKEN=$TOKEN"
echo "PROBE_FP=$FP"
