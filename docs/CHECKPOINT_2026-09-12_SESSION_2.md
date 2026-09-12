# EWS контрольная точка — 2026-09-12 · Session 2

Эта запись является точкой продолжения следующего рабочего сеанса. Не начинать проект заново: продолжать с `main` после merge PR #23.

## Что завершено

- PR #22: проверка Cloudflare deploy стала устойчивой к задержке распространения новой версии без ослабления health-gate.
- PR #23: безопасный Python Node v0.1.0 слит в `main`.
- Commit после merge: `828b04f8dcf02a933a064a2cf59e616d62bff4d8`.
- Post-merge GitHub CI: SUCCESS.
- Cloudflare TEST deploy: SUCCESS.
- Controller: 15 тестов PASS; D1 report/session tests PASS; Cloudflare dry-run PASS; Bandit PASS.
- Drive `Материалы 2024` проверен. Из `CITADEL_UNIFIED_v20.1.0_2026-09-11` переносим полезные идеи по одной, но не копируем несовместимый local Hub/SQLite/HMAC протокол в Cloudflare Controller.

## Python Node v0.1.0

В `agent/` находятся Node, requirements, example config, Windows setup и README.

Node умеет:
- explicit one-time enrollment;
- Ed25519 signed API `/api/v1`;
- heartbeat;
- получать/принимать assignment;
- возвращать полный result/report;
- сохранять очередь результатов при обрыве связи и повторять отправку;
- CPU/RAM guard;
- signed pause/resume/stop commands;
- локальные JSONL logs;
- `PAUSED` / `STOP` controls.

Сейчас зарегистрирован только bounded handler `system_inventory`.

Node не содержит remote shell, произвольного загрузчика кода, кражи credentials, exploit engine, lateral movement, self-propagation, скрытой установки или автономных финансовых транзакций.

Windows setup создаёт venv, ставит заявленные библиотеки, проверяет конфигурацию и регистрирует Node. Скрытый autostart/service намеренно не устанавливается. Production unattended startup должен идти через подписанный пакет и явно разрешённый стандартный механизм администрирования.

## Cloudflare storage planning

Актуальный snapshot на 2026-09-12:
- D1 Free: 500 MB на одну базу;
- до 10 D1 databases;
- до 5 GB D1 storage суммарно по аккаунту;
- R2 Standard: 10 GB-month free storage плюс free monthly operation allowances.

Для EWS установлен консервативный operating target: не заполнять активную D1 выше ~400 MiB. Metadata, indexes, audit и checkpoints остаются в D1; большие report bodies/files должны уходить в R2 до приближения к лимиту.

## Найденные UX/функциональные факты

Уже присутствуют:
- отдельный защищённый Architect login;
- Emergency Control с Stop selected / Stop all / Wipe selected nodes / Wipe entire environment;
- upload malware/prohibited-material acknowledgement;
- Sandbox / Simulated Internet UI;
- RU/EN data attributes;
- Architect durable session checkpoints.

Найден важный незакрытый gap: текущий `controller_tests.py` специально проверяет отсутствие `clientLogin`, `client-section` и `loginClient()` в `index.html`. Это не соответствует постоянному требованию EWS о настоящей клиентской авторизации и role-separated Client/Architect UX. Зафиксировано issue #28.

## Security finding

`npm ci` сейчас показывает 3 high findings в development-only Cloudflare tooling dependency graph (`wrangler/miniflare/sharp`). Это не браузерный/runtime Python Node код. Не применять слепой `npm audit fix --force`. Remediation зафиксирован issue #24; после vendor-compatible fix high-severity npm audit должен стать CI gate.

## Следующие задачи — порядок

1. Issue #25 — signed node telemetry/log ingestion, Architect log browser, 7-day retention, hard caps/deduplication.
2. Issue #26 — D1 metadata + R2 report/file bodies, retention/deletion, migration with hash verification, storage warnings.
3. Issue #28 — полноценный Client portal/login, project reopen/create flow, mobile/RU-EN/accessibility UX.
4. Issue #27 — Internet task intake: provenance → dedupe → classification → quarantine → Architect approval → bounded mission. Internet content never directly controls an agent.
5. Port Drive handlers по одному: `file_integrity`, `python_inventory`, `system_health`, `log_audit`, approved defensive feeds; отдельные limits/tests для каждого.
6. Failure-injection / recovery / tenant-isolation / mobile UX testing before production.
7. Issue #24 — remove inherited high npm audit findings without breaking Cloudflare tooling.

## Правило работы дальше

После каждого существенного рабочего сеанса создавать новую `docs/CHECKPOINT_YYYY-MM-DD_*.md` и указывать:
- последний merged commit;
- что реально прошло CI/TEST deploy;
- что изменено в D1/R2/API/agent/UI;
- открытые security/UX gaps;
- точный следующий шаг.
