/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node-only URDF DOM shim. */
import fs from 'node:fs'
import path from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import URDFLoader from 'urdf-loader'
import { beforeAll, describe, expect, it } from 'vitest'

import { CollisionEngine } from './collisionEngine'
import { FAIRINO_FR5_COLLISION_POLICY } from './collisionTypes'

const MODEL_ALIGNMENT = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0))

describe('Fairino FR5 collision regression', () => {
  beforeAll(() => installDomForUrdfLoader())

  it('does not emit a false collision in the home pose', () => {
    const robot = loadFairinoRobot([0, -58.5, 93.6, -149.6, -90.2, 0])
    const transitions = []
    const engine = createEngine([createSnapshot('fr5', robot, 'training-preview')], transitions)

    engine.tick()
    engine.tick()
    engine.tick()

    expect(transitions).toEqual([])
  })

  it('detects the reported near-ground pose while Training is offline', () => {
    const robot = loadFairinoRobot([0, -31.3, 93.6, -149.6, -90.2, 0])
    const transitions = []
    const engine = createEngine([createSnapshot('fr5', robot, 'training-preview')], transitions)

    engine.tick()
    engine.tick()
    engine.tick()

    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          monitoringMode: 'training-preview',
          observation: expect.objectContaining({ level: 'collision', kind: 'ground' })
        })
      ])
    )
  })

  it('detects the ground penetration pose reported from the ready preview viewport', () => {
    const robot = loadFairinoRobot([0, -13.8, 93.6, -149.6, -90.2, 0])
    const transitions = []
    const engine = createEngine([createSnapshot('fr5', robot, 'training-preview')], transitions)

    const result = engine.tick()

    expect(result.evaluatedRobotCount).toBe(1)
    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          monitoringMode: 'training-preview',
          observation: expect.objectContaining({ level: 'collision', kind: 'ground' })
        })
      ])
    )
  })

  it('detects the below-ground startup pose before login or backend connection', () => {
    const robot = loadFairinoRobot([0, 22.6, 93.6, -149.6, -90.2, 0])
    const transitions = []
    const engine = createEngine([createSnapshot('fr5', robot, 'training-preview')], transitions)

    engine.tick()
    engine.tick()
    engine.tick()

    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          monitoringMode: 'training-preview',
          observation: expect.objectContaining({ level: 'collision', kind: 'ground' })
        })
      ])
    )
  })

  it('detects ground penetration while Training is offline', () => {
    const robot = loadFairinoRobot([0, -58.5, 93.6, -149.6, -90.2, 0])
    robot.position.y = -0.4
    robot.updateMatrixWorld(true)
    const transitions = []
    const engine = createEngine([createSnapshot('fr5', robot, 'training-preview')], transitions)

    engine.tick()
    engine.tick()
    engine.tick()

    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          monitoringMode: 'training-preview',
          observation: expect.objectContaining({ level: 'collision', kind: 'ground' })
        })
      ])
    )
  })

  it('detects two FR5 meshes occupying the same Factory position', () => {
    const left = loadFairinoRobot([0, -58.5, 93.6, -149.6, -90.2, 0])
    const right = loadFairinoRobot([0, -58.5, 93.6, -149.6, -90.2, 0])
    const transitions = []
    const engine = createEngine(
      [
        createSnapshot('left', left, 'factory-active'),
        createSnapshot('right', right, 'factory-active')
      ],
      transitions
    )

    engine.tick()
    engine.tick()
    engine.tick()

    expect(transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          robotId: 'left',
          observation: expect.objectContaining({ level: 'collision', kind: 'robot' })
        }),
        expect.objectContaining({
          robotId: 'right',
          observation: expect.objectContaining({ level: 'collision', kind: 'robot' })
        })
      ])
    )
  })

  it('does not report warnings for six separated Factory robots while their poses change', () => {
    const robots = Array.from({ length: 6 }, (_, index) => {
      const robot = loadFairinoRobot([0, -58.5, 93.6, -149.6, -90.2, 0])
      robot.position.x = index * 2
      robot.updateMatrixWorld(true)
      return createSnapshot(`fr5-${index + 1}`, robot, 'factory-active')
    })
    const transitions = []
    const engine = createEngine(robots, transitions)

    for (let tick = 0; tick < 12; tick += 1) {
      for (const snapshot of robots) {
        snapshot.object.joints.j1.setJointValue(THREE.MathUtils.degToRad(tick * 0.25))
        snapshot.object.updateMatrixWorld(true)
      }
      engine.tick()
    }

    expect(transitions).toEqual([])
  })
})

function createEngine(robots, transitions, policy = FAIRINO_FR5_COLLISION_POLICY) {
  const engine = new CollisionEngine({
    getSnapshot: () => ({ robots, obstacles: [] }),
    getRobotPolicy: () => policy,
    onContactTransition: (transition) => transitions.push(transition)
  })
  while (!engine.prewarmExactGeometry(100)) {
    // The browser performs this work in idle chunks; regression tests prepare synchronously.
  }
  return engine
}

function createSnapshot(robotId, robot, monitoringMode) {
  return {
    robotId,
    object: robot,
    links: robot.links,
    visible: true,
    monitoringMode
  }
}

function loadFairinoRobot(angles) {
  const modelRoot = path.resolve('src/renderer/public/fairino_description')
  const loader = new URDFLoader()
  loader.packages = { fairino_description: modelRoot }
  loader.loadMeshCb = (meshPath, _manager, done) => {
    const data = fs.readFileSync(path.normalize(meshPath))
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    done(new THREE.Mesh(new STLLoader().parse(buffer), new THREE.MeshBasicMaterial()))
  }

  const robot = loader.parse(fs.readFileSync(path.join(modelRoot, 'urdf/fairino5_v6.urdf'), 'utf8'))
  angles.forEach((angle, index) => {
    robot.joints[`j${index + 1}`].setJointValue(THREE.MathUtils.degToRad(angle))
  })
  robot.quaternion.copy(MODEL_ALIGNMENT)
  robot.updateMatrixWorld(true)
  return robot
}

function installDomForUrdfLoader() {
  const document = new DOMParser().parseFromString('<root/>', 'text/xml')
  const ElementConstructor = document.documentElement.constructor
  const DocumentConstructor = document.constructor
  const children = {
    get() {
      return Array.from(this.childNodes ?? []).filter((node) => node.nodeType === 1)
    }
  }

  Object.defineProperty(ElementConstructor.prototype, 'children', children)
  Object.defineProperty(DocumentConstructor.prototype, 'children', children)
  ElementConstructor.prototype.querySelector = function (selector) {
    const match = selector.match(/^([^[]+)\[([^=]+)="([^"]+)"\]$/)
    if (!match) return null

    const [, tag, attribute, value] = match
    let result = null
    const visit = (node) => {
      for (const child of node.children ?? []) {
        if (child.nodeName === tag && child.getAttribute(attribute) === value) {
          result = child
          return
        }
        visit(child)
        if (result) return
      }
    }
    visit(this)
    return result
  }

  globalThis.DOMParser = DOMParser
  globalThis.Document = DocumentConstructor
  globalThis.Element = ElementConstructor
}
