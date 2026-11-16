; Runs elevated during the per-machine install.
!macro customInstall
  ; Let phones on the shop's private network reach the PrintHub server, and nothing else.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="PrintHub"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="PrintHub" dir=in action=allow protocol=TCP localport=3000 profile=private,domain remoteip=localsubnet program="$INSTDIR\PrintHub.exe"'
  ; Shared data folder writable by the (non-admin) shopkeeper account.
  CreateDirectory "$COMMONAPPDATA\PrintHub"
  nsExec::Exec 'icacls "$COMMONAPPDATA\PrintHub" /grant *S-1-5-32-545:(OI)(CI)M /T'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="PrintHub"'
  ; Customer data in ProgramData is intentionally left for the shopkeeper to remove.
!macroend
