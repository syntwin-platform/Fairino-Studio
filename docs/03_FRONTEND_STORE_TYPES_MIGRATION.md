# 03 - Frontend Store, Types & Migration Plan

## 1. Mục tiêu tài liệu

File này hướng dẫn Antigravity refactor store/types để phục vụ multi-robot viewport nhưng vẫn giữ single active control.

Điểm quan trọng:

> **Multi-robot visual không đồng nghĩa với multi-robot runtime.**

Ở phase này:

- Store có nhiều robot.
- Có `selectedRobotId`.
- Viewport render nhiều robot.
- Joint control vẫn chỉ tác động robot selected.
- Workflow playback vẫn chỉ tác động robot selected.

## 2. Current problem

Hiện tại logic viewport đang có dấu hiệu single robot:

```text
robotRef: one robot object
jointAngles: one global joint array
tcpPose: one global TCP pose
workflowSteps: one global workflow
selectedRobotSceneBinding: apply vào robotRef duy nhất
```

Khi user add nhiều robot:

```text
Sidebar có nhiều robot
Backend có nhiều robot
Nhưng viewport chỉ render một robot
```

Nguyên nhân:

```text
Viewport3D chưa loop qua robots list.
URDF loader chỉ load một robot.
robotRef không thể đại diện cho nhiều robot.
jointAngles global đang update object duy nhất.
```

## 3. Target store structure

### 3.1 Robot list state

```ts
type RobotListState = {
  robots: RobotInstance[]
  selectedRobotId: string | null

  setRobots: (robots: RobotInstance[]) => void
  addRobot: (robot: RobotInstance) => void
  updateRobot: (robotId: string, patch: Partial<RobotInstance>) => void
  removeRobot: (robotId: string) => void

  selectRobot: (robotId: string | null) => void
}
```

### 3.2 Active robot selector

```ts
const selectedRobot = robots.find((r) => r.id === selectedRobotId) ?? null
```

Nên tạo selector/helper:

```ts
export function getSelectedRobot(
  robots: RobotInstance[],
  selectedRobotId: string | null
): RobotInstance | null {
  if (!selectedRobotId) return null
  return robots.find((robot) => robot.id === selectedRobotId) ?? null
}
```

### 3.3 Runtime state theo robotId

Nếu đã có telemetry/current pose thì đưa vào map:

```ts
type RobotRuntimeById = Record<
  string,
  {
    jointAngles?: number[]
    tcpPose?: TCPPose
    status?: RobotStatus
    isPlaying?: boolean
    currentCommandId?: string
  }
>
```

Phase này không bắt buộc phải implement đầy đủ. Nhưng nếu cần giữ latest pose cho non-active robot, dùng map này thay vì nhét vào `RobotInstance`.

## 4. Type cần kiểm tra trong robot.types.ts

Antigravity cần mở file:

```text
src/renderer/src/types/robot.types.ts
```

Tìm các type hiện tại:

```text
RobotInstance
Robot
RobotSceneBinding
SceneBinding
RobotStatus
TCPPose
WorkflowStep
```

Nếu thiếu, thêm type theo hướng backward compatible.

### 4.1 Type tối thiểu

```ts
export type RobotStatus = 'offline' | 'connecting' | 'connected' | 'running' | 'warning' | 'error'

export type RobotMode = 'simulator' | 'real'

export type RobotSceneBinding = {
  stageId?: string
  primPath?: string
  usdPath?: string
  urdfPath?: string

  baseX: number
  baseY: number
  baseZ: number
  baseYaw: number

  rosNamespace?: string
  graphPath?: string
}

export type RobotInstance = {
  id: string
  name: string
  robotCode?: string

  vendor?: 'Fairino'
  model: 'FR5'
  mode: RobotMode
  status?: RobotStatus

  sceneBinding?: RobotSceneBinding

  createdAt?: string
  updatedAt?: string
}
```

### 4.2 Helper default scene binding

```ts
export function getDefaultSceneBinding(): RobotSceneBinding {
  return {
    baseX: 0,
    baseY: 0,
    baseZ: 0,
    baseYaw: 0
  }
}
```

### 4.3 Helper normalize scene binding

```ts
export function normalizeSceneBinding(
  binding?: Partial<RobotSceneBinding> | null
): RobotSceneBinding {
  return {
    baseX: Number.isFinite(binding?.baseX) ? Number(binding?.baseX) : 0,
    baseY: Number.isFinite(binding?.baseY) ? Number(binding?.baseY) : 0,
    baseZ: Number.isFinite(binding?.baseZ) ? Number(binding?.baseZ) : 0,
    baseYaw: Number.isFinite(binding?.baseYaw) ? Number(binding?.baseYaw) : 0,
    stageId: binding?.stageId,
    primPath: binding?.primPath,
    usdPath: binding?.usdPath,
    urdfPath: binding?.urdfPath,
    rosNamespace: binding?.rosNamespace,
    graphPath: binding?.graphPath
  }
}
```

## 5. Store migration rules

### Rule 1: Không xóa jointAngles global ngay

Nếu code hiện tại đang dùng:

```ts
jointAngles: number[]
setJointAngles(...)
updateRobotJoints(...)
```

Không xóa ngay vì MoveJ/MoveL/IK/workflow có thể phụ thuộc.

Thay vào đó:

```text
jointAngles global = jointAngles của selected robot
```

### Rule 2: Non-active robot không nhận jointAngles global

Trong Viewport3D:

```ts
if (robotId === selectedRobotId) {
  applyJointAngles(robotObject, jointAngles)
}
```

Không làm:

```ts
robotRefs.forEach((robot) => applyJointAngles(robot, jointAngles))
```

### Rule 3: Khi đổi selectedRobotId

Có 2 cách:

#### Cách an toàn phase đầu

Không đổi `jointAngles` global khi select robot khác. Chỉ đảm bảo robot active mới nhận update sau đó.

#### Cách tốt hơn

Khi select robot khác, sync `jointAngles` global từ latest pose của robot đó nếu có:

```ts
const runtime = runtimeByRobotId[nextRobotId]
if (runtime?.jointAngles) {
  setJointAngles(runtime.jointAngles)
} else {
  setJointAngles(defaultHomeJoints)
}
```

Chỉ làm cách này nếu store hiện tại đủ dữ liệu.

## 6. Store actions cần có

```ts
selectRobot(robotId: string | null): void
setRobots(robots: RobotInstance[]): void
updateRobotSceneBinding(robotId: string, sceneBinding: RobotSceneBinding): void
```

Ví dụ:

```ts
updateRobotSceneBinding: (robotId, sceneBinding) =>
  set((state) => ({
    robots: state.robots.map((robot) => (robot.id === robotId ? { ...robot, sceneBinding } : robot))
  }))
```

## 7. Data flow chuẩn

### 7.1 Load robots

```text
App start
-> backendRobotClient.fetchRobots()
-> normalizeRobot(response)
-> robotStore.setRobots(robots)
-> nếu selectedRobotId null, chọn robot đầu tiên
-> Viewport3D render robots
```

### 7.2 Select robot

```text
User click robot trong sidebar hoặc viewport
-> selectRobot(robotId)
-> selectedRobotId update
-> Viewport3D highlight robot
-> Control panel bám theo selected robot
```

### 7.3 Update placement

```text
Layout Mode
-> user drag robot
-> local scene object update
-> Save Placement
-> backendRobotClient.updateRobotSceneBinding(robotId, newBinding)
-> robotStore.updateRobotSceneBinding(robotId, newBinding)
-> Viewport apply binding
```

## 8. Files Antigravity cần đọc

```text
src/renderer/src/store/robotStore.ts
src/renderer/src/types/robot.types.ts
src/renderer/src/components/robot/RobotSidebar.tsx
src/renderer/src/components/viewport/Viewport3D.tsx
src/renderer/src/services/backendRobotClient.ts
```

## 9. Prompt refactor store cho Antigravity

```text
Bạn hãy kiểm tra robotStore.ts và robot.types.ts.

Mục tiêu:
- Đảm bảo store có robots[] và selectedRobotId.
- Có action selectRobot(robotId).
- Có action updateRobotSceneBinding(robotId, sceneBinding).
- Không xóa jointAngles global hiện tại.
- Không phá MoveJ/MoveL/IK/workflow playback.
- Non-active robot không được dùng jointAngles global trong viewport.
- TypeScript typecheck pass.

Yêu cầu:
1. Trước tiên hãy phân tích store hiện tại.
2. Chỉ sửa tối thiểu để support multi-robot visual.
3. Giữ backward compatibility với code hiện có.
4. Trả về patch theo từng file.
```

## 10. Prompt update sidebar cho Antigravity

```text
Bạn hãy kiểm tra RobotSidebar.tsx.

Mục tiêu:
- Sidebar hiển thị robots list từ store/backend.
- Click robot trong sidebar gọi selectRobot(robot.id).
- Robot selected có style active.
- Không tự điều khiển joint ở sidebar nếu chưa select.
- Không phá UI workflow hiện tại.

Acceptance:
- Có 2 robot thì sidebar hiển thị 2 robot.
- Click robot A thì selectedRobotId = A.
- Click robot B thì selectedRobotId = B.
- Viewport nhận selectedRobotId và highlight đúng.
```

## 11. Acceptance criteria cho store/types

```text
[ ] robot.types.ts có RobotSceneBinding type.
[ ] RobotInstance có optional sceneBinding.
[ ] robotStore có robots[].
[ ] robotStore có selectedRobotId.
[ ] robotStore có selectRobot().
[ ] robotStore có updateRobotSceneBinding().
[ ] Không xóa jointAngles global.
[ ] Không xóa workflow state hiện tại.
[ ] npm.cmd run typecheck pass.
```

## 12. Test thủ công

### Test 1: Load nhiều robot

```text
Given backend trả về 2 robot
When app load
Then robotStore.robots.length = 2
And selectedRobotId không null
```

### Test 2: Select robot

```text
Given sidebar có Robot A và Robot B
When click Robot B
Then selectedRobotId = Robot B id
And control panel hiển thị Robot B
```

### Test 3: Scene binding default

```text
Given robot không có sceneBinding
When normalizeRobot
Then sceneBinding default = 0,0,0,0
And viewport không crash
```

### Test 4: Không phá joint control

```text
Given selectedRobotId = Robot A
When kéo joint slider
Then chỉ Robot A thay đổi pose
And Robot B giữ nguyên
```
