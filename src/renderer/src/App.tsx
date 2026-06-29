import { useState } from 'react'
import { ChevronDown, ChevronUp, Code } from 'lucide-react'

import Header from './components/layout/Header'
import RobotSidebar from './components/robot/RobotSidebar'
import Viewport3D from './components/viewport/Viewport3D'
import WorkflowPanel from './components/workflow/WorkflowPanel'
import CodePanel from './components/code/CodePanel'
import BackendSimulatorPanel from './components/BackendSimulatorPanel'
import BackendProgramControls from './components/BackendProgramControls'

function App(): React.JSX.Element {
  const [showCode, setShowCode] = useState(true)

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#1e1e24] font-sans text-slate-100">
      <Header />

      <div className="flex flex-1 overflow-hidden">
        <RobotSidebar />

        <div className="relative flex h-full min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <Viewport3D />
            <BackendSimulatorPanel />

            <button
              onClick={() => setShowCode(!showCode)}
              className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 rounded-lg border border-[#2d2d34] bg-[#141417]/90 px-3 py-2 text-xs font-semibold text-slate-300 shadow-lg backdrop-blur-sm transition hover:border-blue-500 hover:text-white"
              title={showCode ? 'Ẩn Code Preview' : 'Hiện Code Preview'}
            >
              <Code size={14} className="text-blue-500" />
              <span>LUA Preview</span>

              {showCode ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
          </div>

          {showCode && (
            <div className="h-60 shrink-0">
              <CodePanel />
            </div>
          )}
        </div>

        <div className="flex h-full w-96 shrink-0 flex-col overflow-hidden">
          <BackendProgramControls />

          <div className="min-h-0 flex-1">
            <WorkflowPanel />
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
