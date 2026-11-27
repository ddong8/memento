// Install bootstrap routes (/install.sh, /install.ps1, /install/executor.sh, /install, /install/latest.tar.gz).
// Matches server/server/api/install_bootstrap.py.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Hono, type Context } from "hono";

import type { AppEnv } from "../context";

export const installRoutes = new Hono<AppEnv>();

const GITHUB_BASE = "https://github.com/ddong8/memento";

function findBootstrapDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    "/app/bootstrap",
    resolve(process.cwd(), "deploy/bootstrap"),
    resolve(here, "../../../../deploy/bootstrap"),
    resolve(here, "../../../deploy/bootstrap"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1]!;
}

async function serveScript(c: Context, name: string, mediaType: string) {
  const path = resolve(findBootstrapDir(), name);
  if (!existsSync(path)) {
    return c.text(`Bootstrap asset missing on server: ${name}`, 503);
  }
  const content = await readFile(path);
  return new Response(content, {
    status: 200,
    headers: {
      "content-type": mediaType,
      "cache-control": "public, max-age=300",
    },
  });
}

function publicBase(c: Context): string {
  const url = new URL(c.req.url);
  const proto = (c.req.header("x-forwarded-proto") ?? "").split(",", 1)[0]!.trim() || url.protocol.replace(/:$/, "");
  const rawHost = (c.req.header("x-forwarded-host") ?? "").split(",", 1)[0]!.trim() || c.req.header("host") || "";
  const host = [...rawHost].filter((ch) => /[a-zA-Z0-9.\-:[\]]/.test(ch)).join("");
  if ((proto !== "http" && proto !== "https") || !host) return "";
  return `${proto}://${host}`;
}

installRoutes.get("/install.sh", (c) => serveScript(c, "install.sh", "text/x-shellscript; charset=utf-8"));
installRoutes.get("/install.ps1", (c) => serveScript(c, "install.ps1", "text/plain; charset=utf-8"));

installRoutes.get("/install/executor.sh", async (c) => {
  const path = resolve(findBootstrapDir(), "executor.sh");
  if (!existsSync(path)) return c.text("Bootstrap asset missing on server: executor.sh", 503);
  const body = (await readFile(path, "utf8")).replaceAll("__MEMENTO_SERVER__", publicBase(c) || "__MEMENTO_SERVER__");
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
});

const landing = async (c: Context) => {
  const path = resolve(findBootstrapDir(), "index.html");
  if (!existsSync(path)) {
    return c.html("<h1>Memento</h1><p>Install: <code>curl -fsSL /install.sh | sh</code></p>", 200);
  }
  const content = await readFile(path);
  return new Response(content, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};

installRoutes.get("/install", landing);
installRoutes.get("/install/", landing);

installRoutes.get("/install/latest.tar.gz", (c) => c.redirect(`${GITHUB_BASE}/archive/refs/heads/main.tar.gz`, 302));
