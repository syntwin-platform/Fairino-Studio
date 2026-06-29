import { Eye, EyeOff, Settings, Trash2, Upload } from 'lucide-react'
import { useRef } from 'react'
import type { ChangeEvent, MouseEvent, ReactElement } from 'react'

import { translations } from '../../i18n/translations'
import { useRobotStore } from '../../store/robotStore'
import { useSceneStore } from '../../store/sceneStore'
import type { Transform3D } from '../../types/scene.types'

interface FileWithPath extends File {
  path?: string
}

export default function ScenePanel(): ReactElement {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const objects = useSceneStore((state) => state.objects)
  const addObject = useSceneStore((state) => state.addObject)
  const removeObject = useSceneStore((state) => state.removeObject)
  const updateObjectTransform = useSceneStore((state) => state.updateObjectTransform)
  const updateObjectVisibility = useSceneStore((state) => state.updateObjectVisibility)
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId)
  const setSelectedObjectId = useSceneStore((state) => state.setSelectedObjectId)

  const language = useRobotStore((state) => state.language)
  const t = (key: keyof typeof translations.vi): string => translations[language][key]

  const selectedObject = objects.find((object) => object.id === selectedObjectId)

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0] as FileWithPath | undefined

    if (!file) {
      return
    }

    const name = file.name.split('.').slice(0, -1).join('.')
    const extension = file.name.split('.').pop()?.toLowerCase()

    if (extension !== 'gltf' && extension !== 'glb' && extension !== 'stl') {
      alert(t('importFormatError'))
      return
    }

    const url = URL.createObjectURL(file)
    const filePath = file.path

    addObject({
      name: name || 'Unnamed Object',
      fileType: extension,
      filePath,
      url
    })

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const triggerFileInput = (): void => {
    fileInputRef.current?.click()
  }

  const handleTransformChange = (key: keyof Transform3D, val: number): void => {
    if (!selectedObjectId) {
      return
    }

    updateObjectTransform(selectedObjectId, { [key]: val })
  }

  const stopObjectActionPropagation = (event: MouseEvent<HTMLDivElement>): void => {
    event.stopPropagation()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col text-slate-200">
      <div className="border-b border-[#2d2d34] p-4">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept=".gltf,.glb,.stl"
          className="hidden"
        />
        <button
          type="button"
          onClick={triggerFileInput}
          className="flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[#3a3a45] bg-[#121214] py-4 text-xs font-semibold text-slate-300 transition hover:border-blue-500 hover:bg-[#15151a] hover:text-white"
        >
          <Upload size={20} className="text-blue-500" />
          {t('upload3D')}
          <span className="text-[10px] font-normal text-slate-500">{t('supportFormats')}</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <span className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
          {t('deviceList')} ({objects.length})
        </span>

        {objects.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-500">{t('noDevices')}</div>
        ) : (
          <div className="space-y-1.5">
            {objects.map((object) => {
              const isSelected = selectedObjectId === object.id

              return (
                <div
                  key={object.id}
                  onClick={() => setSelectedObjectId(object.id)}
                  className={`flex cursor-pointer items-center justify-between rounded-lg border p-2.5 text-left transition ${
                    isSelected
                      ? 'border-blue-500 bg-blue-950/10'
                      : 'border-[#2d2d34] bg-[#121214] hover:bg-[#18181d]'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Settings size={14} className="shrink-0 text-slate-400" />
                    <span className="block truncate text-xs font-bold text-white">
                      {object.name}
                    </span>
                    <span className="shrink-0 rounded bg-[#25252b] px-1 py-0.2 text-[9px] font-bold text-slate-400">
                      {object.fileType.toUpperCase()}
                    </span>
                  </div>
                  <div className="flex items-center gap-1" onClick={stopObjectActionPropagation}>
                    <button
                      type="button"
                      onClick={() => updateObjectVisibility(object.id, !object.visible)}
                      className="cursor-pointer rounded p-1 text-slate-500 hover:bg-[#2d2d34] hover:text-slate-300"
                    >
                      {object.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeObject(object.id)}
                      className="cursor-pointer rounded p-1 text-slate-500 hover:bg-rose-950/30 hover:text-rose-400"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {selectedObject && (
        <div className="max-h-[400px] shrink-0 space-y-4 overflow-y-auto border-t border-[#2d2d34] bg-[#141417] p-4">
          <div className="flex items-center justify-between">
            <span className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
              {t('transform')}
            </span>
            <span className="max-w-[150px] truncate text-[10px] font-bold text-blue-400">
              {selectedObject.name}
            </span>
          </div>

          <div className="space-y-2">
            <span className="block text-[11px] font-bold text-slate-400">{t('position')}</span>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <span className="block font-mono text-[9px] text-red-400">X (mm)</span>
                <input
                  type="number"
                  value={selectedObject.transform.x}
                  onChange={(event) =>
                    handleTransformChange('x', parseFloat(event.target.value) || 0)
                  }
                  className="w-full rounded border border-[#2d2d34] bg-[#1e1e24] p-1 text-center font-mono text-xs font-bold text-white outline-none"
                />
              </div>
              <div>
                <span className="block font-mono text-[9px] text-emerald-400">Y (mm)</span>
                <input
                  type="number"
                  value={selectedObject.transform.y}
                  onChange={(event) =>
                    handleTransformChange('y', parseFloat(event.target.value) || 0)
                  }
                  className="w-full rounded border border-[#2d2d34] bg-[#1e1e24] p-1 text-center font-mono text-xs font-bold text-white outline-none"
                />
              </div>
              <div>
                <span className="block font-mono text-[9px] text-blue-400">Z (mm)</span>
                <input
                  type="number"
                  value={selectedObject.transform.z}
                  onChange={(event) =>
                    handleTransformChange('z', parseFloat(event.target.value) || 0)
                  }
                  className="w-full rounded border border-[#2d2d34] bg-[#1e1e24] p-1 text-center font-mono text-xs font-bold text-white outline-none"
                />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <span className="block text-[11px] font-bold text-slate-400">{t('rotation')}</span>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <span className="block font-mono text-[9px] text-red-300">Rx (°)</span>
                <input
                  type="number"
                  value={selectedObject.transform.rx}
                  onChange={(event) =>
                    handleTransformChange('rx', parseFloat(event.target.value) || 0)
                  }
                  className="w-full rounded border border-[#2d2d34] bg-[#1e1e24] p-1 text-center font-mono text-xs font-bold text-white outline-none"
                />
              </div>
              <div>
                <span className="block font-mono text-[9px] text-emerald-300">Ry (°)</span>
                <input
                  type="number"
                  value={selectedObject.transform.ry}
                  onChange={(event) =>
                    handleTransformChange('ry', parseFloat(event.target.value) || 0)
                  }
                  className="w-full rounded border border-[#2d2d34] bg-[#1e1e24] p-1 text-center font-mono text-xs font-bold text-white outline-none"
                />
              </div>
              <div>
                <span className="block font-mono text-[9px] text-blue-300">Rz (°)</span>
                <input
                  type="number"
                  value={selectedObject.transform.rz}
                  onChange={(event) =>
                    handleTransformChange('rz', parseFloat(event.target.value) || 0)
                  }
                  className="w-full rounded border border-[#2d2d34] bg-[#1e1e24] p-1 text-center font-mono text-xs font-bold text-white outline-none"
                />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <span className="block text-[11px] font-bold text-slate-400">{t('scale')}</span>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <span className="block font-mono text-[9px] text-slate-500">Sx</span>
                <input
                  type="number"
                  value={selectedObject.transform.sx}
                  step="0.1"
                  onChange={(event) =>
                    handleTransformChange('sx', parseFloat(event.target.value) || 1)
                  }
                  className="w-full rounded border border-[#2d2d34] bg-[#1e1e24] p-1 text-center font-mono text-xs font-bold text-white outline-none"
                />
              </div>
              <div>
                <span className="block font-mono text-[9px] text-slate-500">Sy</span>
                <input
                  type="number"
                  value={selectedObject.transform.sy}
                  step="0.1"
                  onChange={(event) =>
                    handleTransformChange('sy', parseFloat(event.target.value) || 1)
                  }
                  className="w-full rounded border border-[#2d2d34] bg-[#1e1e24] p-1 text-center font-mono text-xs font-bold text-white outline-none"
                />
              </div>
              <div>
                <span className="block font-mono text-[9px] text-slate-500">Sz</span>
                <input
                  type="number"
                  value={selectedObject.transform.sz}
                  step="0.1"
                  onChange={(event) =>
                    handleTransformChange('sz', parseFloat(event.target.value) || 1)
                  }
                  className="w-full rounded border border-[#2d2d34] bg-[#1e1e24] p-1 text-center font-mono text-xs font-bold text-white outline-none"
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
