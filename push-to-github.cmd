@echo off
rem ============================================================
rem  push vodpad to github. double click this.
rem  the first time, a GitHub sign-in window appears -
rem  choose "Sign in with your browser" and approve. that's it.
rem
rem  this stages and commits whatever changed before pushing.
rem  it used to only push, which quietly did nothing at all when
rem  the build had not been committed yet.
rem ============================================================
cd /d "%~dp0"
title vodpad - push to github

echo.
echo   pushing to https://github.com/zevwtf-boop/vodpad
echo.
echo   if a GitHub window pops up, pick "Sign in with your browser"
echo   and approve it. you only ever do this once.
echo.

git add -A
git diff --cached --quiet
if not errorlevel 1 goto nothing

set "MSG="
set /p "MSG=  one line about this change (or just press enter): "
if not defined MSG set "MSG=update the site"
git commit -m "%MSG%"
if errorlevel 1 goto failed
goto push

:nothing
echo   nothing new to commit - pushing what is already committed.

:push
git push -u origin main
if errorlevel 1 goto failed

echo.
echo   done. the site is at:
echo     https://zevwtf-boop.github.io/vodpad/
echo.
echo   give it a minute, then hard-refresh with ctrl+shift+r.
echo   tell claude "pushed" and it'll check the live site.
echo.
pause
exit /b 0

:failed
echo.
echo   that didn't go through. copy whatever it says above and send it over.
echo.
pause
exit /b 1
