# CITADEL/EWS Python Node v1

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

Нужен Python 3.11+ и одноразовый enrollment token, созданный Архитектором.

```powershell
powershell -File .\setup_windows.ps1 -EnrollmentToken "ONE-TIME-TOKEN"
```

Setup создаёт отдельное `.venv`, ставит зависимости, выполняет `doctor`, регистрирует узел и затем очищает token из процесса. Он **не** создаёт скрытый сервис или автозапуск.

Для постоянного запуска production-версии будет отдельный подписанный пакет. Unattended/autostart допускается только для заранее управляемых компьютеров через стандартный администраторский механизм (например, Intune/MDM/Group Policy) либо после явного локального разрешения пользователя.

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
