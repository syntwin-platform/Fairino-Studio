interface ActiveCommandExecution {
  commandId: string
  controller: AbortController
}

let activeExecution: ActiveCommandExecution | null = null

export class CommandExecutionCancelledError extends Error {
  constructor(reason: string) {
    super(`Command execution cancelled: ${reason}`)
    this.name = 'CommandExecutionCancelledError'
  }
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

export function cancelActiveCommand(reason: string): boolean {
  if (!activeExecution || activeExecution.controller.signal.aborted) {
    return false
  }

  activeExecution.controller.abort(reason)
  return true
}

export function finishCommandExecution(commandId: string): void {
  if (activeExecution?.commandId === commandId) {
    activeExecution = null
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
