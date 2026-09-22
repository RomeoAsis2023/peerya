$out = Join-Path $env:USERPROFILE "Desktop"
$url = "https://romeoasis2023.github.io/peerya/#junieadminizer-txWCscU69yLgnJYNaScOVnk4PvY9yfu4vAhaq1gdpzU"
$inject = Join-Path $PSScriptRoot "scp-inject.js"
& npx.cmd --yes nativefier --name "Peerya Superadmin" --platform windows --arch x64 --user-agent "PeeryaSCP/1.0" --inject $inject --disable-dev-tools --single-instance $url $out
