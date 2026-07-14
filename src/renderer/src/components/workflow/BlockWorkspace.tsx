import React, { useState } from 'react'
import { useRobotStore } from '../../store/robotStore'
import type { StepType, WorkflowStep } from '../../types/robot.types'
import {
  Trash2,
  GripVertical,
  Plus,
  RotateCw,
  Move,
  Radio,
  Clock,
  ToggleLeft,
  HelpCircle,
  Settings
} from 'lucide-react'
import { translations } from '../../i18n/translations'
import WorkflowStepDetailsModal from './WorkflowStepDetailsModal'

// Helper component for descriptive tooltips on technical terms
interface InfoTooltipProps {
  text: string
}

function InfoTooltip({ text }: InfoTooltipProps): React.JSX.Element {
  return (
    <div
      className="relative group inline-block align-middle select-none shrink-0"
      onClick={(event) => event.stopPropagation()}
    >
      <HelpCircle size={11} className="text-white/50 hover:text-white cursor-help transition" />
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-56 bg-[#121214]/95 border border-white/10 text-[10px] text-slate-300 p-2.5 rounded-lg shadow-2xl backdrop-blur-md z-[100] pointer-events-none font-normal leading-relaxed normal-case">
        {text}
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-[#121214]" />
      </div>
    </div>
  )
}

interface BlockTemplate {
  type: StepType
  labelKey: keyof typeof translations.vi
  colorClass: string
  icon: React.ReactNode
}

export default function BlockWorkspace(): React.JSX.Element {
  const steps = useRobotStore((state) => state.steps)
  const addStep = useRobotStore((state) => state.addStep)
  const removeStep = useRobotStore((state) => state.removeStep)
  const updateStep = useRobotStore((state) => state.updateStep)
  const reorderSteps = useRobotStore((state) => state.reorderSteps)
  const selectedStepId = useRobotStore((state) => state.selectedStepId)
  const setSelectedStepId = useRobotStore((state) => state.setSelectedStepId)
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

  const lengthUnit = useRobotStore((state) => state.lengthUnit)
  const angleUnit = useRobotStore((state) => state.angleUnit)

  // Language translation helper
  const language = useRobotStore((state) => state.language)
  const t = (key: keyof typeof translations.vi): string => translations[language][key]

  // Drag & drop state
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [editingStepId, setEditingStepId] = useState<string | null>(null)
  const editingStep = editingStepId
    ? (steps.find((step) => step.id === editingStepId) ?? null)
    : null

  const blockTemplates: BlockTemplate[] = [
    {
      type: 'RotateJoint',
      labelKey: 'rotateJointBlock',
      colorClass: 'bg-indigo-650 border-indigo-400 hover:bg-indigo-600 text-indigo-100',
      icon: <RotateCw size={12} />
    },
    {
      type: 'MoveTCP',
      labelKey: 'moveTCPBlock',
      colorClass: 'bg-blue-650 border-blue-400 hover:bg-blue-600 text-blue-100',
      icon: <Move size={12} />
    },
    {
      type: 'SetDO',
      labelKey: 'setDOBlock',
      colorClass: 'bg-amber-650 border-amber-400 hover:bg-amber-600 text-amber-100',
      icon: <Radio size={12} />
    },
    {
      type: 'WaitMs',
      labelKey: 'waitMsBlock',
      colorClass: 'bg-emerald-650 border-emerald-400 hover:bg-emerald-600 text-emerald-100',
      icon: <Clock size={12} />
    },
    {
      type: 'GripperClose',
      labelKey: 'gripperCloseBlock',
      colorClass: 'bg-rose-650 border-rose-400 hover:bg-rose-600 text-rose-100',
      icon: <ToggleLeft size={12} />
    }
  ]

  // Add default parameters when adding a new step
  const handleAddBlock = (type: StepType): void => {
    let newStepParams: Omit<WorkflowStep, 'id'> = {
      type,
      label: '',
      speed: 30,
      acc: 30
    }

    switch (type) {
      case 'RotateJoint':
        newStepParams = {
          ...newStepParams,
          label: `${t('rotateJointBlock')} 1`,
          jointIndex: 1,
          rotateMode: 'absolute',
          angle: 0
        }
        break
      case 'MoveTCP':
        newStepParams = {
          ...newStepParams,
          label: `${t('moveTCPBlock')} Z`,
          tcpAxis: 'Z',
          moveMode: 'relative',
          distance: 20
        }
        break
      case 'SetDO':
        newStepParams = {
          ...newStepParams,
          label: `${t('setDOBlock')} 1`,
          doIndex: 1,
          doValue: 1,
          doType: 'cabinet'
        }
        break
      case 'WaitMs':
        newStepParams = {
          ...newStepParams,
          label: `${t('waitMsBlock')} 1s`,
          delayMs: 1000
        }
        break
      case 'GripperOpen':
        newStepParams = {
          ...newStepParams,
          label: t('gripperOpenBlock')
        }
        break
      case 'GripperClose':
        newStepParams = {
          ...newStepParams,
          label: t('gripperCloseBlock')
        }
        break
    }

    addStep(newStepParams)
  }

  // Handle Drag Start from Template Palette
  const handleTemplateDragStart = (e: React.DragEvent, type: StepType): void => {
    e.dataTransfer.setData('newBlockType', type)
  }

  // Handle Drag Start from Workspace List (Reordering)
  const handleWorkspaceDragStart = (e: React.DragEvent, index: number): void => {
    setDraggedIndex(index)
    e.dataTransfer.effectAllowed = 'move'
  }

  // Handle Drag Over
  const handleDragOver = (e: React.DragEvent, index: number): void => {
    e.preventDefault()
    if (dragOverIndex !== index) {
      setDragOverIndex(index)
    }
  }

  // Handle Drop in Workspace (Insert or Reorder)
  const handleDrop = (e: React.DragEvent, targetIndex: number): void => {
    e.preventDefault()
    const newType = e.dataTransfer.getData('newBlockType') as StepType | ''

    if (newType) {
      // 1. Insert new block from palette at targetIndex
      let newStepParams: Omit<WorkflowStep, 'id'> = {
        type: newType,
        label: '',
        speed: 30,
        acc: 30
      }

      switch (newType) {
        case 'RotateJoint':
          newStepParams = {
            ...newStepParams,
            label: `${t('rotateJointBlock')} 1`,
            jointIndex: 1,
            rotateMode: 'absolute',
            angle: 0
          }
          break
        case 'MoveTCP':
          newStepParams = {
            ...newStepParams,
            label: `${t('moveTCPBlock')} Z`,
            tcpAxis: 'Z',
            moveMode: 'relative',
            distance: 20
          }
          break
        case 'SetDO':
          newStepParams = {
            ...newStepParams,
            label: `${t('setDOBlock')} 1`,
            doIndex: 1,
            doValue: 1,
            doType: 'cabinet'
          }
          break
        case 'WaitMs':
          newStepParams = {
            ...newStepParams,
            label: `${t('waitMsBlock')} 1s`,
            delayMs: 1000
          }
          break
        case 'GripperOpen':
          newStepParams = { ...newStepParams, label: t('gripperOpenBlock') }
          break
        case 'GripperClose':
          newStepParams = { ...newStepParams, label: t('gripperCloseBlock') }
          break
      }

      const newStep: WorkflowStep = {
        ...newStepParams,
        id: crypto.randomUUID()
      }

      const updatedSteps = [...steps]
      updatedSteps.splice(targetIndex, 0, newStep)
      reorderSteps(updatedSteps)
    } else if (draggedIndex !== null) {
      // 2. Reorder existing blocks
      if (draggedIndex === targetIndex) return
      const updatedSteps = [...steps]
      const [removed] = updatedSteps.splice(draggedIndex, 1)
      updatedSteps.splice(targetIndex, 0, removed)
      reorderSteps(updatedSteps)
    }

    setDraggedIndex(null)
    setDragOverIndex(null)
  }

  // Handle Drag End cleanup
  const handleDragEnd = (): void => {
    setDraggedIndex(null)
    setDragOverIndex(null)
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden bg-[#16161a]">
      {/* 1. Palette: Block templates slider */}
      <div className="p-3 border-b border-[#2d2d34] bg-[#1a1a22] shrink-0">
        <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block mb-2 font-mono">
          {t('dragDropHint')}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {blockTemplates.map((tpl) => (
            <div
              key={tpl.type}
              draggable={!isPlaying}
              onDragStart={(e) => handleTemplateDragStart(e, tpl.type)}
              onClick={() => !isPlaying && handleAddBlock(tpl.type)}
              className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg border text-xs font-bold shadow-sm cursor-grab active:cursor-grabbing transition transform hover:scale-[1.03] select-none ${tpl.colorClass} ${
                isPlaying ? 'opacity-40 pointer-events-none' : ''
              }`}
            >
              {tpl.icon}
              <span>{t(tpl.labelKey)}</span>
              <Plus size={10} className="opacity-60 ml-0.5" />
            </div>
          ))}
        </div>
      </div>

      {/* 2. Workspace: Drop Zone and Blocks List */}
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          if (steps.length === 0) {
            handleDrop(e, 0)
          }
        }}
        className="flex-1 overflow-x-hidden overflow-y-auto p-4 space-y-3 min-h-0 min-w-0 relative select-none"
      >
        {steps.length === 0 ? (
          <div className="h-full border border-dashed border-[#2d2d34] rounded-xl flex flex-col items-center justify-center text-slate-500 p-8 text-center bg-[#111114]">
            <span className="text-xs font-semibold text-slate-400">{t('emptyWorkspace')}</span>
            <span className="text-[10px] text-slate-500 mt-1 max-w-[200px] leading-relaxed">
              {t('emptyWorkspaceHint')}
            </span>
          </div>
        ) : (
          steps.map((step, idx) => {
            const isSelected = selectedStepId === step.id
            const isCurrentSim = isPlaying && currentStepIndex === idx
            const isDragged = draggedIndex === idx
            const isOver = dragOverIndex === idx

            // Define dynamic Lego coloring classes
            let blockBg = 'bg-slate-800'
            let blockBorder = 'border-[#2d2d34]'
            const blockText = 'text-white'

            if (step.type === 'RotateJoint') {
              blockBg = 'bg-indigo-650'
              blockBorder = isSelected ? 'border-indigo-400' : 'border-indigo-700'
            } else if (step.type === 'MoveTCP') {
              blockBg = 'bg-blue-650'
              blockBorder = isSelected ? 'border-blue-400' : 'border-blue-700'
            } else if (step.type === 'SetDO') {
              blockBg = 'bg-amber-650'
              blockBorder = isSelected ? 'border-amber-400' : 'border-amber-700'
            } else if (step.type === 'WaitMs') {
              blockBg = 'bg-emerald-650'
              blockBorder = isSelected ? 'border-emerald-400' : 'border-emerald-700'
            } else if (step.type === 'GripperClose' || step.type === 'GripperOpen') {
              blockBg = 'bg-rose-650'
              blockBorder = isSelected ? 'border-rose-400' : 'border-rose-700'
            }

            return (
              <div
                key={step.id}
                draggable={!isPlaying}
                onDragStart={(e) => handleWorkspaceDragStart(e, idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={(e) => handleDrop(e, idx)}
                onDragEnd={handleDragEnd}
                onClick={() => setSelectedStepId(step.id)}
                className={`relative flex w-full min-w-0 items-stretch rounded-xl border transition shadow-md select-none transform ${blockBg} ${blockBorder} ${blockText} ${
                  isDragged ? 'opacity-30 scale-95' : ''
                } ${isOver && draggedIndex !== idx ? 'border-t-2 border-t-white pt-4' : ''} ${
                  isCurrentSim ? 'ring-2 ring-emerald-400 scale-[1.02] shadow-emerald-500/20' : ''
                }`}
                style={{
                  clipPath:
                    'polygon(0% 0%, 30% 0%, 35% 6px, 45% 6px, 50% 0%, 100% 0%, 100% 100%, 50% 100%, 45% calc(100% + 6px), 35% calc(100% + 6px), 30% 100%, 0% 100%)',
                  marginBottom: '1px'
                }}
              >
                {/* 1. Lego Drag Handle & Color indicator */}
                <div
                  className="w-8 shrink-0 flex items-center justify-center border-r border-white/10 opacity-70 cursor-grab active:cursor-grabbing hover:opacity-100 transition"
                  title="Kéo thả để sắp xếp lại"
                >
                  <GripVertical size={14} />
                </div>

                {/* 2. Block Contents */}
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 p-3 pr-11">
                  {/* Block Type Label */}
                  <span className="text-[10px] font-black uppercase tracking-wider bg-black/30 px-1.5 py-0.5 rounded text-white/90 font-mono flex items-center gap-1 select-none">
                    {step.type === 'RotateJoint' && (
                      <>
                        Rotate
                        <InfoTooltip text={t('tooltipFK')} />
                      </>
                    )}
                    {step.type === 'MoveTCP' && (
                      <>
                        Move TCP
                        <InfoTooltip text={t('tooltipMoveL')} />
                      </>
                    )}
                    {step.type === 'SetDO' && (
                      <>
                        Set DO
                        <InfoTooltip text={t('tooltipDO')} />
                      </>
                    )}
                    {step.type === 'WaitMs' && (
                      <>
                        Delay
                        <InfoTooltip text={t('tooltipDelay')} />
                      </>
                    )}
                    {(step.type === 'GripperClose' || step.type === 'GripperOpen') && <>Gripper</>}
                  </span>

                  {/* Parameter Summary Label */}
                  <span className="text-[11px] text-slate-300 font-medium truncate ml-2">
                    {step.label}
                  </span>
                </div>

                {/* Actions: Edit & Delete buttons */}
                <div
                  className="absolute right-2 top-1/2 z-10 -translate-y-1/2 flex items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => setEditingStepId(step.id)}
                    className="rounded-lg border border-white/10 bg-black/35 p-1.5 text-white/60 shadow-sm transition hover:border-blue-500/40 hover:bg-blue-950/60 hover:text-blue-300 cursor-pointer"
                    title={language === 'vi' ? 'Sửa thông số' : 'Edit parameters'}
                  >
                    <Settings size={13} />
                  </button>
                  <button
                    onClick={() => removeStep(step.id)}
                    className="rounded-lg border border-white/10 bg-black/35 p-1.5 text-white/60 shadow-sm transition hover:border-rose-400/40 hover:bg-rose-950/60 hover:text-rose-300 cursor-pointer"
                    title="Xóa khối"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      {editingStep && (
        <WorkflowStepDetailsModal
          step={editingStep}
          isOpen={!!editingStep}
          onClose={() => setEditingStepId(null)}
          updateStep={updateStep}
          angleUnit={angleUnit}
          lengthUnit={lengthUnit}
          isPlaying={isPlaying}
          language={language}
        />
      )}
    </div>
  )
}
