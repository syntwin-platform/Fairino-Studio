import type { ElectronAPI } from '@electron-toolkit/preload'

import type { AppApi } from './api.types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: AppApi
  }
}
