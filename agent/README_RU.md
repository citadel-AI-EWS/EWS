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

Адрес контроллера уже встроен. Setup при необходимости устанавливает Python 3.14 через Windows Package Manager, создаёт отдельное `.venv`, ставит зависимости, выполняет `doctor` и self-test, автоматически регистрирует узел и проверяет живой цикл с Controller. Узел получает постоянный номер; enrollment token, логин и код подтверждения не требуются.

```powershell
powershell -File .\setup_windows.ps1
```

После успешной проверки Setup создаёт обычный ярлык в папке Windows Startup и запускает один фоновый экземпляр через `pythonw.exe`. Повторный запуск Setup использует ту же Ed25519-идентичность и не должен создавать второй экземпляр агента.

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
