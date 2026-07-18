import * as THREE from 'three'
import URDFLoader, { type URDFRobot } from 'urdf-loader'

type UrdfPackages = URDFLoader['packages']

interface UrdfLoaderLike {
  packages: UrdfPackages
  load: URDFLoader['load']
}

export interface LoadUrdfRobotOptions {
  url: string
  packages: UrdfPackages
  onParsed?: (robot: URDFRobot) => void
  onLoad: (robot: URDFRobot) => void
  onProgress?: Parameters<URDFLoader['load']>[2]
  onError?: Parameters<URDFLoader['load']>[3]
  createLoader?: (manager: THREE.LoadingManager) => UrdfLoaderLike
}

/**
 * URDFLoader calls its model callback after parsing the URDF, while referenced meshes can still
 * be loading. Collision and material caches must only see the robot after LoadingManager reports
 * that the URDF and every child asset have completed.
 */
export function loadUrdfRobotWhenAssetsReady(options: LoadUrdfRobotOptions): void {
  const manager = new THREE.LoadingManager()
  const loader = options.createLoader?.(manager) ?? new URDFLoader(manager)
  let parsedRobot: URDFRobot | null = null
  let assetsReady = false
  let completed = false

  const completeIfReady = (): void => {
    if (completed || !assetsReady || !parsedRobot) return
    completed = true
    options.onLoad(parsedRobot)
  }

  manager.onLoad = () => {
    assetsReady = true
    completeIfReady()
  }

  loader.packages = options.packages
  loader.load(
    options.url,
    (robot) => {
      options.onParsed?.(robot)
      parsedRobot = robot
      completeIfReady()
    },
    options.onProgress,
    options.onError
  )
}
