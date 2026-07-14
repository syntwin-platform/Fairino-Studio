import { useState } from 'react'
import type { ReactElement } from 'react'
import { ChevronDown, ChevronUp, Terminal, Code, History } from 'lucide-react'
import CodePanel from '../code/CodePanel'
import { useRobotStore } from '../../store/robotStore'

export default function BottomConsole(): ReactElement {
  const [isOpen, setIsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'console' | 'lua' | 'commands'>('lua')
  const steps = useRobotStore((state) => state.steps)
  const isPlaying = useRobotStore((state) => {
    const robotId = state.selectedRobotId

    return robotId ? (state.robotExecutionById[robotId]?.isPlaying ?? false) : state.isPlaying
  })

  const currentStepIndex = useRobotStore((state) => {
    const robotId = state.selectedRobotId

    return robotId
      ? (state.robotExecutionById[robotId]?.currentStepIndex ?? 0)
      : state.currentStepIndex
  })
  const currentStep = isPlaying ? steps[currentStepIndex] : null

  const toggleOpen = (): void => {
    setIsOpen(!isOpen)
  }

  const handleTabClick = (tab: 'console' | 'lua' | 'commands'): void => {
    setActiveTab(tab)
    if (!isOpen) {
      setIsOpen(true)
    }
  }

  return (
    <div
      className={`flex shrink-0 flex-col border-t border-[#343849] bg-[#0c0e16] text-slate-200 transition-all duration-300 ${
        isOpen ? 'h-72' : 'h-10'
      }`}
    >
      {/* Header bar */}
      <div className="flex h-10 shrink-0 items-center justify-between bg-[#141720] px-4 select-none">
        {/* Tabs */}
        <div className="flex h-full items-center gap-1">
          <button
            type="button"
            onClick={() => handleTabClick('lua')}
            className={`flex h-full items-center gap-1.5 border-b-2 px-3 text-[11px] font-bold transition ${
              activeTab === 'lua' && isOpen
                ? 'border-blue-500 bg-[#0c0e16] text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Code size={13} className="text-blue-500" />
            LUA Preview
          </button>

          <button
            type="button"
            onClick={() => handleTabClick('console')}
            className={`flex h-full items-center gap-1.5 border-b-2 px-3 text-[11px] font-bold transition ${
              activeTab === 'console' && isOpen
                ? 'border-blue-500 bg-[#0c0e16] text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal size={13} className="text-emerald-500" />
            Console
          </button>

          <button
            type="button"
            onClick={() => handleTabClick('commands')}
            className={`flex h-full items-center gap-1.5 border-b-2 px-3 text-[11px] font-bold transition ${
              activeTab === 'commands' && isOpen
                ? 'border-blue-500 bg-[#0c0e16] text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <History size={13} className="text-amber-500" />
            Command Log
          </button>
        </div>

        {/* Toggle Button */}
        <button
          type="button"
          onClick={toggleOpen}
          className="rounded p-1 text-slate-400 hover:bg-[#242833] hover:text-white"
          title={isOpen ? 'Collapse Console' : 'Expand Console'}
        >
          {isOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>

      {/* Pane Content */}
      {isOpen && (
        <div className="min-h-0 flex-1 bg-[#0c0e16]">
          {activeTab === 'lua' && (
            <div className="h-full w-full">
              <CodePanel hideHeader={true} />
            </div>
          )}

          {activeTab === 'console' && (
            <div className="h-full w-full overflow-y-auto p-4 font-mono text-[10px] space-y-1.5 leading-relaxed bg-[#0c0e16]">
              {currentStep ? (
                <div className="flex gap-2">
                  <span className="text-slate-600 shrink-0">LOCAL</span>
                  <span className="font-bold shrink-0 text-emerald-400">[SIM]</span>
                  <span className="text-slate-300 break-all">
                    Running step {currentStepIndex + 1}: {currentStep.label} ({currentStep.type})
                  </span>
                </div>
              ) : (
                <div className="p-2 text-slate-500 italic">
                  No local console output. Start simulation to see the current local step.
                </div>
              )}
            </div>
          )}

          {activeTab === 'commands' && (
            <div className="h-full w-full overflow-y-auto p-4 font-mono text-[10px] space-y-1.5 leading-relaxed bg-[#0c0e16]">
              <div className="p-2 text-slate-500 italic">
                Backend command history is available from the right panel Command History button.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
