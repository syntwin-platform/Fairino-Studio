import { AlertOctagon, AlertTriangle, Info, X } from 'lucide-react'
import type { SafetyDiagnostic, SafetySeverity } from '../types/backendDevice'

// ─── Severity helpers ─────────────────────────────────────────────────────────

function severityOrder(s: SafetySeverity): number {
  switch (s) {
    case 'Blocker':
      return 0
    case 'Warning':
      return 1
    case 'Info':
      return 2
  }
}

function SeverityIcon({ severity }: { severity: SafetySeverity }): React.ReactElement {
  switch (severity) {
    case 'Blocker':
      return <AlertOctagon size={11} className="shrink-0 text-red-400" />
    case 'Warning':
      return <AlertTriangle size={11} className="shrink-0 text-amber-400" />
    case 'Info':
      return <Info size={11} className="shrink-0 text-blue-400" />
  }
}

function severityBadgeClass(severity: SafetySeverity): string {
  switch (severity) {
    case 'Blocker':
      return 'bg-red-950/60 text-red-300 border border-red-700/40'
    case 'Warning':
      return 'bg-amber-950/60 text-amber-300 border border-amber-700/40'
    case 'Info':
      return 'bg-blue-950/60 text-blue-300 border border-blue-700/40'
  }
}

function severityRowClass(severity: SafetySeverity): string {
  switch (severity) {
    case 'Blocker':
      return 'border-red-900/30 bg-red-950/10'
    case 'Warning':
      return 'border-amber-900/30 bg-amber-950/10'
    case 'Info':
      return 'border-blue-900/30 bg-blue-950/10'
  }
}

// ─── DiagnosticRow ────────────────────────────────────────────────────────────

function DiagnosticRow({ d }: { d: SafetyDiagnostic }): React.ReactElement {
  const stepRef =
    d.stepOrderIndex !== null
      ? [
          d.stepOrderIndex !== null ? `Step ${d.stepOrderIndex}` : null,
          d.stepLabel ? `"${d.stepLabel}"` : null
        ]
          .filter(Boolean)
          .join(' ')
      : null

  return (
    <div
      className={`flex gap-2 rounded px-2.5 py-2 border text-left ${severityRowClass(d.severity)}`}
    >
      <SeverityIcon severity={d.severity} />

      <div className="min-w-0 flex-1 space-y-0.5">
        {/* Top row: badge + code + step ref */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-bold ${severityBadgeClass(d.severity)}`}
          >
            {d.severity}
          </span>
          <span className="font-mono text-[9px] text-slate-400">{d.code}</span>
          {stepRef && <span className="text-[9px] text-slate-500 italic">{stepRef}</span>}
          {d.field && <span className="font-mono text-[9px] text-slate-500">field: {d.field}</span>}
        </div>

        {/* Message */}
        <p className="text-[10px] leading-snug text-slate-200">{d.message}</p>
      </div>
    </div>
  )
}

// ─── SafetyDiagnosticsPanel ───────────────────────────────────────────────────

export interface SafetyDiagnosticsPanelProps {
  message: string
  diagnostics: SafetyDiagnostic[]
  onClose?: () => void
}

export default function SafetyDiagnosticsPanel({
  message,
  diagnostics,
  onClose
}: SafetyDiagnosticsPanelProps): React.ReactElement {
  const sorted = [...diagnostics].sort(
    (a, b) => severityOrder(a.severity) - severityOrder(b.severity)
  )

  const blockers = sorted.filter((d) => d.severity === 'Blocker').length
  const warnings = sorted.filter((d) => d.severity === 'Warning').length

  return (
    <div className="rounded border border-red-700/40 bg-red-950/20 overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-red-700/30 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <AlertOctagon size={12} className="text-red-400 shrink-0" />
            <span className="text-[10px] font-bold uppercase text-red-300">
              Safety Validation Failed
            </span>
          </div>
          <p className="text-[10px] text-slate-300 leading-snug">{message}</p>
          <div className="mt-1 flex gap-2 text-[9px]">
            {blockers > 0 && (
              <span className="text-red-400 font-bold">
                {blockers} blocker{blockers > 1 ? 's' : ''}
              </span>
            )}
            {warnings > 0 && (
              <span className="text-amber-400 font-semibold">
                {warnings} warning{warnings > 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Dismiss"
            className="shrink-0 rounded p-0.5 text-slate-500 hover:bg-[#25252b] hover:text-slate-200 transition"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* Diagnostic list */}
      <div className="max-h-52 overflow-y-auto p-2 space-y-1.5">
        {sorted.map((d, idx) => (
          <DiagnosticRow key={`${d.code}-${idx}`} d={d} />
        ))}
      </div>
    </div>
  )
}
