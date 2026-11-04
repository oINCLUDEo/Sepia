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
Запись от нод идёт через шлюз `vmauth` (контейнер `node-stats-gw`, `stats/vmauth.yml`):
`https://panel.ulya.space:9443/node-stats/write`, логин `writer`, пароль `VM_WRITE_PASS`. Шлюз пропускает только
запись, TLS — сертификатом Caddy (том `caddy-ssl-data`), служебные страницы закрыты ключом `VM_PASS`.
У самой VictoriaMetrics пароля нет (она только в docker-сети и на 127.0.0.1): чтение (дашборд, vmui) на 443
проверяет Caddy — `basic_auth` в блоке `handle /node-stats/*` с хешем `VM_PASS` (`caddy hash-password`).
Белый список IP нодам больше не нужен — `FIREWALL=0` в `/etc/rw-node-sync.conf` снимает правила `rw-sync`.

Дашборд (`stats/dashboard/`, контейнер `node-dash`): `https://panel.ulya.space/node-stats/dash/`, вход тем же
логином/паролем. Открытый с диска `index.html` показывает демо-данные.

- **Шапка**: знак Ulya, отлитый из фото металла из гайдлайна: правое звено — фото, левое рассыпается в ASCII
  (символ — по яркости металла), из него выходят строки кода; статично. Под знаком: трафик сейчас, онлайн, пик за сутки, сколько нод с замечаниями, самый загруженный канал
  (текущая отдача / лучший iperf из полной проверки). Плашки состояний под ней фильтруют карточки.
- **Ноды**: группы «Выходы» и «Мосты в РФ»; отключённые в панели и ноды без статистики — свёрнутым списком в конце.
  Замолчавшая нода показывает последние значения серым. Вид «Карточки / Таблица». Нажатие на ноду открывает
  панель со всеми метриками (память, conntrack, CPU Xray, джиттер, входящий трафик, DPI), графиками и
  доступностью; ссылка вида `…/dash/#node=DE-Aeza-2` открывает её сразу.
- **Динамика** (сутки / неделя / месяц), **часы пик**, **полные проверки**, **хостеры за 30 дней** (хостер — из
  имени ноды: `DE-Aeza-2` → Aeza; средний steal, ретрансмиты, потери, худшая доступность).
- Пороги «замечание / плохо» — одна таблица `TH` в `index.html`; те же «плохо» — в `stats/alerts/rules.yml`.
- **Ни одного внешнего запроса**: шрифты (Lack, Carlito, Alan Sans — OFL) в `fonts/`, флаги (flag-icons, MIT) в
  `flags/`, фото шапки вшито. `no-referrer` и CSP `default-src 'self'` прописаны в самой странице, так что адрес
  панели и IP админа не уходят Google и CDN флагов.

**Алерты в Telegram** (`stats/alerts/`): vmalert считает правила по тем же метрикам, Alertmanager шлёт в чат.

```bash
cd /opt/Sepia/stats
cp alerts/alertmanager.yml.example alerts/alertmanager.yml   # вписать chat_id служебного чата
printf '%s' '123456:ABC...' > alerts/tg_token && chmod 644 alerts/tg_token   # токен бота
docker compose --profile alerts up -d
```

Что приходит: нода молчит больше 30 минут; ретрансмиты выше 5% дольше часа; steal выше 15%, CPU выше 90%,
потери выше 2%, память выше 92% дольше 30 минут; conntrack выше 90%; панель не видит включённую ноду;
`rw-sync.py` 30 минут не обновлял справочник. Когда проблема уходит — сообщение «прошло».

**Как читать ретрансмиты.** Это доля TCP-сегментов, отправленных повторно, по всей ноде (и к юзерам, и в интернет).
С BBR 1–3% — норма: он сам прощупывает канал и терпит потери. 3–5% — смотреть, выше 5% дольше часа — алерт.
Что делать: `node-check.sh report` (растёт только в пик → упирается канал или хостер; держится всегда → плохой
маршрут), `mtr -rwzc 200 <IP в РФ>` с ноды (на каком хопе начинаются потери), сравнить ноды одного хостера в
таблице «Хостеры» (высокие у всех нод хостера → сеть хостера, писать в поддержку или переезжать).

Синхронизация с панелью (`stats/rw-sync.py`, на сервере панели, cron раз в 5 мин): берёт ноды из API
Remnawave, пускает их IP на 443 в `DOCKER-USER` (правила с пометкой `rw-node-sync`, лишние убирает) и пишет
справочник `node_panel_*` (имя, флаг, IP, связь, онлайн) — дашборд показывает ноды под именами из панели,
а ноды без node-check — карточкой «нет статистики». Установка: `python3 /opt/Sepia/stats/rw-sync.py --install`
(спросит API-токен Remnawave), проверка без изменений: `--dry-run`. Ноды сопоставляются по IP: node-check
шлёт метку `ip` (свой внешний IPv4).

На нодах: меню → 6 (URL `https://panel.ulya.space:9443/node-stats/write`, логин `writer`, `VM_WRITE_PASS`), затем
меню → 5 (сбор). Графики — `https://panel.ulya.space/node-stats/vmui`, метрики `node_quick_*{node="..."}`
(каждые 15 мин) и `node_full_*` (после полных прогонов), например `node_quick_tx_mbps`,
`node_quick_cpu_st`, `node_quick_rtt_ms`.

## TODO

- Перевести выпуск серта на **wildcard `*.ulya.space` через DNS-01** (скрывает хостнеймы
  из Certificate Transparency; убирает зависимость от порта 80).
