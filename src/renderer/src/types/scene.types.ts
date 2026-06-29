export interface Transform3D {
  x: number // position x (mm)
  y: number // position y (mm)
  z: number // position z (mm)
  rx: number // rotation x (degrees)
  ry: number // rotation y (degrees)
  rz: number // rotation z (degrees)
  sx: number // scale x
  sy: number // scale y
  sz: number // scale z
}

export interface SceneObject {
  id: string
  name: string
  fileType: 'gltf' | 'glb' | 'stl'
  filePath?: string // absolute path in Electron
  url: string // ObjectURL for active rendering
  transform: Transform3D
  visible: boolean
}
