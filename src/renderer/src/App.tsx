import { useState } from 'react'
import Header from './components/layout/Header'
import RobotSidebar from './components/robot/RobotSidebar'
import Viewport3D from './components/viewport/Viewport3D'
import WorkflowPanel from './components/workflow/WorkflowPanel'
import CodePanel from './components/code/CodePanel'
import { Code, ChevronDown, ChevronUp } from 'lucide-react'
import BackendSimulatorPanel from './components/BackendSimulatorPanel'

function App(): React.JSX.Element {
  const [showCode, setShowCode] = useState(true)

  return (
    <div className="flex flex-col h-screen w-screen bg-[#1e1e24] overflow-hidden text-slate-100 font-sans">
      {/* Top Header */}
      <Header />

      {/* Main Workspace Layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Side: Robot Controls & Scene Settings */}
        <RobotSidebar />

        {/* Center: 3D Scene Viewport & LUA Preview */}
        <div className="flex-1 h-full flex flex-col min-w-0 relative">
          {/* 3D Viewport */}
          <div className="flex-1 min-h-0 relative">
            <Viewport3D />
            <BackendSimulatorPanel />

            {/* Floating Toggle Button for LUA Code Preview */}
            <button
              onClick={() => setShowCode(!showCode)}
              className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 px-3 py-2 bg-[#141417]/90 hover:bg-[#1e1e24] border border-[#2d2d34] hover:border-blue-500 rounded-lg text-xs font-semibold text-slate-300 hover:text-white transition shadow-lg backdrop-blur-sm"
              title={showCode ? 'Ẩn Code Preview' : 'Hiện Code Preview'}
            >
              <Code size={14} className="text-blue-500" />
              <span>LUA Preview</span>
              {showCode ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
          </div>

          {/* Bottom Code Panel */}
          {showCode && (
            <div className="h-60 shrink-0">
              <CodePanel />
            </div>
          )}
        </div>

        {/* Right Side: Workflow Editor */}
        <WorkflowPanel />
      </div>
    </div>
  )
}

export default App
