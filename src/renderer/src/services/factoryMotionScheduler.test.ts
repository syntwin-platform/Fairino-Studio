import { describe, expect, it } from 'vitest'
import { calculateFrameStallCompensation, sampleJointTrajectory } from './factoryMotionScheduler'
import type { JointAngles } from '../types/robot.types'

describe('calculateFrameStallCompensation', () => {
  it('does not compensate normal animation frames', () => {
    expect(calculateFrameStallCompensation(16)).toBe(0)
    expect(calculateFrameStallCompensation(33)).toBe(0)
    expect(calculateFrameStallCompensation(100)).toBe(0)
  })

  it('freezes the excess duration of a long renderer stall', () => {
    const compensation = calculateFrameStallCompensation(556)

    expect(compensation).toBeCloseTo(556 - 1000 / 60, 5)
  })

  it('rejects invalid frame deltas', () => {
    expect(calculateFrameStallCompensation(Number.NaN)).toBe(0)
    expect(calculateFrameStallCompensation(Number.POSITIVE_INFINITY)).toBe(0)
    expect(calculateFrameStallCompensation(-10)).toBe(0)
  })
})

describe('sampleJointTrajectory', () => {
  const start: JointAngles = [0, 0, 0, 0, 0, 0]
  const middle: JointAngles = [10, 20, 30, 40, 50, 60]
  const end: JointAngles = [20, 40, 60, 80, 100, 120]

  it('returns exact trajectory endpoints and middle keyframe', () => {
    expect(sampleJointTrajectory([start, middle, end], 0)).toEqual(start)
    expect(sampleJointTrajectory([start, middle, end], 0.5)).toEqual(middle)
    expect(sampleJointTrajectory([start, middle, end], 1)).toEqual(end)
  })

  it('interpolates between adjacent trajectory keyframes', () => {
    expect(sampleJointTrajectory([start, middle, end], 0.25)).toEqual([5, 10, 15, 20, 25, 30])

    expect(sampleJointTrajectory([start, middle, end], 0.75)).toEqual([15, 30, 45, 60, 75, 90])
  })

  it('clamps progress outside the valid range', () => {
    expect(sampleJointTrajectory([start, middle, end], -1)).toEqual(start)
    expect(sampleJointTrajectory([start, middle, end], 2)).toEqual(end)
  })

  it('rejects an empty trajectory', () => {
    expect(() => sampleJointTrajectory([], 0.5)).toThrow(/requires at least one keyframe/i)
  })
})
