// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer, webUtils } from "electron";
import Store from "../../store-ipc/store";
import { MemoryStoreSchema, StoreSchema } from "~shared/store/schema";
import MemoryStore from "../../store-ipc/memory-store";
import { WindowsEventArguments } from "~shared/types";
import type { PlaybackProxySettings, PlaybackProxyState } from "~shared/playback-proxy";

const store = new Store<StoreSchema>();
const memoryStore = new MemoryStore<MemoryStoreSchema>();

const playbackProxy: PlaybackProxySettings = {
  getState: () => ipcRenderer.invoke("playbackProxy:getState"),
  chooseExecutable: () => ipcRenderer.invoke("playbackProxy:chooseExecutable"),
  importNodes: () => ipcRenderer.invoke("playbackProxy:importNodes"),
  fetchSubscription: url => ipcRenderer.invoke("playbackProxy:fetchSubscription", url),
  testNodes: () => ipcRenderer.invoke("playbackProxy:testNodes"),
  cancelTests: () => { void ipcRenderer.invoke("playbackProxy:cancelTests"); },
  setEnabled: enabled => ipcRenderer.invoke("playbackProxy:setEnabled", enabled),
  selectNode: id => ipcRenderer.invoke("playbackProxy:selectNode", id),
  removeNode: id => ipcRenderer.invoke("playbackProxy:removeNode", id),
  onChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: PlaybackProxyState) => callback(state);
    ipcRenderer.on("playbackProxy:changed", listener);
    return () => { ipcRenderer.removeListener("playbackProxy:changed", listener); };
  },
};

contextBridge.exposeInMainWorld("ytmd", {
  minimizeWindow: () => ipcRenderer.send("windowControls:minimize"),
  maximizeWindow: () => ipcRenderer.send("windowControls:maximize"),
  restoreWindow: () => ipcRenderer.send("windowControls:restore"),
  closeWindow: () => ipcRenderer.send("windowControls:close"),
  handleWindowEvents: (callback: (args: WindowsEventArguments) => void) =>
    ipcRenderer.on("windowControls:stateChanged", (event: Electron.IpcRendererEvent, args: WindowsEventArguments) => {
      callback(args);
    }),
  requestWindowState: () => ipcRenderer.send("windowControls:requestState"),

  isDarwin: process.platform === "darwin",
  isLinux: process.platform === "linux",
  isWindows: process.platform === "win32",
  memoryStore: {
    set: (key: string, value: unknown) => memoryStore.set(key, value),
    get: async (key: keyof MemoryStoreSchema) => await memoryStore.get(key),
    onStateChanged: (callback: (newState: MemoryStoreSchema, oldState: MemoryStoreSchema) => void) => memoryStore.onStateChanged(callback)
  },
  store: {
    set: (key: string, value: unknown) => store.set(key, value),
    get: async (key: keyof StoreSchema) => await store.get(key),
    reset: (key: keyof StoreSchema) => store.reset(key),
    onDidAnyChange: (callback: (newState: StoreSchema, oldState: StoreSchema) => void) => store.onDidAnyChange(callback)
  },
  safeStorage: {
    decryptString: async (value: string) => await ipcRenderer.invoke("safeStorage:decryptString", value),
    encryptString: async (value: string) => await ipcRenderer.invoke("safeStorage:encryptString", value)
  },
  restartApplication: () => ipcRenderer.send("app:relaunch"),
  restartApplicationForUpdate: () => ipcRenderer.send("app:restartApplicationForUpdate"),
  getAppVersion: async (): Promise<string> => await ipcRenderer.invoke("app:getVersion"),
  checkForUpdates: () => ipcRenderer.send("app:checkForUpdates"),
  handleCheckingForUpdate: (callback: () => void) => ipcRenderer.on("autoUpdater:checkingForUpdate", () => callback()),
  handleUpdateAvailable: (callback: () => void) => ipcRenderer.on("autoUpdater:updateAvailable", () => callback()),
  handleUpdateNotAvailable: (callback: () => void) => ipcRenderer.on("autoUpdater:updateNotAvailable", () => callback()),
  handleUpdateDownloaded: (callback: () => void) => ipcRenderer.on("autoUpdater:updateDownloaded", () => callback()),
  isAppUpdateAvailable: async (): Promise<boolean> => await ipcRenderer.invoke("autoUpdater:isUpdateAvailable"),
  isAppUpdateDownloaded: async (): Promise<boolean> => await ipcRenderer.invoke("autoUpdater:isUpdateDownloaded"),
  getTrueFilePath: (file: File) => webUtils.getPathForFile(file),
  playbackProxy,

  lastFMStepAuthenticate: () => ipcRenderer.send("lastfm:authenticate"),

  processVersions: { electron: process.versions.electron, chrome: process.versions.chrome }
});
