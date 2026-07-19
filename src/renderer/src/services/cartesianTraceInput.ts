export type CartesianTraceSpeedMode = 'precision' | 'normal' | 'fast'

export interface CartesianTraceInputState {
  j4Direction: number
  j5Direction: number
  j6Direction: number
  pointerGain: number
  wristDegreesPerSecond: number
  speedMode: CartesianTraceSpeedMode
}

const TRACE_CONTROL_KEYS = new Set([
  'w',
  'a',
  's',
  'd',
  'q',
  'e',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'shift',
  'control'
])

const TRACE_SPEED = {
  precision: { pointerGain: 0.25, wristDegreesPerSecond: 10 },
  normal: { pointerGain: 1, wristDegreesPerSecond: 35 },
  fast: { pointerGain: 2, wristDegreesPerSecond: 80 }
} as const

function direction(positive: boolean, negative: boolean): number {
  return Number(positive) - Number(negative)
}

export function isCartesianTraceControlKey(key: string): boolean {
  return TRACE_CONTROL_KEYS.has(key.toLowerCase())
}

export function resolveCartesianTraceInput(
  pressedKeys: ReadonlySet<string>
): CartesianTraceInputState {
  // Precision wins when both modifiers are held. This is the safer and more predictable fallback.
  const speedMode: CartesianTraceSpeedMode = pressedKeys.has('control')
    ? 'precision'
    : pressedKeys.has('shift')
      ? 'fast'
      : 'normal'
  const speed = TRACE_SPEED[speedMode]

  return {
    // FR5's J4 axis is opposite to the operator-facing up/down convention:
    // decreasing J4 raises the wrist, increasing J4 lowers it.
    j4Direction: direction(
      pressedKeys.has('s') || pressedKeys.has('arrowdown'),
      pressedKeys.has('w') || pressedKeys.has('arrowup')
    ),
    j5Direction: direction(
      pressedKeys.has('d') || pressedKeys.has('arrowright'),
      pressedKeys.has('a') || pressedKeys.has('arrowleft')
    ),
    j6Direction: direction(pressedKeys.has('e'), pressedKeys.has('q')),
    pointerGain: speed.pointerGain,
    wristDegreesPerSecond: speed.wristDegreesPerSecond,
    speedMode
  }
}

export function hasCartesianTraceWristInput(input: CartesianTraceInputState): boolean {
  return input.j4Direction !== 0 || input.j5Direction !== 0 || input.j6Direction !== 0
}
