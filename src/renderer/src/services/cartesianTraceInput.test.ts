import { describe, expect, it } from 'vitest'
import {
  hasCartesianTraceWristInput,
  isCartesianTraceControlKey,
  resolveCartesianTraceInput
} from './cartesianTraceInput'

describe('cartesianTraceInput', () => {
  it('maps WASD, arrows and QE to wrist directions', () => {
    expect(resolveCartesianTraceInput(new Set(['w', 'arrowright', 'q']))).toMatchObject({
      j4Direction: -1,
      j5Direction: 1,
      j6Direction: -1
    })
  })

  it('maps W and Up to FR5 J4 up, S and Down to FR5 J4 down', () => {
    expect(resolveCartesianTraceInput(new Set(['w'])).j4Direction).toBe(-1)
    expect(resolveCartesianTraceInput(new Set(['arrowup'])).j4Direction).toBe(-1)
    expect(resolveCartesianTraceInput(new Set(['s'])).j4Direction).toBe(1)
    expect(resolveCartesianTraceInput(new Set(['arrowdown'])).j4Direction).toBe(1)
  })

  it('cancels opposite directions', () => {
    const input = resolveCartesianTraceInput(new Set(['w', 's', 'a', 'd', 'q', 'e']))
    expect(hasCartesianTraceWristInput(input)).toBe(false)
  })

  it('uses precision when Control and Shift are both held', () => {
    expect(resolveCartesianTraceInput(new Set(['shift']))).toMatchObject({
      speedMode: 'fast',
      pointerGain: 2,
      wristDegreesPerSecond: 80
    })
    expect(resolveCartesianTraceInput(new Set(['shift', 'control']))).toMatchObject({
      speedMode: 'precision',
      pointerGain: 0.25,
      wristDegreesPerSecond: 10
    })
  })

  it('recognizes trace controls without claiming unrelated shortcuts', () => {
    expect(isCartesianTraceControlKey('ArrowUp')).toBe(true)
    expect(isCartesianTraceControlKey('e')).toBe(true)
    expect(isCartesianTraceControlKey('1')).toBe(false)
    expect(isCartesianTraceControlKey('Escape')).toBe(false)
  })
})
