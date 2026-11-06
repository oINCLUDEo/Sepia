#!/usr/bin/env bash
# Проверка кода перед пушем — локально, без GitHub Actions (там они платные для приватного репозитория).
#   bash ci/check.sh
# Что нужно: bash, python3, node. Необязательное (если нет — шаг пропускается с пометкой):
#   shellcheck (pip install shellcheck-py), vmalert-prod (из vmutils VictoriaMetrics), playwright с chromium.
# Ноды при самообновлении всё равно проверяют себя сами (bash -n + настоящий замер) и откатывают сломанное.
cd "$(dirname "$0")/.." || exit 1
fail=0
step(){ printf '\n\033[1m%s\033[0m\n' "$1"; }
ok(){ printf '  \033[32mok\033[0m %s\n' "$1"; }
bad(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }
skip(){ printf '  \033[33mпропуск\033[0m %s\n' "$1"; }

step 'Скрипты bash — синтаксис'
for f in *.sh ci/*.sh probe/*.sh; do bash -n "$f" && ok "$f" || bad "$f"; done
step 'shellcheck (только ошибки)'
if command -v shellcheck >/dev/null 2>&1; then shellcheck -S error ./*.sh probe/*.sh && ok 'без ошибок' || bad shellcheck; else skip 'нет shellcheck: pip install shellcheck-py'; fi

step 'Python — компиляция'
python3 -m py_compile stats/rw-sync.py stats/rename-node.py stats/auth/auth.py stats/setup/setup.py probe/agent.py && ok 'все модули' || bad py_compile
step 'node-auth — отвечает и пускает'
bash ci/auth-smoke.sh || fail=1

step 'Дашборд — синтаксис JS'
for f in stats/dashboard/assets/*.js; do node --check "$f" 2>/dev/null || bad "$f"; done; [ $fail = 0 ] && ok 'все файлы'
step 'Дашборд на демо-данных — все разделы без ошибок'
if node -e "require('playwright')" 2>/dev/null; then node ci/smoke.js || fail=1; else skip 'нет playwright: npm i playwright && npx playwright install chromium'; fi

step 'Алерты — vmalert -dryRun'
VMA=$(command -v vmalert-prod || command -v vmalert || true)
if [ -n "$VMA" ]; then "$VMA" -rule=stats/alerts/rules.yml -dryRun >/dev/null 2>&1 && ok rules.yml || bad 'rules.yml'; else skip 'нет vmalert-prod'; fi

step 'Самопроверка node-check (настоящий замер, ничего не отправляет; нужен root)'
if [ "$(id -u)" = 0 ]; then timeout 60 bash node-check.sh selftest >/dev/null 2>&1 && ok selftest || bad selftest; else skip 'не root: sudo bash ci/check.sh'; fi

echo
[ $fail = 0 ] && printf '\033[32mВсё в порядке\033[0m\n' || printf '\033[31mЕсть ошибки — смотрите выше\033[0m\n'
exit $fail
