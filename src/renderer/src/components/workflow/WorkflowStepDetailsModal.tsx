import type { ReactElement } from 'react'
import { Settings, Cpu } from 'lucide-react'
import { WorkflowStep } from '../../types/robot.types'
import CenterModal from '../ui/CenterModal'
import { translations } from '../../i18n/translations'

interface WorkflowStepDetailsModalProps {
  step: WorkflowStep | null
  isOpen: boolean
  onClose: () => void
  updateStep: (id: string, updated: Partial<WorkflowStep>) => void
  angleUnit: 'deg' | 'rad'
  lengthUnit: 'mm' | 'm'
  isPlaying: boolean
  language: 'vi' | 'en'
}

export default function WorkflowStepDetailsModal({
  step,
  isOpen,
  onClose,
  updateStep,
  angleUnit,
  lengthUnit,
  isPlaying,
  language
}: WorkflowStepDetailsModalProps): ReactElement | null {
  if (!step) return null

  const t = (key: keyof typeof translations.vi): string => translations[language][key]

  const handleUpdateField = (fields: Partial<WorkflowStep>): void => {
    updateStep(step.id, fields)
  }

  // Helper for numeric limits
  const clamp = (val: number, min: number, max: number): number => {
    return Math.min(Math.max(val, min), max)
  }

  return (
    <CenterModal
      title={`Step Details: ${step.type}`}
      subtitle={`Configure parameters for step ID: ${step.id.slice(0, 10)}...`}
      icon={<Settings size={16} />}
      open={isOpen}
      onClose={onClose}
      size="md"
    >
      <div className="space-y-4 text-xs text-slate-300">
        {/* Step Label */}
        <div>
          <label className="block mb-1.5 font-bold uppercase tracking-wider text-slate-400 text-[10px]">
            {language === 'vi' ? 'Nhãn bước' : 'Step Label'}
          </label>
          <input
            type="text"
            value={step.label}
            onChange={(e) => handleUpdateField({ label: e.target.value })}
            disabled={isPlaying}
            className="w-full rounded-md border border-[#343849] bg-[#0c0e16] px-3 py-2 text-white outline-none focus:border-blue-500 disabled:opacity-60 transition"
          />
        </div>

        {/* Speed and Acc (For motion types: MoveJ, MoveL, RotateJoint, MoveTCP) */}
        {['MoveJ', 'MoveL', 'RotateJoint', 'MoveTCP'].includes(step.type) && (
          <div className="grid grid-cols-2 gap-4 border-t border-[#2d2d34] pt-4">
            <div>
              <label className="flex justify-between mb-1.5 font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                <span>{language === 'vi' ? 'Tốc độ' : 'Speed'}</span>
                <span className="text-blue-400 font-mono">{step.speed ?? 30}%</span>
              </label>
              <input
                type="range"
                min={1}
                max={100}
                value={step.speed ?? 30}
                onChange={(e) =>
                  handleUpdateField({ speed: clamp(parseInt(e.target.value) || 30, 1, 100) })
                }
                disabled={isPlaying}
                className="w-full cursor-pointer h-1 bg-[#242833] rounded-lg appearance-none accent-blue-500 disabled:opacity-50"
              />
            </div>

            <div>
              <label className="flex justify-between mb-1.5 font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                <span>{language === 'vi' ? 'Gia tốc' : 'Acceleration'}</span>
                <span className="text-blue-400 font-mono">{step.acc ?? 30}%</span>
              </label>
              <input
                type="range"
                min={1}
                max={100}
                value={step.acc ?? 30}
                onChange={(e) =>
                  handleUpdateField({ acc: clamp(parseInt(e.target.value) || 30, 1, 100) })
                }
                disabled={isPlaying}
                className="w-full cursor-pointer h-1 bg-[#242833] rounded-lg appearance-none accent-blue-500 disabled:opacity-50"
              />
            </div>
          </div>
        )}

        {/* Comment field */}
        <div className="border-t border-[#2d2d34] pt-4">
          <label className="block mb-1.5 font-bold uppercase tracking-wider text-slate-400 text-[10px]">
            {language === 'vi' ? 'Ghi chú (Comment)' : 'Comment'}
          </label>
          <textarea
            value={step.comment || ''}
            onChange={(e) => handleUpdateField({ comment: e.target.value })}
            placeholder={language === 'vi' ? 'Thêm ghi chú cho bước này...' : 'Add a note...'}
            disabled={isPlaying}
            className="w-full h-16 rounded-md border border-[#343849] bg-[#0c0e16] px-3 py-2 text-white outline-none focus:border-blue-500 disabled:opacity-60 transition resize-none"
          />
        </div>

        {/* Type Specific Fields */}
        <div className="border-t border-[#2d2d34] pt-4">
          {/* MoveJ Readonly Info */}
          {step.type === 'MoveJ' && step.jointAngles && (
            <div>
              <span className="block mb-2 font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                {language === 'vi'
                  ? 'Cấu hình góc khớp (Readonly)'
                  : 'Joint Configuration (Readonly)'}
              </span>
              <div className="grid grid-cols-3 gap-2 bg-[#0c0e16] p-3 rounded-lg border border-[#2d2d34]">
                {step.jointAngles.map((val, idx) => (
                  <div
                    key={idx}
                    className="rounded bg-[#141720] border border-[#242833] p-1.5 text-center"
                  >
                    <span className="block text-[9px] font-bold text-slate-500">J{idx + 1}</span>
                    <span className="font-mono font-semibold text-slate-200">
                      {angleUnit === 'rad' ? ((val * Math.PI) / 180).toFixed(3) : val.toFixed(1)}
                      {angleUnit === 'rad' ? ' rad' : '°'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* MoveL Readonly Info */}
          {step.type === 'MoveL' && step.tcpPose && (
            <div>
              <span className="block mb-2 font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                {language === 'vi'
                  ? 'Tọa độ điểm công tác TCP (Readonly)'
                  : 'TCP Cartesian Coordinates (Readonly)'}
              </span>
              <div className="grid grid-cols-3 gap-2 bg-[#0c0e16] p-3 rounded-lg border border-[#2d2d34]">
                <div className="rounded bg-[#141720] border border-[#242833] p-1.5 text-center">
                  <span className="block text-[9px] font-bold text-red-400">X ({lengthUnit})</span>
                  <span className="font-mono font-semibold text-slate-200">
                    {lengthUnit === 'm'
                      ? (step.tcpPose.x / 1000).toFixed(4)
                      : step.tcpPose.x.toFixed(1)}
                  </span>
                </div>
                <div className="rounded bg-[#141720] border border-[#242833] p-1.5 text-center">
                  <span className="block text-[9px] font-bold text-emerald-400">
                    Y ({lengthUnit})
                  </span>
                  <span className="font-mono font-semibold text-slate-200">
                    {lengthUnit === 'm'
                      ? (step.tcpPose.y / 1000).toFixed(4)
                      : step.tcpPose.y.toFixed(1)}
                  </span>
                </div>
                <div className="rounded bg-[#141720] border border-[#242833] p-1.5 text-center">
                  <span className="block text-[9px] font-bold text-blue-400">Z ({lengthUnit})</span>
                  <span className="font-mono font-semibold text-slate-200">
                    {lengthUnit === 'm'
                      ? (step.tcpPose.z / 1000).toFixed(4)
                      : step.tcpPose.z.toFixed(1)}
                  </span>
                </div>
                <div className="rounded bg-[#141720] border border-[#242833] p-1.5 text-center">
                  <span className="block text-[9px] font-bold text-red-300">
                    Rx ({angleUnit === 'rad' ? 'rad' : '°'})
                  </span>
                  <span className="font-mono font-semibold text-slate-200">
                    {angleUnit === 'rad'
                      ? ((step.tcpPose.rx * Math.PI) / 180).toFixed(3)
                      : step.tcpPose.rx.toFixed(1)}
                  </span>
                </div>
                <div className="rounded bg-[#141720] border border-[#242833] p-1.5 text-center">
                  <span className="block text-[9px] font-bold text-emerald-300">
                    Ry ({angleUnit === 'rad' ? 'rad' : '°'})
                  </span>
                  <span className="font-mono font-semibold text-slate-200">
                    {angleUnit === 'rad'
                      ? ((step.tcpPose.ry * Math.PI) / 180).toFixed(3)
                      : step.tcpPose.ry.toFixed(1)}
                  </span>
                </div>
                <div className="rounded bg-[#141720] border border-[#242833] p-1.5 text-center">
                  <span className="block text-[9px] font-bold text-blue-300">
                    Rz ({angleUnit === 'rad' ? 'rad' : '°'})
                  </span>
                  <span className="font-mono font-semibold text-slate-200">
                    {angleUnit === 'rad'
                      ? ((step.tcpPose.rz * Math.PI) / 180).toFixed(3)
                      : step.tcpPose.rz.toFixed(1)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* RotateJoint Fields */}
          {step.type === 'RotateJoint' && (
            <div className="space-y-3">
              <span className="block font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                {language === 'vi' ? 'Quay khớp đơn lẻ' : 'Rotate Joint Parameters'}
              </span>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block mb-1 text-[10px] text-slate-500">
                    {t('jointLimitTitle')}
                  </label>
                  <select
                    value={step.jointIndex || 1}
                    onChange={(e) => {
                      const idxVal = parseInt(e.target.value)
                      handleUpdateField({
                        jointIndex: idxVal,
                        label: `${t('rotateJointBlock')} ${idxVal}`
                      })
                    }}
                    disabled={isPlaying}
                    className="w-full rounded border border-[#343849] bg-[#0c0e16] px-2 py-1.5 text-white outline-none cursor-pointer"
                  >
                    {[1, 2, 3, 4, 5, 6].map((num) => (
                      <option key={num} value={num}>
                        {t('jointLimitTitle')} {num}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block mb-1 text-[10px] text-slate-500">
                    {language === 'vi' ? 'Chế độ quay' : 'Rotate Mode'}
                  </label>
                  <select
                    value={step.rotateMode || 'absolute'}
                    onChange={(e) =>
                      handleUpdateField({
                        rotateMode: e.target.value as WorkflowStep['rotateMode']
                      })
                    }
                    disabled={isPlaying}
                    className="w-full rounded border border-[#343849] bg-[#0c0e16] px-2 py-1.5 text-white outline-none cursor-pointer"
                  >
                    <option value="absolute">{t('toAngle')}</option>
                    <option value="relative">{t('byDegrees')}</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block mb-1 text-[10px] text-slate-500">
                  {language === 'vi' ? 'Góc quay' : 'Angle'} ({angleUnit === 'rad' ? 'rad' : '°'})
                </label>
                <input
                  type="number"
                  value={
                    angleUnit === 'rad'
                      ? Math.round((((step.angle ?? 0) * Math.PI) / 180) * 1000) / 1000
                      : (step.angle ?? 0)
                  }
                  step={angleUnit === 'rad' ? '0.001' : '1'}
                  onChange={(e) => {
                    const inputValue = parseFloat(e.target.value) || 0
                    const degreeValue =
                      angleUnit === 'rad'
                        ? Math.round(((inputValue * 180) / Math.PI) * 10) / 10
                        : inputValue
                    handleUpdateField({ angle: degreeValue })
                  }}
                  disabled={isPlaying}
                  className="w-full rounded border border-[#343849] bg-[#0c0e16] px-3 py-1.5 text-white outline-none font-mono"
                />
              </div>
            </div>
          )}

          {/* MoveTCP Fields */}
          {step.type === 'MoveTCP' && (
            <div className="space-y-3">
              <span className="block font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                {language === 'vi' ? 'Dịch TCP theo trục' : 'Move TCP Axis Parameters'}
              </span>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block mb-1 text-[10px] text-slate-500">
                    {language === 'vi' ? 'Trục' : 'Axis'}
                  </label>
                  <select
                    value={step.tcpAxis || 'Z'}
                    onChange={(e) => {
                      const axisVal = e.target.value as NonNullable<WorkflowStep['tcpAxis']>
                      handleUpdateField({
                        tcpAxis: axisVal,
                        label: `${t('moveTCPBlock')} ${axisVal}`
                      })
                    }}
                    disabled={isPlaying}
                    className="w-full rounded border border-[#343849] bg-[#0c0e16] px-2 py-1.5 text-white outline-none cursor-pointer"
                  >
                    {['X', 'Y', 'Z'].map((axis) => (
                      <option key={axis} value={axis}>
                        {axis}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block mb-1 text-[10px] text-slate-500">
                    {language === 'vi' ? 'Loại dịch chuyển' : 'Move Mode'}
                  </label>
                  <select
                    value={step.moveMode || 'relative'}
                    onChange={(e) =>
                      handleUpdateField({ moveMode: e.target.value as WorkflowStep['moveMode'] })
                    }
                    disabled={isPlaying}
                    className="w-full rounded border border-[#343849] bg-[#0c0e16] px-2 py-1.5 text-white outline-none cursor-pointer"
                  >
                    <option value="relative">{t('byDegrees')}</option>
                    <option value="absolute">{t('toCoordinate')}</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block mb-1 text-[10px] text-slate-500">
                  {language === 'vi' ? 'Khoảng cách' : 'Distance'} ({lengthUnit})
                </label>
                <input
                  type="number"
                  value={
                    lengthUnit === 'm'
                      ? Math.round(((step.distance ?? 0) / 1000) * 10000) / 10000
                      : (step.distance ?? 0)
                  }
                  step={lengthUnit === 'm' ? '0.0001' : '1'}
                  onChange={(e) => {
                    const inputValue = parseFloat(e.target.value) || 0
                    const millimeterValue =
                      lengthUnit === 'm' ? Math.round(inputValue * 1000 * 10) / 10 : inputValue
                    handleUpdateField({ distance: millimeterValue })
                  }}
                  disabled={isPlaying}
                  className="w-full rounded border border-[#343849] bg-[#0c0e16] px-3 py-1.5 text-white outline-none font-mono"
                />
              </div>
            </div>
          )}

          {/* WaitMs Fields */}
          {step.type === 'WaitMs' && (
            <div>
              <label className="block mb-1.5 font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                {language === 'vi' ? 'Thời gian chờ trễ (ms)' : 'Delay Duration (ms)'}
              </label>
              <input
                type="number"
                value={step.delayMs || 1000}
                onChange={(e) => {
                  const val = parseInt(e.target.value) || 0
                  handleUpdateField({
                    delayMs: val,
                    label: language === 'vi' ? `Đợi trễ ${val}ms` : `Wait ${val}ms`
                  })
                }}
                disabled={isPlaying}
                className="w-full rounded border border-[#343849] bg-[#0c0e16] px-3 py-2 text-white outline-none font-mono focus:border-blue-500 transition"
              />
            </div>
          )}

          {/* SetDO Fields */}
          {step.type === 'SetDO' && (
            <div className="space-y-3">
              <span className="block font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                {language === 'vi' ? 'Cài đặt ngõ ra DO' : 'Set DO State'}
              </span>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block mb-1 text-[10px] text-slate-500">
                    {language === 'vi' ? 'Loại cổng' : 'DO Type'}
                  </label>
                  <select
                    value={step.doType || 'cabinet'}
                    onChange={(e) => {
                      const newType = e.target.value as 'cabinet' | 'tool'
                      const newIdx = newType === 'tool' ? 0 : 1
                      handleUpdateField({
                        doType: newType,
                        doIndex: newIdx,
                        label:
                          language === 'vi'
                            ? `Cài đặt ${newType === 'tool' ? 'Tool DO' : 'DO'} ${newIdx}`
                            : `Set ${newType === 'tool' ? 'Tool DO' : 'DO'} ${newIdx}`
                      })
                    }}
                    disabled={isPlaying}
                    className="w-full rounded border border-[#343849] bg-[#0c0e16] px-2 py-1.5 text-white outline-none cursor-pointer"
                  >
                    <option value="cabinet">{t('cabinetDO')}</option>
                    <option value="tool">{t('toolDO')}</option>
                  </select>
                </div>

                <div>
                  <label className="block mb-1 text-[10px] text-slate-500">
                    {language === 'vi' ? 'Cổng số' : 'DO Index'}
                  </label>
                  <select
                    value={step.doIndex ?? 1}
                    onChange={(e) => {
                      const val = parseInt(e.target.value)
                      const type = step.doType || 'cabinet'
                      handleUpdateField({
                        doIndex: val,
                        label:
                          language === 'vi'
                            ? `Cài đặt ${type === 'tool' ? 'Tool DO' : 'DO'} ${val}`
                            : `Set ${type === 'tool' ? 'Tool DO' : 'DO'} ${val}`
                      })
                    }}
                    disabled={isPlaying}
                    className="w-full rounded border border-[#343849] bg-[#0c0e16] px-2 py-1.5 text-white outline-none cursor-pointer"
                  >
                    {((step.doType || 'cabinet') === 'tool'
                      ? [0, 1]
                      : [1, 2, 3, 4, 5, 6, 7, 8]
                    ).map((num) => (
                      <option key={num} value={num}>
                        {(step.doType || 'cabinet') === 'tool' ? `End-DO ${num}` : `DO ${num}`}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block mb-1 text-[10px] text-slate-500">
                    {language === 'vi' ? 'Trạng thái' : 'DO Value'}
                  </label>
                  <select
                    value={step.doValue ?? 1}
                    onChange={(e) => {
                      const val = parseInt(e.target.value) as 0 | 1
                      handleUpdateField({ doValue: val })
                    }}
                    disabled={isPlaying}
                    className="w-full rounded border border-[#343849] bg-[#0c0e16] px-2 py-1.5 text-white outline-none cursor-pointer font-mono"
                  >
                    <option value={1}>{t('turnOn')}</option>
                    <option value={0}>{t('turnOff')}</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* GripperClose & GripperOpen */}
          {(step.type === 'GripperClose' || step.type === 'GripperOpen') && (
            <div className="flex items-start gap-2 bg-[#0c0e16] p-3 rounded-lg border border-[#2d2d34] leading-relaxed">
              <Cpu size={16} className="text-blue-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-slate-200">
                  {step.type === 'GripperClose'
                    ? language === 'vi'
                      ? 'Đóng tay gắp robot'
                      : 'Set gripper state to CLOSED'
                    : language === 'vi'
                      ? 'Mở tay gắp robot'
                      : 'Set gripper state to OPEN'}
                </p>
                <p className="mt-1 text-[10px] text-slate-500">
                  {step.type === 'GripperClose'
                    ? language === 'vi'
                      ? 'Kích hoạt van khí nén (DO 1 = 1) để đóng tay gắp.'
                      : 'Van DO 1 set to 1 (High) to close gripper fingers.'
                    : language === 'vi'
                      ? 'Ngắt van khí nén (DO 1 = 0) để mở tay gắp.'
                      : 'Van DO 1 set to 0 (Low) to release gripper fingers.'}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </CenterModal>
  )
}
