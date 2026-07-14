# 01 - Module Scope & Coding Rules cho Antigravity

## 1. Mục tiêu của module

Module cần vibe code lần này là:

> **Multi-Robot Viewport Renderer + SceneBinding + Single Active Robot Control**

Mục tiêu không phải là làm toàn bộ multi-robot runtime song song ngay lập tức. Mục tiêu đúng ở phase hiện tại là:

- Viewport có thể render **nhiều robot Fairino FR5** cùng lúc.
- Mỗi robot có vị trí base riêng trong scene thông qua `sceneBinding`.
- User có thể click vào robot trong scene để chọn robot active.
- Chỉ **robot active** được điều khiển bởi joint sliders, IK, MoveJ, MoveL, workflow playback hiện tại.
- Các robot không active chỉ hiển thị static ở home pose hoặc latest pose nếu đã có telemetry.
- Không phá flow backend command hiện tại.
- Không chạy nhiều workflow song song ở phase này.
- Không làm multi-runtime manager ở phase này.

## 2. Bối cảnh hiện tại cần nói rõ cho Antigravity

Trước khi code, Antigravity phải hiểu trạng thái hiện tại của project:

```text
Project frontend:
D:/EXE_SynTwin/Fairino-Studio

Project backend:
D:/EXE_SynTwin/SynTwin_Backend
```

Các file frontend quan trọng:

```text
D:/EXE_SynTwin/Fairino-Studio/src/renderer/src/components/viewport/Viewport3D.tsx
D:/EXE_SynTwin/Fairino-Studio/src/renderer/src/store/robotStore.ts
D:/EXE_SynTwin/Fairino-Studio/src/renderer/src/types/robot.types.ts
D:/EXE_SynTwin/Fairino-Studio/src/renderer/src/components/robot/RobotSidebar.tsx
D:/EXE_SynTwin/Fairino-Studio/src/renderer/src/services/backendRobotClient.ts
```

Các file backend liên quan nếu làm API lưu placement:

```text
D:/EXE_SynTwin/SynTwin_Backend/src/Syntwin.Api/Controllers/RobotsController.cs
D:/EXE_SynTwin/SynTwin_Backend/src/Syntwin.Application/Robots/Dtos/RobotResponse.cs
```

Trạng thái hiện tại dự kiến:

- Backend/sidebar đã có nhiều robot.
  Store hiện đã có robots[] + selectedRobotId + setRobots + upsertRobot + selectRobot.
  Không tạo lại các state/action này nếu đã tồn tại.
- Viewport hiện còn tư duy single robot:
  - `robotRef` là một object duy nhất.
  - URDF loader chỉ load một robot.
  - `selectedRobotSceneBinding` chỉ apply vào robotRef hiện tại.
  - `jointAngles` global đang điều khiển một robot.
- Khi có 2 robot trong sidebar, scene vẫn chỉ hiển thị 1 model.

## 3. Định nghĩa module đúng

Module này gồm 4 phần chính:

```text
1. Multi-robot renderer
   Render nhiều robot trong Viewport3D từ robots list.

2. Selection
   Click vào robot trong scene để selectRobot(robotId).

3. SceneBinding
   Mỗi robot có base pose riêng:
   baseX, baseY, baseZ, baseYaw.

4. Single active control
   Chỉ robot selected/active nhận jointAngles global hiện tại.
```

## 4. Không được làm ở phase này

Antigravity tuyệt đối không tự mở rộng scope sang các phần sau nếu chưa được yêu cầu:

```text
Không chạy nhiều workflow song song.
Không tạo BackendDeviceSimulatorManager.
Không sửa command API nếu chưa cần.
Không sửa telemetry history nếu chưa cần.
Không thêm URDF upload.
Không đổi kiến trúc backend lớn.
Không xóa flow MoveJ, MoveL, IK hiện có.
Không xóa workflow playback hiện có.
Không đổi business logic subscription/auth/company.
Không hard-code robot chỉ có 1 con.
Không tạo state global mới làm đè state cũ.
```

## 5. Rule bảo toàn logic cũ

Khi code, bắt buộc giữ nguyên các logic sau:

- Joint sliders hiện tại vẫn hoạt động với robot active.
- MoveJ vẫn gửi command như cũ.
- MoveL vẫn gửi command như cũ.
- IK panel nếu có vẫn chỉ tác động robot active.
- Workflow playback hiện tại vẫn chỉ chạy cho robot active.
- Backend command flow hiện tại không bị đổi.
- `npm.cmd run typecheck` phải pass.
- Không để memory leak do robot object cũ không bị remove khỏi scene.
- Không để duplicate robot khi state update nhiều lần.

## 6. Khái niệm chuẩn trong module

### 6.1 Robot active

Robot active là robot đang được chọn:

```ts
selectedRobotId: string | null
```

Robot active là robot duy nhất được điều khiển bởi:

```text
jointAngles global
MoveJ
MoveL
IK
workflow playback
manual jogging
```

### 6.2 Robot non-active

Robot non-active là robot vẫn xuất hiện trong scene nhưng không nhận control realtime từ UI hiện tại.

Robot non-active nên:

- Render static ở home pose hoặc latest pose.
- Có label/status.
- Có thể click để select.
- Không bị update joint bởi `jointAngles` global.
- Không bị workflow hiện tại điều khiển.

### 6.3 SceneBinding

`SceneBinding` là dữ liệu map robot trong backend/store với vị trí trong scene.

Dạng tối thiểu:

```ts
type RobotSceneBinding = {
  stageId?: string
  primPath?: string
  usdPath?: string
  baseX: number
  baseY: number
  baseZ: number
  baseYaw: number
  rosNamespace?: string
  graphPath?: string
}
```

Ý nghĩa:

```text
baseX/baseY/baseZ: vị trí robot trên sàn factory
baseYaw: góc xoay robot quanh trục Y hoặc Z tùy hệ tọa độ hiện tại của project
primPath: path trong Isaac Sim hoặc scene tree nếu có
usdPath: asset runtime nếu dùng Isaac Sim/USD
rosNamespace: namespace riêng nếu kết nối ROS2
```

Với Three.js/Fairino viewport hiện tại, ít nhất phải dùng:

```text
baseX
baseY
baseZ
baseYaw
```

## 7. View mode cần hướng tới

Nên thiết kế viewport có 3 mode, nhưng phase này có thể implement dần:

### Factory View

Mục tiêu: monitoring nhiều robot.

Đặc điểm:

- Render tất cả robot.
- Label nổi cho từng robot.
- Màu theo trạng thái.
- Click robot để select.
- Không chỉnh joint trực tiếp nếu không phải robot active.
- Camera fit toàn scene.

### Robot Focus View

Mục tiêu: lập trình/debug 1 robot.

Đặc điểm:

- Robot selected hiển thị rõ.
- Robot khác có thể mờ hoặc giữ nguyên.
- Sidebar/workflow/telemetry bám theo `selectedRobotId`.
- Control panel chỉ tác động robot active.

### Layout / Arrange Mode

Mục tiêu: đặt vị trí robot trong factory.

Đặc điểm:

- Kéo thả robot trên mặt sàn.
- Chỉ chỉnh base pose, không chỉnh joint.
- Có snap grid.
- Có save placement.
- Gọi API update SceneBinding.

## 8. Strategy triển khai an toàn

Không bảo Antigravity code tất cả trong một lần. Chia thành các bước nhỏ:

```text
Step 1: Đọc file và phân tích current structure.
Step 2: Thêm type helper nếu thiếu.
Step 3: Refactor Viewport3D từ robotRef sang robotRefs Map.
Step 4: Render robots list.
Step 5: Chỉ update joints cho selected robot.
Step 6: Click select robot.
Step 7: Label/highlight selected robot.
Step 8: Typecheck.
Step 9: Manual test.
```

## 9. Output yêu cầu Antigravity trả về

Mỗi lần prompt Antigravity, yêu cầu output theo format này:

```text
1. Files modified
2. Summary of changes
3. Patch/code changes
4. Ctrl+F anchors
5. Why this does not break existing flow
6. Manual test checklist
7. Typecheck result
```

## 10. Commit strategy

Nên commit theo từng phase:

```text
feat(viewport): render multiple robots from store
feat(viewport): select robot by scene click
feat(viewport): highlight selected robot and show labels
feat(layout): add layout mode for robot scene binding
fix(viewport): prevent non-active robot joint updates
```

Không nên commit một lần quá lớn vì module viewport dễ bị lỗi khó rollback.

## 11. Definition of Done cấp module

Module được coi là đạt khi:

```text
[ ] Khi có 2 robot trong store, viewport render đủ 2 robot.
[ ] Mỗi robot nằm đúng baseX/baseY/baseZ/baseYaw.
[ ] Click robot trong scene đổi selectedRobotId.
[ ] Robot selected có highlight/label rõ.
[ ] Joint slider chỉ làm robot selected chuyển động.
[ ] Robot non-active không bị jointAngles global làm đổi pose.
[ ] Add/delete robot không tạo duplicate object.
[ ] Remove robot khỏi store thì object cũng bị remove khỏi scene.
[ ] Reload app vẫn render robot theo dữ liệu backend/store.
[ ] npm.cmd run typecheck pass.
[ ] Không phá MoveJ/MoveL/IK/workflow playback hiện tại.
```

## 12. Prompt tổng quan copy cho Antigravity

```text
Bạn hãy vibe code module Multi-Robot Viewport Renderer cho project Fairino-Studio.

Mục tiêu phase này:
- Render nhiều robot trong Viewport3D từ robots list.
- Chỉ robot active/selected được điều khiển.
- Robot không active chỉ render static.
- Mỗi robot apply sceneBinding riêng: baseX/baseY/baseZ/baseYaw.
- Click robot trong scene phải selectRobot(robotId).
- Không làm multi-runtime song song.

Bối cảnh:
- Backend/sidebar đã có nhiều robot.
- Store có hoặc sẽ có robots + selectedRobotId.
- Viewport3D hiện đang single robot với robotRef.
- jointAngles hiện đang global và chỉ nên tác động robot selected.

Files cần đọc trước:
- src/renderer/src/components/viewport/Viewport3D.tsx
- src/renderer/src/store/robotStore.ts
- src/renderer/src/types/robot.types.ts
- src/renderer/src/components/robot/RobotSidebar.tsx
- src/renderer/src/services/backendRobotClient.ts

Rules:
- Không phá MoveJ, MoveL, IK, workflow playback.
- Không đổi backend command flow.
- Không chạy nhiều workflow song song.
- Không tạo BackendDeviceSimulatorManager.
- Không thêm URDF upload.
- npm.cmd run typecheck phải pass.

Hãy làm theo phase nhỏ, trước tiên chỉ phân tích current code và đề xuất danh sách file cần sửa.
```
