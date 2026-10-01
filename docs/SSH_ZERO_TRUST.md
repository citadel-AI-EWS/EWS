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
3. агент видит запущенный `cloudflared`;
4. агент подтверждает CITADEL-managed `ForceCommand` и запрет TCP/X11/tunnel forwarding.

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

## Локальный SSH bootstrap / repair

Agent 0.3.27 не получает постоянных административных прав. Изменение системного `sshd_config` выполняется только через уже привилегированный installer/repair путь.

### Windows

Для versioned repair package:

```powershell
.\setup_windows.ps1 -ConfigureSsh -SshUser <existing-local-user>
```

Если Windows OpenSSH Server ещё не установлен, это должно быть отдельным явным действием:

```powershell
.\setup_windows.ps1 -ConfigureSsh -SshUser <existing-local-user> -InstallOpenSsh
```

Для one-click installer эквивалентный opt-in:

```text
CITADEL_EWS_Node_Setup_0.3.27_x64.exe /CONFIGURESSH=1 /SSHUSER=<existing-local-user>
```

Опциональный `/INSTALLOPENSSH=1` разрешает installer добавить Windows capability `OpenSSH.Server~~~~0.0.1.0`. Без этого параметра отсутствие OpenSSH считается явной ошибкой SSH-bootstrap, а обычная установка CITADEL остаётся без сетевой зависимости.

Windows bootstrap:
- не создаёт Windows accounts и не задаёт им пароли;
- создаёт server host keys только локально через OpenSSH, если их ещё нет;
- не копирует private host keys в Hub/D1;
- не создаёт inbound firewall rule;
- сохраняет исходный `sshd_config`, проверяет новый через `sshd -t` и откатывает при неудаче;
- после запуска проверяет фактические listeners и принимает только loopback.

### Linux

На Linux OpenSSH server устанавливается средствами самой ОС. После этого elevated install/repair можно запустить с:

```bash
sudo env CITADEL_CONFIGURE_SSH=1 CITADEL_SSH_USER=<existing-user> ./setup_linux.sh
```

Linux bootstrap также не создаёт пользователя, не открывает firewall, сохраняет исходный `/etc/ssh/sshd_config`, валидирует `sshd -t`, reload/restart делает только для `ssh.service` / `sshd.service` и откатывает конфигурацию при сбое.

## OpenSSH hardening

Bootstrap устанавливает принудительную консоль и запрет forwarding. Эквивалентная политика выглядит так:

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

Agent 0.3.27 сообщает capability `ssh_probe_readonly` и раз в несколько минут отправляет read-only readiness snapshot. Команда `ssh_probe` — подписанная Controller-команда без payload, которая только заставляет агента немедленно обновить readiness heartbeat.

Readiness теперь требует одновременно:
- loopback-only listener на 22;
- запущенный `cloudflared`;
- CITADEL-managed restricted `ForceCommand`;
- disabled TCP/X11/tunnel forwarding.

Controller повторно вычисляет `browser_terminal_local_ready` из этих полей и не доверяет одному client-provided boolean.

Restricted console остаётся hash-pinned payload. Для включения системного OpenSSH/ForceCommand на уже установленной машине требуется один elevated installer/repair bootstrap; обычный LocalService-agent не получает право переписывать системный SSH config.

## Что остаётся внешней настройкой

CITADEL не может сам создать Cloudflare Zero Trust application/tunnel без авторизованного Cloudflare management connection. Перед первым реальным Browser SSH должны существовать:

- Cloudflare Tunnel для конкретной ноды;
- public hostname;
- Access application/policy для разрешённых пользователей;
- работающий `cloudflared` tunnel process на компьютере;
- Cloudflare public hostname, направленный на `localhost:22`;
- Access application/policy для разрешённых пользователей.

Локальный OpenSSH + ForceCommand теперь может подготовить CITADEL installer/repair. Cloudflare account objects всё ещё создаются вне D1/Hub. Для browser-rendered SSH выбранный OS username должен соответствовать выбранному Cloudflare Browser SSH authentication mode; при legacy browser mode Cloudflare документирует соответствие username части email до `@`.

Пока эти внешние зависимости не подтверждены, Hub обязан показывать SSH как not ready и не заявлять о работающем соединении.
