# Sepia

Сайт-заглушка («Сепия» — лендинг сервиса цветокоррекции видео) + скрипт провижинга
standalone VLESS+Reality **selfsteal**-ноды для Remnawave.

Сайт служит реальной страницей за заглушкой: Xray форвардит на него непрошедший
Reality-авторизацию трафик, и активный пробер видит обычный сайт.

## Структура

```
site/                 # decoy-сайт (копируется в /var/www/decoy)
  index.html          # лендинг (favicon, og-метки, живые разделы)
  404.html            # брендированная 404
  favicon.svg
  robots.txt
provision-node.sh     # провижинг ноды (всё кроме remnanode)
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

## TODO

- Перевести выпуск серта на **wildcard `*.ulya.space` через DNS-01** (скрывает хостнеймы
  из Certificate Transparency; убирает зависимость от порта 80).
