; Runs elevated during the per-machine install.
!macro customInstall
  ; Let phones on the same local subnet reach PrintHub. Any profile: Windows often marks new Wi-Fi as Public.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="PrintHub"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="PrintHub" dir=in action=allow protocol=TCP localport=3000 profile=any remoteip=localsubnet program="$INSTDIR\PrintHub.exe"'
  ; Shared data folder (C:\ProgramData\PrintHub) writable by the non-admin shopkeeper account.
  SetShellVarContext all
  CreateDirectory "$APPDATA\PrintHub"
  nsExec::Exec 'icacls "$APPDATA\PrintHub" /grant *S-1-5-32-545:(OI)(CI)M /T'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="PrintHub"'
  ; Customer data in ProgramData is intentionally left for the shopkeeper to remove.
!macroend
