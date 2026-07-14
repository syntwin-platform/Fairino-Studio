# 04 - Multi-Robot Viewport Renderer Implementation Guide

## 1. Mục tiêu kỹ thuật

Refactor `Viewport3D.tsx` từ single robot renderer sang multi-robot renderer.

Target:

```text
Before:
robotRef -> 1 robot object

After:
robotRefs -> Map<robotId, robot object>
activeRobotRef -> robotRefs.get(selectedRobotId)
```

Phase này chỉ render nhiều robot và cho chọn robot. Chưa chạy nhiều robot song song.

## 2. File chính cần sửa

```text
src/renderer/src/components/viewport/Viewport3D.tsx
```

File phụ có thể cần sửa:

```text
src/renderer/src/store/robotStore.ts
src/renderer/src/types/robot.types.ts
src/renderer/src/components/robot/RobotSidebar.tsx
```

## 3. Kiến trúc object trong viewport

### 3.1 Current single robot pattern

Dạng hiện tại thường là:

```ts
const robotRef = useRef<THREE.Group | null>(null)

loader.load(urdfPath, (robot) => {
  robotRef.current = robot
  scene.add(robot)
})
```

Sau đó update joint:

```ts
if (robotRef.current) {
  updateRobotJoints(robotRef.current, jointAngles)
}
```

Vấn đề:

- Chỉ lưu được 1 robot.
- Load robot mới có thể replace robot cũ.
- Không biết robot nào đang selected.
- Không support click robot chính xác.

### 3.2 Target multi robot pattern

```ts
const robotRefs = useRef<Map<string, THREE.Object3D>>(new Map())
const robotMetadataRefs = useRef<Map<string, { robotId: string }>>(new Map())
```

Hoặc gắn trực tiếp vào object:

```ts
robot.userData.robotId = robot.id
robot.traverse((child) => {
  child.userData.robotId = robot.id
})
```

Active robot:

```ts
const activeRobotObject = selectedRobotId ? robotRefs.current.get(selectedRobotId) : null
```

## 4. Pseudo-code lifecycle

### 4.1 Sync robots list với scene

```ts
useEffect(() => {
  if (!sceneRef.current) return

  const scene = sceneRef.current
  const existingIds = new Set(robotRefs.current.keys())
  const nextIds = new Set(robots.map((robot) => robot.id))

  // Remove robots no longer in store
  for (const robotId of existingIds) {
    if (!nextIds.has(robotId)) {
      const object = robotRefs.current.get(robotId)
      if (object) {
        scene.remove(object)
        disposeObject3D(object)
      }
      robotRefs.current.delete(robotId)
    }
  }

  // Add new robots
  for (const robot of robots) {
    if (!robotRefs.current.has(robot.id)) {
      loadRobotIntoScene(robot)
    }
  }

  // Update placement for existing robots
  for (const robot of robots) {
    const object = robotRefs.current.get(robot.id)
    if (object) {
      applySceneBinding(object, robot.sceneBinding)
    }
  }
}, [robots])
```

### 4.2 Apply SceneBinding

```ts
function applySceneBinding(object: THREE.Object3D, binding?: RobotSceneBinding) {
  const safeBinding = normalizeSceneBinding(binding)

  object.position.set(safeBinding.baseX, safeBinding.baseY, safeBinding.baseZ)

  object.rotation.set(0, safeBinding.baseYaw, 0)
}
```

Lưu ý: hệ tọa độ hiện tại của project có thể đang dùng Y-up hoặc Z-up. Antigravity phải kiểm tra code hiện tại trước khi quyết định yaw nằm ở trục nào.

Nếu scene đang dùng Y-up:

```ts
object.rotation.y = baseYaw
```

Nếu scene đang dùng Z-up:

```ts
object.rotation.z = baseYaw
```

Không được đoán cứng nếu code hiện tại đã có convention.

## 5. Load URDF cho từng robot

### 5.1 Function đề xuất

```ts
async function loadRobotForInstance(robot: RobotInstance): Promise<THREE.Object3D> {
  const urdfPath = robot.sceneBinding?.urdfPath ?? getDefaultUrdfPathForModel(robot.model)

  return new Promise((resolve, reject) => {
    loader.load(
      urdfPath,
      (object) => {
        object.name = robot.name
        object.userData.robotId = robot.id

        object.traverse((child) => {
          child.userData.robotId = robot.id
        })

        applySceneBinding(object, robot.sceneBinding)
        resolve(object)
      },
      undefined,
      reject
    )
  })
}
```

### 5.2 Default asset path

Nếu code hiện tại đã có path URDF thì reuse, không tạo path mới tùy tiện.

Nếu cần helper:

```ts
function getDefaultUrdfPathForModel(model: string): string {
  switch (model) {
    case 'FR5':
      return '/assets/robots/fairino/fr5/fr5.urdf'
    default:
      return '/assets/robots/fairino/fr5/fr5.urdf'
  }
}
```

Nhưng Antigravity phải kiểm tra asset path hiện tại của project trước.

## 6. Không để race condition khi load async

Khi `robots` thay đổi nhanh, loader có thể load xong robot đã bị remove.

Cần check trước khi add scene:

```ts
const loadToken = robot.id

loader.load(urdfPath, (object) => {
  const stillExists = robotsRef.current.some((r) => r.id === loadToken)
  const alreadyLoaded = robotRefs.current.has(loadToken)

  if (!stillExists || alreadyLoaded) {
    disposeObject3D(object)
    return
  }

  scene.add(object)
  robotRefs.current.set(loadToken, object)
})
```

Nên có:

```ts
const robotsRef = useRef<RobotInstance[]>([])
useEffect(() => {
  robotsRef.current = robots
}, [robots])
```

## 7. Dispose object đúng cách

Khi remove robot, cần dispose geometry/material tránh memory leak:

```ts
function disposeObject3D(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh

    if (mesh.geometry) {
      mesh.geometry.dispose()
    }

    const material = mesh.material
    if (Array.isArray(material)) {
      material.forEach((m) => m.dispose())
    } else if (material) {
      material.dispose()
    }
  })
}
```

Cẩn thận nếu material/geometry share giữa các robot. Nếu loader clone share resource, dispose có thể ảnh hưởng robot khác. Antigravity phải xem loader hiện tại trước khi áp dụng.

## 8. Update joint chỉ cho active robot

Current code có thể đang gọi:

```ts
updateRobotJoints(robotRef.current, jointAngles)
```

Target:

```ts
const activeRobot = selectedRobotId ? robotRefs.current.get(selectedRobotId) : null

if (activeRobot) {
  updateRobotJoints(activeRobot, jointAngles)
}
```

Không làm:

```ts
for (const robot of robotRefs.current.values()) {
  updateRobotJoints(robot, jointAngles)
}
```

Vì như vậy mọi robot sẽ chuyển động giống nhau.

## 9. Non-active robot pose

Phase đầu nên chọn cách đơn giản:

```text
Non-active robot = home pose
```

Hoặc nếu store đã có latest telemetry:

```text
Non-active robot = latestTelemetry joint pose
```

Nhưng không được dùng `jointAngles` global.

Pseudo-code:

```ts
for (const robot of robots) {
  const object = robotRefs.current.get(robot.id)
  if (!object) continue

  if (robot.id === selectedRobotId) {
    applyJointAngles(object, jointAngles)
  } else {
    const latest = runtimeByRobotId[robot.id]?.jointAngles
    if (latest) {
      applyJointAngles(object, latest)
    }
  }
}
```

Nếu chưa có `runtimeByRobotId`, bỏ qua phần else.

## 10. Raycast click chọn robot

### 10.1 Gắn robotId vào object

```ts
object.userData.robotId = robot.id
object.traverse((child) => {
  child.userData.robotId = robot.id
})
```

### 10.2 Tìm robotId từ intersect

```ts
function findRobotIdFromObject(object: THREE.Object3D): string | null {
  let current: THREE.Object3D | null = object

  while (current) {
    if (typeof current.userData.robotId === 'string') {
      return current.userData.robotId
    }
    current = current.parent
  }

  return null
}
```

### 10.3 Click handler

```ts
function handlePointerDown(event: PointerEvent) {
  const intersects = raycaster.intersectObjects(Array.from(robotRefs.current.values()), true)

  const hit = intersects[0]
  if (!hit) return

  const robotId = findRobotIdFromObject(hit.object)
  if (!robotId) return

  selectRobot(robotId)
}
```

Cần giữ logic camera/orbit control hiện tại. Nếu click đang dùng để drag camera, không được select sai khi user kéo chuột. Có thể dùng threshold:

```text
pointerdown position
pointerup position
if movement < 3px then treat as click
```

## 11. Highlight selected robot

Có nhiều cách. Phase đầu nên chọn cách ít phá material nhất.

### Option A: Bounding box helper

```ts
const selectedBoxHelperRef = useRef<THREE.BoxHelper | null>(null)

function updateSelectedHighlight() {
  if (selectedBoxHelperRef.current) {
    scene.remove(selectedBoxHelperRef.current)
  }

  if (!selectedRobotId) return

  const object = robotRefs.current.get(selectedRobotId)
  if (!object) return

  const helper = new THREE.BoxHelper(object)
  scene.add(helper)
  selectedBoxHelperRef.current = helper
}
```

Ưu điểm:

- Không cần sửa material robot.
- Dễ remove.
- Ít rủi ro phá visual.

Nhược điểm:

- Hiển thị thô.

### Option B: Outline pass

Đẹp hơn nhưng phức tạp hơn. Không khuyến nghị phase đầu nếu project chưa có post-processing.

### Option C: Label + base ring

Có thể thêm ring/circle dưới chân robot selected:

```text
selected robot có vòng tròn dưới base
```

Đây là cách dễ nhìn và không phá material.

## 12. Label robot

Label tối thiểu:

```text
Robot name
Status
```

Có thể dùng CSS2DRenderer nếu project đang có, hoặc sprite/canvas texture nếu chưa.

Phase đầu chỉ cần label đơn giản:

```text
FR5 Line 1
Online
```

Rule:

```text
Label đầy đủ khi selected hoặc hover.
Label ngắn khi factory view.
Không che quá nhiều viewport.
```

## 13. Camera focus selected robot

Có thể làm sau highlight. Nếu làm:

```ts
function focusRobot(robotId: string) {
  const object = robotRefs.current.get(robotId)
  if (!object) return

  const box = new THREE.Box3().setFromObject(object)
  const center = box.getCenter(new THREE.Vector3())

  controls.target.copy(center)
  controls.update()
}
```

Không tự focus mỗi lần render, chỉ focus khi user click hoặc bấm button.

## 14. Prompt Viewport3D cho Antigravity

```text
Bạn hãy refactor Viewport3D.tsx để render nhiều robot.

Current issue:
- Viewport3D đang dùng robotRef single object.
- Khi backend/store có nhiều robot, viewport vẫn chỉ hiện một model.
- selectedRobotSceneBinding chỉ apply vào robotRef hiện tại.

Target:
1. Thay robotRef bằng robotRefs Map<string, THREE.Object3D>.
2. Load URDF cho từng robot trong robots list.
3. Khi robots list thay đổi:
   - add robot mới
   - remove robot không còn trong list
   - update sceneBinding cho robot còn lại
4. Mỗi robot gắn userData.robotId.
5. Click robot bằng raycast thì gọi selectRobot(robotId).
6. Chỉ robot selected nhận jointAngles global.
7. Non-active robot không bị update bởi jointAngles global.
8. Selected robot có highlight/label rõ.
9. Không phá MoveJ, MoveL, IK, workflow playback hiện tại.
10. npm.cmd run typecheck phải pass.

Files cần đọc:
- src/renderer/src/components/viewport/Viewport3D.tsx
- src/renderer/src/store/robotStore.ts
- src/renderer/src/types/robot.types.ts

Hãy trả về:
- Files modified
- Explanation
- Code patch
- Ctrl+F anchors
- Manual test checklist
```

## 15. Manual test checklist

```text
[ ] Store có 1 robot -> viewport render 1 robot.
[ ] Store có 2 robot -> viewport render 2 robot.
[ ] Robot A baseX=0, Robot B baseX=2 -> hai robot cách nhau.
[ ] Robot B baseYaw=1.57 -> Robot B xoay đúng.
[ ] Click Robot A -> selectedRobotId = A.
[ ] Click Robot B -> selectedRobotId = B.
[ ] Kéo joint slider khi selected A -> chỉ A chuyển động.
[ ] Kéo joint slider khi selected B -> chỉ B chuyển động.
[ ] Xóa Robot A khỏi store -> Robot A biến khỏi scene.
[ ] Add Robot C -> Robot C xuất hiện không duplicate A/B.
[ ] Typecheck pass.
```

## 16. Known risks

```text
Risk 1: Loader async tạo duplicate robot.
Mitigation: check robotRefs.has(robotId) trước khi add.

Risk 2: jointAngles global update tất cả robot.
Mitigation: chỉ update selectedRobotId.

Risk 3: click vào mesh con không tìm được robotId.
Mitigation: set userData.robotId cho toàn bộ children.

Risk 4: dispose material shared làm mất material robot khác.
Mitigation: kiểm tra loader clone/share resource.

Risk 5: selectedRobotId null.
Mitigation: chọn robot đầu tiên khi robots loaded hoặc handle null an toàn.

Risk 6: baseYaw sai trục.
Mitigation: kiểm tra convention cũ của Viewport3D trước.
```
