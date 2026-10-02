#ifndef MyVersion
  #define MyVersion "dev"
#endif
#ifndef SourceRoot
  #error SourceRoot must point to the prepared Windows payload
#endif
#ifndef OutputDir
  #define OutputDir "..\..\dist"
#endif

#define ServiceName "CitadelEWSNode"
#define FallbackTaskName "CitadelEWSNodeFallback"
#define ProductName "CITADEL EWS Node"
#define PublisherName "CITADEL AI EWS"

[Setup]
AppId={{E1A48DF0-6F9E-4B2B-8B4E-2B07D5C3E941}
AppName={#ProductName}
AppVersion={#MyVersion}
AppPublisher={#PublisherName}
DefaultDirName={commonappdata}\CitadelEWS\agent
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableFinishedPage=yes
ShowLanguageDialog=no
UninstallFilesDir={commonappdata}\CitadelEWS\uninstall
OutputDir={#OutputDir}
OutputBaseFilename=CITADEL_EWS_Node_Setup_{#MyVersion}_x64
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
CloseApplications=no
RestartApplications=no
SetupLogging=yes
UsePreviousAppDir=no
ChangesAssociations=no
ChangesEnvironment=no

[Files]
Source: "{#SourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
const
  DefaultControllerUrl = 'https://citadel-ai.init1.workers.dev';
  ControllerPublicX = 'erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0';
  TrustedRegistryKey = 'Software\CITADEL\EWS';
  MoveFileReplaceExisting = 1;
  MoveFileWriteThrough = 8;

var
  StartupConfigured: Boolean;
  ExistingNodeStateBeforeSetup: Boolean;

function MoveFileEx(ExistingFileName, NewFileName: string; Flags: LongWord): Boolean;
  external 'MoveFileExW@kernel32.dll stdcall';

function JsonEscape(Value: string): string;
begin
  StringChangeEx(Value, '\', '\\', True);
  StringChangeEx(Value, '"', '\"', True);
  Result := Value;
end;

function InitializeSetup: Boolean;
var
  StateRoot: string;
begin
  StateRoot := ExpandConstant('{commonappdata}\CitadelEWS\state');
  ExistingNodeStateBeforeSetup :=
    FileExists(StateRoot + '\config.json') or
    FileExists(StateRoot + '\node_identity.json') or
    FileExists(StateRoot + '\identity.json');
  Result := True;
end;


procedure RequireExec(FileName, Params, ErrorText: string);
var
  ResultCode: Integer;
begin
  if not ExecAndLogOutput(FileName, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode, nil) then
    RaiseException(ErrorText + ' (unable to start)');
  if ResultCode <> 0 then
    RaiseException(ErrorText + ' (exit code ' + IntToStr(ResultCode) + ')');
end;

procedure TryExec(FileName, Params: string);
var
  ResultCode: Integer;
begin
  Exec(FileName, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure StopExistingService;
var
  Sc: string;
begin
  Sc := ExpandConstant('{sys}\sc.exe');
  TryExec(Sc, 'stop {#ServiceName}');
  Sleep(1500);
end;

procedure StopFallbackTask;
var
  SchTasks, TaskKill: string;
begin
  SchTasks := ExpandConstant('{sys}\schtasks.exe');
  TaskKill := ExpandConstant('{sys}\taskkill.exe');
  { Prevent failure recovery from racing upgrade/uninstall cleanup. }
  TryExec(SchTasks, '/Change /TN "{#FallbackTaskName}" /DISABLE');
  { Kill our host while it is still the parent so /T also terminates the agent child. }
  TryExec(TaskKill, '/IM CitadelNodeService.exe /T /F');
  Sleep(500);
  TryExec(SchTasks, '/End /TN "{#FallbackTaskName}"');
  Sleep(500);
end;

procedure DeleteFallbackTask;
var
  SchTasks: string;
begin
  SchTasks := ExpandConstant('{sys}\schtasks.exe');
  TryExec(SchTasks, '/Delete /TN "{#FallbackTaskName}" /F');
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  { Stop either installation mode before [Files] replaces bundled binaries. }
  StopExistingService;
  StopFallbackTask;
  DeleteFallbackTask;
  Result := '';
end;

function ExplicitControllerUrl: string;
begin
  Result := Trim(ExpandConstant('{param:CONTROLLERURL|}'));
end;

function TrustedControllerUrl(out Value: string): Boolean;
begin
  Value := ExplicitControllerUrl;
  if Value <> '' then
  begin
    Result := True;
    exit;
  end;

  if RegQueryStringValue(HKLM, TrustedRegistryKey, 'ControllerUrl', Value) and (Trim(Value) <> '') then
  begin
    Value := Trim(Value);
    Result := True;
    exit;
  end;

  if not ExistingNodeStateBeforeSetup then
  begin
    Value := DefaultControllerUrl;
    Result := True;
    exit;
  end;

  Value := '';
  Result := False;
end;

procedure PersistTrustedControllerUrl(Value: string);
begin
  if Trim(Value) = '' then exit;
  if not RegWriteStringValue(HKLM, TrustedRegistryKey, 'ControllerUrl', Trim(Value)) then
    RaiseException('Unable to persist trusted CITADEL Controller URL.');
end;

procedure AtomicReplaceTextFile(PathValue, ContentValue, ErrorText: string);
var
  TempPath: string;
begin
  TempPath := PathValue + '.new';
  DeleteFile(TempPath);
  if not SaveStringToFile(TempPath, ContentValue, False) then
    RaiseException(ErrorText + ' (temporary write failed)');
  if not MoveFileEx(TempPath, PathValue, MoveFileReplaceExisting or MoveFileWriteThrough) then
  begin
    DeleteFile(TempPath);
    RaiseException(ErrorText + ' (atomic replace failed)');
  end;
end;

procedure WriteDefaultConfig;
var
  StateRoot, ConfigPath, ConfigText, ControllerUrl: string;
begin
  StateRoot := ExpandConstant('{commonappdata}\CitadelEWS\state');
  if not TrustedControllerUrl(ControllerUrl) then
    ControllerUrl := DefaultControllerUrl;
  PersistTrustedControllerUrl(ControllerUrl);
  ConfigPath := StateRoot + '\config.json';
  ForceDirectories(StateRoot);

  if FileExists(ConfigPath) then
    exit;

  ConfigText :=
    '{' + #13#10 +
    '  "controller_url": "' + ControllerUrl + '",' + #13#10 +
    '  "data_dir": "' + JsonEscape(StateRoot) + '",' + #13#10 +
    '  "poll_seconds": 30,' + #13#10 +
    '  "heartbeat_seconds": 30,' + #13#10 +
    '  "request_timeout_seconds": 30,' + #13#10 +
    '  "max_cpu_percent": 90,' + #13#10 +
    '  "max_memory_percent": 90,' + #13#10 +
    '  "prevent_automatic_sleep": true,' + #13#10 +
    '  "network_recovery_enabled": true,' + #13#10 +
    '  "allowed_wifi_profiles": [],' + #13#10 +
    '  "controller_public_x": "' + ControllerPublicX + '"' + #13#10 +
    '}' + #13#10;

  if not SaveStringToFile(ConfigPath, ConfigText, False) then
    RaiseException('Unable to create CITADEL configuration.');
end;

procedure WriteTrustedSystemRecoveryConfig;
var
  StateRoot, ConfigPath, ConfigText, ControllerUrl: string;
begin
  StateRoot := ExpandConstant('{commonappdata}\CitadelEWS\state');
  if not TrustedControllerUrl(ControllerUrl) then
    RaiseException(
      'SYSTEM recovery for this existing node has no trusted Controller URL metadata. ' +
      'Re-run with /CONTROLLERURL to recover without redirecting the node.'
    );
  PersistTrustedControllerUrl(ControllerUrl);

  ConfigPath := StateRoot + '\config.json';
  ForceDirectories(StateRoot);

  ConfigText :=
    '{' + #13#10 +
    '  "controller_url": "' + ControllerUrl + '",' + #13#10 +
    '  "data_dir": "' + JsonEscape(StateRoot) + '",' + #13#10 +
    '  "poll_seconds": 30,' + #13#10 +
    '  "heartbeat_seconds": 30,' + #13#10 +
    '  "request_timeout_seconds": 30,' + #13#10 +
    '  "max_cpu_percent": 90,' + #13#10 +
    '  "max_memory_percent": 90,' + #13#10 +
    '  "prevent_automatic_sleep": true,' + #13#10 +
    '  "network_recovery_enabled": true,' + #13#10 +
    '  "allowed_wifi_profiles": [],' + #13#10 +
    '  "controller_public_x": "' + ControllerPublicX + '"' + #13#10 +
    '}' + #13#10;

  AtomicReplaceTextFile(
    ConfigPath,
    ConfigText,
    'Unable to rewrite trusted CITADEL configuration for SYSTEM recovery.'
  );
end;

procedure RestoreLocalServiceTreeAccess(PathValue, Description, LocalServiceRights: string);
var
  Icacls: string;
begin
  Icacls := ExpandConstant('{sys}\icacls.exe');
  RequireExec(
    Icacls,
    '"' + PathValue + '" /setowner "*S-1-5-32-544" /T /C',
    'Unable to take ownership while restoring ' + Description
  );
  RequireExec(
    Icacls,
    '"' + PathValue + '" /reset /T /C',
    'Unable to reset ACLs while restoring ' + Description
  );
  RequireExec(
    Icacls,
    '"' + PathValue + '" /inheritance:r /T /C',
    'Unable to normalize ACL inheritance on ' + Description
  );
  RequireExec(
    Icacls,
    '"' + PathValue + '" /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F" "*S-1-5-19:' + LocalServiceRights + '" /T /C',
    'Unable to restore LocalService access on descendants of ' + Description
  );
  RequireExec(
    Icacls,
    '"' + PathValue + '" /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-19:(OI)(CI)' + LocalServiceRights + '"',
    'Unable to install inheritable LocalService ACLs on ' + Description
  );
end;

procedure HardenDirectories;
var
  AppRoot, StateRoot: string;
begin
  AppRoot := ExpandConstant('{app}');
  StateRoot := ExpandConstant('{commonappdata}\CitadelEWS\state');
  RestoreLocalServiceTreeAccess(AppRoot, 'the CITADEL program tree', 'RX');
  RestoreLocalServiceTreeAccess(StateRoot, 'the CITADEL state tree', 'M');
end;

procedure HardenTreeForSystemRecovery(PathValue, Description: string);
var
  Icacls: string;
begin
  Icacls := ExpandConstant('{sys}\icacls.exe');
  RequireExec(
    Icacls,
    '"' + PathValue + '" /setowner "*S-1-5-32-544" /T /C',
    'Unable to take ownership of ' + Description
  );
  RequireExec(
    Icacls,
    '"' + PathValue + '" /reset /T /C',
    'Unable to reset inherited ACLs on ' + Description
  );
  RequireExec(
    Icacls,
    '"' + PathValue + '" /inheritance:r /T /C',
    'Unable to disable inherited ACLs on ' + Description
  );
  RequireExec(
    Icacls,
    '"' + PathValue + '" /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F" /T /C',
    'Unable to grant trusted SYSTEM/Admin ACLs on descendants of ' + Description
  );
  RequireExec(
    Icacls,
    '"' + PathValue + '" /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"',
    'Unable to install inheritable SYSTEM/Admin ACLs on ' + Description
  );
end;

procedure HardenForSystemRecovery;
var
  AppRoot, StateRoot: string;
begin
  AppRoot := ExpandConstant('{app}');
  StateRoot := ExpandConstant('{commonappdata}\CitadelEWS\state');
  HardenTreeForSystemRecovery(AppRoot, 'the CITADEL program tree');
  HardenTreeForSystemRecovery(StateRoot, 'the CITADEL state tree');
end;

function IsManagedSupervisorHealthy: Boolean;
var
  Locator, Services, Hosts, Children, HostObj, ChildObj: Variant;
  HostPid: Integer;
  HostPath, ChildPath, ChildCommand, ExpectedHost, ExpectedPython, StopPath: string;
begin
  Result := False;
  try
    ExpectedHost := ExpandConstant('{app}\CitadelNodeService.exe');
    ExpectedPython := ExpandConstant('{app}\runtime\python.exe');
    StopPath := ExpandConstant('{commonappdata}\CitadelEWS\state\STOP');

    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Services := Locator.ConnectServer('.', 'root\CIMV2');
    Hosts := Services.ExecQuery(
      'SELECT ProcessId, ExecutablePath FROM Win32_Process WHERE Name="CitadelNodeService.exe"'
    );
    if Hosts.Count <> 1 then exit;

    HostObj := Hosts.ItemIndex(0);
    HostPath := HostObj.ExecutablePath;
    if CompareText(HostPath, ExpectedHost) <> 0 then exit;
    HostPid := HostObj.ProcessId;

    if FileExists(StopPath) then
    begin
      Result := True;
      exit;
    end;

    Children := Services.ExecQuery(
      'SELECT ProcessId, ParentProcessId, ExecutablePath, CommandLine FROM Win32_Process ' +
      'WHERE Name="python.exe" AND ParentProcessId=' + IntToStr(HostPid)
    );
    if Children.Count <> 1 then exit;

    ChildObj := Children.ItemIndex(0);
    ChildPath := ChildObj.ExecutablePath;
    ChildCommand := ChildObj.CommandLine;
    Result :=
      (CompareText(ChildPath, ExpectedPython) = 0) and
      (Pos('citadel_node_v2.py', Lowercase(ChildCommand)) > 0);
  except
    Result := False;
  end;
end;

function WaitForManagedAgentHealth: Boolean;
var
  Attempt: Integer;
begin
  Result := False;
  for Attempt := 1 to 40 do
  begin
    if IsManagedSupervisorHealthy then
    begin
      Sleep(1000);
      if IsManagedSupervisorHealthy then
      begin
        Result := True;
        exit;
      end;
    end;
    Sleep(250);
  end;
end;

function ExecOk(FileName, Params: string): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(FileName, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

procedure UpdateSetupStatus(Text: string);
begin
  Log(Text);
  if Assigned(WizardForm) then
  begin
    WizardForm.StatusLabel.Caption := Text;
    WizardForm.StatusLabel.Update;
  end;
end;

function KeepInstallerForegroundRequested: Boolean;
begin
  Result := CompareText(ExpandConstant('{param:FOREGROUND|0}'), '1') = 0;
end;

procedure MinimizeInstallerForBackgroundWork;
begin
  if Assigned(WizardForm) and (not KeepInstallerForegroundRequested) then
  begin
    UpdateSetupStatus('CITADEL: installation continues in the background...');
    WizardForm.WindowState := wsMinimized;
  end;
end;

procedure AppendRecoveryLog(StepName, Outcome, Detail: string);
var
  StateRoot, RecoveryPath, Line: string;
begin
  StateRoot := ExpandConstant('{commonappdata}\CitadelEWS\state');
  ForceDirectories(StateRoot);
  StringChangeEx(Detail, #13, ' ', True);
  StringChangeEx(Detail, #10, ' ', True);
  RecoveryPath := StateRoot + '\install-recovery.log';
  Line := GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':') + ' | ' +
    StepName + ' | ' + Outcome + ' | ' + Detail + #13#10;
  if not SaveStringToFile(RecoveryPath, Line, True) then
    Log('CITADEL could not append install-recovery.log');
end;

function ForceFallbackRequested: Boolean;
begin
  Result := CompareText(ExpandConstant('{param:FORCEFALLBACK|0}'), '1') = 0;
end;

function ForceSystemFallbackRequested: Boolean;
begin
  Result := CompareText(ExpandConstant('{param:FORCESYSTEMFALLBACK|0}'), '1') = 0;
end;

procedure WriteInstallMode(Mode: string);
var
  ModePath: string;
begin
  ModePath := ExpandConstant('{commonappdata}\CitadelEWS\state\install-mode.txt');
  if not SaveStringToFile(ModePath, Mode + #13#10, False) then
    RaiseException('Unable to record CITADEL installation mode.');
end;

function TryInstallService: Boolean;
var
  Sc, ServiceExe, ServiceArgs: string;
begin
  Result := False;
  if ForceFallbackRequested or ForceSystemFallbackRequested then exit;

  Sc := ExpandConstant('{sys}\sc.exe');
  ServiceExe := ExpandConstant('{app}\CitadelNodeService.exe');
  ServiceArgs :=
    'binPath= "' + ServiceExe +
    '" start= delayed-auto obj= "NT AUTHORITY\LocalService" DisplayName= "{#ProductName}"';

  if not ExecOk(Sc, 'config {#ServiceName} ' + ServiceArgs) then
    if not ExecOk(Sc, 'create {#ServiceName} ' + ServiceArgs) then exit;

  if not ExecOk(Sc, 'description {#ServiceName} "CITADEL/EWS bounded node service with bundled Python runtime"') then exit;
  if not ExecOk(Sc, 'failure {#ServiceName} reset= 86400 actions= restart/5000/restart/15000/restart/60000') then exit;
  if not ExecOk(Sc, 'start {#ServiceName}') then
  begin
    Sleep(1500);
    if not ExecOk(Sc, 'start {#ServiceName}') then exit;
  end;
  if not WaitForManagedAgentHealth then
  begin
    TryExec(Sc, 'stop {#ServiceName}');
    exit;
  end;

  DeleteFallbackTask;
  WriteInstallMode('windows_service');
  Result := True;
end;

function XmlEscape(Value: string): string;
begin
  StringChangeEx(Value, '&', '&amp;', True);
  StringChangeEx(Value, '<', '&lt;', True);
  StringChangeEx(Value, '>', '&gt;', True);
  StringChangeEx(Value, '"', '&quot;', True);
  Result := Value;
end;

function TryInstallFallbackTask(UseSystemAccount: Boolean): Boolean;
var
  SchTasks, Sc, HostExe, TaskXml, TaskXmlPath: string;
  PrincipalSid, PrincipalName, RunLevel, ModeName: string;
  FileSystem, XmlFile: Variant;
  Created, Persisted, Started: Boolean;
begin
  Result := False;
  if (not UseSystemAccount) and ForceSystemFallbackRequested then exit;

  StopExistingService;
  Sc := ExpandConstant('{sys}\sc.exe');
  TryExec(Sc, 'delete {#ServiceName}');
  Sleep(1000);

  if UseSystemAccount then
  begin
    HardenForSystemRecovery;
    WriteTrustedSystemRecoveryConfig;
    PrincipalSid := 'S-1-5-18';
    PrincipalName := 'SYSTEM';
    RunLevel := 'HighestAvailable';
    ModeName := 'windows_boot_task_system';
  end
  else
  begin
    PrincipalSid := 'S-1-5-19';
    PrincipalName := 'NT AUTHORITY\LOCALSERVICE';
    RunLevel := 'LeastPrivilege';
    ModeName := 'windows_boot_task';
  end;

  SchTasks := ExpandConstant('{sys}\schtasks.exe');
  HostExe := ExpandConstant('{app}\CitadelNodeService.exe');
  TaskXmlPath := ExpandConstant('{tmp}\citadel-fallback.xml');
  TaskXml :=
    '<?xml version="1.0" encoding="UTF-16"?>' +
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">' +
    '<Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>' +
    '<Principals><Principal id="Agent"><UserId>' + PrincipalSid + '</UserId>' +
    '<RunLevel>' + RunLevel + '</RunLevel></Principal></Principals>' +
    '<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>' +
    '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>' +
    '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>' +
    '<StartWhenAvailable>true</StartWhenAvailable>' +
    '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>' +
    '<RestartOnFailure><Interval>PT1M</Interval><Count>255</Count></RestartOnFailure>' +
    '</Settings><Actions Context="Agent"><Exec><Command>' + XmlEscape(HostExe) +
    '</Command><Arguments>--task-host</Arguments><WorkingDirectory>' +
    XmlEscape(ExpandConstant('{app}')) +
    '</WorkingDirectory></Exec></Actions></Task>';

  Created := False;
  Persisted := False;
  Started := False;
  try
    FileSystem := CreateOleObject('Scripting.FileSystemObject');
    XmlFile := FileSystem.CreateTextFile(TaskXmlPath, True, True);
    try
      XmlFile.Write(TaskXml);
    finally
      XmlFile.Close;
    end;

    DeleteFallbackTask;
    Created := ExecOk(
      SchTasks,
      '/Create /TN "{#FallbackTaskName}" /XML "' + TaskXmlPath + '" /RU "' + PrincipalName + '" /F'
    );
    if Created then
      Persisted := ExecOk(SchTasks, '/Query /TN "{#FallbackTaskName}"');
    if Persisted then
    begin
      Started := ExecOk(SchTasks, '/Run /TN "{#FallbackTaskName}"');
      if not Started then
      begin
        Sleep(1000);
        Started := ExecOk(SchTasks, '/Run /TN "{#FallbackTaskName}"');
      end;
    end;

    if Created and Persisted and Started then
      Started := WaitForManagedAgentHealth;

    if Created and Persisted and Started then
    begin
      WriteInstallMode(ModeName);
      Result := True;
    end;
  except
    Log('CITADEL fallback startup mode raised an exception and will be abandoned.');
    Result := False;
  end;

  DeleteFile(TaskXmlPath);
  if not Result then
  begin
    StopFallbackTask;
    DeleteFallbackTask;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    MinimizeInstallerForBackgroundWork;

  if CurStep = ssPostInstall then
  begin
    WriteDefaultConfig;
    HardenDirectories;
    AppendRecoveryLog('bootstrap', 'start', 'Selecting a supervised Windows startup mode.');
    UpdateSetupStatus('CITADEL: configuring Windows Service...');

    if TryInstallService then
    begin
      AppendRecoveryLog('windows_service', 'success', 'LocalService SCM mode is active.');
      UpdateSetupStatus('CITADEL: Windows Service installed successfully.');
    end
    else
    begin
      AppendRecoveryLog('windows_service', 'failed', 'SCM mode unavailable; trying LocalService boot task.');
      UpdateSetupStatus('CITADEL: Service unavailable; trying LocalService recovery...');
      if TryInstallFallbackTask(False) then
      begin
        AppendRecoveryLog('windows_boot_task', 'success', 'LocalService boot-task fallback is active.');
        UpdateSetupStatus('CITADEL: LocalService recovery mode installed successfully.');
      end
      else
      begin
        AppendRecoveryLog('windows_boot_task', 'failed', 'LocalService boot task unavailable; trying SYSTEM recovery task.');
        UpdateSetupStatus('CITADEL: LocalService recovery unavailable; trying SYSTEM recovery...');
        if TryInstallFallbackTask(True) then
        begin
          AppendRecoveryLog('windows_boot_task_system', 'success',
            'SYSTEM boot-task recovery is active. This is a degraded fallback and should be repaired back to LocalService when policy allows.');
          UpdateSetupStatus('CITADEL: SYSTEM recovery mode installed; repair back to LocalService when policy allows.');
        end
        else
        begin
          AppendRecoveryLog('windows_boot_task_system', 'failed',
            'All safe supervised startup modes failed.');
          RaiseException(
            'CITADEL could not activate Windows Service, LocalService boot-task, or SYSTEM recovery task. ' +
            'See ProgramData\CitadelEWS\state\install-recovery.log.'
          );
        end;
      end;
    end;
    StartupConfigured := True;
  end;
end;

function GetCustomSetupExitCode: Integer;
begin
  { ssPostInstall exceptions alone can otherwise leave a false success code. }
  if StartupConfigured then Result := 0 else Result := 1;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Sc, PowerShell, SshBootstrap, SshState, AppRoot, StateRoot: string;
begin
  if CurUninstallStep = usUninstall then
  begin
    SshState := ExpandConstant('{commonappdata}\CitadelEWS\ssh\bootstrap-state.json');
    if FileExists(SshState) then
    begin
      SshBootstrap := ExpandConstant('{app}\configure_restricted_ssh.ps1');
      if not FileExists(SshBootstrap) then
        RaiseException('Restricted SSH bootstrap state exists but cleanup script is missing.');
      PowerShell := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
      AppRoot := ExpandConstant('{app}');
      StateRoot := ExpandConstant('{commonappdata}\CitadelEWS\state');
      RequireExec(
        PowerShell,
        '-NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "' + SshBootstrap + '" -InstallRoot "' + AppRoot +
          '" -StateRoot "' + StateRoot + '" -Uninstall',
        'Restricted SSH cleanup failed'
      );
    end;

    Sc := ExpandConstant('{sys}\sc.exe');
    TryExec(Sc, 'stop {#ServiceName}');
    Sleep(1000);
    TryExec(Sc, 'delete {#ServiceName}');
    StopFallbackTask;
    DeleteFallbackTask;
  end;
end;
