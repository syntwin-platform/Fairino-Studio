import * as THREE from 'three'
import type { URDFRobot } from 'urdf-loader'
import { describe, expect, it, vi } from 'vitest'

import { loadUrdfRobotWhenAssetsReady } from './urdfRobotLoader'

describe('loadUrdfRobotWhenAssetsReady', () => {
  it('does not publish the robot until every child mesh has finished loading', () => {
    const robot = new THREE.Group() as unknown as URDFRobot
    const onParsed = vi.fn()
    const onLoad = vi.fn()
    const meshLoad = {
      finish: (): void => {
        throw new Error('Mesh completion callback was not registered.')
      }
    }

    loadUrdfRobotWhenAssetsReady({
      url: '/robot.urdf',
      packages: { fairino_description: '/fairino_description' },
      onParsed,
      onLoad,
      createLoader: (manager) => ({
        packages: '',
        load: (_url, handleRobot) => {
          manager.itemStart('/robot.urdf')
          manager.itemStart('/mesh.stl')
          handleRobot(robot)
          manager.itemEnd('/robot.urdf')
          meshLoad.finish = () => manager.itemEnd('/mesh.stl')
        }
      })
    })

    expect(onParsed).toHaveBeenCalledOnce()
    expect(onParsed).toHaveBeenCalledWith(robot)
    expect(onLoad).not.toHaveBeenCalled()
    meshLoad.finish()
    expect(onLoad).toHaveBeenCalledOnce()
    expect(onLoad).toHaveBeenCalledWith(robot)
  })

  it('also handles an asset-ready signal that arrives before the parsed robot callback', () => {
    const robot = new THREE.Group() as unknown as URDFRobot
    const onLoad = vi.fn()

    loadUrdfRobotWhenAssetsReady({
      url: '/robot.urdf',
      packages: '',
      onLoad,
      createLoader: (manager) => ({
        packages: '',
        load: (_url, handleRobot) => {
          manager.itemStart('/robot.urdf')
          manager.itemEnd('/robot.urdf')
          expect(onLoad).not.toHaveBeenCalled()
          handleRobot(robot)
        }
      })
    })

    expect(onLoad).toHaveBeenCalledOnce()
    expect(onLoad).toHaveBeenCalledWith(robot)
  })
})
