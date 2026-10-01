# CITADEL SSH / Zero Trust

## Цель

SSH в CITADEL предназначен для управляемых компьютеров владельца/администратора. Он не должен превращать Hub в хранилище постоянных SSH-ключей или в универсальный remote shell.

Целевая цепочка:

```text
Hub → Cloudflare Access → Cloudflare Tunnel → localhost:22 → OpenSSH → ForceCommand → ssh_restricted_console.py
```

Публичный TCP/22 на компьютере не требуется.

## Что хранит Hub / D1

Таблица `node_ssh_state` хранит только:

- `public_hostname` — публичный hostname Cloudflare Access;
- `ssh_user` — имя разрешённого SSH-пользователя;
- `host_key_fingerprint` — необязательный публичный fingerprint host key;
- состояние локального `sshd` и `cloudflared`;
- время последней проверки.

**Не хранить в D1/Hub:** SSH private keys, пароли, passphrase, Cloudflare Access tokens, service tokens, SSH CA private key или recovery secrets. API `PUT /api/v1/architect/nodes/{node_id}/ssh` отклоняет поля, похожие на секреты.

## Browser SSH

Для browser-rendered SSH Cloudflare public hostname должен вести через Tunnel на:

```text
SSH localhost:22
```

Доступ к hostname защищается Cloudflare Access. Кнопка **Открыть интерактивный SSH** в Hub активируется только когда:

1. для выбранной ноды сохранены hostname + username;
2. агент подтвердил, что `sshd` слушает порт 22 **только на loopback**, а не на `0.0.0.0`/LAN;
3. агент видит запущенный `cloudflared`.

Hub открывает защищённый Cloudflare browser terminal в отдельном окне/вкладке. Он не проксирует SSH-байты через D1/Worker.

## Restricted ForceCommand

Файл `agent/ssh_restricted_console.py` предназначен как `ForceCommand`. Он не запускает `bash`, `cmd.exe`, PowerShell, subprocess, arbitrary executable или произвольный путь.

Разрешены только:

```text
help
status
hostname
uptime
cpu
memory
disk
network
agent-status
agent-logs
lmstudio-status
diagnostics
ping-controller
exit
```

`ping-controller` использует только Controller URL из локального CITADEL config. Пользователь не может передать произвольный host. Shell metacharacters и неизвестные команды отклоняются.

## OpenSSH hardening

После установки OpenSSH отдельному CITADEL SSH-пользователю следует задать принудительную консоль и запретить forwarding. Пример для Linux:

```text
ListenAddress 127.0.0.1

Match User citadel-operator
    ForceCommand /path/to/citadel/.venv/bin/python /path/to/citadel/ssh_restricted_console.py --config /path/to/citadel/config.json
    PermitTTY yes
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
    GatewayPorts no
```

Для Windows используется тот же принцип: `ForceCommand` должен указывать на Python из установленного CITADEL release и `ssh_restricted_console.py`. Конкретный путь зависит от активного versioned release; его нельзя зашивать в Cloudflare или Hub.

После изменения sshd configuration конфигурацию следует проверить штатными средствами OpenSSH перед reload/restart.

## Agent / Controller contract

Agent 0.3.26 сообщает capability `ssh_probe_readonly` и раз в несколько минут отправляет read-only readiness snapshot. Команда `ssh_probe` — подписанная Controller-команда без payload, которая только заставляет агента немедленно обновить readiness heartbeat.

Restricted console встроена в agent 0.3.26 как hash-pinned payload и материализуется рядом с агентом. Поэтому обновление существующей 0.3.25 ноды до 0.3.26 не требует добавлять новый тип update-файла.

## Что остаётся внешней настройкой

CITADEL не может сам создать Cloudflare Zero Trust application/tunnel без авторизованного Cloudflare management connection. Перед первым реальным Browser SSH должны существовать:

- Cloudflare Tunnel для конкретной ноды;
- public hostname;
- Access application/policy для разрешённых пользователей;
- работающий OpenSSH server на компьютере;
- ForceCommand policy для CITADEL SSH user.

Пока эти внешние зависимости не подтверждены, Hub обязан показывать SSH как not ready и не заявлять о работающем соединении.
