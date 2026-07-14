# 06 - Antigravity Phase Prompts

## 1. Cách dùng file này

Không đưa toàn bộ requirement cho Antigravity một lần rồi bảo nó code hết. Hãy chạy theo từng prompt nhỏ.

Quy trình:

```text
Prompt 0: Read-only analysis
Prompt 1: Types/store
Prompt 2: API client sceneBinding
Prompt 3: Multi-robot renderer
Prompt 4: Scene click selection + highlight
Prompt 5: Layout Mode
Prompt 6: Hardening + typecheck + manual test
```

Sau mỗi prompt:

```text
1. Đọc patch
2. Chạy typecheck
3. Chạy app
4. Test thủ công
5. Commit
6. Mới chuyển prompt tiếp theo
```

## 2. Prompt 0 - Read-only analysis

```text
Bạn hãy đọc code hiện tại nhưng chưa sửa file.

Mục tiêu phân tích:
- Viewport3D hiện đang render robot như thế nào?
- robotRef hiện nằm ở đâu?
- URDF loader được gọi ở đâu?
- jointAngles global được apply vào robot object ở đâu?
- robotStore hiện có robots[] và selectedRobotId chưa?
- RobotSidebar đang select robot như thế nào?
- backendRobotClient fetch robots như thế nào?
- Có sceneBinding trong type/backend response chưa?

Files cần đọc:
- src/renderer/src/components/viewport/Viewport3D.tsx
- src/renderer/src/store/robotStore.ts
- src/renderer/src/types/robot.types.ts
- src/renderer/src/components/robot/RobotSidebar.tsx
- src/renderer/src/services/backendRobotClient.ts

Không được sửa code ở prompt này.

Hãy trả về:
1. Current architecture summary.
2. Danh sách single-robot assumptions.
3. Danh sách file cần sửa theo phase.
4. Rủi ro có thể phá MoveJ/MoveL/IK/workflow.
5. Plan patch nhỏ nhất để render nhiều robot.
```

## 3. Prompt 1 - Types/store migration

```text
Bạn hãy sửa tối thiểu types/store để support multi-robot visual.

Mục tiêu:
- Đảm bảo có RobotSceneBinding type.
- Đảm bảo RobotInstance có optional sceneBinding.
- Đảm bảo robotStore có robots[] và selectedRobotId.
- Đảm bảo có selectRobot(robotId).
- Đảm bảo có updateRobotSceneBinding(robotId, sceneBinding).
- Không xóa jointAngles global.
- Không xóa workflow state hiện tại.
- Không đổi backend command flow.

Files:
- src/renderer/src/types/robot.types.ts
- src/renderer/src/store/robotStore.ts

Rules:
- Backward compatible.
- Nếu field đã tồn tại thì reuse, không duplicate type.
- Nếu naming hiện tại khác, hãy adapt theo naming hiện tại.
- TypeScript typecheck phải pass.

Output:
- Files modified.
- Code patch.
- Ctrl+F anchors.
- Manual test.
```

## 4. Prompt 2 - backendRobotClient sceneBinding

```text
Bạn hãy cập nhật backendRobotClient để parse và update sceneBinding.

Mục tiêu:
- fetchRobots trả về robots có sceneBinding default nếu backend chưa trả field.
- Có function updateRobotSceneBinding(robotId, sceneBinding).
- Không phá createRobot/updateRobot/deleteRobot hiện tại.
- Không expose deviceSecret.
- Handle API error an toàn.

Files:
- src/renderer/src/services/backendRobotClient.ts
- src/renderer/src/types/robot.types.ts

Nếu backend chưa có endpoint riêng:
- Implement function theo endpoint hiện có nếu phù hợp.
- Nếu chưa thể gọi API thật, tạo TODO rõ ràng nhưng không mock sai business logic.

Acceptance:
- Typecheck pass.
- fetchRobots vẫn hoạt động.
- updateRobotSceneBinding có signature rõ.
```

## 5. Prompt 3 - Multi-robot renderer

```text
Bạn hãy refactor Viewport3D để render nhiều robot.

Bối cảnh:
- Store đã có robots[] và selectedRobotId.
- Viewport3D hiện chỉ có robotRef single object.
- jointAngles global chỉ được dùng cho selected robot.

Yêu cầu:
1. Thay robotRef single bằng robotRefs Map<string, THREE.Object3D>.
2. Load URDF cho từng robot trong robots list.
3. Khi robots thay đổi:
   - add robot mới
   - remove robot không còn
   - update sceneBinding robot còn lại
4. Mỗi robot apply sceneBinding riêng:
   - baseX
   - baseY
   - baseZ
   - baseYaw
5. Chỉ selected robot nhận jointAngles global.
6. Non-active robot giữ home pose hoặc latest pose nếu đã có.
7. Không sửa MoveJ/MoveL/IK/workflow playback.
8. Không chạy nhiều workflow song song.
9. Không đổi backend command flow.
10. Typecheck pass.

Files:
- src/renderer/src/components/viewport/Viewport3D.tsx
- src/renderer/src/store/robotStore.ts
- src/renderer/src/types/robot.types.ts

Output:
- Files modified.
- Explanation.
- Patch theo từng file.
- Ctrl+F anchors.
- Manual test checklist.
```

## 6. Prompt 4 - Scene click selection + highlight

```text
Bạn hãy thêm scene click selection và highlight selected robot.

Yêu cầu:
- Mỗi robot object và children có userData.robotId.
- Raycast click vào mesh con vẫn tìm được robotId cha.
- Click robot gọi selectRobot(robotId).
- Không conflict với OrbitControls khi user kéo camera.
- Selected robot có highlight rõ.
- Ưu tiên BoxHelper hoặc base ring, không sửa material phức tạp.
- Có label robot name/status nếu dễ implement.
- Typecheck pass.

Files:
- src/renderer/src/components/viewport/Viewport3D.tsx
- src/renderer/src/store/robotStore.ts

Acceptance:
- Click Robot A thì selectedRobotId = A.
- Click Robot B thì selectedRobotId = B.
- Selected robot có visual indicator.
- Kéo camera không select nhầm liên tục.
```

## 7. Prompt 5 - Layout Mode

```text
Bạn hãy thêm Layout / Arrange Mode cho robot placement.

Mục tiêu:
- Có viewportMode: factory | focus | layout.
- Trong Layout Mode, chỉ chỉnh base pose của selected robot.
- Có Save Placement.
- Có Cancel Placement.
- Save gọi backendRobotClient.updateRobotSceneBinding.
- Store update sceneBinding sau khi save.
- Không gửi MoveJ/MoveL khi kéo robot.
- Không chỉnh joint.
- Không cho edit khi robot đang running nếu có status/runtime state.
- Typecheck pass.

Files:
- src/renderer/src/components/viewport/Viewport3D.tsx
- src/renderer/src/store/robotStore.ts
- src/renderer/src/services/backendRobotClient.ts
- src/renderer/src/types/robot.types.ts

Implementation hint:
- Nếu project đã có TransformControls thì dùng.
- Nếu chưa có, làm bản đầu bằng numeric input X/Y/Z/Yaw + apply live vào object.
- Không thêm dependency lớn nếu không cần.

Acceptance:
- User chọn robot.
- Vào Layout Mode.
- Đổi X/Y/Z/Yaw.
- Robot di chuyển trong scene.
- Bấm Save thì backend/store cập nhật.
- Reload app vẫn giữ vị trí.
- Bấm Cancel thì rollback.
```

## 8. Prompt 6 - Hardening

```text
Bạn hãy harden module multi-robot viewport.

Kiểm tra và sửa:
- Không duplicate robot object khi robots list update.
- Remove robot khỏi store thì scene remove object.
- Async loader không add robot đã bị xóa.
- selectedRobotId null không crash.
- Robot thiếu sceneBinding không crash.
- 2 robot cùng vị trí có warning/label.
- Non-active robot không bị jointAngles global update.
- Typecheck pass.

Không thêm feature mới lớn.

Output:
- Bug list found.
- Patch.
- Test checklist.
```

## 9. Prompt backend optional - SceneBinding endpoint

Chỉ dùng nếu backend chưa có API lưu placement.

```text
Bạn hãy thêm endpoint backend để lưu RobotSceneBinding.

Target API:
PUT /api/robots/{id}/scene-binding

Request:
{
  "baseX": 0,
  "baseY": 0,
  "baseZ": 0,
  "baseYaw": 0,
  "stageId": "main_lab",
  "primPath": "/World/Robots/fr5_001",
  "usdPath": "...",
  "urdfPath": "...",
  "rosNamespace": "/robots/fr5_001"
}

Rules:
- Không sửa auth/company logic.
- Phải validate robot thuộc company/user hiện tại nếu project đã có company authorization.
- Không trả deviceSecret.
- Không sửa command runtime.
- Nếu cần migration, tạo migration rõ ràng.

Files:
- src/Syntwin.Api/Controllers/RobotsController.cs
- src/Syntwin.Application/Robots/Dtos/RobotResponse.cs
- robot entity/service/repository liên quan

Acceptance:
- PUT sceneBinding lưu DB.
- GET robots trả lại sceneBinding mới.
- Reload frontend robot giữ placement.
```

## 10. Prompt kiểm tra cuối

```text
Bạn hãy review toàn bộ implementation multi-robot viewport.

Checklist:
- Có thể render nhiều robot.
- selectedRobotId hoạt động từ sidebar và viewport click.
- sceneBinding apply riêng từng robot.
- Joint control chỉ apply selected robot.
- Non-active robot không move theo jointAngles global.
- Layout Mode không gửi command robot.
- Save Placement update backend/store.
- Delete robot cleanup object khỏi scene.
- npm.cmd run typecheck pass.

Hãy trả về:
1. Các file đã thay đổi.
2. Các risk còn lại.
3. Manual test checklist.
4. Gợi ý commit message.
```

## 11. Command nên chạy sau mỗi phase

Tại thư mục frontend:

```cmd
cd /d D:\EXE_SynTwin\Fairino-Studio
npm.cmd run typecheck
```

Nếu có test/lint:

```cmd
npm.cmd run lint
npm.cmd test
```

Nếu cần chạy app:

```cmd
npm.cmd run dev
```

Tại backend nếu có sửa API:

```cmd
cd /d D:\EXE_SynTwin\SynTwin_Backend
dotnet build
dotnet test
```

## 12. Commit message gợi ý

```text
feat(viewport): add multi robot renderer
feat(viewport): select robot from scene
feat(viewport): highlight selected robot
feat(layout): add robot placement mode
feat(api): update robot scene binding
fix(viewport): prevent non active robot joint updates
```

---

# Addendum - Testing, DoD & Handoff Checklist

## A. Commands sau mỗi phase

Frontend:

```cmd
cd /d D:\EXE_SynTwin\Fairino-Studio
npm.cmd run typecheck
```

Nếu có lint/test:

```cmd
npm.cmd run lint
npm.cmd test
```

Backend nếu có sửa API:

```cmd
cd /d D:\EXE_SynTwin\SynTwin_Backend
dotnet build
dotnet test
```

## B. Test data tối thiểu

Chuẩn bị ít nhất 2 robot simulator:

```json
[
  {
    "id": "robot-a",
    "name": "FR5 Line 1",
    "model": "FR5",
    "mode": "simulator",
    "status": "connected",
    "sceneBinding": {
      "baseX": 0,
      "baseY": 0,
      "baseZ": 0,
      "baseYaw": 0
    }
  },
  {
    "id": "robot-b",
    "name": "FR5 Line 2",
    "model": "FR5",
    "mode": "simulator",
    "status": "offline",
    "sceneBinding": {
      "baseX": 2,
      "baseY": 0,
      "baseZ": 0,
      "baseYaw": 1.57
    }
  }
]
```

## C. Acceptance criteria tổng

```text
[ ] App load không crash.
[ ] TypeScript typecheck pass.
[ ] Backend build pass nếu có sửa backend.
[ ] Sidebar hiển thị nhiều robot.
[ ] Viewport render nhiều robot.
[ ] Mỗi robot dùng sceneBinding riêng.
[ ] selectedRobotId sync giữa sidebar và viewport.
[ ] Click robot trong viewport chọn đúng robot.
[ ] Selected robot có highlight/label.
[ ] Joint slider chỉ tác động selected robot.
[ ] Non-active robot không move theo jointAngles global.
[ ] MoveJ chỉ chạy robot selected.
[ ] MoveL chỉ chạy robot selected.
[ ] Workflow playback cũ vẫn chạy robot selected.
[ ] Layout Mode chỉnh base pose, không chỉnh joint.
[ ] Save Placement lưu backend/store.
[ ] Reload app giữ placement.
[ ] Cancel Placement rollback.
[ ] Delete robot cleanup khỏi scene.
[ ] Add robot mới không duplicate robot cũ.
[ ] Nếu 2 robot chồng nhau, UI có warning hoặc label giúp nhận biết.
```

## D. Test case quan trọng

### TC01 - Load nhiều robot

```text
Given backend/store có Robot A và Robot B
When mở app
Then viewport render 2 robot
And Robot A ở base của A
And Robot B ở base của B
```

### TC02 - Click select trong viewport

```text
Given viewport có Robot A và Robot B
When click Robot A mesh
Then selectedRobotId = Robot A
When click Robot B mesh
Then selectedRobotId = Robot B
```

### TC03 - Joint slider chỉ tác động robot active

```text
Given selectedRobotId = Robot A
When kéo joint slider
Then Robot A đổi pose
And Robot B giữ nguyên pose
```

### TC04 - Layout save

```text
Given Robot A at baseX=0
When vào Layout Mode
And đổi baseX=2
And bấm Save Placement
Then API update sceneBinding được gọi
And reload app Robot A ở X=2
```

### TC05 - Layout cancel

```text
Given Robot A at baseX=0
When vào Layout Mode
And đổi baseX=2
And bấm Cancel
Then Robot A quay về X=0
And không gọi API save
```

### TC06 - Remove robot cleanup

```text
Given viewport có Robot A và Robot B
When delete Robot B
Then Robot B biến khỏi scene
And Robot A vẫn còn
And không duplicate object khi reload state
```

## E. Console errors không được có

```text
Cannot read properties of undefined
Cannot set property position of null
Duplicate key robotId
THREE.WebGLRenderer: Context Lost
```

Không dùng `// @ts-ignore` để né lỗi type.

## F. Definition of Done cuối

```text
[ ] Multi-robot visual hoạt động.
[ ] Single active robot control ổn định.
[ ] SceneBinding được apply và lưu được.
[ ] UX có Factory/Focus/Layout hoặc ít nhất có Layout Mode rõ.
[ ] Không phá flow robot cũ.
[ ] Không tạo scope multi-runtime ngoài kế hoạch.
[ ] Code pass typecheck/build.
[ ] Manual test checklist đã chạy.
[ ] Có commit riêng theo phase.
```

## G. Những việc cố ý chưa làm

```text
Chưa làm multi-robot runtime song song.
Chưa làm Start All / Stop All.
Chưa làm collision detection vật lý đầy đủ.
Chưa làm orchestration timeline.
Chưa làm ROS2 namespace runtime thật.
Chưa làm Isaac Sim USD spawner thật nếu hiện viewport mới là Three.js/URDF.
Chưa làm Fairino real controller adapter.
```

## H. Roadmap sau module này

```text
Phase next 1: Runtime state map theo robotId.
Phase next 2: Telemetry latest per robot.
Phase next 3: Command history per robot.
Phase next 4: WorkflowDefinition per robot.
Phase next 5: BackendDeviceSimulatorManager.
Phase next 6: Multi-robot workflow parallel execution.
Phase next 7: Collision zone và safety policy.
Phase next 8: Isaac Sim bridge/spawner thật.
Phase next 9: Real Fairino adapter qua backend/edge gateway.
```
