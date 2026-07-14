interface ActiveCommandExecution {
  commandId: string
  executionGroupId?: string
  controller: AbortController
}

let activeExecution: ActiveCommandExecution | null = null
const activeExecutionsByRobotId = new Map<string, ActiveCommandExecution>()

export class CommandExecutionCancelledError extends Error {
  constructor(reason: string) {
    super(`Command execution cancelled: ${reason}`)
    this.name = 'CommandExecutionCancelledError'
  }
}

function normalizeRobotId(robotId: string): string {
  return robotId.trim()
}

export function beginCommandExecution(commandId: string): AbortSignal {
  if (activeExecution && !activeExecution.controller.signal.aborted) {
    throw new Error(`Command ${activeExecution.commandId} is already executing`)
  }

  const controller = new AbortController()

  activeExecution = {
    commandId,
    controller
  }

  return controller.signal
}

export function beginCommandExecutionForRobot(
  robotId: string,
  commandId: string,
  executionGroupId?: string
): AbortSignal {
  const normalizedRobotId = normalizeRobotId(robotId)

  if (!normalizedRobotId) {
    return beginCommandExecution(commandId)
  }

  const activeRobotExecution = activeExecutionsByRobotId.get(normalizedRobotId)

  if (activeRobotExecution && !activeRobotExecution.controller.signal.aborted) {
    throw new Error(
      `Command ${activeRobotExecution.commandId} is already executing for robot ${normalizedRobotId}`
    )
  }

  const controller = new AbortController()

  activeExecutionsByRobotId.set(normalizedRobotId, {
    commandId,
    executionGroupId: executionGroupId?.trim() || undefined,
    controller
  })

  return controller.signal
}

export function cancelActiveCommand(reason: string): boolean {
  if (!activeExecution || activeExecution.controller.signal.aborted) {
    return false
  }

  activeExecution.controller.abort(reason)
  return true
}

export function cancelActiveCommandForRobot(robotId: string, reason: string): boolean {
  const normalizedRobotId = normalizeRobotId(robotId)

  if (!normalizedRobotId) {
    return cancelActiveCommand(reason)
  }

  const activeRobotExecution = activeExecutionsByRobotId.get(normalizedRobotId)

  if (!activeRobotExecution || activeRobotExecution.controller.signal.aborted) {
    return false
  }

  activeRobotExecution.controller.abort(reason)
  return true
}

export function cancelAllActiveCommands(reason: string): void {
  cancelActiveCommand(reason)

  for (const execution of activeExecutionsByRobotId.values()) {
    if (!execution.controller.signal.aborted) {
      execution.controller.abort(reason)
    }
  }
}

export function cancelActiveCommandsForGroup(executionGroupId: string, reason: string): number {
  const normalizedGroupId = executionGroupId.trim()

  if (!normalizedGroupId) {
    return 0
  }

  let cancelledCount = 0

  for (const execution of activeExecutionsByRobotId.values()) {
    if (execution.executionGroupId === normalizedGroupId && !execution.controller.signal.aborted) {
      execution.controller.abort(reason)
      cancelledCount += 1
    }
  }

  return cancelledCount
}

export function finishCommandExecution(commandId: string): void {
  if (activeExecution?.commandId === commandId) {
    activeExecution = null
  }
}

export function finishCommandExecutionForRobot(robotId: string, commandId: string): void {
  const normalizedRobotId = normalizeRobotId(robotId)

  if (!normalizedRobotId) {
    finishCommandExecution(commandId)
    return
  }

  const activeRobotExecution = activeExecutionsByRobotId.get(normalizedRobotId)

  if (activeRobotExecution?.commandId === commandId) {
    activeExecutionsByRobotId.delete(normalizedRobotId)
  }
}

export function throwIfCommandCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return

  const reason = typeof signal.reason === 'string' ? signal.reason : 'Cancellation requested'

  throw new CommandExecutionCancelledError(reason)
}

export function getActiveCommandId(): string | null {
  return activeExecution?.commandId ?? null
}

export function getActiveCommandIdForRobot(robotId: string): string | null {
  const normalizedRobotId = normalizeRobotId(robotId)

  if (!normalizedRobotId) {
    return getActiveCommandId()
  }

  return activeExecutionsByRobotId.get(normalizedRobotId)?.commandId ?? null
}
