// Instagram and Facebook only serve a reel to a signed-in account, and since Chrome 127 the
// browser refuses to hand its cookie jar to any other program (App-Bound encryption). The
// cookie file therefore has to be exported by the user once. This helper makes that a
// single command: it copies the exported file into place and prints the env var to set.
const out = 'C:\\Users\\Ghulam Mohudin\\Desktop\\CLINE\\komyosys-video-downloader\\cookies\\instagram-facebook.txt';

Write-Host ''
Write-Host 'Instagram / Facebook ke liye ek hi baar ye karo:' -ForegroundColor Cyan
Write-Host ''
Write-Host ' 1. Chrome me Instagram/Facebook login karein (already ho to skip)'
Write-Host ' 2. Ye extension install karein:' -ForegroundColor Yellow
Write-Host '      https://chromewebstore.google.com/detail/get-cookies-securely-in-cdnghbldopoebckbnhcobkjijfcaaigo'
Write-Host ' 3. Extension click karke "Export cookies for this site" dabayein'
Write-Host ' 4. File ko yaha save karein:' -ForegroundColor Yellow
Write-Host "      $out"
Write-Host ''

$dir = Split-Path $out -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

Write-Host "Jab file save ho jaye, yahan ENTER dabayein..." -ForegroundColor Green
$null = Read-Host

if (Test-Path $out) {
    $size = (Get-Item $out).Length
    Write-Host ''
    Write-Host "cookies.txt mil gayi ($size bytes) - Instagram aur Facebook ab kaam karenge!" -ForegroundColor Green
    Write-Host ''
    Write-Host 'Server restart karke ye chalayein:' -ForegroundColor Cyan
    Write-Host "  `$env:INSTAGRAM_COOKIES_FILE = '$out'"
    Write-Host "  `$env:FACEBOOK_COOKIES_FILE  = '$out'"
    Write-Host '  npm run start'
    Write-Host ''
    Write-Host 'Cookies khatam hone par link expire ho jayega - tab dobara export kar lein.' -ForegroundColor DarkGray
} else {
    Write-Host ''
    Write-Host "File yahan nahi mili. Export karne ke baad wahi path choose karein." -ForegroundColor Yellow
    Write-Host "Expected: $out"
}