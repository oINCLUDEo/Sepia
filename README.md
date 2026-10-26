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
| `PANEL_IP` | `51.89.110.208` | доступ к NODE_PORT |
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

## TODO

- Перевести выпуск серта на **wildcard `*.ulya.space` через DNS-01** (скрывает хостнеймы
  из Certificate Transparency; убирает зависимость от порта 80).
