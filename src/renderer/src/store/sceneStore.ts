import { create } from 'zustand'
import type { RobotFaultState, RobotSafetyContactState } from '../types/robotFault.types'
import type { SceneObject, Transform3D } from '../types/scene.types'

interface SceneState {
  objects: SceneObject[]
  objectTransformRevisionById: Record<string, number>
  selectedObjectId: string | null
  robotFaultsById: Record<string, RobotFaultState>
  robotContactsById: Record<string, RobotSafetyContactState>
  isDebugHitbox: boolean

  // Actions
  addObject: (obj: Omit<SceneObject, 'id' | 'transform' | 'visible'>) => void
  removeObject: (id: string) => void
  updateObjectTransform: (id: string, transform: Partial<Transform3D>) => void
  updateObjectVisibility: (id: string, visible: boolean) => void
  setSelectedObjectId: (id: string | null) => void
  setRobotFault: (robotId: string, fault: RobotFaultState | null) => void
  setRobotContact: (robotId: string, contact: RobotSafetyContactState | null) => void
  resolveRobotCollision: (robotId: string) => void
  clearRobotSafetyState: (robotId: string) => void
  clearAllRobotSafetyState: () => void
  setDebugHitbox: (debug: boolean) => void
  clearScene: () => void
}

const DEFAULT_TRANSFORM: Transform3D = {
  x: 400, // Place 400mm in front of robot
  y: 0,
  z: 0,
  rx: 0,
  ry: 0,
  rz: 0,
  sx: 1,
  sy: 1,
  sz: 1
}

export const useSceneStore = create<SceneState>((set) => ({
  objects: [],
  objectTransformRevisionById: {},
  selectedObjectId: null,
  robotFaultsById: {},
  robotContactsById: {},
  isDebugHitbox: false,

  addObject: (obj) =>
    set((state) => {
      const newObj: SceneObject = {
        ...obj,
        id: `obj_${Date.now()}`,
        transform: { ...DEFAULT_TRANSFORM },
        visible: true
      }
      return {
        objects: [...state.objects, newObj],
        objectTransformRevisionById: {
          ...state.objectTransformRevisionById,
          [newObj.id]: 1
        },
        selectedObjectId: newObj.id
      }
    }),

  removeObject: (id) =>
    set((state) => {
      if (!state.objects.some((object) => object.id === id)) return state
      const objectTransformRevisionById = { ...state.objectTransformRevisionById }
      delete objectTransformRevisionById[id]
      return {
        objects: state.objects.filter((object) => object.id !== id),
        objectTransformRevisionById,
        selectedObjectId: state.selectedObjectId === id ? null : state.selectedObjectId
      }
    }),

  updateObjectTransform: (id, transform) =>
    set((state) => {
      const current = state.objects.find((object) => object.id === id)
      if (!current || isTransformPatchEqual(current.transform, transform)) return state
      return {
        objects: state.objects.map((object) =>
          object.id === id
            ? { ...object, transform: { ...object.transform, ...transform } }
            : object
        ),
        objectTransformRevisionById: {
          ...state.objectTransformRevisionById,
          [id]: (state.objectTransformRevisionById[id] ?? 0) + 1
        }
      }
    }),

  updateObjectVisibility: (id, visible) =>
    set((state) => {
      const current = state.objects.find((object) => object.id === id)
      if (!current || current.visible === visible) return state
      return {
        objects: state.objects.map((object) =>
          object.id === id ? { ...object, visible } : object
        ),
        objectTransformRevisionById: {
          ...state.objectTransformRevisionById,
          [id]: (state.objectTransformRevisionById[id] ?? 0) + 1
        }
      }
    }),

  setSelectedObjectId: (id) => set({ selectedObjectId: id }),

  setRobotFault: (robotId, fault) =>
    set((state) => {
      const normalizedRobotId = robotId.trim()
      if (!normalizedRobotId) return state

      const current = state.robotFaultsById[normalizedRobotId]
      if (current === fault || (!current && !fault)) return state

      const robotFaultsById = { ...state.robotFaultsById }
      if (fault) {
        robotFaultsById[normalizedRobotId] = fault
      } else {
        delete robotFaultsById[normalizedRobotId]
      }

      return { robotFaultsById }
    }),

  setRobotContact: (robotId, contact) =>
    set((state) => {
      const normalizedRobotId = robotId.trim()
      if (!normalizedRobotId) return state

      const current = state.robotContactsById[normalizedRobotId]
      if (current === contact || (!current && !contact)) return state

      const robotContactsById = { ...state.robotContactsById }
      if (contact) {
        robotContactsById[normalizedRobotId] = contact
      } else {
        delete robotContactsById[normalizedRobotId]
      }

      return { robotContactsById }
    }),

  resolveRobotCollision: (robotId) =>
    set((state) => {
      const normalizedRobotId = robotId.trim()
      if (!normalizedRobotId) return state

      const fault = state.robotFaultsById[normalizedRobotId]
      const shouldClearCollisionFault =
        fault?.active === true && fault.kind === 'collision' && fault.code.startsWith('COLLISION_')
      const hasContact = Boolean(state.robotContactsById[normalizedRobotId])
      if (!hasContact && !shouldClearCollisionFault) return state

      const robotContactsById = { ...state.robotContactsById }
      delete robotContactsById[normalizedRobotId]

      if (!shouldClearCollisionFault) return { robotContactsById }

      const robotFaultsById = { ...state.robotFaultsById }
      delete robotFaultsById[normalizedRobotId]
      return { robotContactsById, robotFaultsById }
    }),

  clearRobotSafetyState: (robotId) =>
    set((state) => {
      const normalizedRobotId = robotId.trim()
      if (!normalizedRobotId) return state

      const hadFault = Boolean(state.robotFaultsById[normalizedRobotId])
      const hadContact = Boolean(state.robotContactsById[normalizedRobotId])
      if (!hadFault && !hadContact) return state

      const robotFaultsById = { ...state.robotFaultsById }
      const robotContactsById = { ...state.robotContactsById }
      delete robotFaultsById[normalizedRobotId]
      delete robotContactsById[normalizedRobotId]

      return {
        robotFaultsById,
        robotContactsById
      }
    }),

  clearAllRobotSafetyState: () =>
    set({
      robotFaultsById: {},
      robotContactsById: {}
    }),

  setDebugHitbox: (debug) => set({ isDebugHitbox: debug }),

  clearScene: () =>
    set({
      objects: [],
      objectTransformRevisionById: {},
      selectedObjectId: null,
      robotContactsById: {},
      isDebugHitbox: false
    })
}))

function isTransformPatchEqual(current: Transform3D, patch: Partial<Transform3D>): boolean {
  return Object.entries(patch).every(([key, value]) => current[key as keyof Transform3D] === value)
}

export function selectCollisionWarning(state: SceneState): boolean {
  return Object.values(state.robotContactsById).some((contact) => contact.level === 'collision')
}

// Presentation-only selector: keep the alert visible after motion stops and live contact clears.
// Command/workflow guards must continue using selectCollisionWarning so their behavior is unchanged.
export function selectSafetyAlert(state: SceneState): boolean {
  return (
    Object.keys(state.robotContactsById).length > 0 ||
    Object.values(state.robotFaultsById).some(
      (fault) => fault.active && (fault.kind === 'collision' || fault.code.startsWith('COLLISION_'))
    )
  )
}
