# 05 - Layout Mode & Scene Placement

## 1. Mục tiêu

Layout Mode là chế độ để user kéo thả robot vào vị trí trong factory/scene.

Mục tiêu:

- User không cần nhập tay baseX/baseY/baseZ/baseYaw là chính.
- User có thể kéo robot trên mặt sàn.
- User có thể xoay robot quanh trục yaw.
- Khi bấm Save, frontend gọi API lưu `RobotSceneBinding`.
- Chỉ chỉnh base pose, không chỉnh joint.
- Tách rõ khỏi chế độ điều khiển robot để tránh kéo nhầm khi workflow đang chạy.

## 2. Ba mode viewport đề xuất

```ts
type ViewportMode = 'factory' | 'focus' | 'layout'
```

### 2.1 Factory View

Dùng để quan sát toàn bộ line/factory.

```text
Render tất cả robot.
Click robot để select.
Hiển thị label/status.
Không hiện joint control trực tiếp trong scene.
Camera fit toàn scene.
```

### 2.2 Robot Focus View

Dùng để làm việc với một robot.

```text
Robot selected hiển thị rõ.
Control panel bám theo selectedRobotId.
MoveJ/MoveL/IK/workflow chỉ tác động selected robot.
Robot khác có thể mờ hoặc vẫn hiện bình thường.
```

### 2.3 Layout / Arrange Mode

Dùng để setup vị trí robot.

```text
Kéo robot trên mặt sàn.
Xoay robot yaw.
Snap grid.
Reset position.
Save placement.
Cancel placement.
Không chạy workflow.
Không gửi MoveJ/MoveL.
```

## 3. UX flow Add Robot với Layout Mode

Luồng Add Robot nên như sau:

```text
User bấm Add Robot
-> chọn model Fairino FR5
-> nhập tên robot
-> chọn mode simulator/real
-> backend tạo RobotInstance
-> robot xuất hiện ở vị trí default
-> viewport chuyển sang Layout Mode
-> user kéo robot tới vị trí mong muốn
-> user bấm Save Placement
-> frontend gọi updateRobotSceneBinding
-> backend lưu baseX/baseY/baseZ/baseYaw
-> quay lại Factory View hoặc Focus View
```

Không nên bắt user nhập tay tọa độ là cách chính. Vẫn nên có panel nhập số cho user kỹ thuật.

## 4. Data cần lưu

```ts
type RobotSceneBinding = {
  baseX: number
  baseY: number
  baseZ: number
  baseYaw: number

  stageId?: string
  primPath?: string
  usdPath?: string
  urdfPath?: string
  rosNamespace?: string
  graphPath?: string
}
```

Trong Layout Mode chỉ update:

```text
baseX
baseY
baseZ
baseYaw
```

Không update:

```text
jointAngles
tcpPose
workflowSteps
runtimeSession
controllerProfile
```

## 5. UI controls đề xuất

### 5.1 Top toolbar

```text
[Factory] [Focus] [Layout]
```

Hoặc:

```text
Viewport Mode:
- Factory
- Robot Focus
- Layout
```

### 5.2 Layout panel

Khi vào Layout Mode, hiện panel:

```text
Selected Robot: FR5 Line 1

Position
X: [input]
Y: [input]
Z: [input]

Rotation
Yaw/Rz: [input]

Actions
[Snap to Grid]
[Reset]
[Cancel]
[Save Placement]
```

### 5.3 Warning

Nếu robot đang running:

```text
Cannot edit placement while robot is running.
```

Nếu robot chưa selected:

```text
Select a robot to edit placement.
```

Nếu 2 robot chồng nhau:

```text
Warning: This robot overlaps another robot placement.
```

## 6. Transform control strategy

Nếu project đang dùng Three.js, có thể dùng `TransformControls` nếu đã cài.

```ts
import { TransformControls } from 'three/examples/jsm/controls/TransformControls'
```

Nhưng Antigravity phải kiểm tra dependency hiện tại trước khi thêm.

### 6.1 Chỉ attach selected robot trong layout mode

```ts
if (viewportMode === 'layout' && selectedRobotObject) {
  transformControls.attach(selectedRobotObject)
} else {
  transformControls.detach()
}
```

### 6.2 Chỉ cho translate/rotate base

Cách đơn giản phase đầu:

- Translate mode: kéo X/Z hoặc X/Y tùy hệ trục scene.
- Rotate mode: rotate yaw.

Không cho scale.

```ts
transformControls.setMode('translate')
// hoặc
transformControls.setMode('rotate')
```

### 6.3 Disable OrbitControls khi dragging

```ts
transformControls.addEventListener('dragging-changed', (event) => {
  orbitControls.enabled = !event.value
})
```

Nếu không làm, kéo robot sẽ kéo camera.

## 7. Snap grid

### 7.1 Snap translate

```ts
function snap(value: number, step: number): number {
  return Math.round(value / step) * step
}
```

Ví dụ:

```ts
const gridStep = 0.1
object.position.x = snap(object.position.x, gridStep)
object.position.z = snap(object.position.z, gridStep)
```

### 7.2 Snap yaw

```ts
const angleStep = Math.PI / 12 // 15 degrees
object.rotation.y = snap(object.rotation.y, angleStep)
```

Trục yaw phụ thuộc scene convention.

## 8. Dirty state

Khi user kéo robot nhưng chưa save, cần biết placement đã thay đổi.

```ts
type LayoutDraftState = {
  robotId: string
  originalBinding: RobotSceneBinding
  draftBinding: RobotSceneBinding
  dirty: boolean
}
```

Flow:

```text
Enter Layout Mode
-> copy sceneBinding hiện tại vào draft
-> user drag object
-> update draftBinding
-> dirty = true
-> Save hoặc Cancel
```

## 9. Save placement

### 9.1 API client

```ts
async function updateRobotSceneBinding(
  robotId: string,
  binding: RobotSceneBinding
): Promise<RobotInstance> {
  return http.put(`/api/robots/${robotId}/scene-binding`, binding)
}
```

Nếu backend chưa có route riêng:

```ts
return http.put(`/api/robots/${robotId}`, { sceneBinding: binding })
```

### 9.2 Save flow

```ts
async function handleSavePlacement() {
  if (!selectedRobotId) return

  const object = robotRefs.current.get(selectedRobotId)
  if (!object) return

  const nextBinding = extractSceneBindingFromObject(object)

  const updatedRobot = await backendRobotClient.updateRobotSceneBinding(
    selectedRobotId,
    nextBinding
  )

  updateRobotSceneBinding(selectedRobotId, updatedRobot.sceneBinding)
}
```

### 9.3 Extract binding

```ts
function extractSceneBindingFromObject(
  object: THREE.Object3D,
  previous?: RobotSceneBinding
): RobotSceneBinding {
  return {
    ...previous,
    baseX: object.position.x,
    baseY: object.position.y,
    baseZ: object.position.z,
    baseYaw: object.rotation.y
  }
}
```

Nếu scene dùng Z-up thì `baseYaw = object.rotation.z`.

## 10. Cancel placement

```ts
function handleCancelPlacement() {
  if (!selectedRobotId) return

  const robot = robots.find((item) => item.id === selectedRobotId)
  const object = robotRefs.current.get(selectedRobotId)

  if (!robot || !object) return

  applySceneBinding(object, robot.sceneBinding)
  clearLayoutDraft()
}
```

## 11. Reset placement

```ts
function handleResetPlacement() {
  if (!selectedRobotId) return

  const object = robotRefs.current.get(selectedRobotId)
  if (!object) return

  object.position.set(0, 0, 0)
  object.rotation.set(0, 0, 0)
  markDirty()
}
```

## 12. Collision/overlap warning phase đầu

Không cần physics/collision full. Chỉ check khoảng cách base:

```ts
function findOverlappingRobots(
  selectedRobotId: string,
  binding: RobotSceneBinding,
  robots: RobotInstance[]
): RobotInstance[] {
  return robots.filter((robot) => {
    if (robot.id === selectedRobotId) return false

    const other = normalizeSceneBinding(robot.sceneBinding)
    const dx = other.baseX - binding.baseX
    const dz = other.baseZ - binding.baseZ
    const distance = Math.sqrt(dx * dx + dz * dz)

    return distance < 0.2
  })
}
```

Nếu scene dùng X/Y mặt sàn thì dùng `dx/dy`.

## 13. Không cho edit khi robot đang chạy

Rule:

```text
Nếu robot.status = running
hoặc runtimeByRobotId[robotId].isPlaying = true
thì disable Layout Mode cho robot đó.
```

Message:

```text
Stop the robot before editing placement.
```

## 14. Prompt Layout Mode cho Antigravity

```text
Bạn hãy thêm Layout / Arrange Mode cho Viewport3D.

Mục tiêu:
- Có viewportMode: factory | focus | layout.
- Trong layout mode, user có thể chỉnh base pose của selected robot.
- Chỉ chỉnh baseX/baseY/baseZ/baseYaw.
- Không chỉnh joint.
- Không gửi MoveJ/MoveL.
- Có Save Placement gọi backendRobotClient.updateRobotSceneBinding.
- Có Cancel để rollback về sceneBinding cũ.
- Nếu robot đang running thì không cho edit placement.

Files cần đọc:
- src/renderer/src/components/viewport/Viewport3D.tsx
- src/renderer/src/store/robotStore.ts
- src/renderer/src/types/robot.types.ts
- src/renderer/src/services/backendRobotClient.ts

Rules:
- Không phá OrbitControls.
- Khi dùng TransformControls, disable OrbitControls lúc dragging.
- Không làm multi-runtime song song.
- Typecheck pass.

Implementation:
1. Thêm viewportMode state.
2. Thêm toolbar đổi Factory/Focus/Layout.
3. Trong Layout Mode, attach transform control vào selected robot object.
4. On object change, update layout draft.
5. Save gọi API update sceneBinding.
6. Cancel apply lại sceneBinding cũ.
7. Add warning nếu robot placement overlap.
```

## 15. Acceptance criteria Layout Mode

```text
[ ] Có thể chuyển Factory/Focus/Layout.
[ ] Vào Layout Mode cần selectedRobotId.
[ ] Selected robot có gizmo hoặc control để chỉnh base pose.
[ ] Kéo robot không làm joint thay đổi.
[ ] Kéo robot không gửi command backend.
[ ] Save Placement gọi API.
[ ] Reload app robot giữ vị trí mới.
[ ] Cancel trả robot về vị trí cũ.
[ ] Robot đang running không cho edit placement.
[ ] Typecheck pass.
```

## 16. Manual test

### Test 1: Placement save

```text
Given Robot A at 0,0,0
When vào Layout Mode
And kéo Robot A sang X=2
And bấm Save Placement
And reload app
Then Robot A vẫn ở X=2
```

### Test 2: Cancel

```text
Given Robot A at X=0
When kéo Robot A sang X=2
And bấm Cancel
Then Robot A quay về X=0
```

### Test 3: Không ảnh hưởng joint

```text
Given selected Robot A
When vào Layout Mode
And kéo base robot
Then jointAngles không đổi
And không gửi MoveJ/MoveL
```

### Test 4: Overlap warning

```text
Given Robot A và Robot B cùng base 0,0
When vào Factory/Layout
Then UI có warning hoặc label để biết bị chồng
```

## 17. Roadmap sau Layout Mode

Sau khi Layout Mode ổn mới làm:

```text
Phase sau 1: Factory monitoring panel
Phase sau 2: TCP trail/path visualization
Phase sau 3: Collision zone visualization
Phase sau 4: Multi-robot runtime manager
Phase sau 5: Start all / stop all orchestration
```
