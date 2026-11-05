#!/usr/bin/env bash
# node-auth на самом деле отвечает: /me без входа — 401, вход — 204 и cookie, с cookie — 204, не JSON — 400.
# Компиляция такого не ловит: например, метод обработчика с именем базового класса ломал каждый запрос
set -u
PORT=18090 VM_USER=node VM_PASS=ci-password-123 AUTH_SECRET=$(printf 'a%.0s' $(seq 40)) COOKIE_SECURE=0 \
  python3 stats/auth/auth.py >/tmp/auth-ci.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for _ in $(seq 20); do curl -s -o /dev/null http://127.0.0.1:18090/node-stats/auth/me && break; sleep .3; done
U=http://127.0.0.1:18090/node-stats/auth
fail=0
check(){ [ "$2" = "$3" ] && echo "ok   $1: $2" || { echo "FAIL $1: $2, ожидалось $3"; fail=1; }; }
check 'me без входа' "$(curl -s -o /dev/null -w '%{http_code}' $U/me)" 401
check 'неверный пароль' "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"user":"node","pass":"x"}' $U/login)" 401
check 'не JSON' "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '[1]' $U/login)" 400
cookie=$(curl -s -D - -o /dev/null -H 'Content-Type: application/json' -d '{"user":"node","pass":"ci-password-123"}' $U/login | sed -n 's/^Set-Cookie: \(ulya_stats=[^;]*\).*/\1/p')
check 'вход' "$([ -n "$cookie" ] && echo cookie || echo нет)" cookie
check 'с cookie' "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $cookie" $U/verify)" 204
check 'настройка без ADMIN_PASS' "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $cookie" -H 'Content-Type: application/json' -d '{}' $U/setup)" 501
if grep -q Traceback /tmp/auth-ci.log; then echo 'FAIL в журнале node-auth есть Traceback:'; cat /tmp/auth-ci.log; fail=1; fi
exit $fail
