import Editor from '@monaco-editor/react'
import { Check, Code, Copy } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'

import { generateLua } from '../../engine/codegen/luaCodegen'
import { useRobotStore } from '../../store/robotStore'

export interface CodePanelProps {
  hideHeader?: boolean
}

export default function CodePanel({ hideHeader = false }: CodePanelProps): ReactElement {
  const steps = useRobotStore((state) => state.steps)
  const projectName = useRobotStore((state) => state.projectName)
  const [copied, setCopied] = useState(false)

  const luaCode = useMemo(() => generateLua(steps, projectName), [steps, projectName])

  const handleCopy = (): void => {
    void navigator.clipboard.writeText(luaCode)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      className={`flex h-full w-full flex-col text-slate-200 ${hideHeader ? '' : 'border-t border-[#2d2d34] bg-[#1e1e24]'}`}
    >
      {!hideHeader && (
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-[#2d2d34] bg-[#141417] px-4">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
            <Code size={14} className="text-blue-500" />
            <span>Fairino LUA Script Preview</span>
            <span className="text-[10px] font-normal text-slate-500">
              (Cập nhật thời gian thực)
            </span>
          </div>

          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded border border-[#393942] bg-[#25252b] px-2 py-0.5 text-[10px] transition hover:bg-[#2e2e36]"
          >
            {copied ? (
              <>
                <Check size={10} className="text-emerald-500" />
                <span className="text-emerald-500">Đã sao chép</span>
              </>
            ) : (
              <>
                <Copy size={10} />
                <span>Sao chép</span>
              </>
            )}
          </button>
        </div>
      )}

      <div className="relative min-h-0 w-full flex-1">
        {hideHeader && (
          <button
            type="button"
            onClick={handleCopy}
            className="absolute top-2 right-4 z-10 flex items-center gap-1 rounded-md border border-[#343849] bg-[#141720]/90 px-2.5 py-1 text-[10px] text-slate-300 shadow-md backdrop-blur-sm transition hover:border-blue-500 hover:text-white"
          >
            {copied ? (
              <>
                <Check size={10} className="text-emerald-400" />
                <span className="text-emerald-400 font-semibold">Đã sao chép</span>
              </>
            ) : (
              <>
                <Copy size={10} className="text-blue-400" />
                <span>Sao chép code</span>
              </>
            )}
          </button>
        )}
        <Editor
          height="100%"
          language="lua"
          theme="vs-dark"
          value={luaCode}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            fontSize: 12,
            fontFamily: 'Fira Code, Monaco, Menlo, Consolas, monospace',
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            padding: { top: 8 }
          }}
          loading={
            <div className="absolute inset-0 flex items-center justify-center bg-[#0c0e16] text-xs text-slate-500">
              Đang tải Monaco Editor...
            </div>
          }
        />
      </div>
    </div>
  )
}
