import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  Factory,
  FilePlus,
  FolderOpen,
  Globe,
  LogOut,
  Play,
  Save,
  ShieldCheck,
  Upload,
  UserRound,
  Wrench
} from 'lucide-react'

import { generateLua } from '../../engine/codegen/luaCodegen'
import { translations } from '../../i18n/translations'
import { electronService } from '../../services/electronService'
import { buildCollisionAlertPresentation } from '../../services/collision/collisionPresentation'
import { previewLuaProgram } from '../../services/backendLuaImportClient'
import { toWorkflowStep } from '../../services/backendLuaWorkflowMapper'
import { useBackendAuthStore } from '../../store/backendAuthStore'
import { useRobotStore } from '../../store/robotStore'
import { useSceneStore } from '../../store/sceneStore'
import { DEFAULT_JOINT_ANGLES } from '../../types/robot.types'
import type { JointAngles, RobotProgramSource, WorkflowStep } from '../../types/robot.types'
import type { Transform3D } from '../../types/scene.types'

type AppLanguage = keyof typeof translations

interface HeaderProps {
  onLogout: () => void
}

interface SavedSceneObject {
  name: string
  fileType: 'gltf' | 'glb' | 'stl'
  filePath?: string
  url?: string
  transform: Transform3D
  visible: boolean
}

interface SavedProjectData {
  version?: string
  projectName?: string
  robotModel?: string
  jointAngles?: JointAngles
  steps?: WorkflowStep[]
  programSource?: RobotProgramSource
  sceneObjects?: SavedSceneObject[]
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseSavedProject(jsonStr: string): SavedProjectData {
  return JSON.parse(jsonStr) as SavedProjectData
}

export default function Header({ onLogout }: HeaderProps): React.JSX.Element {
  const steps = useRobotStore((state) => state.steps)
  const projectName = useRobotStore((state) => state.projectName)
  const currentFilePath = useRobotStore((state) => state.currentFilePath)
  const robots = useRobotStore((state) => state.robots)
  const selectedRobotId = useRobotStore((state) => state.selectedRobotId)
  const workspaceMode = useRobotStore((state) => state.workspaceMode)
  const setWorkspaceMode = useRobotStore((state) => state.setWorkspaceMode)
  const robotFaultsById = useSceneStore((state) => state.robotFaultsById)
  const robotContactsById = useSceneStore((state) => state.robotContactsById)

  const setProjectName = useRobotStore((state) => state.setProjectName)
  const setCurrentFilePath = useRobotStore((state) => state.setCurrentFilePath)
  const setJointAngles = useRobotStore((state) => state.setJointAngles)
  const reorderSteps = useRobotStore((state) => state.reorderSteps)
  const setProgramSource = useRobotStore((state) => state.setProgramSource)

  const language = useRobotStore((state) => state.language)
  const setLanguage = useRobotStore((state) => state.setLanguage)
  const authUser = useBackendAuthStore((state) => state.user)
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false)
  const accountMenuRef = useRef<HTMLDivElement>(null)

  const t = useCallback(
    (key: keyof typeof translations.vi): string => translations[language][key],
    [language]
  )
  const selectedRobot = robots.find((robot) => robot.id === selectedRobotId) ?? null
  const accountDisplayName = authUser?.fullName?.trim() || authUser?.email || 'SynTwin User'
  const accountInitials = accountDisplayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')

  useEffect(() => {
    if (!isAccountMenuOpen) {
      return
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setIsAccountMenuOpen(false)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [isAccountMenuOpen])
  const collisionAlert = useMemo(
    () =>
      buildCollisionAlertPresentation(
        robots.map((robot) => ({ id: robot.id, name: robot.name })),
        robotContactsById,
        robotFaultsById,
        language
      ),
    [language, robotContactsById, robotFaultsById, robots]
  )
  const handleNewProject = useCallback((): void => {
    if (confirm(t('newProjectConfirm'))) {
      reorderSteps([])
      setJointAngles([...DEFAULT_JOINT_ANGLES])
      setProjectName('coffee_machine_workflow')
      setCurrentFilePath(null)
      setProgramSource('Studio')
      useSceneStore.getState().clearScene()
    }
  }, [reorderSteps, setCurrentFilePath, setJointAngles, setProgramSource, setProjectName, t])

  const serializeProject = useCallback((): string => {
    const robotState = useRobotStore.getState()
    const sceneState = useSceneStore.getState()

    const projectData: SavedProjectData = {
      version: '1.0',
      projectName: robotState.projectName,
      robotModel: robotState.robotModel,
      jointAngles: robotState.jointAngles,
      steps: robotState.steps,
      programSource: robotState.programSource,
      sceneObjects: sceneState.objects.map((object) => ({
        name: object.name,
        fileType: object.fileType,
        filePath: object.filePath,
        url: object.url,
        transform: object.transform,
        visible: object.visible
      }))
    }

    return JSON.stringify(projectData, null, 2)
  }, [])

  const deserializeProject = useCallback(
    (jsonStr: string, filePath: string): void => {
      try {
        const data = parseSavedProject(jsonStr)

        if (data.version !== '1.0') {
          alert(t('projectCompatError'))
          return
        }

        setProjectName(data.projectName || 'loaded_project')
        setProgramSource(
          data.programSource === 'ImportedLua' || data.programSource === 'BackendGenerated'
            ? data.programSource
            : 'Studio'
        )
        setCurrentFilePath(filePath)
        setJointAngles(data.jointAngles || [...DEFAULT_JOINT_ANGLES])
        reorderSteps(data.steps || [])

        const sceneStore = useSceneStore.getState()
        sceneStore.clearScene()

        if (Array.isArray(data.sceneObjects)) {
          data.sceneObjects.forEach((object) => {
            const url = object.filePath
              ? `file:///${object.filePath.replace(/\\/g, '/')}`
              : object.url || ''

            sceneStore.addObject({
              name: object.name,
              fileType: object.fileType,
              filePath: object.filePath,
              url
            })

            const lastAdded = useSceneStore.getState().objects.slice(-1)[0]

            if (lastAdded) {
              sceneStore.updateObjectTransform(lastAdded.id, object.transform)
              sceneStore.updateObjectVisibility(lastAdded.id, object.visible)
            }
          })
        }

        alert(t('projectOpenSuccess'))
      } catch (error: unknown) {
        alert(`${t('projectReadError')} ${getErrorMessage(error)}`)
      }
    },
    [reorderSteps, setCurrentFilePath, setJointAngles, setProgramSource, setProjectName, t]
  )

  const handleOpenProject = useCallback(async (): Promise<void> => {
    const result = await electronService.showOpenDialog({
      title: t('openProject'),
      filters: [{ name: 'FaiRobot Projects', extensions: ['fairobot'] }],
      properties: ['openFile']
    })

    if (!result.canceled && result.filePaths.length > 0) {
      const filePath = result.filePaths[0]
      const readResult = await electronService.readFile(filePath)

      if (readResult.success && readResult.content) {
        deserializeProject(readResult.content, filePath)
      } else {
        alert(`${t('projectReadError')} ${readResult.error}`)
      }
    }
  }, [deserializeProject, t])

  const handleSaveAsProject = useCallback(async (): Promise<void> => {
    const currentProjectName = useRobotStore.getState().projectName
    const content = serializeProject()

    const result = await electronService.showSaveDialog({
      title: t('saveProject'),
      defaultPath: `${currentProjectName}.fairobot`,
      filters: [{ name: 'FaiRobot Projects', extensions: ['fairobot'] }]
    })

    if (!result.canceled && result.filePath) {
      const writeResult = await electronService.writeFile(result.filePath, content)

      if (writeResult.success) {
        setCurrentFilePath(result.filePath)
        alert(t('projectSaveSuccess'))
      } else {
        alert(`${t('projectSaveError')} ${writeResult.error}`)
      }
    }
  }, [serializeProject, setCurrentFilePath, t])

  const handleSaveProject = useCallback(async (): Promise<void> => {
    const currentPath = useRobotStore.getState().currentFilePath

    if (currentPath) {
      const content = serializeProject()
      const writeResult = await electronService.writeFile(currentPath, content)

      if (writeResult.success) {
        alert(t('projectSaveSuccess'))
      } else {
        alert(`${t('projectSaveError')} ${writeResult.error}`)
      }

      return
    }

    await handleSaveAsProject()
  }, [handleSaveAsProject, serializeProject, t])

  const handleExportLua = useCallback(async (): Promise<void> => {
    const currentSteps = useRobotStore.getState().steps
    const currentProjectName = useRobotStore.getState().projectName
    const luaCode = generateLua(currentSteps, currentProjectName)

    const result = await electronService.showSaveDialog({
      title: t('exportLua'),
      defaultPath: `${currentProjectName}.lua`,
      filters: [{ name: 'Lua Script Files', extensions: ['lua'] }]
    })

    if (!result.canceled && result.filePath) {
      const writeResult = await electronService.writeFile(result.filePath, luaCode)

      if (writeResult.success) {
        alert(t('luaExportSuccess'))
      } else {
        alert(`${t('luaExportError')} ${writeResult.error}`)
      }
    }
  }, [t])

  const handleImportLua = useCallback(async (): Promise<void> => {
    const result = await electronService.showOpenDialog({
      title: t('importLua'),
      filters: [{ name: 'Lua Script Files', extensions: ['lua'] }],
      properties: ['openFile']
    })

    if (!result.canceled && result.filePaths.length > 0) {
      const filePath = result.filePaths[0]
      const readResult = await electronService.readFile(filePath)

      if (readResult.success && readResult.content) {
        try {
          const selectedFileName = filePath.split(/[\\/]/).pop() || filePath
          const preview = await previewLuaProgram(selectedFileName, readResult.content)
          const parseErrors = preview.diagnostics.filter(
            (diagnostic) => diagnostic.severity === 'error'
          )

          if (parseErrors.length > 0) {
            const details = parseErrors
              .slice(0, 5)
              .map(
                (diagnostic) =>
                  `Line ${diagnostic.line}: ${diagnostic.message}\n${diagnostic.source}`
              )
              .join('\n\n')

            const remainingCount = parseErrors.length - 5
            const remainingMessage =
              remainingCount > 0 ? `\n\n...and ${remainingCount} more error(s).` : ''

            alert(`${t('luaImportError')}\n\n${details}${remainingMessage}`)
            return
          }

          if (!preview.executionReady) {
            const unsupported = preview.unsupportedSteps?.[0]
            const message = unsupported
              ? `Step ${unsupported.orderIndex} "${unsupported.label}" (${unsupported.stepType}): ${unsupported.reason}`
              : language === 'vi'
                ? 'File LUA parse thành công nhưng chưa sẵn sàng để thực thi. Hãy khởi động lại Backend mới nhất rồi import lại.'
                : 'The LUA file parsed successfully but is not execution-ready. Restart the updated Backend and import it again.'

            alert(`${t('luaImportError')} ${message}`)
            return
          }

          const parsedSteps = preview.parsedSteps
            .map(toWorkflowStep)
            .filter((step): step is WorkflowStep => step !== null)

          if (parsedSteps.length === 0) {
            const message =
              language === 'vi'
                ? 'Không tìm thấy bước lệnh hợp lệ nào trong file LUA.'
                : 'No valid command steps were found in the LUA file.'

            alert(`${t('luaImportError')} ${message}`)
            return
          }

          reorderSteps(parsedSteps)
          setProjectName(preview.metadata.projectName || 'Imported Project')
          setProgramSource('ImportedLua')
          alert(t('luaImportSuccess'))
        } catch (error: unknown) {
          alert(`${t('luaImportError')} ${getErrorMessage(error)}`)
        }
      } else {
        alert(`${t('luaImportError')} ${readResult.error}`)
      }
    }
  }, [language, reorderSteps, setProgramSource, setProjectName, t])

  useEffect(() => {
    if (typeof window !== 'undefined' && 'api' in window && window.api.onMenuAction) {
      const unsubscribe = window.api.onMenuAction((action) => {
        switch (action) {
          case 'new-project':
            handleNewProject()
            break
          case 'open-project':
            void handleOpenProject()
            break
          case 'save-project':
            void handleSaveProject()
            break
          case 'save-as-project':
            void handleSaveAsProject()
            break
          case 'export-lua':
            void handleExportLua()
            break
          case 'import-lua':
            void handleImportLua()
            break
        }
      })

      return unsubscribe
    }

    return undefined
  }, [
    handleExportLua,
    handleImportLua,
    handleNewProject,
    handleOpenProject,
    handleSaveAsProject,
    handleSaveProject
  ])

  return (
    <header className="flex h-14 shrink-0 select-none items-center justify-between border-b border-[#2d2d34] bg-[#141417] px-6 text-slate-200">
      <div className="flex items-center gap-3">
        <div className="rounded-md bg-gradient-to-tr from-blue-600 to-indigo-600 px-2.5 py-1 text-sm font-black text-white shadow-md">
          FAI
        </div>
        <div>
          <h1 className="text-sm font-bold leading-tight text-white">FaiRobot Studio</h1>
          <span className="text-[10px] text-slate-500">v1.0.1 (Beta)</span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex rounded border border-[#343849] bg-[#101218] p-0.5">
          <button
            type="button"
            onClick={() => setWorkspaceMode('factory')}
            title="Monitor and arrange all robots"
            className={`flex items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold transition ${
              workspaceMode === 'factory'
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Factory size={12} />
            Factory
          </button>

          <button
            type="button"
            onClick={() => setWorkspaceMode('train')}
            title="Train and program the selected robot"
            className={`flex items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold transition ${
              workspaceMode === 'train'
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Wrench size={12} />
            Train
          </button>
        </div>

        <input
          type="text"
          value={projectName}
          onChange={(event) => setProjectName(event.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
          placeholder={t('projectNamePlaceholder')}
          title="Tên dự án (chỉ cho phép chữ cái, số, gạch dưới và gạch ngang)"
          className="w-48 rounded border border-[#2d2d34] bg-[#1e1e24] px-2.5 py-1 text-center text-xs font-semibold text-white outline-none transition hover:bg-[#25252d] focus:border-blue-500 focus:bg-[#2d2d38]"
        />
        {selectedRobot && (
          <span
            className="max-w-[180px] truncate rounded border border-blue-500/30 bg-blue-950/30 px-2 py-1 text-[10px] font-semibold text-blue-200"
            title={`${selectedRobot.name} - ${selectedRobot.id}`}
          >
            {selectedRobot.name}
          </span>
        )}

        {currentFilePath && (
          <span
            className="max-w-[150px] truncate text-[9px] text-slate-500"
            title={currentFilePath}
          >
            ({currentFilePath.split('\\').pop()})
          </span>
        )}
      </div>

      {collisionAlert && (
        <div
          className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold ${
            collisionAlert.level === 'proximity'
              ? 'border-amber-500/45 bg-amber-950/55 text-amber-300'
              : 'border-rose-500/45 bg-rose-950/55 text-rose-300 shadow-[0_0_16px_rgba(244,63,94,0.16)]'
          }`}
          title={collisionAlert.detail}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full motion-safe:animate-pulse ${
              collisionAlert.level === 'proximity' ? 'bg-amber-400' : 'bg-rose-400'
            }`}
          />
          <AlertTriangle size={14} />
          {collisionAlert.level === 'proximity'
            ? language === 'vi'
              ? 'Gần va chạm'
              : 'Near collision'
            : t('collisionWarning')}
          <span>({collisionAlert.robotIds.length})</span>
        </div>
      )}

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5 rounded-lg border border-[#2d2d34] bg-[#1e1e24] px-2.5 py-1.5 transition hover:border-slate-500 hover:bg-[#25252d]">
          <Globe size={13} className="text-slate-400" />
          <select
            value={language}
            onChange={(event) => setLanguage(event.target.value as AppLanguage)}
            className="cursor-pointer border-none bg-transparent p-0 pr-1 text-xs font-bold text-slate-300 outline-none"
          >
            <option value="vi">Tiếng Việt</option>
            <option value="en">English</option>
          </select>
        </div>

        <div className="h-5 w-px bg-[#2d2d34]" />

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleNewProject}
            title={t('newProject')}
            className="flex items-center gap-1 rounded-md border border-[#343849] bg-[#1e1e24] p-2 text-slate-300 transition hover:bg-[#282830] hover:text-white hover:border-blue-500/50 shadow-sm"
          >
            <FilePlus size={14} />
          </button>

          <button
            type="button"
            onClick={() => void handleOpenProject()}
            title={t('openProject')}
            className="flex items-center gap-1 rounded-md border border-[#343849] bg-[#1e1e24] p-2 text-slate-300 transition hover:bg-[#282830] hover:text-white hover:border-blue-500/50 shadow-sm"
          >
            <FolderOpen size={14} />
          </button>

          <button
            type="button"
            onClick={() => void handleSaveProject()}
            title={t('saveProject')}
            className="flex items-center gap-1 rounded-md border border-[#343849] bg-[#1e1e24] p-2 text-slate-300 transition hover:bg-[#282830] hover:text-white hover:border-blue-500/50 shadow-sm"
          >
            <Save size={14} />
          </button>

          <div className="mx-1 h-5 w-px bg-[#2d2d34]" />

          <button
            type="button"
            onClick={() => void handleImportLua()}
            title={t('importLua')}
            className="flex items-center gap-1 rounded-md border border-[#343849] bg-[#1e1e24] p-2 text-slate-300 transition hover:bg-[#282830] hover:text-white hover:border-blue-500/50 shadow-sm"
          >
            <Upload size={14} />
          </button>

          <button
            type="button"
            onClick={() => void handleExportLua()}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-md transition hover:bg-blue-500"
          >
            <Play size={12} className="fill-white" />
            {t('exportLua')} ({steps.length})
          </button>
        </div>

        <div ref={accountMenuRef} className="relative">
          <button
            type="button"
            onClick={() => setIsAccountMenuOpen((current) => !current)}
            aria-haspopup="menu"
            aria-expanded={isAccountMenuOpen}
            className="flex max-w-[220px] items-center gap-2 rounded-lg border border-[#343849] bg-[#1e1e24] px-2 py-1.5 text-left transition hover:border-blue-500/50 hover:bg-[#282830]"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 text-[10px] font-black text-white shadow">
              {accountInitials || <UserRound size={14} />}
            </span>

            <span className="min-w-0">
              <span className="block truncate text-[11px] font-semibold text-white">
                {accountDisplayName}
              </span>
              <span className="block truncate text-[9px] text-slate-400">
                {authUser?.subscriptionPlan || 'SynTwin'}
              </span>
            </span>

            <ChevronDown
              size={13}
              className={`shrink-0 text-slate-400 transition ${
                isAccountMenuOpen ? 'rotate-180' : ''
              }`}
            />
          </button>

          {isAccountMenuOpen && authUser && (
            <div
              role="menu"
              className="absolute right-0 top-full z-[100] mt-2 w-80 overflow-hidden rounded-xl border border-[#343849] bg-[#17171d] shadow-2xl shadow-black/50"
            >
              <div className="border-b border-[#2d2d34] bg-gradient-to-br from-blue-600/15 to-indigo-600/5 p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 text-sm font-black text-white">
                    {accountInitials || <UserRound size={18} />}
                  </span>

                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold text-white">
                      {accountDisplayName}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-slate-400">
                      {authUser.email}
                    </span>
                    <span className="mt-2 inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-semibold text-emerald-300">
                      <ShieldCheck size={10} />
                      {language === 'vi' ? 'Đã xác thực' : 'Verified'}
                    </span>
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-px bg-[#2d2d34]">
                <div className="bg-[#1b1b21] px-3 py-2.5">
                  <div className="text-[9px] uppercase tracking-wider text-slate-500">
                    {language === 'vi' ? 'Vai trò' : 'Role'}
                  </div>
                  <div className="mt-1 truncate text-[11px] font-semibold text-slate-200">
                    {authUser.role}
                  </div>
                </div>

                <div className="bg-[#1b1b21] px-3 py-2.5">
                  <div className="text-[9px] uppercase tracking-wider text-slate-500">
                    {language === 'vi' ? 'Gói dịch vụ' : 'Plan'}
                  </div>
                  <div className="mt-1 truncate text-[11px] font-semibold text-blue-300">
                    {authUser.subscriptionPlan}
                  </div>
                </div>

                <div className="bg-[#1b1b21] px-3 py-2.5">
                  <div className="text-[9px] uppercase tracking-wider text-slate-500">
                    {language === 'vi' ? 'Giới hạn robot' : 'Robot limit'}
                  </div>
                  <div className="mt-1 text-[11px] font-semibold text-slate-200">
                    {authUser.maxRobots}
                  </div>
                </div>

                <div className="bg-[#1b1b21] px-3 py-2.5">
                  <div className="text-[9px] uppercase tracking-wider text-slate-500">
                    {language === 'vi' ? 'Trạng thái' : 'Status'}
                  </div>
                  <div className="mt-1 truncate text-[11px] font-semibold text-emerald-300">
                    {authUser.status}
                  </div>
                </div>
              </div>

              <div className="p-2">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsAccountMenuOpen(false)
                    onLogout()
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-rose-300 transition hover:bg-rose-500/10 hover:text-rose-200"
                >
                  <LogOut size={14} />
                  {language === 'vi' ? 'Đăng xuất khỏi SynTwin' : 'Sign out of SynTwin'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
