# CITADEL/EWS Python Node v1

## Windows compatibility release 0.3.11-wincompat.1

- `winget` больше не обязателен для установки Python.
- Setup сначала использует уже установленный совместимый Python 3.12–3.14, затем пробует `winget`, а при его отсутствии или ошибке скачивает официальный Python 3.13.15 с python.org и проверяет SHA-256 до запуска.
- Для 32-битного Python на Windows используется отдельный `requirements-win32.txt` с готовыми win32 wheels.
- Windows dependency install выполняется с `--only-binary=:all:`, поэтому installer не пытается собирать C/Rust зависимости на старом или необычно настроенном ПК.
- Этот compatibility release не обходит Windows security policy и не требует скрытой установки; он рассчитан на компьютеры, где пользователь разрешил установку.

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

Адрес контроллера уже встроен. Setup использует совместимый Python 3.12–3.14; если Python отсутствует, Windows Package Manager используется как первый вариант, но не является обязательным. При отсутствии/ошибке `winget` Setup использует официальный проверяемый Python 3.13.15 installer, выбирая x86/x64/ARM64 по архитектуре Windows. Затем создаётся отдельное `.venv`, ставится подходящий набор бинарных зависимостей, выполняются `doctor` и self-test, узел автоматически регистрируется и проверяет живой цикл с Controller.

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
