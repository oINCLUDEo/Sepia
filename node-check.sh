#!/usr/bin/env bash
#
# node-check.sh — проверка ноды: железо, CPU, сеть, блокировки (для РФ), как сервисы видят IP, нагрузка в пик.
#
# Без аргументов — меню. Режимы (для cron и скриптов):
#   full        разовый прогон ~3 мин (NO_IPERF=1 — без нагрузки на канал)
#   quick       снимок нагрузки ~15 с без iperf -> строка в CSV (+ в VictoriaMetrics, если настроено)
#   minute      снимок за последнюю минуту по счётчикам ядра, ~3 с (его запускает таймер каждую минуту)
#   daily       ночное обслуживание: самообновление (git pull), полная проверка, чистка CSV
#   install     таймеры systemd: minute каждую минуту, daily ночью (без systemd — cron);   uninstall — снять
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
SELF=$(readlink -f "$0"); REPO=$(dirname "$SELF")
STATE_DIR=/var/lib/rw-node-check            # счётчики прошлого минутного снимка
LOCK=/run/rw-node-check.lock                # минутный снимок не идёт, пока работает ночная проверка
ACTIONS=/var/log/rw-node-check-actions.log  # что нода сделала сама (обновилась, увеличила conntrack)
UNIT=rw-node-check
PERIOD=60                                   # шаг сбора, секунд
NIGHT_FULL="${NIGHT_FULL:-1}"; NIGHT_IPERF="${NIGHT_IPERF:-1}"   # ночная полная проверка и iperf3 в ней
NODE_DOMAIN="${NODE_DOMAIN:-}"              # домен заглушки; пусто — найдём сами в nginx (decoy.conf) или Let's Encrypt
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
    NODE_IP=$(detect_ip); [ -n "$NODE_IP" ] && case "$MODE" in quick|minute) save_conf ;; esac   # старые установки: запомнить один раз
  fi
  local code   # пароль через stdin (-K -), чтобы не светился в ps
  code=$(printf 'user = "%s:%s"\n' "$STATS_USER" "$STATS_PASS" | curl -4 -s -K - --max-time 10 -o /dev/null -w '%{http_code}' \
    --data-binary "$1,node=$NODE_NAME,cc=${NODE_CC:-XX}${NODE_IP:+,ip=$NODE_IP}${2:+,$2} $3" "$STATS_URL")
  case "$code" in 2??) return 0 ;; *) printf '\033[1;33m[!]\033[0m Выгрузка в VictoriaMetrics не удалась (HTTP %s)\n' "$code" >&2; return 1 ;; esac
}

# script_ver -> "коммит время_коммита": по ним дашборд видит, кому нужно обновление
script_ver(){
  local v; v=$(git -C "$REPO" log -1 --format='%h %ct' 2>/dev/null)
  [ -n "$v" ] && echo "$v" || echo "$(sha256sum "$SELF" | cut -c1-7) $(stat -c %Y "$SELF")"
}
push_meta(){ local v vts; read -r v vts < <(script_ver); push node_meta "ver=$v" "$(fields up 1 ver_ts "$vts" period "${S_PERIOD:-900}")"; }
# action KIND INFO — что нода сделала сама: в журнал на ноде и в журнал событий на дашборде
action(){ echo "$(date '+%F %T') $1 $2" >> "$ACTIONS"; push node_action "kind=$1,info=${2//[ ,=]/_}" "n=1"; }

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
  gauges
  S_XRAY=-
  [ -n "$p" ] && S_XRAY=$(awk -v d=$((x1-x0)) -v hz="$(getconf CLK_TCK)" -v t="$n" 'BEGIN{printf "%.0f", d*100/hz/t}')
}

# gauges — показатели «на сейчас»: соединения, load, память, conntrack
gauges(){
  S_CONN=$(ss -Htn state established 2>/dev/null | wc -l)
  S_LOAD=$(cut -d' ' -f1 /proc/loadavg)
  S_MEM=$(free | awk '/^Mem:/{printf "%.0f", ($2-$7)*100/$2}')
  S_CT=-
  [ -r /proc/sys/net/netfilter/nf_conntrack_count ] && S_CT=$(awk -v c="$(cat /proc/sys/net/netfilter/nf_conntrack_count)" -v m="$(cat /proc/sys/net/netfilter/nf_conntrack_max)" 'BEGIN{printf "%.0f", c*100/m}')
}

# snapshot_minute — среднее за время с прошлого запуска по счётчикам ядра (CPU, трафик, TCP, Xray), без ожидания:
# нода видна 100% времени, а не 10 секунд из 15 минут. Нет прошлого состояния, оно старше 5 минут
# или счётчик сбросился (перезагрузка) — честный замер 5 секунд, как раньше.
snapshot_minute(){
  local dev now prev us sy st tot rx tx o r p x t0 us0 sy0 st0 tot0 rx0 tx0 o0 r0 p0 x0 dt
  dev=$(iface); now=$(date +%s.%N)
  read -r us sy st tot < <(awk '/^cpu /{print $2+$3, $4+$7+$8, $9, $2+$3+$4+$5+$6+$7+$8+$9}' /proc/stat)
  read -r rx < "/sys/class/net/$dev/statistics/rx_bytes"; read -r tx < "/sys/class/net/$dev/statistics/tx_bytes"
  read -r o r < <(tcp_cnt); p=$(xray_pid); x=$(proc_ticks "$p")
  mkdir -p "$STATE_DIR"; prev=$(cat "$STATE_DIR/last" 2>/dev/null || true)
  echo "$now $us $sy $st $tot $rx $tx $o $r ${p:-0} $x" > "$STATE_DIR/last"
  read -r t0 us0 sy0 st0 tot0 rx0 tx0 o0 r0 p0 x0 <<< "$prev"
  dt=$(awk -v a="${t0:-0}" -v b="$now" 'BEGIN{printf "%.3f", b-a}')
  if [ -z "$prev" ] || awk -v d="$dt" 'BEGIN{exit !(d>300 || d<5)}' || [ "$tot" -le "${tot0:-0}" ] || [ "$rx" -lt "${rx0:-0}" ] || [ "$tx" -lt "${tx0:-0}" ] || [ "$o" -lt "${o0:-0}" ]; then
    snapshot 5; return
  fi
  read -r S_US S_SY S_ST < <(awk -v a=$((us-us0)) -v b=$((sy-sy0)) -v c=$((st-st0)) -v t=$((tot-tot0)) 'BEGIN{printf "%.0f %.0f %.0f\n", a*100/t, b*100/t, c*100/t}')
  S_RX=$(awk -v d=$((rx-rx0)) -v t="$dt" 'BEGIN{printf "%.1f", d*8/t/1e6}')
  S_TX=$(awk -v d=$((tx-tx0)) -v t="$dt" 'BEGIN{printf "%.1f", d*8/t/1e6}')
  S_RETR=$(awk -v o=$((o-o0)) -v r=$((r-r0)) 'BEGIN{printf "%.2f", (o>0 ? r*100/o : 0)}')
  S_XRAY=-
  [ -n "$p" ] && [ "$p" = "$p0" ] && S_XRAY=$(awk -v d=$((x-x0)) -v hz="$(getconf CLK_TCK)" -v t="$dt" 'BEGIN{printf "%.0f", d*100/hz/t}')
  gauges
}

# ct_autotune — conntrack заполнен от 80%: удваиваем таблицу (не больше четверти памяти), срок жизни записи — 2 часа.
# Пишем в /etc/sysctl.d/99-rw-zz-conntrack.conf (читается после 99-rw-node.conf от tune-kernel) и в журнал действий.
ct_autotune(){
  local f=/proc/sys/net/netfilter max mem cap new conf=/etc/sysctl.d/99-rw-zz-conntrack.conf
  [ "${S_CT:--}" != "-" ] && [ "$S_CT" -ge 80 ] && [ -w $f/nf_conntrack_max ] || return 0
  max=$(cat $f/nf_conntrack_max); mem=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
  cap=$(( mem * 1024 * 1024 / 4 / 320 )); new=$(( max * 2 )); [ "$new" -gt "$cap" ] && new=$cap
  if [ "$new" -le "$max" ]; then echo "$(date '+%F %T') conntrack ${S_CT}%: таблица уже на пределе по памяти ($max)" >> "$ACTIONS"; return 0; fi
  sysctl -qw net.netfilter.nf_conntrack_max="$new"
  [ "$(cat $f/nf_conntrack_tcp_timeout_established 2>/dev/null || echo 0)" -gt 7200 ] && sysctl -qw net.netfilter.nf_conntrack_tcp_timeout_established=7200
  [ -w /sys/module/nf_conntrack/parameters/hashsize ] && echo $(( new / 4 )) > /sys/module/nf_conntrack/parameters/hashsize 2>/dev/null
  printf '# node-check: conntrack дошёл до %s%%, таблица увеличена автоматически %s\nnet.netfilter.nf_conntrack_max = %s\nnet.netfilter.nf_conntrack_tcp_timeout_established = 7200\n' "$S_CT" "$(date '+%F %T')" "$new" > "$conf"
  action conntrack "$max-$new"   # в журнал событий на дашборде
}

# --- маскировка: сайт-заглушка и сертификат — то, что видит активный пробер на 443 ---
# site_domain — домен заглушки: NODE_DOMAIN, иначе server_name из decoy.conf (provision-node.sh), иначе Let's Encrypt.
# Нет ни того ни другого — нода в режиме маски на чужой домен (provision режим 3), проверять нечего.
site_domain(){
  [ -n "$NODE_DOMAIN" ] && { echo "$NODE_DOMAIN"; return; }
  local d
  d=$(awk '/server_name/{gsub(";","",$2); print $2; exit}' /etc/nginx/sites-available/decoy.conf 2>/dev/null)
  [ -n "$d" ] || d=$(find /etc/letsencrypt/live -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | grep -v README | head -1)
  echo "$d"
}
cert_days(){ awk -v e="$(date -d "$1" +%s 2>/dev/null || echo 0)" -v n="$(date +%s)" 'BEGIN{printf "%.1f", (e-n)/86400}'; }
renew_ok(){ { systemctl is-active --quiet certbot.timer 2>/dev/null || systemctl is-active --quiet snap.certbot.renew.timer 2>/dev/null || grep -qs certbot /etc/cron.d/* /var/spool/cron/crontabs/root; } && echo 1 || echo 0; }

# decoy_check — стучимся сами к себе на 443 с SNI своего домена, как пробер: отвечает ли заглушка, какой сертификат
# реально отдаётся, проходит ли проверку цепочки. Чиним сами то, что безопасно: nginx лежит — поднять;
# сертификат на диске новее отдаваемого (продлили, а nginx не перечитал) — перезагрузить nginx.
SITE_D=""; SITE_CODE=-; SITE_BYTES=-; SITE_TLS=-; SITE_DAYS=-; SITE_FILE_DAYS=-; SITE_RENEW=-
decoy_check(){
  local d out end fe
  d=$(site_domain); SITE_D=$d; [ -n "$d" ] || return 1
  if command -v nginx >/dev/null 2>&1 && ! systemctl is-active --quiet nginx 2>/dev/null; then
    systemctl restart nginx >/dev/null 2>&1 && action nginx-restart "$d"
  fi
  fe=$(openssl x509 -enddate -noout -in "/etc/letsencrypt/live/$d/fullchain.pem" 2>/dev/null | cut -d= -f2)
  [ -n "$fe" ] && SITE_FILE_DAYS=$(cert_days "$fe")
  end=$(echo | timeout 8 openssl s_client -connect 127.0.0.1:443 -servername "$d" 2>/dev/null | openssl x509 -enddate -noout 2>/dev/null | cut -d= -f2)
  [ -n "$end" ] && SITE_DAYS=$(cert_days "$end")
  if [ "$SITE_DAYS" != "-" ] && [ "$SITE_FILE_DAYS" != "-" ] && awk -v a="$SITE_FILE_DAYS" -v b="$SITE_DAYS" 'BEGIN{exit !(a-b>1)}'; then
    systemctl reload nginx >/dev/null 2>&1 && action nginx-reload "$d"   # серт продлили, а nginx отдаёт старый
  fi
  out=$(curl -s --http1.1 --noproxy '*' -o /dev/null --max-time 8 --resolve "$d:443:127.0.0.1" -w '%{http_code} %{size_download}' "https://$d/" 2>/dev/null)
  if [ "${out%% *}" != "000" ] && [ -n "$out" ]; then SITE_TLS=1
  else SITE_TLS=0; out=$(curl -sk --http1.1 --noproxy '*' -o /dev/null --max-time 8 --resolve "$d:443:127.0.0.1" -w '%{http_code} %{size_download}' "https://$d/" 2>/dev/null); fi
  SITE_CODE=${out%% *}; SITE_BYTES=${out##* }; [ "$SITE_CODE" = "000" ] && SITE_TLS=0
  SITE_RENEW=$(renew_ok)
  push node_site "domain=$d" "$(fields code "$SITE_CODE" bytes "$SITE_BYTES" tls_ok "$SITE_TLS" cert_days "$SITE_DAYS" file_days "$SITE_FILE_DAYS" renew_ok "$SITE_RENEW")"
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
  read -r rtt jit loss < <(ping_stat "$tgt" "${PING_N:-10}")
  [ -s "$CSV" ] || echo "ts,hour,cpu_us,cpu_sy,cpu_st,load1,mem_pct,conntrack_pct,conns,rx_mbps,tx_mbps,retrans_pct,rtt_ms,jitter_ms,loss_pct,xray_cpu,ping_to" > "$CSV"
  echo "$(date '+%F %T'),$(date +%H),$S_US,$S_SY,$S_ST,$S_LOAD,$S_MEM,$S_CT,$S_CONN,$S_RX,$S_TX,$S_RETR,$rtt,$jit,$loss,$S_XRAY,$to" >> "$CSV"
  push node_quick "to=$to" "$(fields cpu_us "$S_US" cpu_sy "$S_SY" cpu_st "$S_ST" load1 "$S_LOAD" mem_pct "$S_MEM" conntrack_pct "$S_CT" \
    conns "$S_CONN" rx_mbps "$S_RX" tx_mbps "$S_TX" retrans_pct "$S_RETR" rtt_ms "$rtt" jitter_ms "$jit" loss_pct "$loss" xray_cpu "$S_XRAY" period "${S_PERIOD:-}")"
  echo "$(date '+%F %T') CPU ${S_US}+${S_SY}% st ${S_ST}% | ↓${S_RX} ↑${S_TX} Мбит/с | conn ${S_CONN} | retr ${S_RETR}% | ${to^^} ${rtt} мс, потери ${loss}%"
}

print_snapshot(){
  grade "$S_ST" 5 15 down "CPU занят $((S_US+S_SY))% (us ${S_US} + sy ${S_SY}), steal ${S_ST}%, Xray ${S_XRAY}%, load ${S_LOAD}"
  grade "$S_RETR" 5 10 down "Трафик: от юзеров ↓${S_RX}, к юзерам ↑${S_TX} Мбит/с, соединений ${S_CONN}, ретрансмиты ${S_RETR}%"
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

  hdr "Маскировка: сайт-заглушка и сертификат"
  if decoy_check; then
    [ "$SITE_CODE" -ge 200 ] 2>/dev/null && [ "$SITE_CODE" -lt 400 ] && ok "Заглушка $SITE_D отвечает: HTTP $SITE_CODE, $SITE_BYTES байт" || bad "Заглушка $SITE_D не отвечает как сайт: HTTP $SITE_CODE"
    [ "$SITE_TLS" = 1 ] && ok "Сертификат проходит проверку цепочки" || bad "Сертификат НЕ проходит проверку (пробер увидит ошибку TLS)"
    grade "$SITE_DAYS" 14 7 up "Сертификат действует ещё $SITE_DAYS дн"
    [ "$SITE_RENEW" = 1 ] && ok "Автопродление certbot включено" || warn "Автопродление certbot не найдено (certbot.timer / cron)"
  else ok "Своей заглушки нет — маска на чужой домен (режим 3), проверять нечего"; fi

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

# Сбор: таймеры systemd (не зависят от службы cron, которая на части образов выключена). Без systemd — cron.
has_systemd(){ command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }
collect_on(){ { has_systemd && systemctl is-enabled --quiet "$UNIT.timer" 2>/dev/null; } || [ -f "$CRON" ]; }
collect_ok(){ if has_systemd && systemctl is-enabled --quiet "$UNIT.timer" 2>/dev/null; then systemctl is-active --quiet "$UNIT.timer"; else [ -f "$CRON" ] && cron_ok; fi; }

install_units(){
  if has_systemd; then
    cat > /etc/systemd/system/$UNIT.service <<EOF
[Unit]
Description=node-check: снимок нагрузки за минуту -> VictoriaMetrics
[Service]
Type=oneshot
Nice=10
Environment=CSV=$CSV
ExecStart=/usr/bin/env bash $SELF minute
TimeoutStartSec=55
StandardOutput=null
EOF
    cat > /etc/systemd/system/$UNIT.timer <<EOF
[Unit]
Description=node-check: каждую минуту
[Timer]
OnCalendar=*-*-* *:*:00
AccuracySec=1s
[Install]
WantedBy=timers.target
EOF
    cat > /etc/systemd/system/$UNIT-daily.service <<EOF
[Unit]
Description=node-check: ночное обслуживание — самообновление, полная проверка, чистка CSV
[Service]
Type=oneshot
Nice=5
Environment=CSV=$CSV
ExecStart=/usr/bin/env bash $SELF daily
TimeoutStartSec=30min
StandardOutput=null
EOF
    # 03:15–05:15 по Москве: тихие часы, полная проверка с iperf3 никому не помешает
    cat > /etc/systemd/system/$UNIT-daily.timer <<EOF
[Unit]
Description=node-check: раз в сутки ночью
[Timer]
OnCalendar=*-*-* 00:15:00 UTC
RandomizedDelaySec=2h
Persistent=true
[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now "$UNIT.timer" "$UNIT-daily.timer" >/dev/null 2>&1
    rm -f "$CRON"   # старое расписание раз в 15 минут больше не нужно
  else
    printf '* * * * * root CSV=%s /usr/bin/env bash %s minute >/dev/null 2>&1\n15 0 * * * root CSV=%s /usr/bin/env bash %s daily >/dev/null 2>&1\n' "$CSV" "$SELF" "$CSV" "$SELF" > "$CRON"
    ensure_cron
  fi
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
  install_units
  if collect_ok; then ok "Сбор включён: снимок каждую минуту -> $CSV${STATS_URL:+ и VictoriaMetrics}; ночью — самообновление и полная проверка."
  else warn "Таймеры поставлены, но не запустились: systemctl status $UNIT.timer"; fi
  S_PERIOD=$PERIOD; snapshot 5; csv_line; push_meta
  if decoy_check; then ok "Заглушка $SITE_D: HTTP $SITE_CODE, сертификат ещё ${SITE_DAYS} дн$([ "$SITE_TLS" = 0 ] && echo ', НЕ проходит проверку')."; fi
}
do_uninstall(){
  if has_systemd; then systemctl disable --now "$UNIT.timer" "$UNIT-daily.timer" >/dev/null 2>&1; rm -f /etc/systemd/system/$UNIT.{service,timer} /etc/systemd/system/$UNIT-daily.{service,timer}; systemctl daemon-reload; fi
  rm -f "$CRON"; ok "Сбор выключен (CSV $CSV оставлен)."
}

# run_minute — из таймера каждую минуту; пока идёт ночная проверка (она грузит CPU и канал) — пропускаем
run_minute(){
  exec 9>"$LOCK"; flock -n 9 || exit 0
  S_PERIOD=$PERIOD; PING_N=5
  snapshot_minute; ct_autotune; csv_line >/dev/null; push_meta
  [ $((10#$(date +%M) % 10)) -eq 0 ] && decoy_check >/dev/null 2>&1
  return 0
}

# self_update — git pull; если версия сменилась — переставить таймеры уже новым скриптом
self_update(){
  local before after
  git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  before=$(git -C "$REPO" rev-parse --short HEAD)
  if ! timeout 120 git -C "$REPO" pull --ff-only -q >/dev/null 2>&1; then
    action update-failed "$before"; return 0   # чаще всего — правки в файлах на ноде: git status в $REPO
  fi
  after=$(git -C "$REPO" rev-parse --short HEAD)
  [ "$before" = "$after" ] && return 0
  action update "$before-$after"
  bash "$SELF" install </dev/null >/dev/null 2>&1 || true
}

# run_daily — ночное обслуживание: обновиться, проверить себя, полная проверка, подрезать CSV до 14 дней
run_daily(){
  exec 9>"$LOCK"; flock -w 900 9 || exit 0
  self_update
  if has_systemd && ! systemctl is-active --quiet "$UNIT.timer"; then
    systemctl enable --now "$UNIT.timer" >/dev/null 2>&1 && action timer-fixed "$UNIT.timer"
  fi
  if [ -s "$CSV" ] && [ "$(wc -l < "$CSV")" -gt 20200 ]; then
    { head -1 "$CSV"; tail -n 20160 "$CSV"; } > "$CSV.tmp" && mv "$CSV.tmp" "$CSV"
  fi
  # сертификат заглушки: осталось меньше 20 дней — пробуем продлить сами (certbot сам решает, пора ли)
  if decoy_check && [ "$SITE_DAYS" != "-" ] && awk -v x="$SITE_DAYS" 'BEGIN{exit !(x<20)}' && command -v certbot >/dev/null 2>&1; then
    if timeout 300 certbot renew --quiet >/dev/null 2>&1; then systemctl reload nginx >/dev/null 2>&1; action cert-renew "$SITE_D"; decoy_check >/dev/null 2>&1
    else action cert-renew-failed "$SITE_D"; fi
  fi
  if [ "$NIGHT_FULL" = 1 ]; then
    if [ "$NIGHT_IPERF" = 1 ]; then NO_IPERF=0; else NO_IPERF=1; fi
    run_full > /var/log/rw-node-check-full.log 2>&1 || true
  fi
  push_meta
}

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
    collect_on && { snapshot 10; csv_line >/dev/null; push_meta; ok "Снимок под именем $NODE_NAME отправлен. Старую историю перенесёт stats/rename-node.py на сервере панели."; }
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
    if collect_on && ! collect_ok; then echo "  5) Сбор каждую минуту:      ВКЛ, но таймер/cron не работает! — починить"
    elif collect_on; then echo "  5) Сбор каждую минуту:      ВКЛ — выключить"; else echo "  5) Сбор каждую минуту:      выкл — включить"; fi
    echo "  6) Выгрузка статистики:     ${STATS_URL:-не настроена} — настроить"
    echo "  0) Выход"
    read -r -p $'\nВыбор: ' ch || exit 0
    echo
    case "$ch" in
      1) run_full ;;
      2) NO_IPERF=1 run_full ;;
      3) snapshot 10; print_snapshot; csv_line ;;
      4) run_report ;;
      5) if collect_on && ! collect_ok; then do_install; elif collect_on; then do_uninstall; else do_install; fi ;;
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
  quick)     snapshot 10; ct_autotune; csv_line; push_meta ;;
  minute)    run_minute ;;
  daily)     run_daily ;;
  install)   do_install ;;
  uninstall) do_uninstall ;;
  report)    run_report ;;
  stats)     setup_stats ;;
  *)         err "Режим: menu | full | quick | minute | daily | install | uninstall | report | stats (сейчас: $MODE)" ;;
esac
