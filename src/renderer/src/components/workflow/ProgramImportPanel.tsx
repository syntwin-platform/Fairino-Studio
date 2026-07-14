import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Braces, CheckCircle2, FileCode2, Info, UploadCloud, X } from 'lucide-react'
import { toWorkflowStep } from '../../services/backendLuaWorkflowMapper'
import type { WorkflowStep } from '../../types/robot.types'
import type { ValidatedLuaProgram } from '../../types/factoryProgram.types'

export type { ValidatedLuaProgram } from '../../types/factoryProgram.types'
import {
  previewLuaProgram,
  previewLuaProgramForRobot,
  type BackendLuaDiagnostic,
  type BackendLuaPreviewResponse,
  type BackendLuaRequestContext
} from '../../services/backendLuaImportClient'
import { electronService } from '../../services/electronService'
import { useRobotStore } from '../../store/robotStore'
import ProgramJsonImport from './ProgramJsonImport'
import {
  beginFactoryRunDiagnosticSession,
  recordFactoryRunDiagnostic
} from '../../services/factoryRunDiagnostics'

const MAX_LUA_FILE_SIZE = 1024 * 1024

interface ProgramImportPanelProps {
  requestContext?: BackendLuaRequestContext
  luaOnly?: boolean
  actionLabel?: string
  onProgramAccepted?: (program: ValidatedLuaProgram) => void
  factoryDiagnostics?: boolean
}

interface LuaPreviewResult {
  steps: WorkflowStep[]
  projectName: string
  diagnostics: BackendLuaDiagnostic[]
  raw: BackendLuaPreviewResponse
}

// ─── Import Status Popover ──────────────────────────────────────────────────

interface ImportStatusPopoverProps {
  importMode: 'lua' | 'json'
  fileName: string
  parseResult: LuaPreviewResult | null
  fileError: string
  isParsing: boolean
  isLoaded: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
}

function ImportStatusPopover({
  importMode,
  fileName,
  parseResult,
  fileError,
  isParsing,
  isLoaded,
  anchorRef,
  onClose
}: ImportStatusPopoverProps): React.JSX.Element | null {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  // Calculate position on first render relative to anchor
  useEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return

    const rect = anchor.getBoundingClientRect()
    const popoverWidth = 320
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    let left = rect.right + 8
    if (left + popoverWidth > viewportWidth - 8) {
      left = rect.left - popoverWidth - 8
    }
    if (left < 8) left = 8

    const estimatedHeight = 340
    let top = rect.top
    if (top + estimatedHeight > viewportHeight - 8) {
      top = Math.max(8, viewportHeight - estimatedHeight - 8)
    }

    setPosition({ top, left })
  }, [anchorRef])

  // Close on outside click
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(event.target as Node)
      ) {
        onClose()
      }
    }
    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [anchorRef, onClose])

  if (!position) return null

  const errorDiagnostics = parseResult?.diagnostics.filter((d) => d.severity === 'error') ?? []
  const warnDiagnostics = parseResult?.diagnostics.filter((d) => d.severity === 'warning') ?? []

  const hasData = Boolean(fileName || parseResult || fileError || isParsing || isLoaded)
  return (
    <div
      ref={popoverRef}
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        width: 320,
        zIndex: 9999
      }}
      className="rounded-lg border border-[#393942] bg-[#101014] shadow-2xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[#2d2d34] px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Info size={11} className="text-blue-400 shrink-0" />
          <span className="text-[10px] font-bold text-slate-200">Import Status Detail</span>
          <span className="text-[9px] text-slate-500 uppercase font-bold px-1.5 py-0.5 rounded bg-[#25252b]">
            {importMode === 'lua' ? 'LUA' : 'JSON'}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Đóng"
          className="ml-2 shrink-0 rounded p-0.5 text-slate-500 hover:bg-[#25252b] hover:text-slate-200 transition"
        >
          <X size={12} />
        </button>
      </div>

      {/* Body */}
      <div className="px-3 py-2.5 space-y-0.5 max-h-80 overflow-y-auto">
        {!hasData && (
          <p className="text-[10px] text-slate-500 py-2 text-center">Chưa có dữ liệu import.</p>
        )}

        {importMode === 'json' && !hasData && (
          <p className="text-[10px] text-slate-500 py-2 text-center">
            Nhập JSON Code ở bảng bên dưới để xem trạng thái.
          </p>
        )}

        {/* File info */}
        {fileName && <StatusRow label="File" value={fileName} />}

        {/* Parse state */}
        {isParsing && <StatusRow label="Status" value="Đang parse với backend..." />}

        {isLoaded && <StatusRow label="Status" value="Đã load vào workflow" success />}

        {/* Parse result */}
        {parseResult && (
          <>
            <StatusRow label="Project Name" value={parseResult.projectName} />
            <StatusRow label="Steps Parsed" value={parseResult.steps.length} />
            <StatusRow
              label="Errors"
              value={
                errorDiagnostics.length > 0 ? `${errorDiagnostics.length} error(s)` : 'Không có lỗi'
              }
              danger={errorDiagnostics.length > 0}
              success={errorDiagnostics.length === 0}
            />
            {warnDiagnostics.length > 0 && (
              <StatusRow label="Warnings" value={`${warnDiagnostics.length} warning(s)`} />
            )}
          </>
        )}

        {/* File error */}
        {fileError && (
          <>
            <div className="my-1.5 border-t border-[#2d2d34]" />
            <p className="text-[9px] font-bold uppercase text-red-400 mb-1">Lỗi</p>
            <div className="rounded border border-red-500/30 bg-red-950/20 px-2 py-1.5">
              <p className="text-[10px] text-red-300 leading-snug">{fileError}</p>
            </div>
          </>
        )}

        {/* Diagnostics */}
        {errorDiagnostics.length > 0 && (
          <>
            <div className="my-1.5 border-t border-[#2d2d34]" />
            <p className="text-[9px] font-bold uppercase text-red-400 mb-1">
              Parser Diagnostics ({errorDiagnostics.length})
            </p>
            <div className="space-y-1.5">
              {errorDiagnostics.map((diag, idx) => (
                <div
                  key={`${diag.line}-${idx}`}
                  className="rounded border border-red-500/30 bg-[#121214] px-2 py-1.5"
                >
                  <p className="text-[10px] font-bold text-red-300">
                    Line {diag.line}: {diag.message}
                  </p>
                  {diag.source && (
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[9px] text-slate-500">
                      {diag.source}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {warnDiagnostics.length > 0 && (
          <>
            <div className="my-1.5 border-t border-[#2d2d34]" />
            <p className="text-[9px] font-bold uppercase text-amber-400 mb-1">
              Warnings ({warnDiagnostics.length})
            </p>
            <div className="space-y-1.5">
              {warnDiagnostics.map((diag, idx) => (
                <div
                  key={`warn-${diag.line}-${idx}`}
                  className="rounded border border-amber-500/30 bg-amber-950/10 px-2 py-1.5"
                >
                  <p className="text-[10px] text-amber-300">
                    Line {diag.line}: {diag.message}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

interface StatusRowProps {
  label: string
  value?: string | number | null
  danger?: boolean
  success?: boolean
}

function StatusRow({ label, value, danger, success }: StatusRowProps): React.ReactElement | null {
  if (value === undefined || value === null || value === '') {
    return null
  }

  return (
    <div className="flex gap-2 py-0.5">
      <span className="w-24 shrink-0 text-[9px] font-medium text-slate-500">{label}</span>
      <span
        className={`break-all text-[10px] leading-snug ${
          danger ? 'text-red-300' : success ? 'text-emerald-300' : 'text-slate-200'
        }`}
      >
        {String(value)}
      </span>
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function ProgramImportPanel({
  requestContext,
  luaOnly = false,
  actionLabel = 'Load into workflow',
  onProgramAccepted,
  factoryDiagnostics = false
}: ProgramImportPanelProps = {}): React.JSX.Element {
  const reorderSteps = useRobotStore((state) => state.reorderSteps)
  const setProjectName = useRobotStore((state) => state.setProjectName)
  const setProgramSource = useRobotStore((state) => state.setProgramSource)
  const inputRef = useRef<HTMLInputElement>(null)
  const [importMode, setImportMode] = useState<'lua' | 'json'>('lua')
  const [fileName, setFileName] = useState('')
  const [fileContent, setFileContent] = useState('')
  const [parseResult, setParseResult] = useState<LuaPreviewResult | null>(null)
  const [isParsing, setIsParsing] = useState(false)
  const [fileError, setFileError] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [isLoaded, setIsLoaded] = useState(false)

  // ── Import status popover ─────────────────────────────────────────────
  const [showImportDetail, setShowImportDetail] = useState(false)
  const importDetailBtnRef = useRef<HTMLButtonElement>(null)

  const parseFileContent = async (name: string, content: string): Promise<void> => {
    const parseStartedAtMonotonicMs = performance.now()

    if (factoryDiagnostics) {
      beginFactoryRunDiagnosticSession(name)

      recordFactoryRunDiagnostic('lua.parse.started', {
        details: {
          fileName: name,
          contentLength: content.length
        }
      })
    }

    setFileError('')
    setIsLoaded(false)

    // Trường hợp user chọn file không phải .lua
    if (!name.toLowerCase().endsWith('.lua')) {
      setFileName(name)
      setParseResult(null)
      setFileContent('')
      setFileError('Only .lua files are supported.')

      if (factoryDiagnostics) {
        recordFactoryRunDiagnostic('lua.parse.failed', {
          durationMs: performance.now() - parseStartedAtMonotonicMs,
          details: {
            reasonCode: 'invalid_extension'
          }
        })
      }

      return
    }

    // Trường hợp file Lua không có nội dung
    if (!content.trim()) {
      setFileName(name)
      setParseResult(null)
      setFileContent('')
      setFileError('The LUA file is empty.')

      if (factoryDiagnostics) {
        recordFactoryRunDiagnostic('lua.parse.failed', {
          durationMs: performance.now() - parseStartedAtMonotonicMs,
          details: {
            reasonCode: 'empty_file'
          }
        })
      }

      return
    }

    setIsParsing(true)

    try {
      const result = requestContext
        ? await previewLuaProgramForRobot(requestContext, name, content)
        : await previewLuaProgram(name, content)

      const steps = result.parsedSteps
        .map(toWorkflowStep)
        .filter((step): step is WorkflowStep => step !== null)

      setFileContent(content)
      setFileName(name)

      setParseResult({
        steps,
        projectName: result.metadata.projectName || 'Imported Project',
        diagnostics: result.diagnostics,
        raw: result
      })

      if (factoryDiagnostics) {
        recordFactoryRunDiagnostic('lua.parse.completed', {
          durationMs: performance.now() - parseStartedAtMonotonicMs,
          details: {
            stepCount: steps.length,
            diagnosticCount: result.diagnostics.length
          }
        })
      }
    } catch (error) {
      setFileName(name)
      setParseResult(null)
      setFileContent('')

      setFileError(error instanceof Error ? error.message : 'Failed to parse the LUA file.')

      if (factoryDiagnostics) {
        recordFactoryRunDiagnostic('lua.parse.failed', {
          durationMs: performance.now() - parseStartedAtMonotonicMs,
          details: {
            reasonCode: 'backend_parse_failed'
          }
        })
      }
    } finally {
      setIsParsing(false)
    }
  }

  const readBrowserFile = async (file: File): Promise<void> => {
    if (file.size > MAX_LUA_FILE_SIZE) {
      setFileName(file.name)
      setParseResult(null)
      setFileError('The LUA file must not exceed 1 MB.')
      return
    }

    try {
      const content = await file.text()
      await parseFileContent(file.name, content)
    } catch (error) {
      setFileName(file.name)
      setParseResult(null)
      setFileError(error instanceof Error ? error.message : 'Failed to read the LUA file.')
    }
  }

  const handleChooseFile = async (): Promise<void> => {
    if (!electronService.isElectron) {
      inputRef.current?.click()
      return
    }

    const result = await electronService.showOpenDialog({
      title: 'Import LUA Program',
      filters: [
        {
          name: 'LUA Script Files',
          extensions: ['lua']
        }
      ],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return
    }

    const filePath = result.filePaths[0]
    const readResult = await electronService.readFile(filePath)

    if (!readResult.success || readResult.content === undefined) {
      setFileName(filePath.split(/[\\/]/).pop() || filePath)
      setParseResult(null)
      setFileError(readResult.error || 'Failed to read the LUA file.')
      return
    }

    const selectedFileName = filePath.split(/[\\/]/).pop() || filePath

    await parseFileContent(selectedFileName, readResult.content)
  }

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]

    if (file) {
      void readBrowserFile(file)
    }

    event.target.value = ''
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setIsDragging(false)

    const file = event.dataTransfer.files?.[0]

    if (file) {
      void readBrowserFile(file)
    }
  }

  const handleLoadWorkflow = (): void => {
    if (!parseResult) return

    const hasErrors = parseResult.diagnostics.some((diagnostic) => diagnostic.severity === 'error')

    if (hasErrors || parseResult.steps.length === 0) {
      return
    }

    if (onProgramAccepted) {
      if (factoryDiagnostics) {
        recordFactoryRunDiagnostic('lua.accepted', {
          details: {
            stepCount: parseResult.steps.length
          }
        })
      }
      onProgramAccepted({
        fileName,
        luaContent: fileContent,
        projectName: parseResult.projectName,
        steps: parseResult.steps,
        diagnostics: parseResult.diagnostics,
        raw: parseResult.raw
      })

      setIsLoaded(true)
      return
    }

    reorderSteps(parseResult.steps)
    setProjectName(parseResult.projectName)
    setProgramSource('ImportedLua')
    setIsLoaded(true)
  }
  const errorDiagnostics =
    parseResult?.diagnostics.filter((diagnostic) => diagnostic.severity === 'error') || []

  const canLoad =
    parseResult !== null && parseResult.steps.length > 0 && errorDiagnostics.length === 0

  // Determine indicator state for the detail button
  const hasImportError = Boolean(fileError) || errorDiagnostics.length > 0
  const hasImportSuccess = isLoaded || (parseResult !== null && errorDiagnostics.length === 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <input
        ref={inputRef}
        type="file"
        accept=".lua"
        className="hidden"
        onChange={handleInputChange}
      />

      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-white">Import Program</h2>

          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            Import a LUA file or enter a JSON program.
          </p>
        </div>

        {/* Import status detail toggle button */}
        <button
          ref={importDetailBtnRef}
          type="button"
          title="Xem chi tiết trạng thái import"
          onClick={() => setShowImportDetail((v) => !v)}
          className={`ml-2 shrink-0 rounded p-1.5 transition ${
            showImportDetail
              ? 'bg-blue-600/30 text-blue-300'
              : hasImportError
                ? 'text-red-400 hover:bg-red-950/30'
                : hasImportSuccess
                  ? 'text-emerald-400 hover:bg-emerald-950/30'
                  : 'text-slate-500 hover:bg-[#25252b] hover:text-slate-200'
          }`}
        >
          <Info size={13} />
        </button>
      </div>

      {!luaOnly && (
        <div className="mb-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setImportMode('lua')}
            className={`flex items-center justify-center gap-1.5 rounded border px-3 py-2 text-xs font-bold ${
              importMode === 'lua'
                ? 'border-blue-500 bg-blue-600 text-white'
                : 'border-[#393942] bg-[#25252b] text-slate-400'
            }`}
          >
            <FileCode2 size={13} />
            LUA File
          </button>

          <button
            type="button"
            onClick={() => setImportMode('json')}
            className={`flex items-center justify-center gap-1.5 rounded border px-3 py-2 text-xs font-bold ${
              importMode === 'json'
                ? 'border-blue-500 bg-blue-600 text-white'
                : 'border-[#393942] bg-[#25252b] text-slate-400'
            }`}
          >
            <Braces size={13} />
            JSON Code
          </button>
        </div>
      )}
      {!luaOnly && importMode === 'json' && <ProgramJsonImport />}

      {importMode === 'lua' && (
        <>
          <div
            onDragEnter={(event) => {
              event.preventDefault()
              setIsDragging(true)
            }}
            onDragOver={(event) => {
              event.preventDefault()
              setIsDragging(true)
            }}
            onDragLeave={(event) => {
              event.preventDefault()
              setIsDragging(false)
            }}
            onDrop={handleDrop}
            className={`flex min-h-52 flex-col items-center justify-center rounded-lg border border-dashed p-6 text-center transition ${
              isDragging ? 'border-blue-400 bg-blue-950/30' : 'border-[#454550] bg-[#121214]'
            }`}
          >
            <UploadCloud size={30} className="mb-3 text-blue-400" />

            <p className="text-xs font-semibold text-slate-200">Drag and drop a LUA file here</p>

            <p className="mt-1 text-[10px] text-slate-500">Only .lua files, maximum 1 MB</p>

            <button
              type="button"
              onClick={() => void handleChooseFile()}
              className="mt-4 rounded bg-blue-600 px-4 py-2 text-xs font-bold text-white hover:bg-blue-500"
            >
              Choose file
            </button>
          </div>

          {fileName && (
            <div className="mt-4 rounded border border-[#393942] bg-[#121214] p-3">
              <p className="truncate text-xs font-semibold text-white">{fileName}</p>

              {parseResult && (
                <p className="mt-1 text-[10px] text-slate-400">
                  Project: {parseResult.projectName}
                </p>
              )}
            </div>
          )}

          {fileError && (
            <div className="mt-3 flex min-w-0 gap-2 rounded border border-red-500/40 bg-red-950/30 p-3 text-red-200">
              <AlertTriangle size={14} className="shrink-0" />

              <p className="min-w-0 flex-1 break-words text-[10px] leading-relaxed">{fileError}</p>
            </div>
          )}

          {parseResult && (
            <div className="mt-3 space-y-3">
              <div
                className={`flex items-center gap-2 rounded border p-3 ${
                  errorDiagnostics.length > 0
                    ? 'border-red-500/40 bg-red-950/30'
                    : 'border-emerald-500/40 bg-emerald-950/20'
                }`}
              >
                {errorDiagnostics.length > 0 ? (
                  <AlertTriangle size={14} className="text-red-300" />
                ) : (
                  <CheckCircle2 size={14} className="text-emerald-300" />
                )}

                <p className="text-[10px] text-slate-200">
                  {isParsing
                    ? 'Parsing with backend...'
                    : `${parseResult.steps.length} step(s), ${errorDiagnostics.length} error(s)`}
                </p>
              </div>

              {errorDiagnostics.length > 0 && (
                <div className="max-h-40 space-y-2 overflow-y-auto">
                  {errorDiagnostics.map((diagnostic, index) => (
                    <div
                      key={`${diagnostic.line}-${index}`}
                      className="rounded border border-red-500/30 bg-[#121214] p-2"
                    >
                      <p className="text-[10px] font-bold text-red-300">
                        Line {diagnostic.line}: {diagnostic.message}
                      </p>

                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[9px] text-slate-500">
                        {diagnostic.source}
                      </pre>
                    </div>
                  ))}
                </div>
              )}

              <button
                type="button"
                disabled={!canLoad}
                onClick={handleLoadWorkflow}
                className="w-full rounded bg-violet-600 px-4 py-2 text-xs font-bold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {actionLabel}
              </button>

              {isLoaded && (
                <p className="text-center text-[10px] text-emerald-300">
                  Program loaded into the workflow.
                </p>
              )}
            </div>
          )}
        </>
      )}

      {/* Floating import status popover */}
      {showImportDetail && (
        <ImportStatusPopover
          importMode={importMode}
          fileName={fileName}
          parseResult={parseResult}
          fileError={fileError}
          isParsing={isParsing}
          isLoaded={isLoaded}
          anchorRef={importDetailBtnRef as React.RefObject<HTMLElement | null>}
          onClose={() => setShowImportDetail(false)}
        />
      )}
    </div>
  )
}
