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
  GenericRead = $80000000;
  GenericWrite = $40000000;
  OpenAlways = 4;
  FileAttributeHidden = 2;
  InvalidHandleValue = -1;

var
  StartupConfigured: Boolean;
  LegacyCutoverActive: Boolean;
  InstallUpdateLockHandle: THandle;

function CreateFile(
  lpFileName: string;
  dwDesiredAccess, dwShareMode, lpSecurityAttributes, dwCreationDisposition,
  dwFlagsAndAttributes: Cardinal;
  hTemplateFile: THandle
): THandle;
  external 'CreateFileW@kernel32.dll stdcall';
function CloseHandle(hObject: THandle): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';

function InstallUpdateLockPath: string;
begin
  Result := ExpandConstant('{commonappdata}\CitadelEWS\state\install-update.lock');
end;

function InstallUpdateMarkerPath: string;
begin
  Result := ExpandConstant('{commonappdata}\CitadelEWS\state\install-update-active.json');
end;

function SecureInstallUpdateStateRoot: Boolean;
var
  StateRoot, Icacls: string;
  ResultCode: Integer;
begin
  Result := False;
  StateRoot := ExpandConstant('{commonappdata}\CitadelEWS\state');
  Icacls := ExpandConstant('{sys}\icacls.exe');
  ForceDirectories(StateRoot);
  if not DirExists(StateRoot) then exit;

  if not Exec(
    Icacls,
    '"' + StateRoot + '" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-19:(OI)(CI)M"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode
  ) then exit;
  Result := ResultCode = 0;
end;

function AcquireInstallUpdateMutex: Boolean;
var
  Attempt: Integer;
  Marker: string;
begin
  Result := False;
  InstallUpdateLockHandle := 0;

  if not SecureInstallUpdateStateRoot then
  begin
    Log('CITADEL install/update lock directory could not be secured.');
    exit;
  end;

  for Attempt := 1 to 300 do
  begin
    InstallUpdateLockHandle := CreateFile(
      InstallUpdateLockPath,
      GenericRead or GenericWrite,
      0,
      0,
      OpenAlways,
      FileAttributeHidden,
      0
    );
    if (InstallUpdateLockHandle <> 0) and
       (Integer(InstallUpdateLockHandle) <> InvalidHandleValue) then
      break;
    InstallUpdateLockHandle := 0;
    Sleep(100);
  end;

  if InstallUpdateLockHandle = 0 then
  begin
    Log('CITADEL install/update lock is busy or unavailable.');
    exit;
  end;

  if FileExists(InstallUpdateMarkerPath) then
  begin
    Log('CITADEL found an abandoned install/update marker; installer is acting as repair authority.');
    DeleteFile(InstallUpdateMarkerPath);
  end;

  Marker :=
    '{"schema":"citadel.install-update-lock.v1","owner":"inno","started_at":"' +
    GetDateTimeString('yyyy-mm-dd"T"hh:nn:ss', '-', ':') + '"}' + #13#10;
  if not SaveStringToFile(InstallUpdateMarkerPath, Marker, False) then
  begin
    CloseHandle(InstallUpdateLockHandle);
    InstallUpdateLockHandle := 0;
    Log('CITADEL could not write the install/update crash marker.');
    exit;
  end;

  Result := True;
end;

procedure ReleaseInstallUpdateMutex;
begin
  if InstallUpdateLockHandle <> 0 then
  begin
    DeleteFile(InstallUpdateMarkerPath);
    CloseHandle(InstallUpdateLockHandle);
    InstallUpdateLockHandle := 0;
  end;
end;

function InitializeSetup: Boolean;
begin
  Result := AcquireInstallUpdateMutex;
end;

procedure DeinitializeSetup;
begin
  ReleaseInstallUpdateMutex;
end;

function InitializeUninstall: Boolean;
begin
  Result := AcquireInstallUpdateMutex;
end;

procedure DeinitializeUninstall;
begin
  ReleaseInstallUpdateMutex;
end;


function JsonEscape(Value: string): string;
begin
  StringChangeEx(Value, '\', '\\', True);
  StringChangeEx(Value, '"', '\"', True);
  Result := Value;
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

function CitadelHostRunning: Boolean;
var
  Cmd: string;
  ResultCode: Integer;
begin
  Cmd := ExpandConstant('{cmd}');
  Result :=
    Exec(
      Cmd,
      '/C tasklist /FI "IMAGENAME eq CitadelNodeService.exe" /NH | findstr /I /C:"CitadelNodeService.exe" >NUL 2>&1',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode
    ) and (ResultCode = 0);
end;

procedure WaitForCitadelHostExit;
var
  Attempt: Integer;
begin
  for Attempt := 1 to 100 do
  begin
    if not CitadelHostRunning then exit;
    Sleep(500);
  end;
  RaiseException('Existing CITADEL supervisor did not stop within 50 seconds.');
end;

procedure StopExistingService;
var
  Sc, SchTasks, TaskKill: string;
begin
  Sc := ExpandConstant('{sys}\sc.exe');
  SchTasks := ExpandConstant('{sys}\schtasks.exe');
  TaskKill := ExpandConstant('{sys}\taskkill.exe');

  { Disable fallback before touching the Service so it cannot race the stop. }
  TryExec(SchTasks, '/Change /TN "{#FallbackTaskName}" /DISABLE');
  TryExec(Sc, 'stop {#ServiceName}');
  Sleep(1000);

  { Old releases do not know about the new lifecycle lock. Kill the supervised
    host tree explicitly, then prove the executable is no longer running before
    [Files] is allowed to replace the live install tree. }
  TryExec(TaskKill, '/IM CitadelNodeService.exe /T /F');
  WaitForCitadelHostExit;
end;

procedure StopFallbackTask;
var
  SchTasks, TaskKill: string;
begin
  SchTasks := ExpandConstant('{sys}\schtasks.exe');
  TaskKill := ExpandConstant('{sys}\taskkill.exe');
  TryExec(SchTasks, '/Change /TN "{#FallbackTaskName}" /DISABLE');
  TryExec(SchTasks, '/End /TN "{#FallbackTaskName}"');
  TryExec(TaskKill, '/IM CitadelNodeService.exe /T /F');
  WaitForCitadelHostExit;
end;

procedure DeleteFallbackTask;
var
  SchTasks: string;
begin
  SchTasks := ExpandConstant('{sys}\schtasks.exe');
  TryExec(SchTasks, '/Delete /TN "{#FallbackTaskName}" /F');
end;


function LegacyCutoverMarkerPath: string;
begin
  Result := ExpandConstant('{commonappdata}\CitadelEWS\state\legacy-cutover.json');
end;

procedure RequireLegacyCutover(Action, ExtraArgs: string);
var
  PythonExe, ScriptPath, AppRoot, StateRoot, Params: string;
begin
  PythonExe := ExpandConstant('{app}\runtime\python.exe');
  ScriptPath := ExpandConstant('{app}\windows_legacy_cutover.py');
  AppRoot := ExpandConstant('{app}');
  StateRoot := ExpandConstant('{commonappdata}\CitadelEWS\state');
  Params :=
    '"' + ScriptPath + '" ' + Action +
    ' --app-root "' + AppRoot + '"' +
    ' --state-root "' + StateRoot + '"' +
    ExtraArgs;
  RequireExec(PythonExe, Params, 'CITADEL legacy lifecycle ' + Action + ' failed');
end;

procedure TryLegacyCutover(Action, ExtraArgs: string);
var
  PythonExe, ScriptPath, AppRoot, StateRoot, Params: string;
begin
  PythonExe := ExpandConstant('{app}\runtime\python.exe');
  ScriptPath := ExpandConstant('{app}\windows_legacy_cutover.py');
  if not FileExists(PythonExe) or not FileExists(ScriptPath) then
    exit;
  AppRoot := ExpandConstant('{app}');
  StateRoot := ExpandConstant('{commonappdata}\CitadelEWS\state');
  Params :=
    '"' + ScriptPath + '" ' + Action +
    ' --app-root "' + AppRoot + '"' +
    ' --state-root "' + StateRoot + '"' +
    ExtraArgs;
  TryExec(PythonExe, Params);
end;

procedure AbortLegacyMigrationLifecycle;
var
  Sc: string;
begin
  { A legacy migration failed after the replacement supervisor was staged.
    Remove only the new machine lifecycle and release the HOLD marker; the
    helper keeps/restores the old per-user Startup lifecycle on failure. }
  StopExistingService;
  StopFallbackTask;
  DeleteFallbackTask;
  Sc := ExpandConstant('{sys}\sc.exe');
  TryExec(Sc, 'delete {#ServiceName}');
  TryLegacyCutover('abort', '');
  DeleteFile(ExpandConstant('{commonappdata}\CitadelEWS\state\install-mode.txt'));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  { Stop either installation mode before [Files] replaces bundled binaries. }
  StopExistingService;
  StopFallbackTask;
  DeleteFallbackTask;
  Result := '';
end;

procedure WriteDefaultConfig;
var
  StateRoot, ConfigPath, ConfigText, ControllerUrl: string;
begin
  StateRoot := ExpandConstant('{commonappdata}\CitadelEWS\state');
  ControllerUrl := ExpandConstant('{param:CONTROLLERURL|' + DefaultControllerUrl + '}');
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

procedure HardenDirectories;
var
  Icacls, AppRoot, StateRoot: string;
begin
  Icacls := ExpandConstant('{sys}\icacls.exe');
  AppRoot := ExpandConstant('{app}');
  StateRoot := ExpandConstant('{commonappdata}\CitadelEWS\state');
  ForceDirectories(StateRoot);
  if not DirExists(StateRoot) then
    RaiseException('Unable to create the CITADEL state directory.');

  RequireExec(
    Icacls,
    '"' + AppRoot + '" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-19:(OI)(CI)RX"',
    'Unable to secure the CITADEL program directory'
  );

  RequireExec(
    Icacls,
    '"' + StateRoot + '" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-19:(OI)(CI)M"',
    'Unable to secure the CITADEL state directory'
  );
end;

function ExecOk(FileName, Params: string): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(FileName, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function ForceFallbackRequested: Boolean;
begin
  Result := CompareText(ExpandConstant('{param:FORCEFALLBACK|0}'), '1') = 0;
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
  if ForceFallbackRequested then exit;

  Sc := ExpandConstant('{sys}\sc.exe');
  ServiceExe := ExpandConstant('{app}\CitadelNodeService.exe');
  ServiceArgs :=
    'binPath= "' + ServiceExe +
    '" start= delayed-auto obj= "NT AUTHORITY\LocalService" DisplayName= "{#ProductName}"';

  if not ExecOk(Sc, 'config {#ServiceName} ' + ServiceArgs) then
    if not ExecOk(Sc, 'create {#ServiceName} ' + ServiceArgs) then exit;

  if not ExecOk(Sc, 'description {#ServiceName} "CITADEL/EWS bounded node service with bundled Python runtime"') then exit;
  if not ExecOk(Sc, 'failure {#ServiceName} reset= 86400 actions= restart/5000/restart/15000/restart/60000') then exit;
  if not ExecOk(Sc, 'start {#ServiceName}') then exit;

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

procedure InstallFallbackTask;
var
  SchTasks, Sc, HostExe, TaskXml, TaskXmlPath: string;
  FileSystem, XmlFile: Variant;
begin
  StopExistingService;
  Sc := ExpandConstant('{sys}\sc.exe');
  TryExec(Sc, 'delete {#ServiceName}');
  Sleep(1000);

  SchTasks := ExpandConstant('{sys}\schtasks.exe');
  HostExe := ExpandConstant('{app}\CitadelNodeService.exe');
  TaskXmlPath := ExpandConstant('{tmp}\citadel-fallback.xml');
  { Explicit settings avoid the Scheduler defaults (72-hour limit and AC only).
    LocalService matches the preferred service account and existing directory ACLs. }
  TaskXml :=
    '<?xml version="1.0" encoding="UTF-16"?>' +
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">' +
    '<Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>' +
    '<Principals><Principal id="Agent"><UserId>S-1-5-19</UserId>' +
    '<RunLevel>LeastPrivilege</RunLevel></Principal></Principals>' +
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
  { SchTasks consumes a Unicode XML file; FSO writes UTF-16LE with a BOM. }
  FileSystem := CreateOleObject('Scripting.FileSystemObject');
  XmlFile := FileSystem.CreateTextFile(TaskXmlPath, True, True);
  try
    XmlFile.Write(TaskXml);
  finally
    XmlFile.Close;
  end;

  DeleteFallbackTask;
  try
    RequireExec(
      SchTasks,
      '/Create /TN "{#FallbackTaskName}" /XML "' + TaskXmlPath + '" /RU "NT AUTHORITY\LOCALSERVICE" /F',
      'Unable to register CITADEL fallback startup task'
    );
  finally
    DeleteFile(TaskXmlPath);
  end;
  RequireExec(
    SchTasks,
    '/Query /TN "{#FallbackTaskName}"',
    'CITADEL fallback startup task was not persisted'
  );
  RequireExec(
    SchTasks,
    '/Run /TN "{#FallbackTaskName}"',
    'Unable to start CITADEL fallback startup task'
  );
  WriteInstallMode('windows_boot_task');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    HardenDirectories;
    RequireLegacyCutover('stage', '');
    LegacyCutoverActive := FileExists(LegacyCutoverMarkerPath);
    try
      WriteDefaultConfig;
      if not TryInstallService then
      begin
        Log('CITADEL Windows Service path unavailable; switching to bounded LocalService boot-task fallback.');
        InstallFallbackTask;
      end;
      if LegacyCutoverActive then
        RequireLegacyCutover('commit', ' --expected-version "{#MyVersion}"');
      StartupConfigured := True;
    except
      if LegacyCutoverActive then
        AbortLegacyMigrationLifecycle;
      RaiseException('CITADEL post-install lifecycle cutover failed.');
    end;
  end;
end;

function GetCustomSetupExitCode: Integer;
begin
  { ssPostInstall exceptions alone can otherwise leave a false success code. }
  if StartupConfigured then Result := 0 else Result := 1;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Sc: string;
begin
  if CurUninstallStep = usUninstall then
  begin
    Sc := ExpandConstant('{sys}\sc.exe');
    StopExistingService;
    TryExec(Sc, 'delete {#ServiceName}');
    StopFallbackTask;
    DeleteFallbackTask;
    TryLegacyCutover('uninstall', '');
  end;
end;
