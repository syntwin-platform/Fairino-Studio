import { electronAPI } from '@electron-toolkit/preload'
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

import type {
  AppApi,
  BackendRequestOptions,
  BackendResponsePayload,
  OpenDialogOptions,
  OpenDialogResult,
  SaveDialogOptions,
  SaveDialogResult
} from './api.types'

type WindowWithApi = Window &
  typeof globalThis & {
    electron: typeof electronAPI
    api: AppApi
  }

const api: AppApi = {
  showSaveDialog: (options: SaveDialogOptions): Promise<SaveDialogResult> =>
    ipcRenderer.invoke('show-save-dialog', options) as Promise<SaveDialogResult>,

  showOpenDialog: (options: OpenDialogOptions): Promise<OpenDialogResult> =>
    ipcRenderer.invoke('show-open-dialog', options) as Promise<OpenDialogResult>,

  writeFile: (filePath, content) =>
    ipcRenderer.invoke('write-file', filePath, content) as ReturnType<AppApi['writeFile']>,

  readFile: (filePath) =>
    ipcRenderer.invoke('read-file', filePath) as ReturnType<AppApi['readFile']>,

  backendRequest: (url: string, options?: BackendRequestOptions): Promise<BackendResponsePayload> =>
    ipcRenderer.invoke('backend-request', url, options) as Promise<BackendResponsePayload>,

  onMenuAction: (callback) => {
    const listener = (_event: IpcRendererEvent, action: string): void => callback(action)
    ipcRenderer.on('menu-action', listener)

    return (): void => {
      ipcRenderer.removeListener('menu-action', listener)
    }
  },

  checkForUpdates: () =>
    ipcRenderer.invoke('check-for-updates') as ReturnType<AppApi['checkForUpdates']>,

  restartAndInstall: () => {
    ipcRenderer.invoke('restart-and-install')
  },

  onUpdateStatus: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => {
      callback(payload as Parameters<Parameters<AppApi['onUpdateStatus']>[0]>[0])
    }
    ipcRenderer.on('auto-update-status', listener)

    return (): void => {
      ipcRenderer.removeListener('auto-update-status', listener)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  const targetWindow = window as WindowWithApi
  targetWindow.electron = electronAPI
  targetWindow.api = api
}
