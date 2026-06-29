import { create } from 'zustand'
import { SceneObject, Transform3D } from '../types/scene.types'

interface SceneState {
  objects: SceneObject[]
  selectedObjectId: string | null
  collisionWarning: boolean
  isDebugHitbox: boolean

  // Actions
  addObject: (obj: Omit<SceneObject, 'id' | 'transform' | 'visible'>) => void
  removeObject: (id: string) => void
  updateObjectTransform: (id: string, transform: Partial<Transform3D>) => void
  updateObjectVisibility: (id: string, visible: boolean) => void
  setSelectedObjectId: (id: string | null) => void
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

  setCollisionWarning: (warning) => set({ collisionWarning: warning }),

  setDebugHitbox: (debug) => set({ isDebugHitbox: debug }),

  clearScene: () =>
    set({ objects: [], selectedObjectId: null, collisionWarning: false, isDebugHitbox: false })
}))
