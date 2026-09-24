# Windows One-Click Installer

Это рекомендуемый способ установки CITADEL/EWS Node на Windows.

## Что изменилось

На целевом компьютере больше не нужно заранее искать или устанавливать Python. В установщик заранее входят:

- отдельный x64 Python runtime только для CITADEL;
- необходимые Python-зависимости агента;
- `citadel_node_v1.py` и `citadel_node_v2.py`;
- заранее скомпилированный Windows Service host;
- проверенный helper интеграции с LM Studio.

Runtime собирается и тестируется в CI. На компьютере пользователя установщик **не запускает** `winget`, `pip install`, загрузку Python, компиляцию C# и не меняет системный PATH.

## Обычная установка

Запустить:

`CITADEL_EWS_Node_Setup_<version>_x64.exe`

Windows покажет стандартное UAC-подтверждение администратора, потому что CITADEL устанавливается как системная служба. После этого не должно быть отдельных вопросов про Python, зависимости, папки или firewall.

Установщик регистрирует `CitadelEWSNode` как Windows Service с типом запуска Automatic (Delayed Start) под `NT AUTHORITY\LocalService`.

## Тихая управляемая установка

Для компьютеров, которые принадлежат оператору или находятся под его администрированием:

```cmd
CITADEL_EWS_Node_Setup_<version>_x64.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-
```

Это unattended-режим установщика, а не обход защиты Windows. Разрешение администратора всё равно требуется.

## Работа без интернета

Сама установка не требует доступа к интернету. Если Controller в этот момент недоступен, служба остаётся установленной и запущенной, а существующий retry/backoff агента продолжает попытки связи позже.

После появления интернета агент регистрируется/сверяет node identity и начинает heartbeat. Входящий порт для связи CITADEL с Controller не открывается: соединение идёт наружу по HTTPS.

## LM Studio

Агент поддерживает оба локальных интерфейса LM Studio, которые использует CITADEL:

- REST streaming: `127.0.0.1:1234/api/v1/chat`;
- OpenAI-compatible: `127.0.0.1:1234/v1/chat/completions`.

CI проверяет оба протокола через локальный тестовый сервер, поэтому несовместимое изменение API должно остановить сборку.

Основной установщик CITADEL не ослабляет PowerShell policy ради установки LM Studio. Если `llmster` уже установлен, CITADEL обнаруживает и использует `lms`. Официальный Windows-установщик headless LM Studio сейчас PowerShell-based, поэтому на компьютерах, где организация запрещает такой запуск, LM Studio должен быть установлен разрешённым администратором способом.

## OpenRouter

OpenRouter остаётся финальным quality gate на стороне Controller/Hub и не устанавливается отдельно на каждый node. Автоматический тест проверяет endpoint chat completions, Bearer authorization, Fusion model/preset и privacy-настройки, не раскрывая реальный API key.

## Безопасность

- нет `ExecutionPolicy Bypass`;
- нет команд отключения или обхода firewall;
- нет произвольного remote shell;
- служба работает как `LocalService`, а не Administrator;
- ACL каталогов программы и state ограничиваются после установки;
- state сохраняется при удалении приложения, чтобы approved repair/reinstall мог сохранить node identity;
- для каждого собранного installer создаётся SHA-256.

## Что ещё нужно перед публичным production-релизом

Публичный Windows installer желательно Authenticode-подписать сертификатом проекта. SHA-256 позволяет проверить конкретный пакет, но именно цифровая подпись даёт Windows подтверждённого издателя и заметно уменьшает предупреждения SmartScreen. CI намеренно не создаёт фиктивный сертификат и не хранит приватный signing key в репозитории.
