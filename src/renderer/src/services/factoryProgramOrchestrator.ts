import { useFactoryProgramStore } from '../store/factoryProgramStore'
import type { ValidatedLuaProgram } from '../types/factoryProgram.types'
import { importLuaProgramForRobot, type BackendLuaRequestContext } from './backendLuaImportClient'
import {
  enqueueRunProgram,
  publishRobotProgram,
  waitForRobotCommand,
  type BackendProgramContext
} from './backendProgramClient'

export interface FactoryProgramTarget {
  robotId: string
  robotName: string
}

function createRunId(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `factory_${Date.now()}`
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index])
    }
  })

  await Promise.all(workers)
  return results
}

export async function executeFactoryProgramV1(
  context: BackendProgramContext,
  program: ValidatedLuaProgram,
  targets: FactoryProgramTarget[],
  signal?: AbortSignal
): Promise<void> {
  if (targets.length === 0) {
    throw new Error('No robot was selected.')
  }

  if (program.raw.executionReady !== true) {
    throw new Error(
      `LUA program ${program.fileName} is not execution-ready. Import and validate it again before running it.`
    )
  }

  const store = useFactoryProgramStore.getState()
  const factoryRunId = createRunId()

  store.setBusy(true)
  store.setRunMetadata({
    factoryRunId,
    scheduledStartAtUtc: null,
    status: 'preparing',
    error: null
  })

  try {
    const prepared = await mapWithConcurrency(targets, 3, async (target) => {
      store.patchRobotState(target.robotId, {
        status: 'preparing',
        message: 'Importing LUA...'
      })

      try {
        const luaContext: BackendLuaRequestContext = {
          ...context,
          robotId: target.robotId
        }

        const imported = await importLuaProgramForRobot(
          luaContext,
          program.fileName,
          program.luaContent,
          signal
        )

        store.patchRobotState(target.robotId, {
          status: 'preparing',
          programId: imported.id,
          message: 'Publishing...'
        })

        await publishRobotProgram(context, target.robotId, imported.id, signal)

        store.patchRobotState(target.robotId, {
          status: 'prepared',
          programId: imported.id,
          message: 'Prepared'
        })

        return {
          target,
          programId: imported.id,
          error: null as string | null
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Program preparation failed'

        store.patchRobotState(target.robotId, {
          status: 'failed',
          message
        })

        return {
          target,
          programId: '',
          error: message
        }
      }
    })

    const preparationFailures = prepared.filter((item) => item.error)

    if (preparationFailures.length > 0) {
      throw new Error(
        `${preparationFailures.length} robot(s) failed during preparation. Nothing was started.`
      )
    }

    store.setRunMetadata({ status: 'starting' })

    const dispatched = await Promise.all(
      prepared.map(async ({ target, programId }) => {
        try {
          store.patchRobotState(target.robotId, {
            status: 'waiting-start',
            message: 'Dispatching RunProgram...'
          })

          const command = await enqueueRunProgram(
            context,
            target.robotId,
            programId,
            factoryRunId,
            signal
          )

          store.patchRobotState(target.robotId, {
            status: 'running',
            commandId: command.id,
            message: command.status
          })

          return { target, command, error: null as string | null }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'RunProgram dispatch failed'

          store.patchRobotState(target.robotId, {
            status: 'failed',
            message
          })

          return { target, command: null, error: message }
        }
      })
    )

    store.setRunMetadata({ status: 'running' })

    const dispatchedCommands = dispatched.filter(
      (
        item
      ): item is typeof item & {
        command: NonNullable<typeof item.command>
      } => item.command !== null
    )

    await Promise.all(
      dispatchedCommands.map(async ({ target, command }) => {
        try {
          const finalCommand = await waitForRobotCommand(
            context,
            target.robotId,
            command.id,
            signal
          )

          const completed = finalCommand.status === 'Completed'

          store.patchRobotState(target.robotId, {
            status: completed ? 'completed' : 'failed',
            message:
              finalCommand.result?.message ?? finalCommand.failureReason ?? finalCommand.status,
            completedAt: finalCommand.completedAt ?? new Date().toISOString()
          })
        } catch (error) {
          const aborted = signal?.aborted === true

          store.patchRobotState(target.robotId, {
            status: aborted ? 'cancelled' : 'failed',
            message: aborted
              ? 'Cancelled by user'
              : error instanceof Error
                ? error.message
                : 'Command monitoring failed'
          })
        }
      })
    )

    const latestStates = useFactoryProgramStore.getState().robotStates
    const hasFailure = targets.some(
      (target) => latestStates[target.robotId]?.status !== 'completed'
    )

    store.setRunMetadata({
      status: hasFailure ? 'failed' : 'completed',
      error: hasFailure ? 'One or more robots did not complete.' : null
    })
  } catch (error) {
    const aborted = signal?.aborted === true

    store.setRunMetadata({
      status: aborted ? 'cancelled' : 'failed',
      error: aborted
        ? 'Factory run was cancelled.'
        : error instanceof Error
          ? error.message
          : 'Factory run failed.'
    })

    throw error
  } finally {
    store.setBusy(false)
  }
}
