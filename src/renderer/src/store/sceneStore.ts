import { create } from 'zustand'
import type { RobotFaultState, RobotSafetyContactState } from '../types/robotFault.types'
import type { SceneObject, Transform3D } from '../types/scene.types'

interface SceneState {
  objects: SceneObject[]
  selectedObjectId: string | null
  robotFaultsById: Record<string, RobotFaultState>
  robotContactsById: Record<string, RobotSafetyContactState>
  collisionWarning: boolean
  isDebugHitbox: boolean

  // Actions
  addObject: (obj: Omit<SceneObject, 'id' | 'transform' | 'visible'>) => void
  removeObject: (id: string) => void
  updateObjectTransform: (id: string, transform: Partial<Transform3D>) => void
  updateObjectVisibility: (id: string, visible: boolean) => void
  setSelectedObjectId: (id: string | null) => void
  setRobotFault: (robotId: string, fault: RobotFaultState | null) => void
  setRobotContact: (robotId: string, contact: RobotSafetyContactState | null) => void
  clearRobotSafetyState: (robotId: string) => void
  setCollisionWarning: (warning: boolean) => void
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
  selectedObjectId: null,
  robotFaultsById: {},
  robotContactsById: {},
  collisionWarning: false,
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
        selectedObjectId: newObj.id
      }
    }),

  removeObject: (id) =>
    set((state) => ({
      objects: state.objects.filter((o) => o.id !== id),
      selectedObjectId: state.selectedObjectId === id ? null : state.selectedObjectId
    })),

  updateObjectTransform: (id, transform) =>
    set((state) => ({
      objects: state.objects.map((o) =>
        o.id === id ? { ...o, transform: { ...o.transform, ...transform } } : o
      )
    })),

  updateObjectVisibility: (id, visible) =>
    set((state) => ({
      objects: state.objects.map((o) => (o.id === id ? { ...o, visible } : o))
    })),

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

      return {
        robotContactsById,
        collisionWarning: Object.values(robotContactsById).some(
          (robotContact) => robotContact.level === 'collision'
        )
      }
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
        robotContactsById,
        collisionWarning: Object.values(robotContactsById).some(
          (robotContact) => robotContact.level === 'collision'
        )
      }
    }),

  setCollisionWarning: (warning) => set({ collisionWarning: warning }),

  setDebugHitbox: (debug) => set({ isDebugHitbox: debug }),

  clearScene: () =>
    set({
      objects: [],
      selectedObjectId: null,
      robotContactsById: {},
      collisionWarning: false,
      isDebugHitbox: false
    })
}))
