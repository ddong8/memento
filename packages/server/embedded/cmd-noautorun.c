/*
 * cmd-noautorun.c — Tiny zero-dependency Windows COMSPEC shim for embedded PostgreSQL.
 *
 * Why this exists:
 *   PostgreSQL's initdb.exe and pg_ctl.exe invoke MSVC _popen("\"...\\postgres.exe\" -V", "r")
 *   to verify the postgres binary version (src/common/exec.c -> pipe_read_line).
 *   MSVC _popen() spawns "%COMSPEC% /c <cmd>" WITHOUT /d. On Windows machines where
 *   HKLM or HKCU "Software\Microsoft\Command Processor\AutoRun" prints anything to stdout
 *   (very common on Chinese dev PCs: `chcp 65001` prints "Active code page: 65001", or
 *   conda/clink hooks), pipe_read_line() reads that banner as the first line instead of
 *   "postgres (PostgreSQL) 16.16" and aborts with "not the same version as initdb".
 *
 * What it does:
 *   Forwards the exact tail of GetCommandLineW() to "<System32>\cmd.exe /d <tail>" with
 *   inherited stdio handles and returns its exit code, without touching the user's registry.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

int wmain(void) {
  const wchar_t *raw = GetCommandLineW();
  const wchar_t *p = raw;

  /* Skip argv[0] (the shim's own path, quoted or unquoted) */
  if (*p == L'"') {
    p++;
    while (*p && *p != L'"') p++;
    if (*p == L'"') p++;
  } else {
    while (*p && *p != L' ' && *p != L'\t') p++;
  }
  while (*p == L' ' || *p == L'\t') p++;

  wchar_t sysDir[MAX_PATH];
  UINT sysLen = GetSystemDirectoryW(sysDir, MAX_PATH);
  if (sysLen == 0 || sysLen >= MAX_PATH - 12) return 1;

  wchar_t cmdPath[MAX_PATH + 16];
  DWORD n = 0;
  for (UINT i = 0; i < sysLen; i++) cmdPath[n++] = sysDir[i];
  if (n > 0 && cmdPath[n - 1] != L'\\') cmdPath[n++] = L'\\';
  const wchar_t *suffix = L"cmd.exe";
  for (int i = 0; suffix[i]; i++) cmdPath[n++] = suffix[i];
  cmdPath[n] = L'\0';

  SIZE_T tailLen = lstrlenW(p);
  SIZE_T totalChars = (SIZE_T)n + 8 + tailLen + 1;
  wchar_t *cmdLine = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, totalChars * sizeof(wchar_t));
  if (!cmdLine) return 1;

  SIZE_T pos = 0;
  cmdLine[pos++] = L'"';
  for (DWORD i = 0; i < n; i++) cmdLine[pos++] = cmdPath[i];
  cmdLine[pos++] = L'"';
  cmdLine[pos++] = L' ';
  cmdLine[pos++] = L'/';
  cmdLine[pos++] = L'd';
  if (tailLen > 0) {
    cmdLine[pos++] = L' ';
    for (SIZE_T i = 0; i < tailLen; i++) cmdLine[pos++] = p[i];
  }
  cmdLine[pos] = L'\0';

  STARTUPINFOW si;
  PROCESS_INFORMATION pi;
  ZeroMemory(&si, sizeof(si));
  ZeroMemory(&pi, sizeof(pi));
  si.cb = sizeof(si);

  BOOL ok = CreateProcessW(cmdPath, cmdLine, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi);
  HeapFree(GetProcessHeap(), 0, cmdLine);
  if (!ok) return 1;

  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD exitCode = 1;
  GetExitCodeProcess(pi.hProcess, &exitCode);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return (int)exitCode;
}
