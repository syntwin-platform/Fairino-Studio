import { app, BrowserWindow, dialog, Menu, MenuItemConstructorOptions, shell } from 'electron'
/**
 * Creates and sets the native application menu bar.
 * Dispatches file events to the Renderer process via WebContents.
 */
export function setupMenu(mainWindow: BrowserWindow): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    // File Menu
    {
      label: 'File',
      submenu: [
        {
          label: 'Dự án Mới',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            mainWindow.webContents.send('menu-action', 'new-project')
          }
        },
        {
          label: 'Mở Dự án...',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            mainWindow.webContents.send('menu-action', 'open-project')
          }
        },
        { type: 'separator' },
        {
          label: 'Lưu',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            mainWindow.webContents.send('menu-action', 'save-project')
          }
        },
        {
          label: 'Lưu Dưới Dạng...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            mainWindow.webContents.send('menu-action', 'save-as-project')
          }
        },
        { type: 'separator' },
        {
          label: 'Xuất Script LUA...',
          accelerator: 'CmdOrCtrl+E',
          click: () => {
            mainWindow.webContents.send('menu-action', 'export-lua')
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    // Edit Menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Hoàn tác' },
        { role: 'redo', label: 'Làm lại' },
        { type: 'separator' },
        { role: 'cut', label: 'Cắt' },
        { role: 'copy', label: 'Sao chép' },
        { role: 'paste', label: 'Dán' },
        { role: 'selectAll', label: 'Chọn tất cả' }
      ]
    },
    // View Menu
    {
      label: 'View',
      submenu: [
        { role: 'reload', label: 'Tải lại' },
        { role: 'forceReload', label: 'Tải lại toàn bộ' },
        { role: 'toggleDevTools', label: 'Bật/Tắt DevTools' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Đặt lại cỡ chữ' },
        { role: 'zoomIn', label: 'Phóng to' },
        { role: 'zoomOut', label: 'Thu nhỏ' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Toàn màn hình' }
      ]
    },
    // Help Menu
    {
      label: 'Help',
      submenu: [
        {
          label: 'Tìm hiểu thêm',
          click: async (): Promise<void> => {
            await shell.openExternal('https://electronjs.org')
          }
        },
        {
          label: 'Về FaiRobot Studio',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Về FaiRobot Studio',
              message: 'FaiRobot Studio v1.0.1',
              detail: 'Ứng dụng mô phỏng và lập trình kéo thả trực quan cho robot Fairino FR5.'
            })
          }
        }
      ]
    }
  ]

  // macOS specific menu setup
  if (isMac) {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about', label: `Về ${app.name}` },
        { type: 'separator' },
        { role: 'services', label: 'Dịch vụ' },
        { type: 'separator' },
        { role: 'hide', label: `Ẩn ${app.name}` },
        { role: 'hideOthers', label: 'Ẩn các cửa sổ khác' },
        { role: 'unhide', label: 'Hiện tất cả' },
        { type: 'separator' },
        { role: 'quit', label: `Thoát ${app.name}` }
      ]
    })
  }

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}
