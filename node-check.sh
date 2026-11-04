#!/usr/bin/env bash
#
# node-check.sh — проверка ноды: железо, CPU, сеть, блокировки (для РФ), как сервисы видят IP, нагрузка в пик.
#
# Без аргументов — меню. Режимы (для cron и скриптов):
#   full        разовый прогон ~3 мин (NO_IPERF=1 — без нагрузки на канал)
#   quick       снимок нагрузки ~15 с без iperf -> строка в CSV (+ в VictoriaMetrics, если настроено)
#   install     cron: quick каждые 15 минут;   uninstall — снять
#   report      средние по часам суток из CSV: пик против тишины
#   stats       настроить выгрузку в VictoriaMetrics (URL, логин, пароль, имя ноды)
#
# Нода в РФ определяется по стране IP (RU=1 / RU=0 — принудительно). Для РФ-нод full добавляет проверки
# по мотивам censorcheck: «заморозку» TLS на 16–20 КБ до зарубежных хостингов (ТСПУ), доступность
# сайтов, которые режет DPI, скорость скачивания из Европы и пинг до Европы.
#
# В отличие от multitest, чужие скрипты не качает и не запускает. Наружу уходят только метрики в
# свою VictoriaMetrics (stats/ в этом репо), если её настроить. Настройки — /etc/rw-node-check.conf.
# iperf3-серверы РФ — из списка github.com/itdoginfo/russian-iperf3-servers.
# full на ~20 с занимает CPU целиком и гонит трафик iperf3 — в пик юзеры это почувствуют.
#
set -uo pipefail   # без -e: упавший замер не должен обрывать весь отчёт
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"   # cron даёт урезанный PATH без sbin

MODE="${1:-}"
CONF=/etc/rw-node-check.conf
_env=$(declare -p STATS_URL STATS_USER STATS_PASS NODE_NAME NODE_CC NODE_IP 2>/dev/null || true)   # переменные из команды важнее конфига
# shellcheck disable=SC1090
[ -r "$CONF" ] && . "$CONF"
eval "$_env"
NO_IPERF="${NO_IPERF:-0}"
RU="${RU:-auto}"
CSV="${CSV:-/var/log/rw-node-check.csv}"
CRON=/etc/cron.d/rw-node-check
STATS_URL="${STATS_URL:-}"; STATS_USER="${STATS_USER:-writer}"; STATS_PASS="${STATS_PASS:-}"
NODE_NAME="${NODE_NAME:-$(hostname -s)}"; NODE_NAME="${NODE_NAME//[ ,=]/_}"; NODE_CC="${NODE_CC:-}"; NODE_IP="${NODE_IP:-}"
RU_PING="${RU_PING:-77.88.8.8 spd-rudp.hostkey.ru st.spb.ertelecom.ru st.nn.ertelecom.ru}"
RU_IPERF="${RU_IPERF:-spd-rudp.hostkey.ru st.spb.ertelecom.ru st.nn.ertelecom.ru}"
EU_PING="${EU_PING:-fsn1-speed.hetzner.com hel1-speed.hetzner.com proof.ovh.net}"   # не anycast: 1.1.1.1 отвечает с ближайшего узла, Европу не меряет
# файлы на зарубежных хостингах (отдают Range) — тест «заморозки» и скорости из Европы
EU_FILES="${EU_FILES:-https://fsn1-speed.hetzner.com/100MB.bin https://hel1-speed.hetzner.com/100MB.bin https://proof.ovh.net/files/10Mb.dat https://fra-de-ping.vultr.com/vultr.com.100MB.bin}"
# сайты, которые в РФ режет DPI (часть списка censorcheck)
DPI_SITES="${DPI_SITES:-youtube.com discord.com instagram.com x.com facebook.com linkedin.com rutracker.org api.telegram.org}"
BAD_CC="RU BY IR CN KP SY CU"   # страны, из которых OpenAI, Google и др. режут доступ

PROBLEMS=()
log(){  printf '\033[1;36m[*]\033[0m %s\n' "$*"; }
ok(){   printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[!]\033[0m %s\n' "$*"; PROBLEMS+=("$*"); }
bad(){  printf '\033[1;31m[x]\033[0m %s\n' "$*"; PROBLEMS+=("$*"); }
err(){  printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
hdr(){  printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

# grade VALUE GOOD BAD DIR TEXT — DIR=up: больше лучше, down: меньше лучше; VALUE "-" = замер не удался
grade(){
  local v=$1 g=$2 b=$3 d=$4; shift 4
  [ "$v" = "-" ] && { warn "$* — замер не удался"; return; }
  [ "$d" = down ] && { v=$(awk -v x="$v" 'BEGIN{print -x}'); g="-$g"; b="-$b"; }
  if   awk -v x="$v" -v t="$g" 'BEGIN{exit !(x>=t)}'; then ok "$*"
  elif awk -v x="$v" -v t="$b" 'BEGIN{exit !(x>t)}';  then warn "$*"
  else bad "$*"; fi
}

need(){  # need CMD PKG — доставить пакет, если команды нет (Debian/Ubuntu)
  command -v "$1" >/dev/null 2>&1 && return 0
  command -v apt-get >/dev/null 2>&1 || { warn "Нет $1, а apt-get недоступен — часть замеров пропущу."; return 1; }
  log "Ставлю $2..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y "$2" >/dev/null 2>&1 || { apt-get update >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y "$2" >/dev/null 2>&1; }
  command -v "$1" >/dev/null 2>&1 || { warn "Не удалось поставить $2."; return 1; }
}

detect_cc(){
  local c
  c=$(curl -4 -s --max-time 8 https://ipinfo.io/country | grep -oE '^[A-Z]{2}$') ||
    c=$(curl -4 -s --max-time 8 'http://ip-api.com/line/?fields=countryCode' | grep -oE '^[A-Z]{2}$')
  echo "${c:-}"
}
is_ru(){ case "$RU" in 1) return 0 ;; 0) return 1 ;; esac; [ -n "$NODE_CC" ] || NODE_CC=$(detect_cc); [ "$NODE_CC" = RU ]; }
detect_ip(){ curl -4 -s --max-time 8 https://api.ipify.org | grep -oE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || true; }

save_conf(){ ( umask 077; cat > "$CONF" <<EOF
# node-check.sh: выгрузка статистики и метка ноды (пишется меню / режимами stats и install)
STATS_URL='$STATS_URL'
STATS_USER='$STATS_USER'
STATS_PASS='$STATS_PASS'
NODE_NAME='$NODE_NAME'
NODE_CC='$NODE_CC'
NODE_IP='$NODE_IP'
EOF
); }

# fields k1 v1 k2 v2 ... -> "k1=v1,k2=v2"; "-" и пустые пропускаем — line protocol их не примет
fields(){ local out=""; while [ $# -ge 2 ]; do case "$2" in ""|-) ;; *) out="${out:+$out,}$1=$2" ;; esac; shift 2; done; echo "$out"; }
# push MEASUREMENT EXTRA_TAGS FIELDS — строка Influx line protocol в VictoriaMetrics (если настроено)
push(){
  [ -n "$STATS_URL" ] && [ -n "$3" ] || return 0
  if [ -z "$NODE_IP" ]; then   # IP в метке: по нему дашборд находит ноду в панели (имя и флаг из Remnawave)
    NODE_IP=$(detect_ip); [ -n "$NODE_IP" ] && [ "$MODE" = quick ] && save_conf   # старые установки: запомнить один раз
  fi
  local code   # пароль через stdin (-K -), чтобы не светился в ps
  code=$(printf 'user = "%s:%s"\n' "$STATS_USER" "$STATS_PASS" | curl -4 -s -K - --max-time 10 -o /dev/null -w '%{http_code}' \
    --data-binary "$1,node=$NODE_NAME,cc=${NODE_CC:-XX}${NODE_IP:+,ip=$NODE_IP}${2:+,$2} $3" "$STATS_URL")
  case "$code" in 2??) return 0 ;; *) printf '\033[1;33m[!]\033[0m Выгрузка в VictoriaMetrics не удалась (HTTP %s)\n' "$code" >&2; return 1 ;; esac
}

iface(){ ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}'; }
tcp_cnt(){ awk '/^Tcp:/{ if(!h){for(i=1;i<=NF;i++) k[$i]=i; h=1} else print $k["OutSegs"], $k["RetransSegs"] }' /proc/net/snmp; }
xray_pid(){ pgrep -x rw-core 2>/dev/null | head -1 || true; }
proc_ticks(){ [ -n "$1" ] && [ -r "/proc/$1/stat" ] && awk '{print $14+$15}' "/proc/$1/stat" || echo 0; }

# снимок нагрузки за N секунд -> S_US S_SY S_ST S_RX S_TX S_RETR S_CONN S_LOAD S_MEM S_CT S_XRAY
snapshot(){
  local n=${1:-10} dev rx0 tx0 rx1 tx1 o0 r0 o1 r1 p x0 x1
  dev=$(iface)
  read -r rx0 < "/sys/class/net/$dev/statistics/rx_bytes"; read -r tx0 < "/sys/class/net/$dev/statistics/tx_bytes"
  read -r o0 r0 < <(tcp_cnt); p=$(xray_pid); x0=$(proc_ticks "$p")
  # первая строка vmstat — среднее с загрузки, её пропускаем
  read -r S_US S_SY S_ST < <(vmstat 1 $((n+1)) | awk 'NR==2{for(i=1;i<=NF;i++) c[$i]=i; next} NR>3{k++; us+=$c["us"]; sy+=$c["sy"]; st+=$c["st"]} END{printf "%.0f %.0f %.0f\n", us/k, sy/k, st/k}')
  read -r rx1 < "/sys/class/net/$dev/statistics/rx_bytes"; read -r tx1 < "/sys/class/net/$dev/statistics/tx_bytes"
  read -r o1 r1 < <(tcp_cnt); x1=$(proc_ticks "$p")
  S_RX=$(awk -v a="$rx0" -v b="$rx1" -v t="$n" 'BEGIN{printf "%.1f", (b-a)*8/t/1e6}')
  S_TX=$(awk -v a="$tx0" -v b="$tx1" -v t="$n" 'BEGIN{printf "%.1f", (b-a)*8/t/1e6}')
  S_RETR=$(awk -v o=$((o1-o0)) -v r=$((r1-r0)) 'BEGIN{printf "%.2f", (o>0 ? r*100/o : 0)}')   # скобки: без них ">" в printf — перенаправление
  S_CONN=$(ss -Htn state established 2>/dev/null | wc -l)
  S_LOAD=$(cut -d' ' -f1 /proc/loadavg)
  S_MEM=$(free | awk '/^Mem:/{printf "%.0f", ($2-$7)*100/$2}')
  S_CT=-
  [ -r /proc/sys/net/netfilter/nf_conntrack_count ] && S_CT=$(awk -v c="$(cat /proc/sys/net/netfilter/nf_conntrack_count)" -v m="$(cat /proc/sys/net/netfilter/nf_conntrack_max)" 'BEGIN{printf "%.0f", c*100/m}')
  S_XRAY=-
  [ -n "$p" ] && S_XRAY=$(awk -v d=$((x1-x0)) -v hz="$(getconf CLK_TCK)" -v t="$n" 'BEGIN{printf "%.0f", d*100/hz/t}')
}

# ping_stat HOST [COUNT] -> "avg_ms mdev_ms loss_%" ("-" если не ответил)
ping_stat(){
  command -v ping >/dev/null 2>&1 || { echo "- - -"; return; }   # нет ping — не путать с потерями 100%
  ping -4 -n -q -c "${2:-10}" -i 0.3 -W 2 "$1" 2>/dev/null | awk '
    /packet loss/{for(i=1;i<=NF;i++) if($i ~ /%,?$/) l=$i+0}
    /^(rtt|round-trip)/{split($4,a,"/"); avg=a[2]; md=a[4]}
    END{if(avg=="") avg="-"; if(md=="") md="-"; if(l=="") l=100; print avg, md, l}'
}

csv_line(){
  local rtt jit loss to=ru tgt=${RU_PING%% *}
  is_ru && { to=eu; tgt=${EU_PING%% *}; }   # РФ-ноде в пик важнее плечо до Европы
  read -r rtt jit loss < <(ping_stat "$tgt" 10)
  [ -s "$CSV" ] || echo "ts,hour,cpu_us,cpu_sy,cpu_st,load1,mem_pct,conntrack_pct,conns,rx_mbps,tx_mbps,retrans_pct,rtt_ms,jitter_ms,loss_pct,xray_cpu,ping_to" > "$CSV"
  echo "$(date '+%F %T'),$(date +%H),$S_US,$S_SY,$S_ST,$S_LOAD,$S_MEM,$S_CT,$S_CONN,$S_RX,$S_TX,$S_RETR,$rtt,$jit,$loss,$S_XRAY,$to" >> "$CSV"
  push node_quick "to=$to" "$(fields cpu_us "$S_US" cpu_sy "$S_SY" cpu_st "$S_ST" load1 "$S_LOAD" mem_pct "$S_MEM" conntrack_pct "$S_CT" \
    conns "$S_CONN" rx_mbps "$S_RX" tx_mbps "$S_TX" retrans_pct "$S_RETR" rtt_ms "$rtt" jitter_ms "$jit" loss_pct "$loss" xray_cpu "$S_XRAY")"
  echo "$(date '+%F %T') CPU ${S_US}+${S_SY}% st ${S_ST}% | ↓${S_RX} ↑${S_TX} Мбит/с | conn ${S_CONN} | retr ${S_RETR}% | ${to^^} ${rtt} мс, потери ${loss}%"
}

print_snapshot(){
  grade "$S_ST" 5 15 down "CPU занят $((S_US+S_SY))% (us ${S_US} + sy ${S_SY}), steal ${S_ST}%, Xray ${S_XRAY}%, load ${S_LOAD}"
  grade "$S_RETR" 1 3 down "Трафик: от юзеров ↓${S_RX}, к юзерам ↑${S_TX} Мбит/с, соединений ${S_CONN}, ретрансмиты ${S_RETR}%"
  grade "$S_MEM" 80 92 down "Память занята ${S_MEM}%"
  [ "$S_CT" != "-" ] && grade "$S_CT" 70 90 down "conntrack заполнен на ${S_CT}%"
}

# iperf_port HOST — первый свободный порт сервера из 5201-5209
iperf_port(){ local p; for p in 5201 5202 5203 5204 5205 5206 5207 5208 5209; do timeout 8 iperf3 -4 -c "$1" -p "$p" -t 1 >/dev/null 2>&1 && { echo "$p"; return 0; }; done; return 1; }
# iperf_mbps HOST PORT [-R] — итог receiver по 4 потокам за 10 с
iperf_mbps(){ local v; v=$(timeout 30 iperf3 -4 -c "$1" -p "$2" -P 4 -t 10 -f m ${3:-} 2>/dev/null | awk '/SUM.*receiver/{print $6}'); echo "${v:--}"; }

# freeze_check URL -> "ok|freeze|slow|blocked БАЙТ": ТСПУ замораживает TLS к зарубежным хостингам после ~16–20 КБ
freeze_check(){
  local r size
  r=$(curl -4 -s -o /dev/null -r 0-65535 --max-time 8 -w '%{size_download}' "$1"); size=${r:-0}
  if   [ "$size" -ge 65536 ]; then echo "ok $size"
  elif [ "$size" -ge 10000 ] && [ "$size" -le 30000 ]; then echo "freeze $size"
  elif [ "$size" -gt 0 ]; then echo "slow $size"
  else echo "blocked 0"; fi
}
# site_check DOMAIN -> что видит РФ-нода при заходе на сайт
site_check(){
  local code rc
  code=$(curl -4 -s -o /dev/null --max-time 6 -A 'Mozilla/5.0' -w '%{http_code}' "https://$1/"); rc=$?
  case "$rc" in
    0)     if [ "${code:-0}" -lt 400 ]; then echo "ok доступен ($code)"; else echo "ok ответ $code"; fi ;;
    6)     echo "block DNS не резолвит" ;;
    7)     echo "block нет соединения (блок по IP)" ;;
    28)    echo "block таймаут (похоже на DPI)" ;;
    35|56) echo "block сброс TLS (DPI)" ;;
    *)     echo "block ошибка curl $rc" ;;
  esac
}

run_full(){
  local dev cc qdisc single multi st cores h p rtt jit loss down up best=- ip org cc_ipinfo cc_ipapi cc_cf cc_yt c u r ru=0
  local nfreeze=- nblock=- eudl=- sc=- s
  PROBLEMS=()
  need curl curl; need ping iputils-ping; need sysbench sysbench
  [ "$NO_IPERF" = 1 ] || need iperf3 iperf3
  is_ru && ru=1
  dev=$(iface); cores=$(nproc)
  printf '\033[1mnode-check: %s (%s), %s\033[0m\n' "$NODE_NAME" "${NODE_CC:-?}" "$(date '+%F %T %Z')"
  [ "$ru" = 1 ] && log "Нода в РФ — добавлю проверки блокировок и плеча до Европы."

  hdr "Система"
  log "CPU: $(awk -F': ' '/model name/{print $2; exit}' /proc/cpuinfo) × ${cores}, виртуализация: $(systemd-detect-virt 2>/dev/null || echo '?')"
  log "RAM: $(free -h | awk '/^Mem:/{print $2}'), swap: $(free -h | awk '/^Swap:/{print $2}'), ядро $(uname -r), интерфейс ${dev}"
  cc=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null); qdisc=$(tc qdisc show dev "$dev" 2>/dev/null | awk 'NR==1{print $2}')
  if [ "$cc" = bbr ]; then ok "TCP: ${cc} + ${qdisc}"; else warn "TCP: ${cc} + ${qdisc} — нет BBR, прогони tune-kernel.sh"; fi
  # sysctl disable_ipv6 бывает =1 при живом v6 на интерфейсе — смотрим на адрес
  if ip -6 addr show scope global 2>/dev/null | grep -q inet6; then log "IPv6: есть глобальный адрес (Xray должен ходить через UseIPv4)"; else log "IPv6: глобального адреса нет"; fi
  if [ -n "$(xray_pid)" ]; then ok "Xray (rw-core) запущен"; else warn "Xray (rw-core) не найден — нода не обслуживает юзеров?"; fi

  hdr "Нагрузка сейчас (10 с)"
  snapshot 10; print_snapshot

  hdr "CPU"
  single=$(sysbench cpu --threads=1 --time=10 run 2>/dev/null | awk '/events per second/{print $4}')
  grade "${single:--}" 1000 700 up "sysbench 1 поток: ${single:--} events/s (норма ≥1000)"
  # steal меряем под полной нагрузкой: в простое гипервизору нечего отбирать
  sysbench cpu --threads="$cores" --time=12 run > /tmp/node-check-sb.txt 2>&1 &
  read -r _ _ st < <(vmstat 1 11 | awk 'NR==2{for(i=1;i<=NF;i++) c[$i]=i; next} NR>3{k++; st+=$c["st"]} END{printf "0 0 %.0f\n", st/k}')
  wait
  multi=$(awk '/events per second/{print $4}' /tmp/node-check-sb.txt); rm -f /tmp/node-check-sb.txt
  grade "$st" 5 15 down "steal под нагрузкой: ${st}% (норма ≤5, >15 — хост перегружен)"
  if [ "$cores" -gt 1 ] && [ -n "$single" ] && [ -n "$multi" ]; then
    sc=$(awk -v m="$multi" -v s="$single" -v n="$cores" 'BEGIN{printf "%.0f", m*100/(s*n)}')
    grade "$sc" 80 60 up "${cores} потоков: ${multi} events/s — ${sc}% от идеала (ядра делят с соседями, если мало)"
  fi

  if [ "$ru" = 1 ]; then hdr "Пинг до Европы (20 пакетов)"; s=$EU_PING; else hdr "Пинг до РФ (20 пакетов)"; s=$RU_PING; fi
  for h in $s; do
    read -r rtt jit loss < <(ping_stat "$h" 20)
    grade "$loss" 0 2 down "${h}: ${rtt} мс, джиттер ${jit} мс, потери ${loss}%"
  done

  if [ "$NO_IPERF" != 1 ] && command -v iperf3 >/dev/null 2>&1; then
    hdr "Канал до юзеров в РФ (iperf3, 4 потока × 10 с; публичные серверы бывают заняты)"
    for h in $RU_IPERF; do
      if ! p=$(iperf_port "$h"); then warn "${h}: все порты заняты или сервер недоступен"; continue; fi
      down=$(iperf_mbps "$h" "$p"); up=$(iperf_mbps "$h" "$p" -R)
      log "${h}: нода → РФ (скачивание юзеров) ${down} Мбит/с, РФ → нода (отдача юзеров) ${up} Мбит/с"
      [ "$down" != "-" ] && best=$(awk -v a="$best" -v b="$down" 'BEGIN{print ((a=="-" || b+0>a+0) ? b : a)}')
    done
    grade "$best" 200 80 up "Лучший канал нода → РФ: ${best} Мбит/с (норма ≥200)"
  fi

  if [ "$ru" = 1 ]; then
    hdr "Блокировки (РФ): «заморозка» 16–20 КБ до зарубежных хостингов"
    nfreeze=0
    for u in $EU_FILES; do
      read -r r s < <(freeze_check "$u"); h=${u#https://}; h=${h%%/*}
      case "$r" in
        ok)      ok "${h}: 64 КБ скачались" ;;
        freeze)  bad "${h}: обрыв на ${s} байт — ТСПУ режет TLS к зарубежным хостингам (плечо РФ → Европа под угрозой)"; nfreeze=$((nfreeze+1)) ;;
        slow)    warn "${h}: за 8 с пришло только ${s} байт" ;;
        blocked) warn "${h}: недоступен" ;;
      esac
    done
    hdr "Блокировки (РФ): сайты, которые режет DPI"
    nblock=0
    for h in $DPI_SITES; do
      read -r r s < <(site_check "$h")
      if [ "$r" = ok ]; then log "${h}: ${s}"; else log "${h}: "$'\033[1;31m'"${s}"$'\033[0m'; nblock=$((nblock+1)); fi
    done
    log "Заблокировано ${nblock} из $(echo $DPI_SITES | wc -w) — для РФ это фон провайдера, ноде не мешает, если плечо до Европы цело."
    hdr "Скорость скачивания из Европы (10 с)"
    for u in $(echo $EU_FILES | cut -d' ' -f1-2); do
      s=$(curl -4 -s -o /dev/null --max-time 10 -w '%{speed_download}' "$u" | awk '{printf "%.0f", $1*8/1e6}')
      h=${u#https://}; log "${h%%/*}: ${s:-0} Мбит/с"
      eudl=$(awk -v a="$eudl" -v b="${s:-0}" 'BEGIN{print ((a=="-" || b+0>a+0) ? b : a)}')
    done
    grade "$eudl" 200 80 up "Лучшая скорость Европа → нода: ${eudl} Мбит/с (норма ≥200)"
  fi

  hdr "IP глазами баз и сервисов"
  ip=$(curl -4 -s --max-time 8 https://api.ipify.org); org=$(curl -4 -s --max-time 8 https://ipinfo.io/org)
  # только код страны: при лимите запросов базы отвечают текстом ошибки
  cc_ipinfo=$(curl -4 -s --max-time 8 https://ipinfo.io/country | grep -oE '^[A-Z]{2}$')
  cc_ipapi=$(curl -4 -s --max-time 8 'http://ip-api.com/line/?fields=countryCode' | grep -oE '^[A-Z]{2}$')
  cc_cf=$(curl -4 -s --max-time 8 https://chatgpt.com/cdn-cgi/trace | awk -F= '/^loc=/{print $2}')
  cc_yt=$(curl -4 -s --max-time 10 -A 'Mozilla/5.0' https://www.youtube.com/ | grep -oE '"GL":"[A-Z]{2}"' | head -1 | cut -d'"' -f4)
  log "IP ${ip:-?}, ${org:-?}"
  log "Страна: ipinfo ${cc_ipinfo:--}, ip-api ${cc_ipapi:--}, ChatGPT/Cloudflare ${cc_cf:--}, YouTube ${cc_yt:--}"
  c=$(printf '%s\n' "$cc_ipinfo" "$cc_ipapi" "$cc_cf" "$cc_yt" | grep -v '^$' | sort -u)
  if [ -z "$c" ]; then
    warn "Ни одна база/сервис не ответили — страну IP не определить"
  elif [ "$ru" != 1 ] && printf '%s\n' "$c" | grep -qwE "$(echo "$BAD_CC" | tr ' ' '|')"; then
    bad "Кто-то видит IP в стране из списка блокировок (${BAD_CC}) — ChatGPT/Gemini и др. могут не работать"
  elif [ "$(printf '%s\n' "$c" | grep -c .)" -gt 1 ]; then
    warn "Базы расходятся в стране IP: $(echo $c) — сервисы могут показывать разный регион"
  else
    ok "Страна везде одна: ${c}"
  fi

  hdr "Итог"
  if [ ${#PROBLEMS[@]} -eq 0 ]; then ok "Замечаний нет."; else printf ' - %s\n' "${PROBLEMS[@]}"; fi
  push node_full "" "$(fields sysbench_1t "${single:--}" sysbench_mt "${multi:--}" steal_load "$st" scaling_pct "$sc" iperf_best_mbps "$best" \
    eu_dl_mbps "$eudl" freeze_hosts "$nfreeze" dpi_blocked "$nblock" problems "${#PROBLEMS[@]}")" && [ -n "$STATS_URL" ] && ok "Итоги выгружены в VictoriaMetrics."
}

run_report(){
  [ -s "$CSV" ] || err "Нет данных в $CSV — сначала включи сбор (меню, пункт 5) и подожди сутки."
  awk -F, -v tz="$(date +%Z)" '
    NR==1{next}
    { h=$2; n[h]++; cpu[h]+=$3+$4; st[h]+=$5; conn[h]+=$9; tx[h]+=$11; retr[h]+=$12; loss[h]+=$15
      if($13!="-"){rtt[h]+=$13; rn[h]++} }
    END{
      printf "Средние по часам (время ноды, %s):\n", tz
      printf "%4s %6s %9s %7s %6s %7s %7s %8s %8s\n", "час", "замер", "↑Мбит/с", "соедин", "CPU%", "steal%", "ретр%", "RTT мс", "потери%"
      for(i=0;i<24;i++){ h=sprintf("%02d",i); if(!(h in n)) continue
        a=tx[h]/n[h]; r=(rn[h]?rtt[h]/rn[h]:-1)
        printf "%4s %6d %9.1f %7.0f %6.0f %7.1f %7.2f %8s %8.1f\n", h, n[h], a, conn[h]/n[h], cpu[h]/n[h], st[h]/n[h], retr[h]/n[h], (r<0?"-":sprintf("%.1f",r)), loss[h]/n[h]
        if(pk=="" || a>tx[pk]/n[pk]) pk=h
        if(qt=="" || a<tx[qt]/n[qt]) qt=h }
      if(pk==qt){ print "\nМало данных: нужен хотя бы день замеров."; exit }
      pr=(rn[pk]?rtt[pk]/rn[pk]:0); qr=(rn[qt]?rtt[qt]/rn[qt]:0)
      printf "\nПик %s:00 (↑%.1f Мбит/с, CPU %.0f%%) против тишины %s:00 (↑%.1f Мбит/с, CPU %.0f%%)\n", pk, tx[pk]/n[pk], cpu[pk]/n[pk], qt, tx[qt]/n[qt], cpu[qt]/n[qt]
      d=0
      if(cpu[pk]/n[pk]>80){ print "[!] CPU в пик выше 80% — ядер не хватает"; d=1 }
      if(st[pk]/n[pk]>5){ print "[!] steal в пик выше 5% — соседи по хосту отбирают CPU"; d=1 }
      if(retr[pk]/n[pk]>2){ print "[!] ретрансмиты в пик выше 2% — канал или маршрут захлёбывается"; d=1 }
      if(loss[pk]/n[pk]>1){ print "[!] потери в пик выше 1%"; d=1 }
      if(qr>0 && pr>qr*1.5+5){ printf "[!] RTT в пик %.0f мс против %.0f мс в тишине — перегрузка канала\n", pr, qr; d=1 }
      if(!d) print "[+] В пик нода держится: CPU, steal, ретрансмиты, потери и RTT в норме."
    }' "$CSV"
}

# cron_ok — служба cron работает (на части образов она выключена или не установлена: расписание есть, а снимков нет)
cron_ok(){ systemctl is-active --quiet cron 2>/dev/null || systemctl is-active --quiet crond 2>/dev/null || pgrep -x 'cron|crond' >/dev/null 2>&1; }
ensure_cron(){
  cron_ok && return 0
  warn "Служба cron не работает — по расписанию снимки не уходили бы. Включаю."
  if ! systemctl enable --now cron >/dev/null 2>&1 && ! systemctl enable --now crond >/dev/null 2>&1; then
    command -v apt-get >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cron >/dev/null 2>&1 && systemctl enable --now cron >/dev/null 2>&1
  fi
  if cron_ok; then ok "cron включён."; else warn "Не удалось включить cron: systemctl enable --now cron (или apt-get install cron)."; fi
}

do_install(){
  local v
  if [ -z "$STATS_URL" ] && [ -t 0 ]; then   # без выгрузки снимки останутся только в CSV на ноде
    printf '\033[1;33m[!]\033[0m Выгрузка статистики не настроена: на дашборде этой ноды не будет.\n'
    read -r -p "Настроить выгрузку сейчас? [Y/n] " v
    case "${v:-y}" in [YyДд]*) setup_stats ;; esac
  fi
  need ping iputils-ping
  [ -n "$NODE_CC" ] || NODE_CC=$(detect_cc)
  [ -n "$NODE_IP" ] || NODE_IP=$(detect_ip)
  save_conf; mkdir -p "$(dirname "$CSV")"
  echo "*/15 * * * * root CSV=$CSV /usr/bin/env bash $(readlink -f "$0") quick >/dev/null 2>&1" > "$CRON"
  ensure_cron
  ok "Сбор включён: снимок каждые 15 минут -> $CSV${STATS_URL:+ и VictoriaMetrics}."
  snapshot 10; csv_line
}
do_uninstall(){ rm -f "$CRON"; ok "Сбор выключен (CSV $CSV оставлен)."; }

setup_stats(){
  local v def=${STATS_URL:-https://panel.ulya.space:9443/node-stats/write}
  if [ -t 0 ]; then
    read -r -p "URL приёмника [$def]: " v; STATS_URL=${v:-$def}
    read -r -p "Логин [$STATS_USER]: " v; STATS_USER=${v:-$STATS_USER}
    read -r -s -p "Пароль${STATS_PASS:+ [Enter — оставить прежний]}: " v; echo; STATS_PASS=${v:-$STATS_PASS}
    read -r -p "Имя ноды — лучше как в панели Remnawave [$NODE_NAME]: " v; NODE_NAME=${v:-$NODE_NAME}; NODE_NAME=${NODE_NAME//[ ,=]/_}
  fi
  [ -n "$STATS_URL" ] && [ -n "$STATS_PASS" ] || err "Нужны URL и пароль (интерактивно или STATS_URL=... STATS_PASS=...)."
  [ -n "$NODE_CC" ] || NODE_CC=$(detect_cc)
  if push node_setup "" "ok=1"; then save_conf; ok "Приёмник ответил, настройки сохранены в $CONF (права 600)."
    # сбор уже включён — сразу шлём снимок под новым именем, не ждём cron (выключать и включать сбор не нужно)
    [ -f "$CRON" ] && { snapshot 10; csv_line >/dev/null; ok "Снимок под именем $NODE_NAME отправлен. Старую историю перенесёт stats/rename-node.py на сервере панели."; }
  else warn "Приёмник не принял тестовую метрику — настройки не сохранены. Проверь URL, логин и пароль."; return 1; fi   # иначе «stats && install» включит сбор без выгрузки
}

menu(){
  local ch
  [ -n "$NODE_CC" ] || NODE_CC=$(detect_cc)
  while true; do
    clear 2>/dev/null || true
    printf '\033[1mnode-check — %s (%s)\033[0m%s\n\n' "$NODE_NAME" "${NODE_CC:-?}" "$(is_ru && echo '  нода в РФ: + проверки блокировок')"
    echo "  1) Полная проверка          ~3 мин, нагружает CPU и канал"
    echo "  2) Полная без iperf3        бережно в час пик"
    echo "  3) Быстрый снимок нагрузки  ~15 с"
    echo "  4) Отчёт: пик против тишины"
    if [ -f "$CRON" ] && ! cron_ok; then echo "  5) Сбор каждые 15 мин:      ВКЛ, но служба cron не работает! — починить"
    elif [ -f "$CRON" ]; then echo "  5) Сбор каждые 15 мин:      ВКЛ — выключить"; else echo "  5) Сбор каждые 15 мин:      выкл — включить"; fi
    echo "  6) Выгрузка статистики:     ${STATS_URL:-не настроена} — настроить"
    echo "  0) Выход"
    read -r -p $'\nВыбор: ' ch || exit 0
    echo
    case "$ch" in
      1) run_full ;;
      2) NO_IPERF=1 run_full ;;
      3) snapshot 10; print_snapshot; csv_line ;;
      4) run_report ;;
      5) if [ -f "$CRON" ] && ! cron_ok; then ensure_cron; elif [ -f "$CRON" ]; then do_uninstall; else do_install; fi ;;
      6) setup_stats ;;
      0|q|Q) exit 0 ;;
      *) continue ;;
    esac
    read -r -p $'\nEnter — назад в меню ' _ || exit 0
  done
}

[ -n "$MODE" ] || { [ -t 0 ] && MODE=menu || MODE=full; }
[ "$(id -u)" -eq 0 ] || [ "$MODE" = report ] || err "Запусти от root:  sudo bash $0 ${MODE}"
case "$MODE" in
  menu)      menu ;;
  full)      run_full ;;
  quick)     snapshot 10; csv_line ;;
  install)   do_install ;;
  uninstall) do_uninstall ;;
  report)    run_report ;;
  stats)     setup_stats ;;
  *)         err "Режим: menu | full | quick | install | uninstall | report | stats (сейчас: $MODE)" ;;
esac
