export interface FileDialogFilter {
  name: string
  extensions: string[]
}

export interface SaveDialogOptions {
  title?: string
  defaultPath?: string
  filters?: FileDialogFilter[]
}

export interface OpenDialogOptions {
  title?: string
  defaultPath?: string
  filters?: FileDialogFilter[]
  properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles'>
}

export interface SaveDialogResult {
  canceled: boolean
  filePath?: string
}

export interface OpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

export interface FileWriteResult {
  success: boolean
  error?: string
}

export interface FileReadResult {
  success: boolean
  content?: string
  error?: string
}

export interface BackendRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface BackendResponsePayload {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
}

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

export interface AppApi {
  showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogResult>
  showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogResult>
  writeFile: (filePath: string, content: string) => Promise<FileWriteResult>
  readFile: (filePath: string) => Promise<FileReadResult>
  backendRequest: (url: string, options?: BackendRequestOptions) => Promise<BackendResponsePayload>
  onMenuAction: (callback: (action: string) => void) => () => void
  checkForUpdates: () => Promise<{ success: boolean; error?: string }>
  restartAndInstall: () => void
  onUpdateStatus: (callback: (payload: UpdateStatusPayload) => void) => () => void
}
