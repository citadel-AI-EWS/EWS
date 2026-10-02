# CITADEL SSH / Zero Trust

## Цель

SSH в CITADEL предназначен для управляемых компьютеров владельца/администратора. Он не должен превращать Hub в хранилище постоянных SSH-ключей или в универсальный remote shell.

Целевая цепочка:

```text
Hub → Cloudflare Access → Cloudflare Tunnel → localhost:22 → OpenSSH → ForceCommand → restricted CITADEL console
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
4. на Windows агент подтвердил CITADEL bootstrap-state, установленную restricted console, Cloudflare CA **public** key и управляемый `ForceCommand`.

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

Для Windows используется отдельная стабильная console `C:\ProgramData\CitadelEWS\ssh\CitadelSshConsole.exe`. Она компилируется локально из hash-pinned `CitadelSshConsole.cs`, не запускает `cmd.exe`, PowerShell или произвольные дочерние процессы и реализует тот же фиксированный allow-list.

Однократный `configure_restricted_ssh.ps1` выполняется с UAC/admin только для системной подготовки: Microsoft OpenSSH Server, отдельный непривилегированный пользователь, `ListenAddress 127.0.0.1`, `AllowUsers`, Cloudflare CA **public** key, `ForceCommand`, отключение password authentication/forwarding/tunneling и отключение стандартного inbound firewall rule. Если OpenSSH уже существовал до CITADEL, bootstrap без явного `-ForceLoopback` отказывается переписывать конфигурацию.

Bootstrap поддерживает оба Windows-layout CITADEL: managed-release (`install-state.json` + `releases/...`) и плоскую one-click установку в `ProgramData\CitadelEWS\agent` с config в `ProgramData\CitadelEWS\state`. На чистой установке Windows OpenSSH bootstrap один раз запускает `sshd`, чтобы Windows создала штатный `sshd_config` и host keys, затем останавливает сервис, применяет CITADEL policy и проверяет её через `sshd.exe -t`.

Windows-конфигурация сознательно не использует директивы `KbdInteractiveAuthentication`, `PermitTunnel` и `X11Forwarding`, которые Windows OpenSSH не поддерживает. Ограничение доступа обеспечивается `AllowUsers`, public-key-only authentication, `ForceCommand`, `AllowAgentForwarding no`, `AllowTcpForwarding no` и `GatewayPorts no`.

После изменения sshd configuration конфигурацию следует проверить штатными средствами OpenSSH перед reload/restart.

## Agent / Controller contract

Agent 0.3.27 продолжает capability `ssh_probe_readonly`, отправляет SSH readiness v2 и умеет принимать два новых подписанных update-asset: `CitadelSshConsole.cs` и `configure_restricted_ssh.ps1`. Команда `ssh_probe` остаётся read-only и только заставляет немедленно обновить readiness heartbeat.

`0.3.27` — совместимый bridge-релиз: существующий `0.3.26` принимает его через старый набор v1/v2. Windows installer `0.3.27+` уже содержит SSH assets при чистой установке.

`0.3.28` — asset-delivery релиз: Controller включает `CitadelSshConsole.cs` и `configure_restricted_ssh.ps1` в обычный подписанный/hash-verified update payload вместе с v1/v2. Поэтому нода, уже перешедшая с `0.3.26` на bridge `0.3.27`, получает недостающие SSH assets удалённо без переустановки. После применения assets Windows-нода публикует capability `windows_restricted_ssh_bootstrap`; только после этого Hub разрешает копирование локальной elevated bootstrap-команды.

## Windows bootstrap security model

Hub не передаёт bootstrap-пароль, приватный SSH key, Cloudflare Tunnel token или CA private key. Кнопка **Копировать Windows bootstrap** доступна только если сама нода сообщила capability `windows_restricted_ssh_bootstrap` — то есть assets реально присутствуют рядом с агентом.

Bootstrap просит локально только SSH username и Cloudflare SSH CA **public** key. Созданный CITADEL SSH user не состоит в Administrators; его случайный локальный пароль не выводится и для SSH отключён через `AuthenticationMethods publickey` + `PasswordAuthentication no`. `sshd_config` сначала резервируется, затем проверяется через `sshd.exe -t`; при опасном non-loopback listener исходная конфигурация восстанавливается.

При удалении CITADEL основной Windows uninstaller сначала вызывает SSH cleanup. Он восстанавливает исходный `sshd_config`, удаляет только созданного CITADEL SSH user и CITADEL SSH artifacts, но не удаляет Microsoft OpenSSH feature целиком.

## Что остаётся внешней настройкой

CITADEL не может сам создать Cloudflare Zero Trust application/tunnel без авторизованного Cloudflare management connection. Перед первым реальным Browser SSH должны существовать:

- Cloudflare Tunnel для конкретной ноды;
- public hostname;
- Access application/policy для разрешённых пользователей;
- работающий OpenSSH server на компьютере;
- ForceCommand policy для CITADEL SSH user.

Пока эти внешние зависимости не подтверждены, Hub обязан показывать SSH как not ready и не заявлять о работающем соединении.

## Inline Restricted Terminal in Hub

Agent 0.3.31 adds an on-demand terminal-like UI inside Hub that does **not** require Cloudflare Tunnel or an exposed SSH transport. It uses the existing signed Controller → node command channel:

```text
Hub → authenticated Architect API → signed ssh_console command → node agent
    → hash-pinned ssh_restricted_console.py → bounded ssh_console_results row → Hub
```

This is intentionally not a general-purpose shell. The Controller and agent both independently enforce the same fixed read-only command allow-list. Unknown commands and shell syntax are rejected before execution. The agent calls the restricted console's `execute()` function directly; it does not start `cmd.exe`, PowerShell, Bash, or an arbitrary subprocess.

Results are stored in the separate `ssh_console_results` table only for the individual `ssh_console` command, are limited to 24 KiB, and are deleted automatically with the parent command. Hub polls only that command ID until it reaches `completed` or `failed`. The hot `commands` row and regular node-details polling path do not carry terminal output.

The inline terminal and Browser SSH are complementary:

- **Inline Restricted Terminal** — works over the signed CITADEL agent channel and is useful for safe diagnostics before Cloudflare SSH is configured.
- **Browser SSH** — real SSH through Cloudflare Access/Tunnel to loopback-only OpenSSH with the restricted ForceCommand policy.

Neither path stores SSH private keys, passwords, Cloudflare Access tokens, or CA private keys in Hub/D1.

