@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  ^<달 아래 비밀 없는 정원^> 베타플레이 서버를 시작합니다...
echo.
if not exist node_modules (
  echo  최초 실행: 필요한 패키지를 설치합니다. 잠시만 기다려주세요.
  call npm install
)
start "" http://localhost:3000/host
node server.js
pause
