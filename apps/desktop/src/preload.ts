import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

/**
 * What the web app can reach on the desktop: the local daemon's status, logs
 * and actions, and a few app settings. Exposed as window.mementoDesktop.
 */
const subscribe = (channel: string) => (cb: (payload: unknown) => void) => {
  const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

contextBridge.exposeInMainWorld("mementoDesktop", {
  isDesktop: true,
  info: () => ipcRenderer.invoke("app:info"),
  setOpenAtLogin: (on: boolean) => ipcRenderer.invoke("app:set-open-at-login", on),
  checkForUpdates: () => ipcRenderer.invoke("app:check-updates"),
  notify: (options: { title: string; body: string; url?: string }) =>
    ipcRenderer.invoke("app:notify", options),
  openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),
  openPath: (path: string) => ipcRenderer.invoke("shell:open-path", path),
  showItemInFolder: (path: string) => ipcRenderer.invoke("shell:show-item-in-folder", path),
  toMediaUrl: (path: string) => `memento-media://${path.startsWith("/") ? "" : "/"}${encodeURI(path)}`,
  daemon: {
    status: () => ipcRenderer.invoke("daemon:status"),
    logs: () => ipcRenderer.invoke("daemon:logs"),
    action: (name: "resync" | "rediscover" | "sync-profile") => ipcRenderer.invoke("daemon:action", name),
    onStatus: subscribe("daemon:status-event"),
    onLog: subscribe("daemon:log-event"),
    onMode: subscribe("daemon:mode-event"),
  },
});
