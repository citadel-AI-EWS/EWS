# CITADEL/EWS Python Node v1

## v0.3.16 — Local Windows Agent без admin и системного Python

- `START_HERE.cmd` устанавливает Local Agent по умолчанию: без UAC, без `RunAs`, без Winget и без системной установки Python.
- Windows ZIP содержит собственный официальный Python 3.14.7 embeddable runtime; Local Agent хранится в `%LOCALAPPDATA%\CitadelEWS\local-agent`.
- Local Agent запускается через собственный hidden watchdog при входе пользователя и поддерживает restart/update exit-codes агента.
- Корпоративная Windows Service остаётся отдельным режимом через `Install Windows Service.cmd`; только этот режим требует Administrator, потому что создаёт системную службу.
- Windows LM Studio/llmster больше не запускает PowerShell installer. Agent читает из официального `install.ps1` только allowlisted metadata, скачивает официальный llmster ZIP, требует SHA-512 checksum и запускает фиксированный `llmster.exe bootstrap` без shell.
- Local Agent и встроенный runtime проходят отдельный Windows CI: self-test, doctor, временная no-admin установка и uninstall.
- x64, x86 и ARM64 получают отдельные bundled Python runtimes; неподдерживаемая архитектура завершается явной ошибкой, без попытки ставить что-либо в систему.

## v0.3.15 — mini-workers, delta update и стабильный llmster HOME

- Python-only проект координирует до 8 локальных mini-workers (до 4 одновременно) и не вызывает LLM.
- Mini-workers выполняют только bounded/deterministic операции существующего Python-only режима; произвольный remote Python/exec по-прежнему запрещён.
- Обновление агента сравнивает локальный SHA-256 с release manifest и скачивает/заменяет только изменившиеся файлы.
- Перед delta-update сохраняется полный core backup для health-check/rollback.
- LM Studio/llmster получает стабильный CITADEL-managed HOME в state-каталоге, поэтому Windows LocalService и последующие команды видят один и тот же runtime/models.
- Официальный llmster installer по-прежнему проверяется CITADEL helper hash и запускается без shell.
- Windows always-on guard повторно заявляет `ES_SYSTEM_REQUIRED`, поэтому автоматический sleep/hibernate не должен срабатывать, пока long-running Agent активен. Явный shutdown/hibernate пользователя не перехватывается.
- При потере сети агент проверяет доступность Controller, выполняет DHCP renew и перебирает только ранее использованные или явно разрешённые Wi‑Fi профили; после каждого подключения проверяется достижимость Controller.
- Произвольные открытые/неизвестные Wi‑Fi сети автоматически не подключаются. Их можно добавить в `allowed_wifi_profiles` только после явного решения администратора.

## v0.3.14 — Python-only execution и управление LM Studio

- Architect и Hub могут отправлять задачи в режим `Python only`: агент выполняет только детерминированные операции и не вызывает LM Studio, LLM или OpenRouter.
- Для проектов добавлена capability `project_python`; Python-only проект не требует установленной или загруженной языковой модели.
- Python-only executor поддерживает ограниченные вычисления, анализ `text:`, проверку/разбор `json:` и диагностику CPU/RAM/диска/сети. Свободный вопрос, который Python не может достоверно вывести, завершается явным сообщением вместо скрытого перехода к ИИ.
- Добавлена подписанная команда `lmstudio_uninstall` с отдельным подтверждением Architect. По умолчанию удаляется только runtime; модели и данные сохраняются.
- Полное удаление CITADEL-managed LM Studio data/model storage доступно только по отдельному `purge_data` и тому же явному подтверждению.
- Удаление LM Studio не удаляет CITADEL Agent, node identity или Controller enrollment.

## v0.3.13 — Windows Enterprise Services

- Агент включает hash-pinned read-only probe `windows_enterprise_probe.ps1`; он запускается только из локального allowlist-кода Agent с `shell=False`.
- Probe собирает CIM/Performance Counters, краткие счётчики критических/ошибочных событий Windows Event Log, Windows Update/reboot/hotfix state, Hyper-V inventory, domain/GPO, MDM/Intune и service-identity readiness.
- Для gMSA/dMSA агент сообщает только проверяемую готовность/identity-кандидат и не угадывает тип managed service account без авторитетных данных AD.
- Hotpatch не объявляется включённым по локальным косвенным признакам: без внешнего Microsoft management signal показывается `external-management-required`.
- Hyper-V, GPO/Intune/MDM и Event Log используются как read-only adapters; Agent не включает роли Windows, не меняет tenant/domain policy и не открывает WinRM.
- Controller/Architect добавляют RBAC `owner / operator / viewer`, Desired State / compliance, Sites / Node Groups, SHA-256 verification последнего inventory и recovery manifest без тел отчётов и секретов.
- Никакого универсального PowerShell/WinRM, удалённого shell или произвольного command text в Enterprise layer нет.

## v0.3.12 — Windows Core Service

- Core Agent устанавливается как видимая Windows Service `CitadelEWSNode` под `NT AUTHORITY\LocalService`.
- Тип запуска: `Automatic (Delayed Start)`; служба работает после загрузки Windows без входа пользователя.
- Старый Startup shortcut удаляется; core-процесс больше не зависит от пользовательского логина.
- Installer переносит существующую node identity из старого профиля в `%ProgramData%\CitadelEWS\state` и сохраняет `node_id`.
- State/install ACL разрешают LocalService только необходимый Modify-доступ; SYSTEM и Administrators сохраняют полный контроль.
- Подписанный `restart`/update перезапускает Python child внутри service-host; подписанный `stop` не вызывает recovery-loop.
- Узел сообщает capability `windows_core_service` только когда Python Core реально запущен через SCM-host; одна версия 0.3.12 сама по себе не считается доказательством миграции.
- Обычный Windows Stop/Shutdown использует отдельный временный файл `SERVICE_STOP`; постоянный `STOP` зарезервирован только для подписанного uninstall и не может случайно пережить перезагрузку из-за остановки Windows.
- Установка строит новый versioned release полностью до cutover: venv, зависимости, self-test, enrollment/live-cycle и компиляция service-host проходят, пока старый агент продолжает работать.
- При замене уже существующей службы её SCM-конфигурация сохраняется и восстанавливается при ошибке запуска новой версии.
- Профиль исходного пользователя определяется по SID, переданному через UAC; identity/PAUSED/queue переносятся именно из его профиля, а не из профиля введённого администратора.
- ACL для ProgramData собирается с нуля до копирования identity или исполняемых файлов: SYSTEM/Administrators — FullControl, LocalService — Modify.
- Новый service-agent во время cutover временно удерживается маркером `SERVICE_HOLD`, чтобы не было окна двойного выполнения заданий со старым Startup-agent. Durable-состояние `PAUSED` переносится отдельно.
- Конфигурация службы записывается через Win32_Service API и после записи перечитывается и проверяется; хрупкий `sc.exe binPath=` не используется.
- `setup_windows.ps1 -Uninstall` удаляет службу и CITADEL-компоненты; `-PreserveState` оставляет node state по явному запросу.
- LM Studio остаётся headless runtime: если он устанавливается из Core Service, он работает в профиле LocalService, без интерактивного desktop-сеанса.

## v0.3.11 — защищённая Windows identity

- На Windows Ed25519 private key больше не сохраняется в `identity.json` как читаемый PKCS#8 PEM.
- Ключ сохраняется как machine-bound DPAPI blob; копия state-файла на другой Windows host не должна давать рабочую node identity.
- Legacy `private_key_pem` автоматически мигрирует при первом запуске 0.3.11 с сохранением `node_id`.
- Windows installer ограничивает ACL каталога state текущим устанавливающим пользователем, SYSTEM и Administrators.
- Linux пока сохраняет прежний формат с жёсткими файловыми правами; отдельное защищённое хранилище для Linux остаётся следующим security increment.

Постоянный прозрачный агент для компьютеров, принадлежащих оператору или находящихся под его администрированием. Он подключается напрямую к существующему Cloudflare Controller `/api/v1`, получает только разрешённые задания, отправляет heartbeat и результаты и проверяет Ed25519-подписи управляющих команд.

## v0.1.0

- отдельная Ed25519-идентичность для каждого разрешённого компьютера;
- одноразовая регистрация через enrollment token; токен не записывается в постоянный config;
- подпись каждого запроса узла в точном формате API v1;
- heartbeat, получение assignments и отправка полных результатов;
- локальная очередь результатов при временной потере связи;
- CPU/RAM guard и экспоненциальный backoff;
- проверка подписи Controller для `pause`, `resume`, `uninstall`;
- локальные `PAUSED`/`STOP` и JSONL-журнал;
- только локально зарегистрированные mission handlers. В первой версии включён `system_inventory`.

Здесь нет remote shell, выполнения произвольного кода, сбора паролей/токенов, скрытой установки, самораспространения, обхода защиты или механизма эксплуатации сторонних систем.

## Windows setup

Рекомендуемый путь для обычного/чужого компьютера без административных прав:

```text
START_HERE.cmd
```

Этот путь использует Python runtime из самого ZIP и устанавливает Local Agent в профиль текущего пользователя. PowerShell, Winget и системный Python для Local Agent не нужны. Автозапуск создаётся только для текущего пользователя.

Если компьютер находится под администрированием и нужен machine-wide Core Service до входа пользователя, используйте отдельный `Install Windows Service.cmd`. Этот режим законно требует UAC/Administrator, потому что регистрирует Windows Service `CitadelEWSNode` под LocalService.

Unattended/autostart предназначен только для компьютеров, принадлежащих оператору или находящихся под его администрированием.

## Ручной запуск

```powershell
.\.venv\Scripts\python.exe .\citadel_node_v1.py self-test
.\.venv\Scripts\python.exe .\citadel_node_v1.py doctor --config .\config.json
.\.venv\Scripts\python.exe .\citadel_node_v1.py once --config .\config.json
.\.venv\Scripts\python.exe .\citadel_node_v1.py run --config .\config.json
```

## Следующие обработчики

Из проверенного Drive-пакета будут переноситься по одному: `file_integrity`, `python_inventory`, `system_health`, `log_audit` и чтение разрешённых defensive feeds. Каждый получает отдельные лимиты входа, времени, файлов и сети и отдельные тесты.

Задания из интернета никогда не должны сразу исполняться агентом: сначала `source provenance → deduplication → safety classification → quarantine → Architect approval → assignment`.
