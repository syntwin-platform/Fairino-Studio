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

export interface AppApi {
  showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogResult>
  showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogResult>
  writeFile: (filePath: string, content: string) => Promise<FileWriteResult>
  readFile: (filePath: string) => Promise<FileReadResult>
  onMenuAction: (callback: (action: string) => void) => () => void
}
