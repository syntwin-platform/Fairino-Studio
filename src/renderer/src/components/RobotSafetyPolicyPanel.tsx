import { useCallback, useState } from 'react'
import {
  AlertOctagon,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Save,
  Shield
} from 'lucide-react'
import {
  deleteRobotSafetyPolicy,
  getRobotSafetyPolicy,
  putRobotSafetyPolicy,
  SafetyValidationError
} from '../services/backendSafetyClient'
import type {
  RobotJointLimit,
  RobotSafetyPolicyDefinition,
  RobotTcpWorkspaceLimit,
  SafetyPolicyResponse,
  SafetyPolicySource
} from '../types/backendDevice'
import SafetyDiagnosticsPanel from './SafetyDiagnosticsPanel'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sourceBadge(source: SafetyPolicySource): React.ReactElement {
  const styles: Record<SafetyPolicySource, string> = {
    Robot: 'bg-blue-950/60 text-blue-300 border border-blue-700/40',
    Company: 'bg-slate-800 text-slate-400 border border-slate-700/40',
    Default: 'bg-slate-800 text-slate-400 border border-slate-700/40'
  }

  const labels: Record<SafetyPolicySource, string> = {
    Robot: 'Robot Override',
    Company: 'Base Policy',
    Default: 'Base Policy'
  }

  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[9px] font-bold ${styles[source]}`}>
      {labels[source]}
    </span>
  )
}

function formatUpdatedAt(updatedAt: string | null): string {
  if (!updatedAt) return ''
  const d = new Date(updatedAt)
  if (Number.isNaN(d.getTime())) return updatedAt
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
// ─── Validation ───────────────────────────────────────────────────────────────

interface ValidationErrors {
  [key: string]: string
}

function validatePolicy(policy: RobotSafetyPolicyDefinition): ValidationErrors {
  const errors: ValidationErrors = {}

  if (!policy.name.trim()) errors.name = 'Name is required'
  if (!policy.robotModel.trim()) errors.robotModel = 'Robot model is required'

  if (policy.jointLimits.length !== 6) {
    errors.jointLimits = 'Exactly 6 joint limits required'
  } else {
    const jointNums = policy.jointLimits.map((j) => j.joint)
    const uniqueJoints = new Set(jointNums)
    if (uniqueJoints.size !== 6) errors.jointLimits = 'Duplicate joint numbers detected'
    else if (!jointNums.every((n) => n >= 1 && n <= 6))
      errors.jointLimits = 'Joint numbers must be 1–6'
    else {
      policy.jointLimits.forEach((j, idx) => {
        if (j.minDeg >= j.maxDeg) {
          errors[`joint_${idx}`] = `Joint ${j.joint}: minDeg must be < maxDeg`
        }
      })
    }
  }

  const tcp = policy.tcpWorkspace
  if (tcp.minX >= tcp.maxX) errors.tcpX = 'minX must be < maxX'
  if (tcp.minY >= tcp.maxY) errors.tcpY = 'minY must be < maxY'
  if (tcp.minZ >= tcp.maxZ) errors.tcpZ = 'minZ must be < maxZ'
  if (tcp.minRotationDeg >= tcp.maxRotationDeg)
    errors.tcpRot = 'minRotationDeg must be < maxRotationDeg'

  if (policy.minSpeedPercent < 1 || policy.minSpeedPercent > 100)
    errors.minSpeed = 'Min speed must be 1–100'
  if (policy.maxSpeedPercent < 1 || policy.maxSpeedPercent > 100)
    errors.maxSpeed = 'Max speed must be 1–100'
  if (policy.minSpeedPercent > policy.maxSpeedPercent)
    errors.speedRange = 'Min speed must be ≤ max speed'

  if (policy.minAccelerationPercent < 1 || policy.minAccelerationPercent > 100)
    errors.minAcc = 'Min acc must be 1–100'
  if (policy.maxAccelerationPercent < 1 || policy.maxAccelerationPercent > 100)
    errors.maxAcc = 'Max acc must be 1–100'
  if (policy.minAccelerationPercent > policy.maxAccelerationPercent)
    errors.accRange = 'Min acc must be ≤ max acc'

  if (policy.maxJointDeltaDegPerStep <= 0) errors.maxDeltaPerStep = 'Must be > 0'
  if (policy.maxFirstStepJointDeltaDeg <= 0) errors.maxFirstStepDelta = 'Must be > 0'

  return errors
}

// ─── Input helpers ────────────────────────────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span className="block text-[9px] font-semibold text-slate-500 uppercase tracking-wider mb-0.5">
      {children}
    </span>
  )
}

function TextInput({
  value,
  onChange,
  readOnly,
  error
}: {
  value: string
  onChange: (v: string) => void
  readOnly: boolean
  error?: string
}): React.ReactElement {
  return (
    <div>
      <input
        type="text"
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded border px-2 py-1 text-[11px] text-white outline-none transition
          ${readOnly ? 'bg-[#121214] border-[#2d2d34] text-slate-400 cursor-default' : 'bg-[#0f0f12] border-[#393942] focus:border-blue-500'}
          ${error ? 'border-red-500/60' : ''}`}
      />
      {error && <p className="mt-0.5 text-[9px] text-red-400">{error}</p>}
    </div>
  )
}

function NumberInput({
  value,
  onChange,
  readOnly,
  error,
  step = 1
}: {
  value: number
  onChange: (v: number) => void
  readOnly: boolean
  error?: string
  step?: number
}): React.ReactElement {
  return (
    <div>
      <input
        type="number"
        value={value}
        readOnly={readOnly}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className={`w-full rounded border px-2 py-1 text-[11px] font-mono text-white outline-none transition
          ${readOnly ? 'bg-[#121214] border-[#2d2d34] text-slate-400 cursor-default' : 'bg-[#0f0f12] border-[#393942] focus:border-blue-500'}
          ${error ? 'border-red-500/60' : ''}`}
      />
      {error && <p className="mt-0.5 text-[9px] text-red-400">{error}</p>}
    </div>
  )
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="space-y-2">
      <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500">{title}</p>
      {children}
    </div>
  )
}

// ─── PolicyForm ───────────────────────────────────────────────────────────────

interface PolicyFormProps {
  policy: RobotSafetyPolicyDefinition
  onChange: (p: RobotSafetyPolicyDefinition) => void
  readOnly: boolean
  errors: ValidationErrors
}

function PolicyForm({ policy, onChange, readOnly, errors }: PolicyFormProps): React.ReactElement {
  const set = <K extends keyof RobotSafetyPolicyDefinition>(
    key: K,
    value: RobotSafetyPolicyDefinition[K]
  ): void => {
    onChange({ ...policy, [key]: value })
  }

  const setJoint = (idx: number, field: keyof RobotJointLimit, value: number): void => {
    const updated = policy.jointLimits.map((jointLimit, index) =>
      index === idx ? { ...jointLimit, [field]: value } : jointLimit
    )

    set('jointLimits', updated)
  }

  const setTcp = (field: keyof RobotTcpWorkspaceLimit, value: number): void => {
    set('tcpWorkspace', { ...policy.tcpWorkspace, [field]: value })
  }

  return (
    <div className="space-y-4">
      {/* General */}
      <Section title="General">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <FieldLabel>Name</FieldLabel>
            <TextInput
              value={policy.name}
              onChange={(v) => set('name', v)}
              readOnly={readOnly}
              error={errors.name}
            />
          </div>
          <div>
            <FieldLabel>Robot Model</FieldLabel>
            <TextInput
              value={policy.robotModel}
              onChange={(v) => set('robotModel', v)}
              readOnly={readOnly}
              error={errors.robotModel}
            />
          </div>
        </div>
      </Section>

      {/* Joint Limits */}
      <Section title="Joint Limits">
        {errors.jointLimits && <p className="text-[9px] text-red-400 mb-1">{errors.jointLimits}</p>}
        <div className="space-y-1.5">
          {/* Header */}
          <div className="grid grid-cols-[2rem_1fr_1fr] gap-1.5 px-1">
            <span className="text-[9px] font-semibold text-slate-500 uppercase tracking-wider">
              J#
            </span>
            <span className="text-[9px] font-semibold text-slate-500 uppercase tracking-wider">
              Min °
            </span>
            <span className="text-[9px] font-semibold text-slate-500 uppercase tracking-wider">
              Max °
            </span>
          </div>
          {policy.jointLimits.map((j, idx) => (
            <div key={idx} className="grid grid-cols-[2rem_1fr_1fr] gap-1.5 items-center">
              <span className="text-[11px] font-mono font-bold text-slate-400 pl-1">{j.joint}</span>
              <NumberInput
                value={j.minDeg}
                onChange={(v) => setJoint(idx, 'minDeg', v)}
                readOnly={readOnly}
                error={errors[`joint_${idx}`]}
                step={0.1}
              />
              <NumberInput
                value={j.maxDeg}
                onChange={(v) => setJoint(idx, 'maxDeg', v)}
                readOnly={readOnly}
                step={0.1}
              />
            </div>
          ))}
        </div>
      </Section>

      {/* TCP Workspace */}
      <Section title="TCP Workspace (mm / °)">
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['minX', 'maxX', 'X axis', errors.tcpX],
              ['minY', 'maxY', 'Y axis', errors.tcpY],
              ['minZ', 'maxZ', 'Z axis', errors.tcpZ],
              ['minRotationDeg', 'maxRotationDeg', 'Rotation °', errors.tcpRot]
            ] as [
              keyof RobotTcpWorkspaceLimit,
              keyof RobotTcpWorkspaceLimit,
              string,
              string | undefined
            ][]
          ).map(([minKey, maxKey, label, err]) => (
            <div key={label} className="space-y-1 col-span-2">
              <FieldLabel>{label}</FieldLabel>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="text-[9px] text-slate-600">min</span>
                  <NumberInput
                    value={policy.tcpWorkspace[minKey]}
                    onChange={(v) => setTcp(minKey, v)}
                    readOnly={readOnly}
                    error={err}
                    step={1}
                  />
                </div>
                <div>
                  <span className="text-[9px] text-slate-600">max</span>
                  <NumberInput
                    value={policy.tcpWorkspace[maxKey]}
                    onChange={(v) => setTcp(maxKey, v)}
                    readOnly={readOnly}
                    step={1}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Speed & Acceleration */}
      <Section title="Speed & Acceleration (%)">
        {(errors.speedRange || errors.accRange) && (
          <p className="text-[9px] text-red-400">{errors.speedRange || errors.accRange}</p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <FieldLabel>Min Speed</FieldLabel>
            <NumberInput
              value={policy.minSpeedPercent}
              onChange={(v) => set('minSpeedPercent', v)}
              readOnly={readOnly}
              error={errors.minSpeed}
              step={1}
            />
          </div>
          <div>
            <FieldLabel>Max Speed</FieldLabel>
            <NumberInput
              value={policy.maxSpeedPercent}
              onChange={(v) => set('maxSpeedPercent', v)}
              readOnly={readOnly}
              error={errors.maxSpeed}
              step={1}
            />
          </div>
          <div>
            <FieldLabel>Min Acc</FieldLabel>
            <NumberInput
              value={policy.minAccelerationPercent}
              onChange={(v) => set('minAccelerationPercent', v)}
              readOnly={readOnly}
              error={errors.minAcc}
              step={1}
            />
          </div>
          <div>
            <FieldLabel>Max Acc</FieldLabel>
            <NumberInput
              value={policy.maxAccelerationPercent}
              onChange={(v) => set('maxAccelerationPercent', v)}
              readOnly={readOnly}
              error={errors.maxAcc}
              step={1}
            />
          </div>
        </div>
      </Section>

      {/* Step delta */}
      <Section title="Step Delta Limits (°)">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <FieldLabel>Max Δ/Step</FieldLabel>
            <NumberInput
              value={policy.maxJointDeltaDegPerStep}
              onChange={(v) => set('maxJointDeltaDegPerStep', v)}
              readOnly={readOnly}
              error={errors.maxDeltaPerStep}
              step={0.1}
            />
          </div>
          <div>
            <FieldLabel>Max First-Step Δ</FieldLabel>
            <NumberInput
              value={policy.maxFirstStepJointDeltaDeg}
              onChange={(v) => set('maxFirstStepJointDeltaDeg', v)}
              readOnly={readOnly}
              error={errors.maxFirstStepDelta}
              step={0.1}
            />
          </div>
        </div>
      </Section>
    </div>
  )
}

// ─── RobotSafetyPolicyPanel ───────────────────────────────────────────────────

interface RobotSafetyPolicyPanelProps {
  backendUrl: string
  robotId: string
  token: string
}

export default function RobotSafetyPolicyPanel({
  backendUrl,
  robotId,
  token
}: RobotSafetyPolicyPanelProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<SafetyPolicyResponse | null>(null)
  const [draft, setDraft] = useState<RobotSafetyPolicyDefinition | null>(null)
  const [errors, setErrors] = useState<ValidationErrors>({})
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [statusFailed, setStatusFailed] = useState(false)
  const [safetyError, setSafetyError] = useState<{
    message: string
    diagnostics: import('../types/backendDevice').SafetyDiagnostic[]
  } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setStatusMsg('')
    setStatusFailed(false)
    setSafetyError(null)
    try {
      const resp = await getRobotSafetyPolicy(backendUrl, robotId, token)
      setData(resp)
      setDraft(JSON.parse(JSON.stringify(resp.policy)) as RobotSafetyPolicyDefinition)
      setErrors({})
    } catch (err) {
      setStatusFailed(true)
      setStatusMsg(err instanceof Error ? err.message : 'Failed to load policy')
    } finally {
      setLoading(false)
    }
  }, [backendUrl, robotId, token])

  const handleToggle = (): void => {
    const nextExpanded = !expanded
    setExpanded(nextExpanded)

    if (nextExpanded && !data && !loading) {
      void load()
    }
  }

  const handleSave = async (): Promise<void> => {
    if (!draft) return

    const errs = validatePolicy(draft)
    setErrors(errs)
    if (Object.keys(errs).length > 0) return

    setSaving(true)
    setStatusMsg('')
    setStatusFailed(false)
    setSafetyError(null)
    try {
      await putRobotSafetyPolicy(backendUrl, robotId, draft, token)
      setStatusMsg('Policy saved as Robot Override')
      void load()
    } catch (err) {
      if (err instanceof SafetyValidationError) {
        setSafetyError({ message: err.message, diagnostics: err.diagnostics })
      } else {
        setStatusFailed(true)
        setStatusMsg(err instanceof Error ? err.message : 'Save failed')
      }
    } finally {
      setSaving(false)
    }
  }

  const handleReturnDefault = async (): Promise<void> => {
    if (
      !confirm(
        'Return this robot to the default/base policy? The robot-specific policy will be removed.'
      )
    ) {
      return
    }
    setDeleting(true)
    setStatusMsg('')
    setStatusFailed(false)
    setSafetyError(null)
    try {
      await deleteRobotSafetyPolicy(backendUrl, robotId, token)
      setStatusMsg('Returned to default/base policy')
      setData(null) // force re-fetch
      void load()
    } catch (err) {
      setStatusFailed(true)
      setStatusMsg(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }

  const busy = saving || deleting || loading

  return (
    <div className="rounded border border-[#2d2d34] overflow-hidden">
      {/* Header toggle */}
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center justify-between px-3 py-2 bg-[#141417] hover:bg-[#1b1b1f] transition select-none"
      >
        <div className="flex items-center gap-1.5">
          <Shield size={12} className="text-blue-400" />
          <span className="text-[10px] font-bold uppercase text-slate-400">Safety Policy</span>
          {data && (
            <span
              className={`inline-block rounded px-1.5 py-0.5 text-[8px] font-bold ${
                data.source === 'Robot'
                  ? 'bg-blue-950/60 text-blue-400'
                  : 'bg-slate-800 text-slate-500'
              }`}
            >
              {data.source === 'Robot' ? 'Robot' : 'Base'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {loading && <LoaderCircle size={10} className="animate-spin text-slate-500" />}
          {expanded ? (
            <ChevronUp size={12} className="text-slate-500" />
          ) : (
            <ChevronDown size={12} className="text-slate-500" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="max-h-[calc(100vh-12rem)] space-y-3 overflow-y-auto overscroll-contain bg-[#18181c] p-3">
          {loading && !data && (
            <div className="flex items-center gap-2 py-2 text-[10px] text-slate-400">
              <LoaderCircle size={12} className="animate-spin" />
              Loading policy…
            </div>
          )}

          {!loading && statusFailed && !data && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[10px] text-red-400">
                <AlertOctagon size={11} />
                {statusMsg}
              </div>
              <button
                type="button"
                onClick={() => void load()}
                className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300 transition"
              >
                <RefreshCw size={10} /> Retry
              </button>
            </div>
          )}

          {data && (
            <>
              {/* Meta row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                  {sourceBadge(data.source)}
                  {data.updatedAt && (
                    <span className="text-[9px] text-slate-600">
                      Updated {formatUpdatedAt(data.updatedAt)}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void load()}
                  disabled={busy}
                  title="Refresh policy"
                  className="rounded p-1 text-slate-500 hover:bg-[#25252b] hover:text-white disabled:opacity-40 transition"
                >
                  <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
                </button>
              </div>

              {/* Source context hint */}
              {data.source !== 'Robot' && (
                <div className="flex items-start gap-1.5 rounded bg-slate-800/40 border border-slate-700/30 px-2 py-1.5">
                  <AlertTriangle size={10} className="text-slate-400 mt-0.5 shrink-0" />
                  <p className="text-[9px] text-slate-400 leading-snug">
                    This is the current base policy. Save to create a robot-specific override.
                  </p>
                </div>
              )}

              {draft && (
                <PolicyForm
                  policy={draft}
                  onChange={setDraft}
                  readOnly={!data.canManage}
                  errors={errors}
                />
              )}

              {/* Diagnostics panel (from save attempt) */}
              {safetyError && (
                <SafetyDiagnosticsPanel
                  message={safetyError.message}
                  diagnostics={safetyError.diagnostics}
                  onClose={() => setSafetyError(null)}
                />
              )}

              {/* Status message */}
              {statusMsg && !safetyError && (
                <p className={`text-[10px] ${statusFailed ? 'text-red-400' : 'text-emerald-400'}`}>
                  {statusMsg}
                </p>
              )}

              {/* Action buttons */}
              {data.canManage && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={busy}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 hover:bg-blue-500 transition"
                  >
                    {saving ? (
                      <LoaderCircle size={11} className="animate-spin" />
                    ) : (
                      <Save size={11} />
                    )}
                    Save Policy
                  </button>

                  {data.source === 'Robot' && (
                    <button
                      type="button"
                      onClick={() => void handleReturnDefault()}
                      disabled={busy}
                      title="Remove robot-specific policy and return to the default/base policy"
                      className="flex items-center justify-center gap-1.5 rounded border border-slate-600/50 bg-slate-800/50 px-2.5 py-1.5 text-xs font-semibold text-slate-300 disabled:opacity-40 hover:border-blue-500/50 hover:bg-blue-950/30 hover:text-blue-200 transition"
                    >
                      {deleting ? (
                        <LoaderCircle size={11} className="animate-spin" />
                      ) : (
                        <RotateCcw size={11} />
                      )}
                      Return Default
                    </button>
                  )}
                </div>
              )}

            </>
          )}
        </div>
      )}
    </div>
  )
}
