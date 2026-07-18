; Fanad Windows installer — compiled by installer\build-installer.ps1, which stages the payload
; (app + production node_modules + web\dist + private Node runtime) and passes the defines below.

#ifndef AppVersion
  #error Pass /DAppVersion=x.y.z — run installer\build-installer.ps1 instead of compiling directly
#endif
#ifndef StagingDir
  #error Pass /DStagingDir=<staged payload dir> — run installer\build-installer.ps1 instead
#endif

[Setup]
AppId={{822E21CF-8E34-480D-B971-A4C08B950260}
AppName=Fanad
AppVersion={#AppVersion}
AppPublisher=Fanad
DefaultDirName={localappdata}\Fanad
DefaultGroupName=Fanad
DisableProgramGroupPage=yes
; Per-user install: no admin, no UAC, and .env + data\ live beside the app exactly like a checkout.
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupIconFile=assets\fanad.ico
UninstallDisplayIcon={app}\fanad.ico
OutputDir=dist
OutputBaseFilename=FanadSetup-{#AppVersion}
; Unsigned for now (SmartScreen shows "unknown publisher" — documented in the README). When a
; signing identity exists, define a SignTool named e.g. "fanadsign" and uncomment:
;SignTool=fanadsign
;SignedUninstaller=yes

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; Upgrades replace these trees wholesale — overlaying a new node_modules/runtime over an old one
; would strand files from packages that no longer exist.
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\web\dist"

[Files]
Source: "{#StagingDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Start Fanad Server"; Filename: "{app}\bin\fanad-start.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\fanad.ico"; Comment: "Start the Fanad server (keep the window open)"
Name: "{group}\Fanad Setup"; Filename: "{app}\bin\fanad-setup.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\fanad.ico"; Comment: "First-run setup wizard — writes .env"
Name: "{autodesktop}\Fanad"; Filename: "{app}\bin\fanad-start.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\fanad.ico"; Tasks: desktopicon

[Run]
; The wizard refuses to overwrite an existing .env ('wx' write), so this is safe on reinstall.
Filename: "{app}\bin\fanad-setup.cmd"; Description: "Run Fanad setup now"; Flags: postinstall nowait shellexec skipifsilent

[Code]
// Uninstall removes only what the installer put down — .env and data\ (DB + encryption key)
// survive by design. Tell the user where they are instead of deleting them.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and not UninstallSilent then
    MsgBox('Fanad was removed.' #13#10 #13#10
      + 'Your settings and data (including the database and encryption key) were kept at:' #13#10
      + ExpandConstant('{app}') + #13#10 #13#10
      + 'Delete that folder yourself if you want them gone too.',
      mbInformation, MB_OK);
end;
