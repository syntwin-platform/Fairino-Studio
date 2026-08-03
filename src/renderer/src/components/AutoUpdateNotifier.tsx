import React, { useEffect, useState } from 'react'
import { Download, RefreshCw, AlertCircle, CheckCircle2, X, Sparkles } from 'lucide-react'
import type { UpdateStatusPayload } from '../../../preload/api.types'

export const AutoUpdateNotifier: React.FC = () => {
  const [status, setStatus] = useState<UpdateStatusPayload | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Listen for status updates from main process
    const removeStatusListener = window.api.onUpdateStatus((payload) => {
      setStatus(payload)
      if (payload.state !== 'idle') {
        setVisible(true)
      }
      if (payload.state === 'not-available') {
        // Auto hide "not available" toast after 4 seconds
        setTimeout(() => setVisible(false), 4000)
      }
    })

    // Listen for menu actions (Help -> Check for updates)
    const removeMenuListener = window.api.onMenuAction((action) => {
      if (action === 'check-for-updates') {
        setVisible(true)
        setStatus({ state: 'checking' })
        window.api.checkForUpdates().catch((err) => {
          setStatus({ state: 'error', error: err instanceof Error ? err.message : String(err) })
        })
      }
    })

    return () => {
      removeStatusListener()
      removeMenuListener()
    }
  }, [])

  if (!visible || !status) return null

  const handleRestart = (): void => {
    window.api.restartAndInstall()
  }

  const handleCheckAgain = (): void => {
    setStatus({ state: 'checking' })
    window.api.checkForUpdates().catch((err) => {
      setStatus({ state: 'error', error: err instanceof Error ? err.message : String(err) })
    })
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex w-96 max-w-[calc(100vw-3rem)] flex-col gap-3 rounded-xl border border-[#3b4259] bg-[#1c202e]/95 p-4 shadow-2xl backdrop-blur-md transition-all duration-300">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          {status.state === 'checking' && (
            <RefreshCw className="h-5 w-5 animate-spin text-blue-400" />
          )}
          {status.state === 'available' && <Sparkles className="h-5 w-5 text-amber-400" />}
          {status.state === 'downloading' && (
            <Download className="h-5 w-5 animate-bounce text-blue-400" />
          )}
          {status.state === 'downloaded' && <CheckCircle2 className="h-5 w-5 text-emerald-400" />}
          {status.state === 'not-available' && (
            <CheckCircle2 className="h-5 w-5 text-slate-400" />
          )}
          {status.state === 'error' && <AlertCircle className="h-5 w-5 text-rose-400" />}

          <div>
            <h4 className="text-sm font-semibold text-slate-100">
              {status.state === 'checking' && 'Đang kiểm tra bản cập nhật...'}
              {status.state === 'available' && `Phát hiện phiên bản mới v${status.version || ''}`}
              {status.state === 'downloading' && 'Đang tải bản cập nhật...'}
              {status.state === 'downloaded' && 'Cập nhật đã sẵn sàng!'}
              {status.state === 'not-available' && 'Bạn đang dùng phiên bản mới nhất'}
              {status.state === 'error' && 'Không thể kiểm tra cập nhật'}
            </h4>
            <p className="text-xs text-slate-400">
              {status.state === 'checking' && 'Đang kết nối tới máy chủ phát hành...'}
              {status.state === 'available' && 'Tệp cập nhật sẽ tự động được tải xuống.'}
              {status.state === 'downloading' &&
                `Tiến độ: ${status.progress?.percent || 0}% (${(
                  (status.progress?.transferred || 0) / 1024 / 1024
                ).toFixed(1)} / ${((status.progress?.total || 0) / 1024 / 1024).toFixed(1)} MB)`}
              {status.state === 'downloaded' &&
                'Khởi động lại ứng dụng để hoàn tất việc nâng cấp.'}
              {status.state === 'not-available' && 'Hệ thống đã ở phiên bản mới nhất.'}
              {status.state === 'error' && (status.error || 'Vui lòng kiểm tra lại kết nối mạng.')}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setVisible(false)}
          className="rounded-md p-1 text-slate-400 hover:bg-[#282f42] hover:text-slate-200"
          title="Đóng"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {status.state === 'downloading' && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-[#282f42]">
          <div
            className="h-full bg-blue-500 transition-all duration-300"
            style={{ width: `${status.progress?.percent || 0}%` }}
          />
        </div>
      )}

      {status.state === 'downloaded' && (
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={handleRestart}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-medium text-white shadow transition hover:bg-emerald-500 active:scale-95"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Khởi động lại & Cập nhật ngay
          </button>
        </div>
      )}

      {status.state === 'error' && (
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            onClick={handleCheckAgain}
            className="rounded-lg border border-[#3b4259] bg-[#242938] px-3 py-1 text-xs font-medium text-slate-200 hover:bg-[#2e3548]"
          >
            Thử lại
          </button>
        </div>
      )}
    </div>
  )
}
