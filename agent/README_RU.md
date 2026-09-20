# CITADEL/EWS Python Node v1

## v0.3.12 — Windows Core Service

- Core Agent устанавливается как видимая Windows Service `CitadelEWSNode` под `NT AUTHORITY\LocalService`.
- Тип запуска: `Automatic (Delayed Start)`; служба работает после загрузки Windows без входа пользователя.
- Старый Startup shortcut удаляется; core-процесс больше не зависит от пользовательского логина.
- Installer переносит существующую node identity из старого профиля в `%ProgramData%\CitadelEWS\state` и сохраняет `node_id`.
- State/install ACL разрешают LocalService только необходимый Modify-доступ; SYSTEM и Administrators сохраняют полный контроль.
- Подписанный `restart`/update перезапускает Python child внутри service-host; подписанный `stop` не вызывает recovery-loop.
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

Адрес контроллера уже встроен. Setup при необходимости устанавливает Python 3.14 через Windows Package Manager, создаёт отдельное `.venv`, ставит зависимости, выполняет `doctor` и self-test, автоматически регистрирует узел и проверяет живой цикл с Controller. Узел получает постоянный номер; enrollment token, логин и код подтверждения не требуются.

```powershell
powershell -File .\setup_windows.ps1
```

После успешной проверки Setup компилирует минимальный проверяемый service-host из `CitadelNodeService.cs`, регистрирует `CitadelEWSNode` как Automatic (Delayed Start) Windows Service и запускает Core Agent под LocalService. Повторный запуск Setup выполняет repair той же установки и сохраняет Ed25519-идентичность.

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
