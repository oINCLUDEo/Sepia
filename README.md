# Sepia

Сайты-заглушки + скрипт провижинга standalone VLESS+Reality **selfsteal**-ноды для Remnawave.

Сайт служит реальной страницей за заглушкой: Xray форвардит на него непрошедший
Reality-авторизацию трафик, и активный пробер видит обычный сайт.

Выбор сайта — переменная `SITE` (вопрос в меню), по умолчанию **arclayer**:

- **arclayer** — многостраничный лендинг Arclayer (вымышленный web3-инфра бренд): главная
  + Network/Build/Company + 404, локализация EN/RU, дот-глобус. Папка `site/`. Основной.
- **sepia** — одностраничная «Сепия» (лендинг цветокора видео). Папка `site-sepia/`.
- **racelive** — реальное приложение RaceLive (Next.js+FastAPI, ~4 ГБ RAM), разворачивается
  `deploy-racelive.sh` поверх. См. раздел ниже.

## Структура

```
site/                 # Arclayer (основной decoy, -> /var/www/decoy)
  index.html  network.html  build.html  company.html  404.html  robots.txt
  assets/             # app.css, app.js, favicon.svg (общие для всех страниц)
site-sepia/           # «Сепия» (альтернативный одностраничный decoy)
provision-node.sh     # провижинг ноды (всё кроме remnanode)
tune-kernel.sh        # тюнинг ядра (BBR+cake, swap, nofile)
node-check.sh         # проверка ноды: меню, CPU, сеть, блокировки (РФ), гео IP, пик против тишины
stats/                # VictoriaMetrics на сервере панели — приёмник статистики node-check
deploy-racelive.sh    # вариант SITE=racelive (черновик)
```

## Что делает provision-node.sh

Ставит и настраивает **всё, кроме самого remnanode**:

1. nginx-заглушку на `127.0.0.1:8081` (http2 + TLS1.3), decoy из `site/`
2. сертификат Let's Encrypt (HTTP-01 webroot, авто-продление)
3. nftables-фаервол:
   - наружу только `80` и `443`
   - `NODE_PORT` (2222) — только с IP панели
   - SSH — только с `ADMIN_IP`
   - всё остальное — `RST` (как будто порт закрыт)
   - безопасное применение с авто-откатом (`nft flush` через 120с, если не подтвердить)
4. генерацию ключей **X25519 + shortId** (для вставки в Config Profile панели)

## Использование

На свежем NL-сервере (Debian/Ubuntu):

```bash
git clone https://github.com/oINCLUDEo/Sepia.git
cd Sepia
sudo DOMAIN=studio.ulya.space ./provision-node.sh
```

Переопределяемые параметры (env, есть дефолты под парк `ulya.space`):

| env | дефолт | смысл |
|-----|--------|-------|
| `DOMAIN` | — (обязательно) | поддомен ноды = SNI |
| `EMAIL` | `ulya-tech@yandex.com` | для Let's Encrypt |
| `PANEL_IP` | `51.89.110.208` + `179.253.100.109` (панель переезжает 15.11) | доступ к NODE_PORT |
| `ADMIN_IP` | `95.104.206.188` | SSH-доступ (динамический — обновлять!) |
| `NODE_PORT` | `2222` | control-порт remnanode |
| `STUB_PORT` | `8081` | локальный порт заглушки |

После скрипта:
1. поставить **remnanode** штатно (NODE_PORT + SECRET_KEY из панели);
2. вписать выведенные `privateKey/publicKey/shortId/serverNames/target` в
   Config Profile → Inbound, привязать Host (`address` = **домен**) к ноде, добавить в Squad.

## Предварительно

- A-запись `DOMAIN` → IP ноды, **DNS-only** (без Cloudflare-proxy).
- Держать открытой консоль хостера (VNC) при первом применении фаервола.
- `ADMIN_IP` динамический: при смене IP обновить правило и перезапустить `nft -f /etc/nftables.conf`
  (или перейти на Tailscale/Headscale — SSH только из mesh).

## Тюнинг ядра — tune-kernel.sh

Отдельный скрипт, можно гонять и на новых, и на уже работающих нодах
(из `provision-node.sh` вызывается при `TUNE=1` или ответе `y` на вопрос).

```bash
sudo bash tune-kernel.sh                              # cake, IPv6 off, swap 1G
sudo QDISC=fq NO_IPV6=0 SWAP_SIZE=2G bash tune-kernel.sh
```

Что делает:
- BBR + qdisc (`cake` по умолчанию, `QDISC=fq` легче по CPU); qdisc держится после
  перезагрузки через `rw-qdisc.service`
- буферы/очереди/TIME_WAIT/conntrack под тысячи соединений, `tcp_mtu_probing`
- hardening: анти-спуфинг, ICMP, ptrace, ASLR
- IPv6 off + вычищает `listen [::]` из nginx
- `ip_forward=0`, но только если нет контейнеров в bridge-сети (иначе оставляет 1)
- swap-файл, если свопа нет; `swappiness=10`
- `nofile=1048576` для контейнеров (`default-ulimits` в `/etc/docker/daemon.json`)

Всё пишется в `/etc/sysctl.d/99-rw-node.conf`, `/etc/modules-load.d/rw-node.conf`;
бэкапы изменённых файлов — `/root/rw-tune-backup/<дата>/`. **Не для сервера панели**
(скрипт сам откажется, если видит контейнер `remnawave/backend`).

## Проверка ноды — node-check.sh

```bash
sudo bash node-check.sh                 # меню
sudo bash node-check.sh full            # полный прогон ~3 мин (NO_IPERF=1 — без нагрузки на канал)
sudo bash node-check.sh install         # cron: снимок каждые 15 мин -> /var/log/rw-node-check.csv
sudo bash node-check.sh report          # через сутки-двое: средние по часам, пик против тишины
sudo bash node-check.sh stats           # выгрузка в VictoriaMetrics (URL, логин, пароль, имя ноды)
```

- **full**: система и настройки (BBR, IPv6, Xray), нагрузка сейчас, sysbench 1 поток + steal под
  полной нагрузкой, пинг/потери, iperf3 до РФ в обе стороны, страна IP по ipinfo, ip-api, ChatGPT
  (Cloudflare) и YouTube. В конце — список замечаний.
- **Нода в РФ** определяется сама (RU=1/RU=0 — принудительно): вместо пинга до РФ — пинг до Европы,
  плюс «заморозка» TLS на 16–20 КБ до Hetzner/OVH/Vultr (ТСПУ), сайты, которые режет DPI, скорость
  скачивания из Европы.
- **quick** (из cron): CPU/steal, трафик, соединения, ретрансмиты, conntrack, CPU Xray, RTT (до РФ,
  у РФ-ноды — до Европы); без iperf, канал юзеров не трогает.
- **report**: таблица по часам суток, пиковый час против самого тихого и что деградирует в пик.

Чужие скрипты не качает (в отличие от multitest). Наружу уходят только метрики в свою
VictoriaMetrics, если настроить. Настройки ноды: `/etc/rw-node-check.conf` (600).

### Статистика всех нод — stats/

На сервере панели: `cd stats && cp .env.example .env` (задать `VM_PASS`), `docker compose up -d` —
контейнер `node-stats` в сети `remnawave-network`. В `/opt/remnawave/caddy/Caddyfile` в блок
`panel.ulya.space` добавить `handle /node-stats/* { reverse_proxy node-stats:8428 }` (остальное — в
`handle { ... }`). Отдельный поддомен не годится: `DOCKER-USER` не пускает Let's Encrypt, серт не выпустится.
Ноды пустить на 443: `iptables -I DOCKER-USER -s <IP_ноды> -p tcp --dport 443 -j ACCEPT && netfilter-persistent save`.

Дашборд (`stats/dashboard/`, контейнер `node-dash`): `https://panel.ulya.space/node-stats/dash/` — карточки нод,
динамика, часы пик, полные проверки; вход тем же логином/паролем. Открытый с диска `index.html` показывает
демо-данные. Шрифт Lack лежит рядом (OFL, `fonts/OFL.txt`), Carlito и Alan Sans — с Google Fonts.

Синхронизация с панелью (`stats/rw-sync.py`, на сервере панели, cron раз в 5 мин): берёт ноды из API
Remnawave, пускает их IP на 443 в `DOCKER-USER` (правила с пометкой `rw-node-sync`, лишние убирает) и пишет
справочник `node_panel_*` (имя, флаг, IP, связь, онлайн) — дашборд показывает ноды под именами из панели,
а ноды без node-check — карточкой «нет статистики». Установка: `python3 /opt/Sepia/stats/rw-sync.py --install`
(спросит API-токен Remnawave), проверка без изменений: `--dry-run`. Ноды сопоставляются по IP: node-check
шлёт метку `ip` (свой внешний IPv4).

На нодах: меню → 6 (URL `https://panel.ulya.space/node-stats/write`, тот же логин/пароль), затем
меню → 5 (сбор). Графики — `https://panel.ulya.space/node-stats/vmui`, метрики `node_quick_*{node="..."}`
(каждые 15 мин) и `node_full_*` (после полных прогонов), например `node_quick_tx_mbps`,
`node_quick_cpu_st`, `node_quick_rtt_ms`.

## TODO

- Перевести выпуск серта на **wildcard `*.ulya.space` через DNS-01** (скрывает хостнеймы
  из Certificate Transparency; убирает зависимость от порта 80).
