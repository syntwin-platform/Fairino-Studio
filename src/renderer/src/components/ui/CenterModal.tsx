import { useEffect } from 'react'
import type { ReactElement } from 'react'
import { X } from 'lucide-react'

export interface CenterModalProps {
  title: string
  subtitle?: string
  icon?: React.ReactNode
  open: boolean
  onClose: () => void
  children: React.ReactNode
  size?: 'md' | 'lg' | 'xl'
}

export default function CenterModal({
  title,
  subtitle,
  icon,
  open,
  onClose,
  children,
  size = 'md'
}: CenterModalProps): ReactElement | null {
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose])

  if (!open) return null

  const sizeClasses = {
    md: 'max-w-md w-full',
    lg: 'max-w-2xl w-full',
    xl: 'max-w-4xl w-full'
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[#06070a]/80 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Modal Container */}
      <div
        className={`relative flex max-h-[85vh] flex-col rounded-xl border border-[#343849] bg-[#141720] text-slate-100 shadow-2xl transition-all ${sizeClasses[size]}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[#343849] bg-[#0c0e16]/50 px-5 py-4">
          <div className="flex items-center gap-2.5">
            {icon && <div className="text-blue-500">{icon}</div>}
            <div>
              <h3 className="text-sm font-bold text-white leading-tight">{title}</h3>
              {subtitle && (
                <p className="mt-0.5 text-[10px] text-slate-400 font-medium">{subtitle}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-[#242833] hover:text-white"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  )
}
