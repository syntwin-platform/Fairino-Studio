# 02 - Domain Model, SceneBinding & Backend API

## 1. Mục tiêu tài liệu

File này mô tả model dữ liệu cần có cho module Add Robot / Multi-Robot Viewport.

Mục tiêu là để Antigravity không nhầm lẫn giữa:

```text
RobotInstance: robot được user tạo và lưu trong hệ thống
RobotSceneBinding: vị trí/binding của robot trong scene
RobotRuntimeState: trạng thái runtime/latest telemetry
RobotCommand: command được gửi tới robot
Workflow: logic chạy robot
```

Ở phase hiện tại, ưu tiên cao nhất là:

```text
RobotInstance + RobotSceneBinding
```

Các phần runtime/history/workflow chỉ cần giữ tương thích, chưa mở rộng song song.

## 2. Nguyên tắc thiết kế model

Không gom tất cả vào một object lớn kiểu:

```ts
RobotInstance {
  jointAngles
  tcpPose
  workflowSteps
  deviceSecret
  runtimeStatus
}
```

Cách này dễ gây rối vì:

- `jointAngles` và `tcpPose` là dữ liệu realtime.
- `workflowSteps` là definition/routine riêng.
- `deviceSecret` là secret, không nên trả về frontend.
- `runtimeStatus` có thể stale nếu lưu trực tiếp vào bảng Robots.
- `sceneBinding` là config placement, không phải telemetry.

Nên tách tối thiểu:

```text
RobotInstance
RobotSceneBinding
RobotRuntimeState
RobotControllerProfile
```

## 3. Type đề xuất cho frontend

### 3.1 RobotModel

```ts
export type RobotModel = {
  id: string
  vendor: 'Fairino'
  model: 'FR5'
  displayName: string
  dof: number
  urdfPath?: string
  usdPath?: string
  defaultJointAngles?: number[]
  jointNames?: string[]
}
```

Ví dụ:

```ts
const fairinoFr5Model: RobotModel = {
  id: 'fairino-fr5',
  vendor: 'Fairino',
  model: 'FR5',
  displayName: 'Fairino FR5',
  dof: 6,
  urdfPath: '/assets/robots/fairino/fr5/fr5.urdf',
  usdPath: '/assets/robots/fairino/fr5/fr5.usd',
  defaultJointAngles: [0, 0, 0, 0, 0, 0]
}
```

### 3.2 RobotSceneBinding

```ts
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
```

Trong phase Viewport3D hiện tại, bắt buộc dùng:

```text
baseX
baseY
baseZ
baseYaw
```

Các field còn lại để sẵn cho Isaac Sim/ROS2 sau này.

### 3.3 RobotInstance

```ts
export type RobotInstance = {
  id: string
  name: string
  robotCode?: string

  vendor?: 'Fairino'
  model: 'FR5'
  mode: 'simulator' | 'real'

  status?: 'offline' | 'connecting' | 'connected' | 'running' | 'warning' | 'error'

  sceneBinding?: RobotSceneBinding

  createdAt?: string
  updatedAt?: string
}
```

Không nên để `jointAngles` trực tiếp trong `RobotInstance` ở phase dài hạn. Nếu code hiện tại đã có thì vẫn giữ để tương thích, nhưng không mở rộng thêm logic mới dựa vào field đó.

### 3.4 RobotRuntimeState

```ts
export type RobotRuntimeState = {
  robotId: string
  runtimeSessionId?: string
  status: 'offline' | 'connecting' | 'connected' | 'running' | 'warning' | 'error'
  latestJointAngles?: number[]
  latestTcpPose?: {
    x: number
    y: number
    z: number
    rx: number
    ry: number
    rz: number
  }
  currentCommandId?: string
  lastSeenAt?: string
  errorMessage?: string
}
```

Phase hiện tại không bắt buộc implement đầy đủ `RobotRuntimeState`, nhưng type này giúp tránh nhét telemetry vào `RobotInstance`.

## 4. Backend entity đề xuất

### 4.1 Robots table

```text
Robots
- Id
- CompanyId
- Name
- RobotCode
- Vendor
- Model
- Mode
- StatusLastKnown
- CreatedAt
- UpdatedAt
```

Không nên lưu secret trực tiếp trong bảng này.

### 4.2 RobotSceneBindings table

```text
RobotSceneBindings
- Id
- RobotId
- StageId
- PrimPath
- UsdPath
- UrdfPath
- BaseX
- BaseY
- BaseZ
- BaseYaw
- RosNamespace
- GraphPath
- CreatedAt
- UpdatedAt
```

Một robot simulator nên có một SceneBinding active.

### 4.3 RobotControllerProfiles table

```text
RobotControllerProfiles
- Id
- RobotId
- Type
- Ip
- Port
- SecretRef
- ConnectionMode
- CreatedAt
- UpdatedAt
```

Chỉ dùng cho real robot. `SecretRef` trỏ tới secret storage hoặc hash, không trả secret gốc về frontend.

## 5. DTO đề xuất

### 5.1 RobotResponse

```csharp
public sealed class RobotResponse
{
    public Guid Id { get; init; }
    public string Name { get; init; } = default!;
    public string? RobotCode { get; init; }

    public string Vendor { get; init; } = "Fairino";
    public string Model { get; init; } = "FR5";
    public string Mode { get; init; } = default!;

    public string? Status { get; init; }

    public RobotSceneBindingResponse? SceneBinding { get; init; }

    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset UpdatedAt { get; init; }
}
```

### 5.2 RobotSceneBindingResponse

```csharp
public sealed class RobotSceneBindingResponse
{
    public string? StageId { get; init; }
    public string? PrimPath { get; init; }
    public string? UsdPath { get; init; }
    public string? UrdfPath { get; init; }

    public double BaseX { get; init; }
    public double BaseY { get; init; }
    public double BaseZ { get; init; }
    public double BaseYaw { get; init; }

    public string? RosNamespace { get; init; }
    public string? GraphPath { get; init; }
}
```

### 5.3 UpdateRobotSceneBindingRequest

```csharp
public sealed class UpdateRobotSceneBindingRequest
{
    public string? StageId { get; init; }
    public string? PrimPath { get; init; }
    public string? UsdPath { get; init; }
    public string? UrdfPath { get; init; }

    public double BaseX { get; init; }
    public double BaseY { get; init; }
    public double BaseZ { get; init; }
    public double BaseYaw { get; init; }

    public string? RosNamespace { get; init; }
    public string? GraphPath { get; init; }
}
```

## 6. API đề xuất

### 6.1 CRUD robot

```http
GET    /api/robots
POST   /api/robots
GET    /api/robots/{id}
PUT    /api/robots/{id}
DELETE /api/robots/{id}
```

### 6.2 SceneBinding

```http
GET    /api/robots/{id}/scene-binding
PUT    /api/robots/{id}/scene-binding
```

Hoặc nếu backend hiện tại chưa muốn route riêng, có thể update trong:

```http
PUT /api/robots/{id}
```

Nhưng route riêng sẽ rõ hơn cho Layout Mode.

### 6.3 Runtime connection

Không cần làm trong phase viewport renderer, nhưng nên giữ định hướng:

```http
POST /api/robots/{id}/test-connection
POST /api/robots/{id}/connect
POST /api/robots/{id}/disconnect
GET  /api/robots/{id}/runtime-state
```

### 6.4 Command

Không sửa ở phase này nếu command flow đang chạy ổn:

```http
POST /api/robots/{id}/commands
GET  /api/robots/{id}/commands
```

## 7. Mapping backend sang frontend

Backend response:

```json
{
  "id": "1f2a",
  "name": "FR5 Line 1",
  "robotCode": "fr5_001",
  "vendor": "Fairino",
  "model": "FR5",
  "mode": "simulator",
  "status": "connected",
  "sceneBinding": {
    "stageId": "main_lab",
    "primPath": "/World/Robots/fr5_001",
    "usdPath": "/Assets/Robots/Fairino/FR5/fr5.usd",
    "urdfPath": "/assets/robots/fairino/fr5/fr5.urdf",
    "baseX": 0,
    "baseY": 0,
    "baseZ": 0,
    "baseYaw": 0,
    "rosNamespace": "/robots/fr5_001"
  }
}
```

Frontend normalize:

```ts
function normalizeRobot(response: RobotResponse): RobotInstance {
  return {
    id: response.id,
    name: response.name,
    robotCode: response.robotCode,
    vendor: response.vendor ?? 'Fairino',
    model: response.model ?? 'FR5',
    mode: response.mode ?? 'simulator',
    status: response.status ?? 'offline',
    sceneBinding: {
      baseX: response.sceneBinding?.baseX ?? 0,
      baseY: response.sceneBinding?.baseY ?? 0,
      baseZ: response.sceneBinding?.baseZ ?? 0,
      baseYaw: response.sceneBinding?.baseYaw ?? 0,
      stageId: response.sceneBinding?.stageId,
      primPath: response.sceneBinding?.primPath,
      usdPath: response.sceneBinding?.usdPath,
      urdfPath: response.sceneBinding?.urdfPath,
      rosNamespace: response.sceneBinding?.rosNamespace,
      graphPath: response.sceneBinding?.graphPath
    }
  }
}
```

## 8. Validation rules

### 8.1 Khi tạo robot

```text
name không rỗng
name không trùng trong cùng company/stage
model phải là FR5 trong phase này
mode phải là simulator hoặc real
nếu simulator thì tạo sceneBinding default
nếu real thì IP bắt buộc ở real profile
```

### 8.2 Khi update SceneBinding

```text
baseX/baseY/baseZ/baseYaw phải là number hợp lệ
không NaN
không Infinity
primPath nếu có thì không trùng robot khác trong cùng stage
rosNamespace nếu có thì không trùng robot khác trong cùng stage
```

### 8.3 Warning nếu robot chồng nhau

Nếu hai robot có base pose quá gần nhau:

```text
distance < 0.1m
```

thì hiển thị warning trong frontend:

```text
Warning: Robot placement overlaps another robot.
```

Không cần chặn save ở phase đầu, nhưng nên cảnh báo.

## 9. Prompt backend cho Antigravity

```text
Bạn hãy đọc backend SynTwin_Backend và kiểm tra RobotsController / Robot DTO hiện tại.

Mục tiêu:
- Đảm bảo RobotResponse có sceneBinding gồm baseX/baseY/baseZ/baseYaw.
- Nếu chưa có API update scene binding, thêm endpoint PUT /api/robots/{id}/scene-binding.
- Không sửa auth/company/subscription logic.
- Không thay đổi command flow.
- Không lưu secret trong RobotResponse.
- Không trả DeviceSecret về frontend.

Files cần đọc:
- src/Syntwin.Api/Controllers/RobotsController.cs
- src/Syntwin.Application/Robots/Dtos/RobotResponse.cs
- các entity/repository/service liên quan tới Robots

Yêu cầu:
1. Trả về danh sách file cần sửa.
2. Giữ backward compatibility với frontend hiện tại.
3. Nếu migration DB cần thiết, nói rõ migration cần thêm columns/table gì.
4. Không code runtime real Fairino trong phase này.
```

## 10. Prompt frontend API client cho Antigravity

```text
Bạn hãy cập nhật backendRobotClient.ts để support sceneBinding.

Mục tiêu:
- parse RobotResponse.sceneBinding
- expose updateRobotSceneBinding(robotId, sceneBinding)
- không phá các hàm fetch/create/update/delete robot hiện tại
- TypeScript typecheck pass

Files:
- src/renderer/src/services/backendRobotClient.ts
- src/renderer/src/types/robot.types.ts

Acceptance:
- fetchRobots trả về RobotInstance[] có sceneBinding default nếu backend thiếu field
- updateRobotSceneBinding gọi đúng API
- lỗi API được handle an toàn
```

## 11. Checklist kiểm thử model/API

```text
[ ] GET /api/robots trả về nhiều robot.
[ ] Mỗi robot có id/name/model/mode.
[ ] Robot simulator có sceneBinding.
[ ] Nếu sceneBinding null, frontend vẫn default base pose 0,0,0,0.
[ ] PUT /api/robots/{id}/scene-binding update thành công.
[ ] Reload app robot vẫn giữ vị trí mới.
[ ] Không có secret trong response.
[ ] Không phá create/update/delete robot cũ.
```
