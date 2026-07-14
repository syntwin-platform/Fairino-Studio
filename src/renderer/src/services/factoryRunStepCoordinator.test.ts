import { describe, expect, it } from 'vitest'
import { FactoryRunStepCoordinator, FactoryRunStepSkewError } from './factoryRunStepCoordinator'

function createSealedCoordinator(now: () => number): FactoryRunStepCoordinator {
  const coordinator = new FactoryRunStepCoordinator({
    now,
    maxCompletionSkewMs: 50,
    barrierTimeoutMs: 2000
  })

  coordinator.registerParticipant('run-1', 'robot-1')
  coordinator.registerParticipant('run-1', 'robot-2')
  coordinator.sealParticipants('run-1')

  return coordinator
}

describe('FactoryRunStepCoordinator', () => {
  it('releases every participant with the same next-step epoch', async () => {
    let currentTime = 1100
    const coordinator = createSealedCoordinator(() => currentTime)

    const robot1 = coordinator.arriveAtStep({
      factoryRunId: 'run-1',
      participantId: 'robot-1',
      stepIndex: 0,
      completedAtMonotonicMs: 1088
    })

    currentTime = 1102

    const robot2 = coordinator.arriveAtStep({
      factoryRunId: 'run-1',
      participantId: 'robot-2',
      stepIndex: 0,
      completedAtMonotonicMs: 1090
    })

    const [result1, result2] = await Promise.all([robot1, robot2])

    expect(result1).toEqual(result2)
    expect(result1.participantCount).toBe(2)
    expect(result1.completionSkewMs).toBe(2)
    expect(result1.nextStepStartedAtMonotonicMs).toBe(1102)
  })

  it('does not fail when the whole cohort is delayed by 556 ms', async () => {
    const currentTime = 2090
    const coordinator = createSealedCoordinator(() => currentTime)

    const robot1 = coordinator.arriveAtStep({
      factoryRunId: 'run-1',
      participantId: 'robot-1',
      stepIndex: 0,
      completedAtMonotonicMs: 2088
    })

    const robot2 = coordinator.arriveAtStep({
      factoryRunId: 'run-1',
      participantId: 'robot-2',
      stepIndex: 0,
      completedAtMonotonicMs: 2090
    })

    const results = await Promise.all([robot1, robot2])

    expect(results[0].completionSkewMs).toBe(2)
    expect(results[1].completionSkewMs).toBe(2)
  })

  it('fails the whole cohort when one robot is actually late', async () => {
    const coordinator = createSealedCoordinator(() => 1200)

    const robot1 = coordinator.arriveAtStep({
      factoryRunId: 'run-1',
      participantId: 'robot-1',
      stepIndex: 0,
      completedAtMonotonicMs: 1100
    })

    const robot2 = coordinator.arriveAtStep({
      factoryRunId: 'run-1',
      participantId: 'robot-2',
      stepIndex: 0,
      completedAtMonotonicMs: 1180
    })

    const results = await Promise.allSettled([robot1, robot2])

    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('rejected')

    if (results[0].status === 'rejected') {
      expect(results[0].reason).toBeInstanceOf(FactoryRunStepSkewError)
    }

    if (results[1].status === 'rejected') {
      expect(results[1].reason).toBeInstanceOf(FactoryRunStepSkewError)
    }
  })

  it('enforces step order', async () => {
    const coordinator = createSealedCoordinator(() => 1000)

    expect(() =>
      coordinator.arriveAtStep({
        factoryRunId: 'run-1',
        participantId: 'robot-1',
        stepIndex: 1,
        completedAtMonotonicMs: 1000
      })
    ).toThrow(/expected step 1/i)
  })

  it('drops one failed participant and releases only the surviving synchronized cohort', async () => {
    let currentTime = 1000
    const coordinator = new FactoryRunStepCoordinator({
      now: () => currentTime,
      maxCompletionSkewMs: 50,
      barrierTimeoutMs: 2000
    })

    for (let index = 1; index <= 6; index += 1) {
      coordinator.registerParticipant('run-1', `robot-${index}`)
    }
    coordinator.sealParticipants('run-1')

    const stepOneSurvivors = Array.from({ length: 5 }, (_, index) =>
      coordinator.arriveAtStep({
        factoryRunId: 'run-1',
        participantId: `robot-${index + 1}`,
        stepIndex: 0,
        completedAtMonotonicMs: 990 + index
      })
    )

    currentTime = 1005
    const activeParticipantCount = coordinator.dropParticipant(
      'run-1',
      'robot-6',
      new Error('robot-6 failed')
    )
    const stepOneResults = await Promise.all(stepOneSurvivors)

    expect(activeParticipantCount).toBe(5)
    expect(stepOneResults.every((result) => result.participantCount === 5)).toBe(true)

    const stepTwoSurvivors = Array.from({ length: 5 }, (_, index) =>
      coordinator.arriveAtStep({
        factoryRunId: 'run-1',
        participantId: `robot-${index + 1}`,
        stepIndex: 1,
        completedAtMonotonicMs: 1100 + index
      })
    )

    const stepTwoResults = await Promise.all(stepTwoSurvivors)
    expect(stepTwoResults.every((result) => result.participantCount === 5)).toBe(true)
  })
})
