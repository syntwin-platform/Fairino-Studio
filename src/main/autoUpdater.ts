import { BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'

export type UpdateStatusState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateStatusPayload {
  state: UpdateStatusState
  version?: string
  progress?: {
    percent: number
    transferred: number
    total: number
    bytesPerSecond: number
  }
  error?: string
}

export function setupAutoUpdater(mainWindow: BrowserWindow): void {
  // Configure autoUpdater
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  const sendStatus = (payload: UpdateStatusPayload): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auto-update-status', payload)
    }
  }

  // Event handlers
  autoUpdater.on('checking-for-update', () => {
    sendStatus({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    sendStatus({ state: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', (info) => {
    sendStatus({ state: 'not-available', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    sendStatus({ state: 'error', error: err ? err.message : 'Unknown update error' })
  })

  autoUpdater.on('download-progress', (progressObj) => {
    sendStatus({
      state: 'downloading',
      progress: {
        percent: Math.round(progressObj.percent),
        transferred: progressObj.transferred,
        total: progressObj.total,
        bytesPerSecond: progressObj.bytesPerSecond
      }
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    sendStatus({ state: 'downloaded', version: info.version })
  })

  // IPC Listeners
  ipcMain.handle('check-for-updates', async () => {
    try {
      if (is.dev) {
        // In dev mode, autoUpdater might fail without dev-app-update.yml, so we return gracefully or try
        sendStatus({ state: 'checking' })
        const result = await autoUpdater.checkForUpdates()
        return { success: true, result }
      } else {
        const result = await autoUpdater.checkForUpdates()
        return { success: true, result }
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      sendStatus({ state: 'error', error: errorMsg })
      return { success: false, error: errorMsg }
    }
  })

  ipcMain.handle('restart-and-install', () => {
    autoUpdater.quitAndInstall(false, true)
  })

  // Perform initial update check in production mode automatically
  if (!is.dev) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error('Initial autoUpdate check failed:', err)
      })
    }, 5000) // Delay 5 seconds after startup to avoid slowing down launch
  }
}
