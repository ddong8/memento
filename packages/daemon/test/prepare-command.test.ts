import { describe, expect, it } from "vitest";

import { parseShellExports, prepareCommand } from "../src/exec-env.js";

describe("prepareCommand", () => {
  it("runs the executable directly off Windows", async () => {
    expect(await prepareCommand("/usr/local/bin/codex", ["exec", "-p", "hello"], { isWindows: false })).toEqual({
      executable: "/usr/local/bin/codex",
      args: ["exec", "-p", "hello"],
    });
  });

  it("runs a Windows .exe with spaces in its path directly", async () => {
    const res = await prepareCommand("C:\\Program Files\\OpenAI\\codex.exe", ["exec", "-m", "gpt-4o"], { isWindows: true });
    expect(res).toEqual({ executable: "C:\\Program Files\\OpenAI\\codex.exe", args: ["exec", "-m", "gpt-4o"] });
  });

  it("resolves an npm batch wrapper to node and its script", async () => {
    const npmCmd = `@ECHO off
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;
    const res = await prepareCommand("C:\\Program Files\\nodejs\\codex.cmd", ["exec", "--skip-git-repo-check", "hello"], {
      isWindows: true,
      readText: async () => npmCmd,
      exists: () => true,
    });
    expect(res.executable).toContain("node.exe");
    expect(res.args[0]).toContain("node_modules\\@openai\\codex\\bin\\codex.js");
    expect(res.args.slice(1)).toEqual(["exec", "--skip-git-repo-check", "hello"]);
  });

  it("resolves a python batch wrapper to python and its script", async () => {
    const res = await prepareCommand("C:\\Users\\admin\\AppData\\Local\\agy\\bin\\agy.cmd", ["-p", "fix bug"], {
      isWindows: true,
      readText: async () => '@echo off\r\npython "C:\\Users\\admin\\AppData\\Local\\agy\\bin\\agy_cli.py" %*\r\n',
      exists: () => true,
      python: "python",
    });
    expect(res).toEqual({ executable: "python", args: ["C:\\Users\\admin\\AppData\\Local\\agy\\bin\\agy_cli.py", "-p", "fix bug"] });
  });

  it("runs any other batch file through COMSPEC /d /c call", async () => {
    const res = await prepareCommand("C:\\Program Files\\Some Vendor\\custom_tool.bat", ["--flag", "value with spaces"], {
      isWindows: true,
      comSpec: "C:\\Windows\\system32\\cmd.exe",
      readText: async () => "@echo custom batch script",
      exists: () => true,
    });
    expect(res).toEqual({
      executable: "C:\\Windows\\system32\\cmd.exe",
      args: ["/d", "/c", "call", "C:\\Program Files\\Some Vendor\\custom_tool.bat", "--flag", "value with spaces"],
    });
  });

  it("wraps a .mjs or .js file directly with node on Windows", async () => {
    const res = await prepareCommand("C:\\Users\\admin\\.workbuddy\\bin\\workbuddy_cli.mjs", ["-p", "hello"], {
      isWindows: true,
    });
    expect(res).toEqual({
      executable: "node",
      args: ["C:\\Users\\admin\\.workbuddy\\bin\\workbuddy_cli.mjs", "-p", "hello"],
    });
  });

  it("wraps a .py file directly with python on Windows", async () => {
    const res = await prepareCommand("C:\\Users\\admin\\.gemini\\antigravity\\bin\\agy_cli.py", ["-p", "task"], {
      isWindows: true,
      python: "C:\\Python312\\python.exe",
    });
    expect(res).toEqual({
      executable: "C:\\Python312\\python.exe",
      args: ["C:\\Users\\admin\\.gemini\\antigravity\\bin\\agy_cli.py", "-p", "task"],
    });
  });
});

it("reads the API keys agents need from shell rc files", () => {
  const rc = `# comment
export OPENAI_API_KEY="sk-one"
ANTHROPIC_API_KEY='sk-two'; echo hi
export PATH=/usr/bin
export OPENAI_API_KEY=sk-later
`;
  expect(parseShellExports(rc)).toEqual({ OPENAI_API_KEY: "sk-one", ANTHROPIC_API_KEY: "sk-two" });
});
