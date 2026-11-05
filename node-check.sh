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
  c=$(curl -4 -s --connect-timeout 4 --max-time 6 https://ipinfo.io/country | grep -oE '^[A-Z]{2}$') ||
    c=$(curl -4 -s --connect-timeout 4 --max-time 6 'http://ip-api.com/line/?fields=countryCode' | grep -oE '^[A-Z]{2}$')
  echo "${c:-}"
}
is_ru(){ case "$RU" in 1) return 0 ;; 0) return 1 ;; esac; [ -n "$NODE_CC" ] || [ -n "$GEO_TRIED" ] || NODE_CC=$(detect_cc); [ "$NODE_CC" = RU ]; }
detect_ip(){ curl -4 -s --connect-timeout 4 --max-time 6 https://api.ipify.org | grep -oE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || true; }
# remember_geo — для минутного сбора: страну и IP узнаём по сети не чаще раза в час и запоминаем в конфиг.
# Раньше при недоступных ipinfo/ipify каждый запуск ждал их таймауты (страна в пинге, IP в каждой выгрузке —
# до полуминуты) и мог не уложиться в 55 секунд таймера: снимок терялся, нода на дашборде «молчала»
remember_geo(){
  GEO_TRIED=1
  [ -n "$NODE_CC" ] && [ -n "$NODE_IP" ] && return 0
  local f="$STATE_DIR/geo_try" now; now=$(date +%s)
  [ $(( now - $(cat "$f" 2>/dev/null || echo 0) )) -lt 3600 ] && return 0
  echo "$now" > "$f" 2>/dev/null
  [ -n "$NODE_CC" ] || NODE_CC=$(detect_cc)
  [ -n "$NODE_IP" ] || NODE_IP=$(detect_ip)
  [ -n "$NODE_CC$NODE_IP" ] && save_conf
  return 0
}

# save_conf — обновляет в конфиге только свои поля; всё, что дописано руками (NODE_DOMAIN, NIGHT_IPERF, RU...), не трогает.
# Значения — через printf %q: пароль с ' " \ или пробелом не ломает ни конфиг, ни его чтение
SAVE_KEYS="STATS_URL STATS_USER STATS_PASS NODE_NAME NODE_CC NODE_IP"
save_conf(){ (
  umask 077
  local tmp k; tmp=$(mktemp "$CONF.XXXXXX") || return 1
  if [ -f "$CONF" ]; then grep -vE "^(${SAVE_KEYS// /|})=" "$CONF" > "$tmp" || true
  else echo "# node-check.sh: выгрузка статистики и метка ноды (свои поля пишет скрипт; ниже можно дописывать свои)" > "$tmp"; fi
  for k in $SAVE_KEYS; do printf '%s=%q\n' "$k" "${!k}" >> "$tmp"; done
  mv -f "$tmp" "$CONF"
); }

# fields k1 v1 k2 v2 ... -> "k1=v1,k2=v2"; "-" и пустые пропускаем — line protocol их не примет
fields(){ local out=""; while [ $# -ge 2 ]; do case "$2" in ""|-) ;; *) out="${out:+$out,}$1=$2" ;; esac; shift 2; done; echo "$out"; }
# push MEASUREMENT EXTRA_TAGS FIELDS — строка Influx line protocol в VictoriaMetrics (если настроено)
push(){
  [ -n "$STATS_URL" ] && [ -n "$3" ] || return 0
  if [ -z "$NODE_IP" ] && [ -z "$GEO_TRIED" ]; then   # IP в метке: по нему дашборд находит ноду в панели (имя и флаг из Remnawave)
    NODE_IP=$(detect_ip); [ -n "$NODE_IP" ] && case "$MODE" in quick|minute) save_conf ;; esac   # старые установки: запомнить один раз
  fi
  send_body "$1,node=$NODE_NAME,cc=${NODE_CC:-XX}${NODE_IP:+,ip=$NODE_IP}${2:+,$2} $3"
}
# send_body — отправить готовые строки line protocol (одну или несколько через перевод строки)
send_body(){
  local code   # пароль через stdin (-K -), чтобы не светился в ps
  local cu=${STATS_USER//\\/\\\\} cp=${STATS_PASS//\\/\\\\}; cu=${cu//\"/\\\"}; cp=${cp//\"/\\\"}   # для конфига curl: \ и " экранируем
  code=$(printf 'user = "%s:%s"\n' "$cu" "$cp" | curl -4 -s -K - --connect-timeout 5 --max-time 10 -o /dev/null -w '%{http_code}' \
    --data-binary "$1" "$STATS_URL")
  case "$code" in 2??) return 0 ;; *) printf '\033[1;33m[!]\033[0m Выгрузка в VictoriaMetrics не удалась (HTTP %s)\n' "$code" >&2; return 1 ;; esac
}
# push_many MEASUREMENT < строки «доп_метки|поля» — много точек одним запросом
push_many(){
  [ -n "$STATS_URL" ] || return 0
  local tags fields body="" base="node=$NODE_NAME,cc=${NODE_CC:-XX}${NODE_IP:+,ip=$NODE_IP}"
  while IFS='|' read -r tags fields; do [ -n "$fields" ] && body+="$1,$base${tags:+,$tags} $fields"$'\n'; done
  [ -n "$body" ] && send_body "$body"
}

# script_ver -> "коммит время_коммита": по ним дашборд видит, кому нужно обновление
script_ver(){
  local v; v=$(git -C "$REPO" log -1 --format='%h %ct' 2>/dev/null)
  [ -n "$v" ] && echo "$v" || echo "$(sha256sum "$SELF" | cut -c1-7) $(stat -c %Y "$SELF")"
}
# цена ноды в месяц (NODE_PRICE, NODE_PRICE_CUR в конфиге) — дашборд считает по ней «за ТБ» и «за 100 Мбит/с пика»
push_meta(){ local v vts cur=${NODE_PRICE_CUR//[^A-Za-z]/}; read -r v vts < <(script_ver)
  push node_meta "ver=$v${NODE_PRICE:+,cur=${cur:-EUR}}" "$(fields up 1 ver_ts "$vts" period "${S_PERIOD:-900}" price_month "${NODE_PRICE:-}")"; }
# set_price 6.5 EUR — записать цену в конфиг (0 — убрать) и сразу отправить
set_price(){
  local p=${1//,/.} c=${2:-EUR}
  [[ "$p" =~ ^[0-9]+(\.[0-9]+)?$ ]] || err "Цена — число: sudo bash $0 price 6.5 EUR  (валюта: EUR, USD, RUB…; 0 — убрать)"
  c=$(printf '%s' "$c" | tr -cd 'A-Za-z' | tr '[:lower:]' '[:upper:]'); [ -n "$c" ] || c=EUR
  touch "$CONF"; chmod 600 "$CONF"; sed -i '/^NODE_PRICE=/d;/^NODE_PRICE_CUR=/d' "$CONF"
  if awk -v x="$p" 'BEGIN{exit !(x>0)}'; then printf 'NODE_PRICE=%s\nNODE_PRICE_CUR=%s\n' "$p" "$c" >> "$CONF"; NODE_PRICE=$p; NODE_PRICE_CUR=$c; ok "Цена: $p $c в месяц — увидите в «Ёмкости» дашборда."
  else NODE_PRICE=; ok "Цена убрана."; fi
  push_meta || true
}
# action KIND INFO — что нода сделала сама: в журнал на ноде и в журнал событий на дашборде
action(){ echo "$(date '+%F %T') $1 $2" >> "$ACTIONS"; push node_action "kind=$1,info=${2//[ ,=]/_}" "n=1"; }

# iface — сетевая карта с выходом в интернет: маршрут по умолчанию в основной таблице, иначе в любой (policy routing),
# иначе первая физическая. Пусто — счётчики трафика будут «-», а не падение всего снимка
iface(){
  local d
  d=$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')
  [ -n "$d" ] || d=$(ip -4 route show table all 2>/dev/null | awk '/^default/{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')
  [ -n "$d" ] || d=$(ls /sys/class/net 2>/dev/null | grep -vE '^(lo|docker|br-|veth|virbr|ifb|tun|wg|dummy)' | head -1)
  echo "$d"
}
# netbytes IFACE rx|tx — счётчик байт карты; нет карты — 0 (и трафик за снимок выйдет «-»)
netbytes(){ cat "/sys/class/net/$1/statistics/$2_bytes" 2>/dev/null || echo 0; }
tcp_cnt(){ awk '/^Tcp:/{ if(!h){for(i=1;i<=NF;i++) k[$i]=i; h=1} else print $k["OutSegs"], $k["RetransSegs"] }' /proc/net/snmp; }
xray_pid(){ pgrep -x rw-core 2>/dev/null | head -1 || true; }
proc_ticks(){ [ -n "$1" ] && [ -r "/proc/$1/stat" ] && awk '{print $14+$15}' "/proc/$1/stat" || echo 0; }

# снимок нагрузки за N секунд -> S_US S_SY S_ST S_RX S_TX S_RETR S_CONN S_LOAD S_MEM S_CT S_XRAY
snapshot(){
  local n=${1:-10} dev rx0 tx0 rx1 tx1 o0 r0 o1 r1 p x0 x1
  dev=$(iface)
  rx0=$(netbytes "$dev" rx); tx0=$(netbytes "$dev" tx)
  read -r o0 r0 < <(tcp_cnt); p=$(xray_pid); x0=$(proc_ticks "$p")
  # первая строка vmstat — среднее с загрузки, её пропускаем
  read -r S_US S_SY S_ST < <(vmstat 1 $((n+1)) | awk 'NR==2{for(i=1;i<=NF;i++) c[$i]=i; next} NR>3{k++; us+=$c["us"]; sy+=$c["sy"]; st+=$c["st"]} END{printf "%.0f %.0f %.0f\n", us/k, sy/k, st/k}')
  rx1=$(netbytes "$dev" rx); tx1=$(netbytes "$dev" tx)
  read -r o1 r1 < <(tcp_cnt); x1=$(proc_ticks "$p")
  S_RX=$(awk -v a="$rx0" -v b="$rx1" -v t="$n" 'BEGIN{printf "%.1f", (b-a)*8/t/1e6}')
  S_TX=$(awk -v a="$tx0" -v b="$tx1" -v t="$n" 'BEGIN{printf "%.1f", (b-a)*8/t/1e6}')
  [ "$rx1" -gt 0 ] || { S_RX=-; S_TX=-; }
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
  rx=$(netbytes "$dev" rx); tx=$(netbytes "$dev" tx)
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
  [ "$rx" -gt 0 ] || { S_RX=-; S_TX=-; }
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
  echo "options nf_conntrack hashsize=$(( new / 4 ))" > /etc/modprobe.d/rw-conntrack.conf   # и после перезагрузки — под новый размер
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
  end=$(echo | timeout 5 openssl s_client -connect 127.0.0.1:443 -servername "$d" 2>/dev/null | openssl x509 -enddate -noout 2>/dev/null | cut -d= -f2)
  [ -n "$end" ] && SITE_DAYS=$(cert_days "$end")
  if [ "$SITE_DAYS" != "-" ] && [ "$SITE_FILE_DAYS" != "-" ] && awk -v a="$SITE_FILE_DAYS" -v b="$SITE_DAYS" 'BEGIN{exit !(a-b>1)}'; then
    systemctl reload nginx >/dev/null 2>&1 && action nginx-reload "$d"   # серт продлили, а nginx отдаёт старый
  fi
  out=$(curl -s --http1.1 --noproxy '*' -o /dev/null --max-time 5 --resolve "$d:443:127.0.0.1" -w '%{http_code} %{size_download}' "https://$d/" 2>/dev/null)
  if [ "${out%% *}" != "000" ] && [ -n "$out" ]; then SITE_TLS=1
  else SITE_TLS=0; out=$(curl -sk --http1.1 --noproxy '*' -o /dev/null --max-time 5 --resolve "$d:443:127.0.0.1" -w '%{http_code} %{size_download}' "https://$d/" 2>/dev/null); fi
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
  S_LOSS=$loss; S_TGT=$tgt   # для автотрассировки: потери и куда пингуем
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
  need mtr mtr-tiny || true   # автотрассировка при потерях
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

# svc_check — открываются ли сервисы с этой ноды: YouTube, Instagram, ChatGPT, Telegram… и российские — Госуслуги, Сбер,
# Яндекс, VK, Ozon, WB. Для выхода — что получит пользователь через него; для моста в РФ — работает ли «напрямую»
# российское и что режут. Все запросы параллельно, до 8 секунд; на дашборд — код ответа и время (код 0 — нет ответа).
# Что считать «работает», решает дашборд (assets/access.js): у ChatGPT и Claude API ответ 401 — доступ есть, 403 — регион закрыт
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
SVC_LIST='youtube https://www.youtube.com/
instagram https://www.instagram.com/
chatgpt https://api.openai.com/v1/models
claude https://api.anthropic.com/v1/models
telegram https://web.telegram.org/
whatsapp https://web.whatsapp.com/
discord https://discord.com/api/v9/experiments
x https://x.com/
spotify https://open.spotify.com/
netflix https://www.netflix.com/
gosuslugi https://www.gosuslugi.ru/
sber https://online.sberbank.ru/
yandex https://ya.ru/
vk https://vk.com/
ozon https://www.ozon.ru/
wb https://www.wildberries.ru/'
svc_check(){
  local d id url f code t; d=$(mktemp -d) || return 1
  ( while read -r id url; do
      [ -n "$id" ] && curl -4 -s -o /dev/null --connect-timeout 5 --max-time 8 -A "$UA" -w '%{http_code} %{time_total}' "$url" > "$d/$id" 2>/dev/null &
    done <<< "$SVC_LIST"; wait )
  for f in "$d"/*; do read -r code t < "$f"; echo "svc=${f##*/}|$(fields code "$((10#${code:-0}))" ms "$(awk -v t="${t:-0}" 'BEGIN{printf "%d", t*1000}')")"; done | push_many node_svc
  rm -rf "$d"
}
# rep_check — репутация IP ноды: чёрные списки (DNSBL) и капча Google. Попала в список — почта, банки и Google начинают
# мешать пользователям («тормозит», «капча на каждом шаге»). Поле: 1 — в списке, 0 — нет; нет поля — не удалось проверить
rep_check(){
  local ip=${NODE_IP:-} rev z name hit flds="" g cap=""
  [ -n "$ip" ] || return 1
  rev=$(echo "$ip" | awk -F. '{print $4"."$3"."$2"."$1}')
  for z in spamhaus:zen.spamhaus.org barracuda:b.barracudacentral.org spamcop:bl.spamcop.net dronebl:dnsbl.dronebl.org; do
    name=${z%%:*}; hit=$(timeout 4 getent ahostsv4 "$rev.${z#*:}" 2>/dev/null | awk 'NR==1{print $1}')
    case "$hit" in "") flds+=" $name 0" ;; 127.255.255.*) ;; 127.*) flds+=" $name 1" ;; esac   # 127.255.255.x — сервис отказал (публичный DNS)
  done
  g=$(curl -4 -s -o /dev/null --max-time 8 -A "$UA" -w '%{http_code} %{redirect_url}' 'https://www.google.com/search?q=weather&hl=en' 2>/dev/null)
  case "$g" in 429*|*/sorry/*) cap=1 ;; 200*|30*) cap=0 ;; esac
  # shellcheck disable=SC2086
  push node_rep "" "$(fields $flds captcha "$cap")"
}
# trace_run [ЦЕЛЬ] — трассировка mtr: на каком участке пути начинаются потери. Сама — когда потери или ретрансмиты
# выше «плохо» (не чаще раза в 30 минут), вручную — bash node-check.sh trace. На дашборд — хопы (node_trace) с одной меткой run
trace_run(){
  local tgt=${1:-${RU_PING%% *}} run; command -v mtr >/dev/null 2>&1 || { warn "Нет mtr: apt-get install mtr-tiny"; return 1; }
  run=$(date +%s)
  timeout 25 mtr -4 -n -r -w -c 8 -i 0.3 "$tgt" 2>/dev/null | awk -v run="$run" -v tgt="$tgt" '
    $1 ~ /^[0-9]+\.\|--/ { h=$1; sub(/\..*/, "", h); host=($2=="???" ? "none" : $2); l=$3; sub(/%/, "", l)
      printf "hop=%d,hip=%s,target=%s|loss=%s,ms=%s,run=%s\n", h, host, tgt, l+0, $6+0, run }' | tee /dev/stderr | push_many node_trace
}
# проблема сейчас: потери до цели пинга от 2% или ретрансмиты от 10% при заметном трафике (те же «плохо», что на дашборде)
trace_needed(){ awk -v l="${S_LOSS:-0}" -v r="${S_RETR:-0}" -v t="${S_TX:-0}" 'BEGIN{exit !((l+0 >= 2 && l+0 < 100) || (r+0 >= 10 && t+0 >= 1))}'; }

# sec_check — безопасность и обновления ОС, раз в сутки: сколько обновлений ждёт (и из них безопасности), нужна ли
# перезагрузка, включены ли автообновления, пускает ли SSH по паролю и root, включён ли фаервол, какие порты слушают снаружи
sec_check(){
  local upd="" secu="" reboot=0 unat=0 pass="" root="" fw=0 ports up t sim
  if command -v apt-get >/dev/null 2>&1; then
    timeout 180 apt-get update -qq >/dev/null 2>&1
    sim=$(apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>/dev/null | grep '^Inst ')
    upd=$(printf '%s' "$sim" | grep -c '^Inst '); secu=$(printf '%s' "$sim" | grep -ci 'security')
    dpkg -s unattended-upgrades >/dev/null 2>&1 && apt-config dump 2>/dev/null | grep -q 'APT::Periodic::Unattended-Upgrade "1"' && unat=1
  fi
  [ -f /var/run/reboot-required ] && reboot=1
  if command -v sshd >/dev/null 2>&1; then
    t=$(sshd -T 2>/dev/null)
    case "$(awk '$1=="passwordauthentication"{print $2}' <<< "$t")" in yes) pass=1 ;; no) pass=0 ;; esac
    case "$(awk '$1=="permitrootlogin"{print $2}' <<< "$t")" in yes) root=2 ;; no) root=0 ;; prohibit-password|without-password|forced-commands-only) root=1 ;; esac
  fi
  { nft list ruleset 2>/dev/null | grep -q 'policy drop'; } || { iptables -S INPUT 2>/dev/null | grep -q '^-P INPUT DROP'; } && fw=1
  ports=$(ss -H -lntu 2>/dev/null | awk '{a=$5; n=split(a,p,":"); port=p[n]; addr=substr(a,1,length(a)-length(port)-1); if (addr ~ /^(127\.|\[::1\]|::1)/ || addr ~ /%lo$/) next; print port}' | sort -un | head -20 | paste -sd+ -)
  up=$(awk '{printf "%d", $1/86400}' /proc/uptime)
  push node_sec "${ports:+ports=$ports}" "$(fields updates "$upd" sec_updates "$secu" reboot $reboot unattended $unat ssh_password "$pass" root_login "$root" firewall $fw uptime_days "$up")"
}

# раз в period секунд по отметке в STATE_DIR (пропущенные минуты не мешают)
due(){ local f="$STATE_DIR/$1_ts" now; now=$(date +%s); [ $(( now - $(cat "$f" 2>/dev/null || echo 0) )) -ge "$2" ] && echo "$now" > "$f"; }

# run_minute — из таймера каждую минуту; пока идёт ночная проверка (она грузит CPU и канал) — пропускаем
run_minute(){
  exec 9>"$LOCK"; flock -n 9 || exit 0
  S_PERIOD=$PERIOD; PING_N=5
  mkdir -p "$STATE_DIR"; remember_geo
  snapshot_minute; ct_autotune; csv_line >/dev/null; push_meta
  date +%s > "$STATE_DIR/ok"   # успешный запуск: по этой отметке ночная проверка видит, что сбор не падает
  # заглушка (до ~15 с) — раз в 10 минут и только если запуск не затянулся: таймер даёт 55 секунд на всё
  # тяжёлое — не больше одного за запуск и только если запуск не затянулся: таймер даёт 55 секунд на всё.
  # Трассировка — первой: проблему ловим, пока она идёт
  if [ "$SECONDS" -lt 20 ] && trace_needed && due trace 1800; then trace_run "$S_TGT" >/dev/null 2>&1 && action trace "$S_TGT"
  elif [ $((10#$(date +%M) % 10)) -eq 0 ]; then [ "$SECONDS" -lt 30 ] && decoy_check >/dev/null 2>&1
  elif [ "$SECONDS" -lt 25 ] && due svc 1800; then svc_check >/dev/null 2>&1
  elif [ "$SECONDS" -lt 25 ] && due rep 10800; then rep_check >/dev/null 2>&1; fi
  return 0
}

# self_update — git pull; новая версия сначала проходит самопроверку (синтаксис + настоящий замер без отправки).
# Не прошла — откат на прежний коммит (git reset --keep: локальные правки не трогаем) и событие на дашборд;
# следующей ночью попробуем снова. Прошла — переставляем таймеры уже новым скриптом.
self_update(){
  local before after err target
  git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  before=$(git -C "$REPO" rev-parse HEAD)
  if ! timeout 120 git -C "$REPO" fetch -q >/dev/null 2>&1 || ! target=$(git -C "$REPO" rev-parse -q --verify '@{u}' 2>/dev/null); then
    action update-failed "${before:0:7}"; return 0
  fi
  [ "$before" = "$target" ] && return 0
  if ! timeout 60 git -C "$REPO" merge --ff-only -q "$target" >/dev/null 2>&1; then
    action update-failed "${before:0:7}"; return 0   # чаще всего — правки в файлах на ноде: git status в $REPO
  fi
  after=$(git -C "$REPO" rev-parse HEAD)
  [ "$before" = "$after" ] && return 0
  if ! err=$(bash -n "$SELF" 2>&1) || ! err=$(timeout 60 bash "$SELF" selftest 2>&1); then
    git -C "$REPO" reset -q --keep "$before" 2>/dev/null || git -C "$REPO" checkout -q "$before" -- . 2>/dev/null
    action update-rollback "${after:0:7}-${before:0:7}"
    echo "$(date '+%F %T') самопроверка ${after:0:7} не прошла: ${err:0:300}" >> "$ACTIONS"
    return 0
  fi
  action update "${before:0:7}-${after:0:7}"
  bash "$SELF" install </dev/null >/dev/null 2>&1 || true
}

# run_selftest — для самообновления: настоящий замер, ничего не отправляем и не трогаем состояние минутного сбора
run_selftest(){
  STATS_URL=""; STATE_DIR=$(mktemp -d); CSV=/dev/null
  snapshot 1
  [[ "$S_US" =~ ^[0-9]+$ ]] && [[ "$S_TX" =~ ^[0-9.]+$ ]] && [[ "$S_CONN" =~ ^[0-9]+$ ]] || { echo "замер дал мусор: us=$S_US tx=$S_TX conn=$S_CONN"; rm -rf "$STATE_DIR"; exit 1; }
  decoy_check >/dev/null 2>&1 || true   # проверка заглушки не должна падать (результат не важен)
  rm -rf "$STATE_DIR"; echo "selftest ok"
}

# run_daily — ночное обслуживание: обновиться, проверить себя, полная проверка, подрезать CSV до 14 дней
run_daily(){
  exec 9>"$LOCK"; flock -w 900 9 || exit 0
  self_update
  sec_check >/dev/null 2>&1 || true   # обновления и безопасность ОС — раз в сутки (apt-get update долгий для минутного запуска)
  if has_systemd && ! systemctl is-active --quiet "$UNIT.timer"; then
    systemctl enable --now "$UNIT.timer" >/dev/null 2>&1 && action timer-fixed "$UNIT.timer"
  fi
  # таймер работает, а успешных минутных запусков давно нет — сбор падает: в журнал дашборда с причиной
  local okts; okts=$(cat "$STATE_DIR/ok" 2>/dev/null || echo 0)
  if collect_on && [ $(( $(date +%s) - okts )) -gt 1800 ]; then
    action minute-failing "$(( ($(date +%s) - okts) / 60 ))"
    echo "$(date '+%F %T') минутный сбор падает: $(timeout 50 bash "$SELF" selftest 2>&1 | tail -3 | tr '\n' ' ')" >> "$ACTIONS"
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
  selftest)  run_selftest ;;
  install)   do_install ;;
  uninstall) do_uninstall ;;
  report)    run_report ;;
  stats)     setup_stats ;;
  price)     set_price "${2:-}" "${3:-}" ;;
  trace)     trace_run "${2:-}" ;;
  security)  sec_check && ok "Проверка безопасности отправлена — дашборд, «Доступ»." ;;
  *)         err "Режим: menu | full | quick | minute | daily | install | uninstall | report | stats | price | trace | security (сейчас: $MODE)" ;;
esac
