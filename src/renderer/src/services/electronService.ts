import type {
  FileReadResult,
  FileWriteResult,
  OpenDialogOptions,
  OpenDialogResult,
  SaveDialogOptions,
  SaveDialogResult
} from '../../../preload/api.types'

export interface ElectronService {
  isElectron: boolean
  showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogResult>
  showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogResult>
  writeFile: (filePath: string, content: string) => Promise<FileWriteResult>
  readFile: (filePath: string) => Promise<FileReadResult>
}

const isElectronEnv = typeof window !== 'undefined' && 'api' in window

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const electronService: ElectronService = {
  isElectron: isElectronEnv,

  showSaveDialog: async (options) => {
    if (isElectronEnv) {
      return window.api.showSaveDialog(options)
    }

    console.warn('showSaveDialog called outside Electron env.')

    const fileName = prompt(
      'Nhập tên file để lưu (giả lập):',
      options.defaultPath || 'project.fairobot'
    )

    if (fileName) {
      return { canceled: false, filePath: fileName }
    }

    return { canceled: true }
  },

  showOpenDialog: async (options) => {
    if (isElectronEnv) {
      return window.api.showOpenDialog(options)
    }

    console.warn('showOpenDialog called outside Electron env.')
    alert('Vui lòng sử dụng tính năng import trên giao diện web.')

    return { canceled: true, filePaths: [] }
  },

  writeFile: async (filePath, content) => {
    if (isElectronEnv) {
      return window.api.writeFile(filePath, content)
    }

    console.warn('writeFile called outside Electron env.')

    try {
      const blob = new Blob([content], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')

      anchor.href = url
      anchor.download = filePath.split(/[\\/]/).pop() || 'project.fairobot'

      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      URL.revokeObjectURL(url)

      return { success: true }
    } catch (error: unknown) {
      return { success: false, error: getErrorMessage(error) }
    }
  },

  readFile: async (filePath) => {
    if (isElectronEnv) {
      return window.api.readFile(filePath)
    }

    console.warn('readFile called outside Electron env.')

    return {
      success: false,
      error: 'Không hỗ trợ đọc file trực tiếp ngoài Electron.'
    }
  }
}
