#!/usr/bin/env bash
#
# tune-kernel.sh — тюнинг ядра Linux для нод Remnawave (Xray).
#
#   - BBR + qdisc (cake по умолчанию; QDISC=fq — лёгкая альтернатива)
#   - буферы, очереди, TIME_WAIT, conntrack под тысячи соединений
#   - hardening: анти-спуфинг, ICMP, ptrace, ASLR
#   - IPv6 off (NO_IPV6=0 — оставить включённым)
#   - swap-файл SWAP_SIZE (1G), если свопа нет; swappiness=10
#   - nofile для контейнеров Docker (default-ulimits в /etc/docker/daemon.json)
#
# Пишет в отдельные файлы (/etc/sysctl.d/99-rw-node.conf и т.п.), основной
# /etc/sysctl.conf не трогает. Повторный запуск безопасен (идемпотентен).
# Бэкапы того, что меняется: /root/rw-tune-backup/<дата>/
#
# НЕ для сервера ПАНЕЛИ: там Docker-бриджи, им нужен ip_forward (скрипт это проверяет).
#
# Запуск:
#   sudo bash tune-kernel.sh
#   sudo QDISC=fq NO_IPV6=0 SWAP_SIZE=2G bash tune-kernel.sh
#
set -euo pipefail

QDISC="${QDISC:-cake}"
NO_IPV6="${NO_IPV6:-1}"
SWAP_SIZE="${SWAP_SIZE:-1G}"
NOFILE="${NOFILE:-1048576}"
FORCE="${FORCE:-0}"
SYSCTL_CONF=/etc/sysctl.d/99-rw-node.conf
MODULES_CONF=/etc/modules-load.d/rw-node.conf
DAEMON_JSON=/etc/docker/daemon.json
BACKUP_DIR="/root/rw-tune-backup/$(date +%Y%m%d-%H%M%S)"

log(){  printf '\033[1;36m[*]\033[0m %s\n' "$*"; }
ok(){   printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
err(){  printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || err "Запусти от root:  sudo bash tune-kernel.sh"
case "$QDISC" in cake|fq) ;; *) err "QDISC должен быть cake или fq (сейчас: $QDISC)" ;; esac
command -v tc >/dev/null 2>&1 || err "Нет утилиты tc (пакет iproute2)."

HAVE_DOCKER=0
command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && HAVE_DOCKER=1

### 0. Защита от запуска на панели
if [ "$HAVE_DOCKER" = 1 ] && docker ps --format '{{.Image}}' | grep -q 'remnawave/backend'; then
  [ "$FORCE" = 1 ] || err "Похоже, это сервер ПАНЕЛИ (контейнер remnawave/backend). Скрипт для нод. Если точно надо — FORCE=1."
fi
mkdir -p "$BACKUP_DIR"

### 1. Модули ядра (bbr, conntrack, cake) + автозагрузка
log "Модули ядра..."
modprobe tcp_bbr || err "Модуль tcp_bbr недоступен (ядро старше 4.9?) — BBR не включить."
modprobe nf_conntrack 2>/dev/null || warn "nf_conntrack не загрузился — conntrack_max пропущу."
if [ "$QDISC" = cake ] && ! modprobe sch_cake 2>/dev/null; then
  log "sch_cake нет в ядре — ставлю linux-modules-extra-$(uname -r)..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y "linux-modules-extra-$(uname -r)" >/dev/null 2>&1 || true
  if ! modprobe sch_cake 2>/dev/null; then
    warn "cake на этом ядре недоступен — переключаюсь на fq."
    QDISC=fq
  fi
fi
printf 'tcp_bbr\nnf_conntrack\n' > "$MODULES_CONF"
if [ "$QDISC" = cake ]; then echo sch_cake >> "$MODULES_CONF"; fi
ok "BBR, conntrack$([ "$QDISC" = cake ] && echo ', cake') загружены и в автозагрузке."

### 2. ip_forward: 0 только если нет контейнеров в bridge-сети
FWD=0
if [ "$HAVE_DOCKER" = 1 ]; then
  BRIDGED="$(docker ps -q | xargs -r docker inspect -f '{{.Name}} {{.HostConfig.NetworkMode}}' 2>/dev/null \
            | awk '$2!="host" && $2!="none" {sub("^/","",$1); printf "%s ", $1}')"
  if [ -n "$BRIDGED" ]; then
    FWD=1
    warn "Контейнеры в bridge-сети: ${BRIDGED}— им нужен forwarding, оставляю ip_forward=1."
  fi
fi

### 3. IPv6 off -> убрать listen [::] из nginx, иначе nginx может не подняться
if [ "$NO_IPV6" = 1 ] && [ -d /etc/nginx ]; then
  NGX_FILES="$(grep -rlE 'listen[[:space:]]+\[::\]' /etc/nginx 2>/dev/null | xargs -r -n1 readlink -f | sort -u || true)"
  if [ -n "$NGX_FILES" ]; then
    log "nginx: убираю IPv6-listen..."
    for f in $NGX_FILES; do
      cp "$f" "$BACKUP_DIR/nginx-$(basename "$f")"
      sed -i -E 's/listen[[:space:]]+\[::\][^;]*;[[:space:]]*//g' "$f"
    done
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx 2>/dev/null || true
      ok "nginx: IPv6-listen убраны, конфиг валиден."
    else
      warn "nginx -t ругается после правки — откатываю nginx-файлы."
      for f in $NGX_FILES; do cp "$BACKUP_DIR/nginx-$(basename "$f")" "$f"; done
    fi
  fi
fi

### 4. sysctl
log "Пишу $SYSCTL_CONF ..."
[ -f "$SYSCTL_CONF" ] && cp "$SYSCTL_CONF" "$BACKUP_DIR/"
if [ "$NO_IPV6" = 1 ]; then V6=1; else V6=0; fi
CT_LINE="# nf_conntrack не загружен — conntrack_max не задан"
[ -f /proc/sys/net/netfilter/nf_conntrack_max ] && CT_LINE="net.netfilter.nf_conntrack_max = 262144"

cat > "$SYSCTL_CONF" <<EOF
# Managed by Sepia/tune-kernel.sh — не правь руками, перезапусти скрипт.

### IPv6
net.ipv6.conf.all.disable_ipv6 = $V6
net.ipv6.conf.default.disable_ipv6 = $V6
net.ipv6.conf.lo.disable_ipv6 = $V6

### IPv4: маршрутизация и анти-спуфинг
net.ipv4.ip_forward = $FWD
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.log_martians = 1
net.ipv4.conf.default.log_martians = 1

### ICMP
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ratelimit = 100
net.ipv4.icmp_ratemask = 88089
net.ipv4.icmp_ignore_bogus_error_responses = 1

### TCP: защита и оптимизация
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_timestamps = 1
net.ipv4.tcp_fin_timeout = 20
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.tcp_max_tw_buckets = 262144
net.ipv4.tcp_ecn = 2
net.ipv4.tcp_sack = 1
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 60
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

### Очереди и буферы ядра
net.core.somaxconn = 4096
net.core.netdev_max_backlog = 5000
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216

### BBR + qdisc
net.core.default_qdisc = $QDISC
net.ipv4.tcp_congestion_control = bbr

### conntrack
$CT_LINE

### Hardening ядра
kernel.yama.ptrace_scope = 1
kernel.randomize_va_space = 2
fs.suid_dumpable = 0

### Файлы и память
fs.file-max = 2097152
vm.swappiness = 10
EOF

SYSERR="$BACKUP_DIR/sysctl.err"
sysctl -p "$SYSCTL_CONF" >/dev/null 2>"$SYSERR" || true
if [ -s "$SYSERR" ]; then warn "sysctl пожаловался на часть ключей (остальное применено):"; sed 's/^/      /' "$SYSERR"
else ok "sysctl применён без ошибок."; fi

### 5. qdisc на основном интерфейсе: сейчас + после перезагрузки
IFACE="$(ip -o route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')"
TC_BIN="$(command -v tc)"
if [ -n "$IFACE" ]; then
  if tc qdisc replace dev "$IFACE" root "$QDISC" 2>/dev/null; then ok "qdisc $QDISC повешен на $IFACE."
  else warn "Не удалось повесить $QDISC на $IFACE — применится после перезагрузки (default_qdisc)."; fi
  cat > /etc/systemd/system/rw-qdisc.service <<EOF
[Unit]
Description=RW node: root qdisc $QDISC on $IFACE
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$TC_BIN qdisc replace dev $IFACE root $QDISC
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable rw-qdisc.service >/dev/null 2>&1 || true
else
  warn "Не нашёл интерфейс с default-маршрутом — qdisc применится только через default_qdisc после перезагрузки."
fi

### 6. swap
if swapon --show --noheadings 2>/dev/null | grep -q .; then
  ok "swap уже есть — не трогаю."
else
  NEED_MB=$(( $(numfmt --from=iec "$SWAP_SIZE") / 1048576 ))
  AVAIL_MB="$(df -Pm / | awk 'NR==2{print $4}')"
  if [ "$AVAIL_MB" -lt $(( NEED_MB + 1024 )) ]; then
    warn "Мало места на / (${AVAIL_MB} МБ) — swap $SWAP_SIZE не создаю."
  else
    log "Создаю swap $SWAP_SIZE..."
    rm -f /swapfile
    if ! { fallocate -l "$SWAP_SIZE" /swapfile 2>/dev/null && chmod 600 /swapfile \
           && mkswap /swapfile >/dev/null 2>&1 && swapon /swapfile 2>/dev/null; }; then
      rm -f /swapfile
      { dd if=/dev/zero of=/swapfile bs=1M count="$NEED_MB" status=none && chmod 600 /swapfile \
        && mkswap /swapfile >/dev/null 2>&1 && swapon /swapfile 2>/dev/null; } \
        || { rm -f /swapfile; warn "swap поднять не удалось (OpenVZ/LXC?) — пропускаю."; }
    fi
    if swapon --show --noheadings 2>/dev/null | grep -q '^/swapfile'; then
      grep -qE '^/swapfile[[:space:]]' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
      ok "swap $SWAP_SIZE включён и прописан в fstab."
    fi
  fi
fi

### 7. nofile для контейнеров (default-ulimits в daemon.json)
NOFILE_RES=skip
if ! command -v python3 >/dev/null 2>&1; then
  warn "Нет python3 — nofile в daemon.json не выставляю."
else
  [ -f "$DAEMON_JSON" ] && cp "$DAEMON_JSON" "$BACKUP_DIR/"
  NOFILE_RES="$(python3 - "$NOFILE" "$DAEMON_JSON" <<'PY'
import json, os, sys
n, path = int(sys.argv[1]), sys.argv[2]
data = {}
if os.path.exists(path):
    raw = open(path).read().strip()
    data = json.loads(raw) if raw else {}
new = {"Name": "nofile", "Soft": n, "Hard": n}
if data.get("default-ulimits", {}).get("nofile") == new:
    print("same")
else:
    data.setdefault("default-ulimits", {})["nofile"] = new
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(json.dumps(data, indent=2) + "\n")
    print("changed")
PY
)" || { warn "$DAEMON_JSON не разобрался как JSON — nofile пропускаю (файл не тронут)."; NOFILE_RES=skip; }
  case "$NOFILE_RES" in
    same)    ok "nofile=$NOFILE для контейнеров уже стоит." ;;
    changed) ok "nofile=$NOFILE записан в $DAEMON_JSON." ;;
  esac
fi

if [ "$NOFILE_RES" = changed ] && systemctl is-active --quiet docker 2>/dev/null; then
  RUNNING="$(docker ps -q | wc -l)"
  DO=y
  if [ "$RUNNING" -gt 0 ]; then
    warn "Чтобы лимит применился, нужен перезапуск docker — контейнеры ($RUNNING шт., в т.ч. remnanode) моргнут на пару секунд."
    DO=n
    if [ -t 0 ]; then read -r -t 60 -p "Перезапустить docker сейчас? [y/N]: " DO || DO=n; fi
  fi
  case "$DO" in
    y|Y|yes) systemctl restart docker && ok "docker перезапущен." ;;
    *)       warn "docker НЕ перезапущен — сделай позже: systemctl restart docker" ;;
  esac
fi

### 8. Проверка
echo
log "Проверка:"
echo "    congestion control : $(sysctl -n net.ipv4.tcp_congestion_control)"
echo "    default_qdisc      : $(sysctl -n net.core.default_qdisc)"
[ -n "$IFACE" ] && echo "    qdisc на $IFACE : $(tc qdisc show dev "$IFACE" | head -1)"
echo "    ip_forward         : $(sysctl -n net.ipv4.ip_forward)  (в конфиге: $FWD; docker при старте может включить сам — это ок)"
echo "    IPv6 disabled      : $(sysctl -n net.ipv6.conf.all.disable_ipv6 2>/dev/null || echo n/a)"
echo "    swap               : $(free -m | awk '/^Swap/{print $2" МБ"}')   swappiness=$(sysctl -n vm.swappiness)"
echo "    conntrack_max      : $(sysctl -n net.netfilter.nf_conntrack_max 2>/dev/null || echo n/a)"
if [ "$HAVE_DOCKER" = 1 ]; then
  for c in $(docker ps --format '{{.Names}}'); do
    echo "    ulimit -n [$c]   : $(docker exec "$c" sh -c 'ulimit -n' 2>/dev/null || echo '?')"
  done
  echo "    (если у remnanode всё ещё 1024 — пересоздай контейнер: docker compose up -d --force-recreate)"
fi
echo "    бэкапы             : $BACKUP_DIR"
ok "Тюнинг завершён."
