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

Agent 0.3.31 продолжает capability `ssh_probe_readonly`, отправляет SSH readiness v2 и принимает подписанные/hash-verified assets `CitadelSshConsole.cs` и `configure_restricted_ssh.ps1`. Команда `ssh_probe` остаётся read-only и только заставляет немедленно обновить readiness heartbeat.

Ноды 0.3.29 уже знают эти два asset-имени, поэтому переход на 0.3.31 доставляет обновлённый Cloudflare/bootstrap код обычным signed update без переустановки. Чистые Windows one-click/fixed packages также содержат restricted SSH assets.

## Cloudflare Zero Trust provisioning

Workflow `.github/workflows/provision-ssh-zero-trust.yml` запускается вручную в защищённом environment `cloudflare-test`. По умолчанию это dry-run; реальное изменение Cloudflare выполняется только с input `apply=true`.

SSH username по умолчанию берётся из локальной части разрешённого email и поэтому должен укладываться в лимит локальной Windows-учётной записи: максимум 20 символов. Если нужен другой user, это должно быть задано до apply; provisioner fail-closed не создаёт Cloudflare resources для неподходящего username.

Имя Tunnel по умолчанию выводится из node-id, а если node-id не задан — из public hostname, поэтому один и тот же Access email не заставляет разные ноды делить один dedicated Tunnel.

Workflow через Cloudflare API создаёт или проверяет:

- отдельный remotely-managed Tunnel;
- ingress `ssh://localhost:22`;
- proxied CNAME `<public hostname> -> <tunnel UUID>.cfargotunnel.com`;
- Access application типа Browser SSH;
- Allow policy для **одного точного email**;
- app-specific short-lived SSH CA и её **public key**.

Cloudflare API bearer token берётся только из protected GitHub secret (`FULL_CLOUDFLARE_CONTROL`, с fallback на `CLOUDFLARE_API_TOKEN`). Provisioner сознательно **не запрашивает Tunnel token** и не пишет его в Actions output/artifacts.

На Windows `configure_restricted_ssh.ps1` по умолчанию также подготавливает локальный `cloudflared`: при необходимости восстанавливает WinGet, ставит официальный пакет `Cloudflare.cloudflared`, затем в уже elevated локальном окне просит Tunnel token через скрытый `Read-Host -AsSecureString` и выполняет `cloudflared service install`. Token не принимается параметром командной строки и не сохраняется в CITADEL state/D1/Hub. Сам Windows service `cloudflared` хранит необходимые локальные connector credentials по штатной модели Cloudflare; они остаются на управляемом компьютере.

Если на машине уже существует неизвестный service `cloudflared`, bootstrap fail-closed и не перезаписывает его. Явный `-SkipCloudflared` оставляет внешний connector без изменений. При uninstall CITADEL удаляет `cloudflared` service только если bootstrap-state подтверждает, что его создал CITADEL.

## Windows bootstrap security model

Hub не передаёт bootstrap-пароль, приватный SSH key, Cloudflare Tunnel token или CA private key. Кнопка **Копировать Windows bootstrap** доступна только если сама нода сообщила capability `windows_restricted_ssh_bootstrap` — то есть assets реально присутствуют рядом с агентом.

Bootstrap просит локально только SSH username и Cloudflare SSH CA **public** key. Созданный CITADEL SSH user не состоит в Administrators; его случайный локальный пароль не выводится и для SSH отключён через `AuthenticationMethods publickey` + `PasswordAuthentication no`. `sshd_config` сначала резервируется, затем проверяется через `sshd.exe -t`; при опасном non-loopback listener исходная конфигурация восстанавливается.

При удалении CITADEL основной Windows uninstaller сначала вызывает SSH cleanup. Он восстанавливает исходный `sshd_config`, удаляет только созданного CITADEL SSH user и CITADEL SSH artifacts, но не удаляет Microsoft OpenSSH feature целиком.

## Cloudflare provisioning safety

GitHub workflow создаёт или переиспользует только dedicated remotely-managed Tunnel с именем `citadel-ssh-*`. Если у найденного Tunnel есть чужие hostname routes, нестандартный catch-all или он locally managed, provisioning останавливается вместо изменения ресурса.

Dry-run использует настоящий Cloudflare API token только для read-only проверки: реальная Zone, существующий Tunnel, DNS, Access app/policy и CA проверяются до apply. Drift `session_duration` и exact-email policy показывается как update-required; запись выполняется только при `apply=true`.

Для browser-rendered SSH CITADEL использует self-hosted Access application и application-specific SSH CA. Cloudflare в 2026 рекомендует Access for Infrastructure для новых native-SSH сценариев с WARP/Gateway и command logging; это отдельный режим и не требуется для выбранного clientless Browser SSH пути.

## Что остаётся внешней настройкой

После merge 0.3.31 программная цепочка готова к provisioning. Для первого реального Browser SSH всё ещё нужны два значения, которые нельзя безопасно выдумать:

- public hostname в домене/zone, управляемом вашим Cloudflare;
- точный email identity, которому Cloudflare Access разрешит вход.

После запуска protected workflow с этими значениями он выдаёт CA **public** key и создаёт Tunnel/DNS/Access. Tunnel token берётся в Cloudflare для конкретного Tunnel и вводится только локально в скрытом prompt Windows bootstrap. Пока Tunnel connector и restricted SSH readiness не подтверждены агентом, Hub обязан показывать SSH как NOT READY.

