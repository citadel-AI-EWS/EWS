CITADEL/EWS QUICK AGENT 0.3.16 — WINDOWS

ОСНОВНАЯ УСТАНОВКА
1. Полностью распакуйте ZIP.
2. Дважды нажмите START_HERE.cmd.
3. Дождитесь строки:
   [CITADEL] READY: CITADEL Quick Agent is installed and running.

Никакой EXE-установщик не нужен.
Права администратора не нужны.
PowerShell для обычной установки не нужен.
Системный Python не нужен: приватный Python runtime уже находится внутри пакета.

КУДА УСТАНАВЛИВАЕТСЯ
- программа: %LOCALAPPDATA%\CitadelEWS\releases\0.3.16
- состояние/identity: %LOCALAPPDATA%\CitadelEWS\state
- автозапуск: только текущий пользователь (HKCU Run)

После входа пользователя в Windows Quick Agent запускается автоматически.
Если нужна работа ещё ДО входа пользователя, используйте отдельный Core Service вариант.

CONTROLLER / HUB
Agent сам создаёт Ed25519 identity, регистрируется на
https://citadel-ai.init1.workers.dev
и после успешного heartbeat появляется в Hub.
Если интернет или Controller временно недоступны, установка остаётся целой,
а Agent продолжит безопасные повторные попытки позже.

LM STUDIO / LLMSTER
Quick installer пытается подготовить headless LM Studio автоматически.
На Windows PowerShell installer не выполняется:
Python helper читает официальные metadata LM Studio, скачивает официальный
llmster archive с llmster.lmstudio.ai, проверяет SHA-512 и запускает только
проверенный llmster.exe bootstrap.

Установка LM Studio считается успешной только если:
- lms daemon up прошёл;
- lms server start --port 1234 --bind 127.0.0.1 прошёл;
- http://127.0.0.1:1234/v1/models реально ответил.

Сервер остаётся локальным на 127.0.0.1 и не публикуется в LAN/Internet.
Если в LM Studio вручную включена Require Authentication, можно задать
LM_API_TOKEN в окружении или lm_api_token в config.json; Agent добавит Bearer token.
По умолчанию локальная аутентификация LM Studio не требуется.

MULTI-AGENT
Один установленный CITADEL Agent может создавать bounded локальные mini-workers
для разделения одной задачи на части. Они работают внутри разрешённого компьютера
и не устанавливают CITADEL на другие компьютеры.

УДАЛЕНИЕ
Запустите UNINSTALL.cmd. Он отключит user autostart и остановит Agent.
