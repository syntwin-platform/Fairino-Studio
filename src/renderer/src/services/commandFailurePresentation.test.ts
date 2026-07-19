import { describe, expect, it } from 'vitest'

import { buildCommandFailurePresentation } from './commandFailurePresentation'

describe('buildCommandFailurePresentation', () => {
  it('turns a raw trace error into an actionable message', () => {
    const result = buildCommandFailurePresentation(
      'Execution: Robot 24eccb17-2c28-4495-bf90-b7581b475be7 motion blocked: ' +
        'Trace trace-a must start at sample 0, received 1'
    )

    expect(result.code).toBe('TRACE_INCOMPLETE')
    expect(result.title).toBe('Quỹ đạo ghi lại không đầy đủ')
    expect(result.detail).toContain('điểm 1')
    expect(result.technicalDetail).toContain('trace-a')
  })

  it('does not offer a command reset as an emergency-stop reset', () => {
    const result = buildCommandFailurePresentation(
      'Global emergency stop requested by command 123.'
    )

    expect(result.code).toBe('EMERGENCY_STOP')
    expect(result.suggestion).toContain('reset E-Stop riêng')
  })
})
