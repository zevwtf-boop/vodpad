@echo off
rem ============================================================
rem  push vodpad to github. double click this.
rem  the first time, a GitHub sign-in window appears -
rem  choose "Sign in with your browser" and approve. that's it.
rem ============================================================
cd /d "%~dp0"
title vodpad - push to github

echo.
echo   pushing to https://github.com/zevwtf-boop/vodpad
echo.
echo   if a GitHub window pops up, pick "Sign in with your browser"
echo   and approve it. you only ever do this once.
echo.

git push -u origin main

if errorlevel 1 (
  echo.
  echo   that didn't go through. copy whatever it says above and send it over.
) else (
  echo.
  echo   done. the site is at:
  echo     https://zevwtf-boop.github.io/vodpad/
  echo.
  echo   tell claude "pushed" and it'll switch pages on and test it.
)

echo.
pause
