# Windows One-Click installer

This is the preferred Windows deployment path for CITADEL/EWS nodes.

## What changes

The target computer no longer needs to install or discover Python before CITADEL can start. The installer contains:

- a private x64 Python runtime used only by CITADEL;
- the pinned Python dependencies required by the agent;
- `citadel_node_v1.py` and `citadel_node_v2.py`;
- a precompiled Windows Service host;
- the reviewed LM Studio integration helper.

The private runtime is assembled and tested in CI. The target machine does **not** run `winget`, `pip install`, download Python, compile C#, or modify the system PATH.

## Normal installation

Run:

`CITADEL_EWS_Node_Setup_<version>_x64.exe`

Windows may show the normal administrator/UAC approval because CITADEL is installed as a machine service. After that approval there are no Python, dependency, directory, or firewall setup questions.

The installer registers `CitadelEWSNode` as an Automatic (Delayed Start) Windows Service under `NT AUTHORITY\LocalService`.

## Quiet managed installation

For PCs that you own or administer:

```cmd
CITADEL_EWS_Node_Setup_<version>_x64.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-
```

This is an unattended installer mode, not a security bypass. Administrator authorization is still required by Windows.

## Offline behavior

Installation itself does not require Internet access. If the Controller is unreachable, the service remains installed and running and the existing agent retry/backoff loop keeps trying later.

When Internet access becomes available, the agent enrolls/reconciles its node identity and begins normal heartbeats. No inbound firewall port is required for the CITADEL Controller connection; it is outbound HTTPS.

## LM Studio

CITADEL supports both LM Studio local interfaces used by the agent:

- LM Studio REST streaming endpoint on `127.0.0.1:1234/api/v1/chat`;
- OpenAI-compatible `127.0.0.1:1234/v1/chat/completions`.

CI exercises both contracts with a local test server so a protocol regression fails the build.

The CITADEL core installer does not silently weaken PowerShell policy in order to install LM Studio. If `llmster` is already installed, CITADEL can discover and use `lms`. The current official LM Studio Windows headless installer is PowerShell-based, so machines whose organization blocks that installer need LM Studio to be deployed by an approved administrator/software-distribution method.

## OpenRouter

OpenRouter remains a Controller/Hub quality gate, not a dependency installed on every node. Its automated test verifies the chat-completions endpoint, Bearer authorization, configured Fusion model/preset, and privacy flags without exposing the real API key.

## Security properties

- no `ExecutionPolicy Bypass`;
- no firewall-disable or firewall-bypass commands;
- no arbitrary remote shell;
- Windows service runs as `LocalService`, not as Administrator;
- program/state ACLs are narrowed after installation;
- state is preserved when the application is uninstalled, so node identity can be retained for an approved repair/reinstall;
- SHA-256 is emitted for every built installer.

## Remaining production requirement: code signing

A public production installer should be Authenticode-signed with the project's Windows code-signing certificate. SHA-256 proves package identity once the hash is known, but signing is what gives Windows a publisher identity and materially reduces SmartScreen friction. CI intentionally does not fabricate or embed a private signing key.
