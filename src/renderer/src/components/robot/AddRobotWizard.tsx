import { useEffect, useMemo, useState } from 'react'
import { LoaderCircle, Plus, RefreshCw, X } from 'lucide-react'
import {
  BackendRobot,
  BackendRobotModel,
  createRobot,
  listRobotModels
} from '../../services/backendRobotClient'
import CenterModal from '../ui/CenterModal'

interface AddRobotWizardProps {
  open: boolean
  backendUrl: string
  token: string
  companyId: string
  onClose: () => void
  onCreated?: (robot: BackendRobot, deviceSecret: string) => void
}

type RuntimeMode = 'Simulator' | 'HTTP'

function toNumber(value: string): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function firstModelName(model?: BackendRobotModel): string {
  return model?.displayName?.trim() || model?.modelCode?.trim() || 'Robot'
}

export default function AddRobotWizard({
  open,
  backendUrl,
  token,
  companyId,
  onClose,
  onCreated
}: AddRobotWizardProps): React.ReactElement {
  const [models, setModels] = useState<BackendRobotModel[]>([])
  const [selectedModelId, setSelectedModelId] = useState('')
  const [robotName, setRobotName] = useState('')
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>('Simulator')
  const [baseX, setBaseX] = useState('0')
  const [baseY, setBaseY] = useState('0')
  const [baseZ, setBaseZ] = useState('0')
  const [baseYaw, setBaseYaw] = useState('0')
  const [ipAddress, setIpAddress] = useState('')
  const [port, setPort] = useState('')

  const [loadingModels, setLoadingModels] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [createdSecret, setCreatedSecret] = useState('')

  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? null,
    [models, selectedModelId]
  )

  async function loadModels(): Promise<void> {
    if (!backendUrl.trim() || !token.trim()) return

    setLoadingModels(true)
    setError('')

    try {
      const result = await listRobotModels(backendUrl, token)
      setModels(result)

      if (!selectedModelId && result.length > 0) {
        setSelectedModelId(result[0].id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load robot models.')
    } finally {
      setLoadingModels(false)
    }
  }

  useEffect(() => {
    if (!open) return

    setCreatedSecret('')
    void loadModels()
  }, [open])

  useEffect(() => {
    if (!selectedModel || robotName.trim()) return

    setRobotName(`${firstModelName(selectedModel)} - Line 1`)
  }, [selectedModel, robotName])

  async function handleCreate(): Promise<void> {
    if (!companyId.trim()) {
      setError('Company ID is required.')
      return
    }

    if (!selectedModel) {
      setError('Please select a robot model.')
      return
    }

    if (!robotName.trim()) {
      setError('Robot name is required.')
      return
    }

    if (runtimeMode !== 'Simulator' && !ipAddress.trim()) {
      setError('IP address is required for real/controller mode.')
      return
    }

    setSaving(true)
    setError('')
    setCreatedSecret('')

    try {
      const response = await createRobot(backendUrl, token, {
        companyId,
        robotModelId: selectedModel.id,
        robotName: robotName.trim(),
        model: selectedModel.displayName || selectedModel.modelCode,
        connectionType: runtimeMode,
        ipAddress: runtimeMode === 'Simulator' ? null : ipAddress.trim(),
        port: runtimeMode === 'Simulator' || !port.trim() ? null : Number(port),
        sceneBinding: {
          sceneType: 'FairinoStudio',
          baseX: toNumber(baseX),
          baseY: toNumber(baseY),
          baseZ: toNumber(baseZ),
          baseYaw: toNumber(baseYaw),
          urdfPath: selectedModel.urdfPath ?? null,
          primPath: null,
          rosNamespace: null,
          graphPath: null
        }
      })

      setCreatedSecret(response.deviceSecret)
      onCreated?.(response.robot, response.deviceSecret)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create robot.')
    } finally {
      setSaving(false)
    }
  }

  function handleClose(): void {
    if (saving) return
    onClose()
  }

  return (
    <CenterModal
      title="Add Robot"
      subtitle="Create a backend robot instance and scene binding"
      icon={<Plus size={16} />}
      open={open}
      onClose={handleClose}
      size="lg"
    >
      <div className="space-y-4 text-slate-200">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase text-slate-400">Robot Model</p>
            <p className="text-[11px] text-slate-500">Choose from backend robot model catalog.</p>
          </div>

          <button
            type="button"
            onClick={() => void loadModels()}
            disabled={loadingModels || saving}
            className="flex items-center gap-1 rounded border border-[#343849] px-2 py-1 text-xs text-slate-300 hover:bg-[#242833] disabled:opacity-40"
          >
            <RefreshCw size={12} className={loadingModels ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="col-span-2 text-xs">
            <span className="mb-1 block text-slate-400">Model</span>
            <select
              value={selectedModelId}
              onChange={(event) => {
                setSelectedModelId(event.target.value)
                setRobotName('')
              }}
              disabled={loadingModels || saving}
              className="w-full rounded border border-[#343849] bg-[#0f0f12] px-3 py-2 text-sm text-white outline-none"
            >
              {models.length === 0 ? (
                <option value="">No models found</option>
              ) : (
                models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName} ({model.modelCode})
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="col-span-2 text-xs">
            <span className="mb-1 block text-slate-400">Robot Name</span>
            <input
              value={robotName}
              onChange={(event) => setRobotName(event.target.value)}
              disabled={saving}
              className="w-full rounded border border-[#343849] bg-[#0f0f12] px-3 py-2 text-sm text-white outline-none"
              placeholder="Fairino FR5 - Line 1"
            />
          </label>

          <label className="col-span-2 text-xs">
            <span className="mb-1 block text-slate-400">Runtime Mode</span>
            <select
              value={runtimeMode}
              onChange={(event) => setRuntimeMode(event.target.value as RuntimeMode)}
              disabled={saving}
              className="w-full rounded border border-[#343849] bg-[#0f0f12] px-3 py-2 text-sm text-white outline-none"
            >
              <option value="Simulator">Simulator</option>
              <option value="HTTP">Real Controller / HTTP</option>
            </select>
          </label>

          {runtimeMode !== 'Simulator' && (
            <>
              <label className="text-xs">
                <span className="mb-1 block text-slate-400">IP Address</span>
                <input
                  value={ipAddress}
                  onChange={(event) => setIpAddress(event.target.value)}
                  disabled={saving}
                  className="w-full rounded border border-[#343849] bg-[#0f0f12] px-3 py-2 text-sm text-white outline-none"
                  placeholder="192.168.1.10"
                />
              </label>

              <label className="text-xs">
                <span className="mb-1 block text-slate-400">Port</span>
                <input
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                  disabled={saving}
                  className="w-full rounded border border-[#343849] bg-[#0f0f12] px-3 py-2 text-sm text-white outline-none"
                  placeholder="8080"
                />
              </label>
            </>
          )}
        </div>

        <div>
          <p className="mb-2 text-xs font-bold uppercase text-slate-400">Scene Position</p>

          <div className="grid grid-cols-4 gap-2">
            <label className="text-xs">
              <span className="mb-1 block text-slate-400">X</span>
              <input
                value={baseX}
                onChange={(event) => setBaseX(event.target.value)}
                disabled={saving}
                className="w-full rounded border border-[#343849] bg-[#0f0f12] px-2 py-2 text-sm text-white outline-none"
              />
            </label>

            <label className="text-xs">
              <span className="mb-1 block text-slate-400">Y</span>
              <input
                value={baseY}
                onChange={(event) => setBaseY(event.target.value)}
                disabled={saving}
                className="w-full rounded border border-[#343849] bg-[#0f0f12] px-2 py-2 text-sm text-white outline-none"
              />
            </label>

            <label className="text-xs">
              <span className="mb-1 block text-slate-400">Z</span>
              <input
                value={baseZ}
                onChange={(event) => setBaseZ(event.target.value)}
                disabled={saving}
                className="w-full rounded border border-[#343849] bg-[#0f0f12] px-2 py-2 text-sm text-white outline-none"
              />
            </label>

            <label className="text-xs">
              <span className="mb-1 block text-slate-400">Yaw</span>
              <input
                value={baseYaw}
                onChange={(event) => setBaseYaw(event.target.value)}
                disabled={saving}
                className="w-full rounded border border-[#343849] bg-[#0f0f12] px-2 py-2 text-sm text-white outline-none"
              />
            </label>
          </div>
        </div>

        {selectedModel && (
          <div className="rounded border border-[#343849] bg-[#11131a] p-3 text-[11px] text-slate-400">
            <div className="grid grid-cols-2 gap-2">
              <span>Vendor: {selectedModel.vendor}</span>
              <span>DOF: {selectedModel.dof}</span>
              <span className="col-span-2">URDF: {selectedModel.urdfPath || 'N/A'}</span>
            </div>
          </div>
        )}

        {createdSecret && (
          <div className="rounded border border-emerald-500/30 bg-emerald-950/20 p-3 text-xs text-emerald-200">
            <p className="font-bold">Robot created successfully.</p>
            <p className="mt-1 break-all font-mono text-[11px]">{createdSecret}</p>
            <p className="mt-1 text-[11px] text-emerald-300/80">
              Save this device secret now. Backend will not show it again.
            </p>
          </div>
        )}

        {error && (
          <div className="rounded border border-red-500/40 bg-red-950/30 p-3 text-xs text-red-200">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-[#2d2d34] pt-4">
          <button
            type="button"
            onClick={handleClose}
            disabled={saving}
            className="flex items-center gap-1 rounded border border-[#343849] px-3 py-2 text-xs text-slate-300 hover:bg-[#242833] disabled:opacity-40"
          >
            <X size={13} />
            Close
          </button>

          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={saving || loadingModels || !selectedModel}
            className="flex items-center gap-1 rounded bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-40"
          >
            {saving ? <LoaderCircle size={13} className="animate-spin" /> : <Plus size={13} />}
            Create Robot
          </button>
        </div>
      </div>
    </CenterModal>
  )
}
