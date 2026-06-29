import { useState } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'

import { ProgramJsonParseResult, parseProgramJson } from '../../engine/codegen/programJsonParser'
import { useRobotStore } from '../../store/robotStore'

const MAX_JSON_LENGTH = 1024 * 1024

export default function ProgramJsonImport(): React.JSX.Element {
  const reorderSteps = useRobotStore((state) => state.reorderSteps)
  const setProjectName = useRobotStore((state) => state.setProjectName)
  const setProgramSource = useRobotStore((state) => state.setProgramSource)

  const [content, setContent] = useState('')
  const [result, setResult] = useState<ProgramJsonParseResult | null>(null)
  const [inputError, setInputError] = useState('')
  const [isLoaded, setIsLoaded] = useState(false)

  const handleValidate = (): void => {
    setInputError('')
    setIsLoaded(false)

    if (!content.trim()) {
      setResult(null)
      setInputError('JSON content is empty.')
      return
    }

    if (content.length > MAX_JSON_LENGTH) {
      setResult(null)
      setInputError('JSON content must not exceed 1 MB.')
      return
    }

    setResult(parseProgramJson(content))
  }

  const handleLoadWorkflow = (): void => {
    if (!result || result.diagnostics.length > 0 || result.steps.length === 0) {
      return
    }

    reorderSteps(result.steps)
    setProjectName(result.projectName)
    setProgramSource('BackendGenerated')
    setIsLoaded(true)
  }

  const canLoad = result !== null && result.steps.length > 0 && result.diagnostics.length === 0

  return (
    <div className="space-y-3">
      <textarea
        value={content}
        spellCheck={false}
        placeholder={`{
  "name": "Swagger Program",
  "status": "Draft",
  "source": "BackendGenerated",
  "steps": []
}`}
        onChange={(event) => {
          setContent(event.target.value)
          setResult(null)
          setInputError('')
          setIsLoaded(false)
        }}
        className="min-h-64 w-full resize-y rounded-lg border border-[#454550] bg-[#121214] p-3 font-mono text-[11px] leading-relaxed text-slate-200 outline-none focus:border-blue-500"
      />

      <button
        type="button"
        onClick={handleValidate}
        className="w-full rounded bg-blue-600 px-4 py-2 text-xs font-bold text-white hover:bg-blue-500"
      >
        Validate JSON
      </button>

      {inputError && (
        <div className="flex gap-2 rounded border border-red-500/40 bg-red-950/30 p-3">
          <AlertTriangle size={14} className="shrink-0 text-red-300" />
          <p className="text-[10px] text-red-200">{inputError}</p>
        </div>
      )}

      {result && (
        <>
          <div
            className={`flex items-center gap-2 rounded border p-3 ${
              result.diagnostics.length > 0
                ? 'border-red-500/40 bg-red-950/30'
                : 'border-emerald-500/40 bg-emerald-950/20'
            }`}
          >
            {result.diagnostics.length > 0 ? (
              <AlertTriangle size={14} className="text-red-300" />
            ) : (
              <CheckCircle2 size={14} className="text-emerald-300" />
            )}

            <p className="text-[10px] text-slate-200">
              {result.steps.length} step(s), {result.diagnostics.length} error(s)
            </p>
          </div>

          {result.diagnostics.length > 0 && (
            <div className="max-h-40 space-y-2 overflow-y-auto">
              {result.diagnostics.map((diagnostic, index) => (
                <div
                  key={`${diagnostic.path}-${index}`}
                  className="rounded border border-red-500/30 bg-[#121214] p-2"
                >
                  <p className="text-[10px] font-bold text-red-300">
                    {diagnostic.path}: {diagnostic.message}
                  </p>
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
            Load JSON into workflow
          </button>

          {isLoaded && (
            <p className="text-center text-[10px] text-emerald-300">
              JSON program loaded into the workflow.
            </p>
          )}
        </>
      )}
    </div>
  )
}
