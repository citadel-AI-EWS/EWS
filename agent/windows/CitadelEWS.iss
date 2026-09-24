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
  ControllerUrl = 'https://citadel-ai.init1.workers.dev';
  ControllerPublicX = 'erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0';

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
  if not Exec(FileName, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
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

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  { Stop an existing service before [Files] replaces the bundled runtime or host. }
  StopExistingService;
  Result := '';
end;

procedure WriteDefaultConfig;
var
  StateRoot, ConfigPath, ConfigText: string;
begin
  StateRoot := ExpandConstant('{commonappdata}\CitadelEWS\state');
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

procedure InstallService;
var
  Sc, ServiceExe, ServiceArgs: string;
  ResultCode: Integer;
begin
  Sc := ExpandConstant('{sys}\sc.exe');
  ServiceExe := ExpandConstant('{app}\CitadelNodeService.exe');
  ServiceArgs :=
    'binPath= "' + ServiceExe +
    '" start= delayed-auto obj= "NT AUTHORITY\LocalService" DisplayName= "{#ProductName}"';

  { Repair/upgrade in place when the service already exists. }
  if not Exec(Sc, 'config {#ServiceName} ' + ServiceArgs, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    RaiseException('Unable to inspect/update the CITADEL Windows service');

  if ResultCode <> 0 then
  begin
    RequireExec(
      Sc,
      'create {#ServiceName} ' + ServiceArgs,
      'Unable to register the CITADEL Windows service'
    );
  end;

  RequireExec(
    Sc,
    'description {#ServiceName} "CITADEL/EWS bounded node service with bundled Python runtime"',
    'Unable to set the CITADEL service description'
  );

  RequireExec(
    Sc,
    'failure {#ServiceName} reset= 86400 actions= restart/5000/restart/15000/restart/60000',
    'Unable to configure CITADEL service recovery'
  );

  RequireExec(
    Sc,
    'start {#ServiceName}',
    'Unable to start the CITADEL Windows service'
  );
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    WriteDefaultConfig;
    HardenDirectories;
    InstallService;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Sc: string;
begin
  if CurUninstallStep = usUninstall then
  begin
    Sc := ExpandConstant('{sys}\sc.exe');
    TryExec(Sc, 'stop {#ServiceName}');
    Sleep(1000);
    TryExec(Sc, 'delete {#ServiceName}');
  end;
end;
