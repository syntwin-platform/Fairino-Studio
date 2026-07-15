import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'

import { ObstacleBoundsCache, RobotCollisionGeometryCache } from './collisionCache'
import { CollisionEngine } from './collisionEngine'
import type {
  CollisionContactTransition,
  CollisionRobotSnapshot,
  CollisionWorldSnapshot,
  RobotCollisionPolicy
} from './collisionTypes'
import { FAIRINO_FR5_COLLISION_POLICY } from './collisionTypes'

const TEST_POLICY: RobotCollisionPolicy = {
  thresholds: {
    groundWarningDistanceMeters: 0.08,
    selfWarningDistanceMeters: 0.08,
    robotWarningDistanceMeters: 0.08,
    obstacleWarningDistanceMeters: 0.08,
    confirmTicks: 1,
    clearTicks: 2,
    broadPhaseMarginMeters: 0.1,
    groundPenetrationToleranceMeters: 0.002
  },
  geometry: {
    selfCollisionPairs: [],
    groundIgnoredLinkPatterns: [],
    robotPairIgnoredLinkPatterns: []
  }
}

describe('CollisionEngine', () => {
  it('detects ground contact and clears it only after the configured clear ticks', () => {
    const robot = createRobot('robot-a', [['tool_link', [0, -0.04, 0]]])
    const transitions: CollisionContactTransition[] = []
    const world = createWorld([robot])
    const engine = createEngine(world, transitions)

    engine.tick()
    expect(transitions.at(-1)?.observation?.kind).toBe('ground')
    expect(transitions.at(-1)?.observation?.level).toBe('collision')

    robot.links.tool_link.position.y = 0.3
    robot.object.updateMatrixWorld(true)
    engine.tick()
    expect(transitions.at(-1)?.observation).not.toBeNull()
    engine.tick()
    expect(transitions.at(-1)).toEqual({
      robotId: 'robot-a',
      monitoringMode: 'factory-active',
      observation: null
    })
  })

  it('uses the real link mesh instead of subtracting a guessed TCP radius', () => {
    const robot = createRobot('robot-a', [['tool_link', [0, 0.06, 0]]])
    const transitions: CollisionContactTransition[] = []
    const engine = createEngine(createWorld([robot]), transitions)

    engine.tick()

    expect(transitions.at(-1)?.observation).toEqual(
      expect.objectContaining({ kind: 'ground', level: 'proximity' })
    )
    expect(transitions.at(-1)?.observation?.signature).toBe('ground:tool_link')
  })

  it('does not warn for a normal FR5 link clearance 37 mm above the ground', () => {
    const robot = createRobot('robot-a', [['wrist3_link', [0, 0.087, 0]]])
    const transitions: CollisionContactTransition[] = []
    const engine = createEngine(createWorld([robot]), transitions, FAIRINO_FR5_COLLISION_POLICY)

    engine.tick()

    expect(transitions).toEqual([])
  })

  it('does not use conservative self-link capsules as a proximity alarm', () => {
    const robot = createRobot('robot-a', [
      ['shoulder_link', [0, 0.3, 0]],
      ['forearm_link', [0.137, 0.3, 0]]
    ])
    const transitions: CollisionContactTransition[] = []
    const engine = createEngine(createWorld([robot]), transitions, FAIRINO_FR5_COLLISION_POLICY)

    engine.tick()

    expect(transitions).toEqual([])
  })

  it('detects configured self-collision pairs', () => {
    const policy: RobotCollisionPolicy = {
      ...TEST_POLICY,
      geometry: {
        ...TEST_POLICY.geometry,
        selfCollisionPairs: [{ a: 'left_link', b: 'right_link' }]
      }
    }
    const robot = createRobot('robot-a', [
      ['left_link', [0, 0.3, 0]],
      ['right_link', [0, 0.3, 0]]
    ])
    const transitions: CollisionContactTransition[] = []
    const engine = createEngine(createWorld([robot]), transitions, policy)

    engine.tick()

    expect(transitions.at(-1)?.observation?.kind).toBe('self')
  })

  it('emits proximity immediately without classifying it as a collision', () => {
    const robot = createRobot('robot-a', [['tool_link', [0, 0.11, 0]]])
    const transitions: CollisionContactTransition[] = []
    const engine = createEngine(createWorld([robot]), transitions)

    engine.tick()

    expect(transitions.at(-1)?.observation).toEqual(
      expect.objectContaining({ level: 'proximity', kind: 'ground' })
    )
  })

  it('requires consecutive confirmation ticks before emitting a collision', () => {
    const policy: RobotCollisionPolicy = {
      ...TEST_POLICY,
      thresholds: { ...TEST_POLICY.thresholds, confirmTicks: 3 }
    }
    const robot = createRobot('robot-a', [['tool_link', [0, -0.04, 0]]])
    const transitions: CollisionContactTransition[] = []
    const engine = createEngine(createWorld([robot]), transitions, policy)

    engine.tick()
    engine.tick()
    expect(transitions).toHaveLength(1)
    expect(transitions[0].observation?.level).toBe('proximity')
    engine.tick()
    expect(transitions.at(-1)?.observation?.level).toBe('collision')
  })

  it('confirms a robot-pair collision even when the intersecting link pair changes', () => {
    const policy: RobotCollisionPolicy = {
      ...TEST_POLICY,
      thresholds: { ...TEST_POLICY.thresholds, confirmTicks: 3 }
    }
    const left = createRobot('robot-a', [
      ['left_a', [0, 1, 0]],
      ['left_b', [5, 1, 0]]
    ])
    const right = createRobot('robot-b', [
      ['right_a', [0, 1, 0]],
      ['right_b', [10, 1, 0]]
    ])
    const transitions: CollisionContactTransition[] = []
    const engine = createEngine(createWorld([left, right]), transitions, policy)

    engine.tick()
    expect(
      transitions.filter((transition) => transition.observation?.level === 'proximity')
    ).toHaveLength(2)

    setLinkX(left, 'left_a', 20)
    setLinkX(left, 'left_b', 5)
    setLinkX(right, 'right_a', 30)
    setLinkX(right, 'right_b', 5)
    engine.tick()

    setLinkX(left, 'left_a', 0)
    setLinkX(left, 'left_b', 5)
    setLinkX(right, 'right_a', 0)
    setLinkX(right, 'right_b', 10)
    engine.tick()

    expect(
      transitions.filter((transition) => transition.observation?.level === 'collision')
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ robotId: 'robot-a' }),
        expect.objectContaining({ robotId: 'robot-b' })
      ])
    )
  })

  it('detects obstacle contact and invalidates obstacle bounds by transform revision', () => {
    const robot = createRobot('robot-a', [['tool_link', [0, 0.3, 0]]])
    const obstacle = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1))
    obstacle.position.set(0, 0.3, 0)
    obstacle.updateMatrixWorld(true)
    const world: CollisionWorldSnapshot = {
      robots: [robot],
      obstacles: [
        {
          objectId: 'obstacle-a',
          object: obstacle,
          visible: true,
          transformRevision: 1
        }
      ]
    }
    const transitions: CollisionContactTransition[] = []
    const engine = createEngine(world, transitions)

    engine.tick()
    expect(transitions.at(-1)?.observation?.kind).toBe('obstacle')

    obstacle.position.x = 2
    obstacle.updateMatrixWorld(true)
    world.obstacles[0].transformRevision += 1
    engine.tick()
    engine.tick()
    expect(transitions.at(-1)?.observation).toBeNull()
  })

  it('emits symmetric robot-robot collision observations', () => {
    const left = createRobot('robot-a', [['tool_link', [0, 0.3, 0]]])
    const right = createRobot('robot-b', [['tool_link', [0, 0.3, 0]]])
    const transitions: CollisionContactTransition[] = []
    const engine = createEngine(createWorld([left, right]), transitions)

    engine.tick()

    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          robotId: 'robot-a',
          observation: expect.objectContaining({ kind: 'robot', counterpartRobotIds: ['robot-b'] })
        }),
        expect.objectContaining({
          robotId: 'robot-b',
          observation: expect.objectContaining({ kind: 'robot', counterpartRobotIds: ['robot-a'] })
        })
      ])
    )
  })

  it('does not promote overlapping link bounding boxes to a mesh collision', () => {
    const left = createSparseRobot('robot-a')
    const right = createRobot('robot-b', [['tool_link', [0, 0.3, 0]]])
    const transitions: CollisionContactTransition[] = []
    expect(
      new RobotCollisionGeometryCache().intersectsLinkPairExact(
        left,
        'sparse_link',
        right,
        'tool_link'
      )
    ).toBe(false)
    const engine = createEngine(createWorld([left, right]), transitions)

    engine.tick()

    expect(
      transitions.filter((transition) => transition.observation?.level === 'collision')
    ).toEqual([])
  })

  it('continues narrow-phase monitoring while an online robot is unchanged', () => {
    const robot = createRobot('robot-a', [['tool_link', [0, 0.3, 0]]])
    const engine = createEngine(createWorld([robot]), [])

    expect(engine.tick().narrowPhaseRobotCount).toBe(1)
    expect(engine.tick().narrowPhaseRobotCount).toBe(1)
  })

  it('monitors a Training robot even when it is offline', () => {
    const robot = createRobot('robot-a', [['tool_link', [0, -0.04, 0]]])
    robot.monitoringMode = 'training-preview'
    const transitions: CollisionContactTransition[] = []
    const engine = createEngine(createWorld([robot]), transitions)

    expect(engine.tick().evaluatedRobotCount).toBe(1)
    expect(transitions.at(-1)?.monitoringMode).toBe('training-preview')
    expect(transitions.at(-1)?.observation?.level).toBe('collision')
  })

  it('monitors a Factory offline robot for UI warnings without changing its monitoring mode', () => {
    const robot = createRobot('robot-a', [['tool_link', [0, -0.04, 0]]])
    robot.monitoringMode = 'factory-static'
    const transitions: CollisionContactTransition[] = []
    const engine = createEngine(createWorld([robot]), transitions)

    expect(engine.tick().evaluatedRobotCount).toBe(1)
    expect(transitions.at(-1)?.monitoringMode).toBe('factory-static')
    expect(transitions.at(-1)?.observation?.level).toBe('collision')
  })

  it('keeps contact state when a robot is temporarily absent from one snapshot', () => {
    const robot = createRobot('robot-a', [['tool_link', [0, -0.04, 0]]])
    const transitions: CollisionContactTransition[] = []
    const world = createWorld([robot])
    const engine = createEngine(world, transitions)

    engine.tick()
    expect(transitions.at(-1)?.observation?.level).toBe('collision')

    world.robots = []
    engine.tick()

    expect(transitions.at(-1)?.observation?.level).toBe('collision')

    engine.removeRobot('robot-a')
    expect(transitions.at(-1)?.observation).toBeNull()
  })

  it('clears emitted contacts when the engine is disposed', () => {
    const robot = createRobot('robot-a', [['tool_link', [0, -0.04, 0]]])
    const transitions: CollisionContactTransition[] = []
    const engine = createEngine(createWorld([robot]), transitions)

    engine.tick()
    engine.dispose()

    expect(transitions.at(-1)).toEqual({
      robotId: 'robot-a',
      monitoringMode: 'factory-active',
      observation: null
    })
  })

  it('does not publish semantic contact clears during an internal scene teardown', () => {
    const robot = createRobot('robot-a', [['tool_link', [0, -0.04, 0]]])
    const transitions: CollisionContactTransition[] = []
    const engine = createEngine(createWorld([robot]), transitions)

    engine.tick()
    engine.dispose({ emitClearTransitions: false })

    expect(transitions).toHaveLength(1)
    expect(transitions[0].observation?.level).toBe('collision')
  })
})

describe('ObstacleBoundsCache', () => {
  it('reuses bounds until the transform revision changes', () => {
    const object = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    object.updateMatrixWorld(true)
    const obstacle = { objectId: 'object-a', object, visible: true, transformRevision: 1 }
    const cache = new ObstacleBoundsCache()

    expect(cache.sync([obstacle]).changed).toBe(true)
    expect(cache.sync([obstacle]).changed).toBe(false)

    object.position.x = 4
    object.updateMatrixWorld(true)
    expect(cache.sync([obstacle]).changed).toBe(false)
    obstacle.transformRevision += 1
    expect(cache.sync([obstacle]).changed).toBe(true)
  })
})

function createEngine(
  world: CollisionWorldSnapshot,
  transitions: CollisionContactTransition[],
  policy = TEST_POLICY
): CollisionEngine {
  return new CollisionEngine({
    getSnapshot: () => world,
    getRobotPolicy: () => policy,
    onContactTransition: (transition) => transitions.push(transition),
    now: vi.fn(() => 0)
  })
}

function createWorld(robots: CollisionRobotSnapshot[]): CollisionWorldSnapshot {
  return { robots, obstacles: [] }
}

function createRobot(
  robotId: string,
  links: Array<[string, [number, number, number]]>
): CollisionRobotSnapshot {
  const object = new THREE.Group()
  const linkObjects: Record<string, THREE.Object3D> = {}
  for (const [linkName, position] of links) {
    const link = new THREE.Group()
    link.name = linkName
    link.position.set(...position)
    link.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1)))
    object.add(link)
    linkObjects[linkName] = link
  }
  object.updateMatrixWorld(true)
  return {
    robotId,
    object,
    links: linkObjects,
    visible: true,
    monitoringMode: 'factory-active'
  }
}

function createSparseRobot(robotId: string): CollisionRobotSnapshot {
  const robot = createRobot(robotId, [['sparse_link', [0, 0.3, 0]]])
  const link = robot.links.sparse_link
  link.clear()
  const leftMesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1))
  const rightMesh = leftMesh.clone()
  leftMesh.position.x = -0.2
  rightMesh.position.x = 0.2
  link.add(leftMesh, rightMesh)
  robot.object.updateMatrixWorld(true)
  return robot
}

function setLinkX(robot: CollisionRobotSnapshot, linkName: string, x: number): void {
  robot.links[linkName].position.x = x
  robot.object.updateMatrixWorld(true)
}
