# Fairino Studio UI Refactor Plan

Updated: 2026-06-29

Purpose: document a UI-only upgrade plan for Fairino Studio so another AI/engineer can implement the design cleanly without changing the original robot/backend logic.

## Current Backup Point

Before UI refactor, the current Fairino state was committed and pushed:

```text
42189e9 chore: backup Fairino before UI refactor
```

Use this commit as the rollback point if any UI refactor breaks behavior.

## Main Goal

Upgrade Fairino Studio into a cleaner dark industrial robot IDE:

- Center viewport is the main visual focus.
- Left panel is for live robot control and connection.
- Right panel is for workflow/program building.
- Bottom console is secondary and collapsed by default.
- Safety Policy, Command History, and detailed workflow step fields should open in centered modal/panel overlays, not dropdowns that push or cover lower fields.

This is a UI upgrade only. Do not change robot movement, backend communication, safety validation, command execution, LUA generation, stores, or services unless explicitly required for wiring existing UI actions.

## Non-Negotiable Logic Rules

Do not modify core logic in these areas:

```text
src/renderer/src/services/
src/renderer/src/store/
src/renderer/src/engine/
src/renderer/src/types/
src/main/
src/preload/
```

Avoid changing logic in:

```text
src/renderer/src/components/viewport/Viewport3D.tsx
src/renderer/src/components/workflow/WorkflowPanel.tsx
src/renderer/src/components/BackendProgramControls.tsx
src/renderer/src/components/BackendSimulatorPanel.tsx
```

Allowed in those files:

- JSX layout changes.
- CSS/className changes.
- Moving an existing component to another panel.
- Passing props for UI presentation.
- Extracting existing rendered content into a modal component.

Not allowed:

- Changing `backendDeviceSimulator.start`.
- Changing `backendDeviceSimulator.stop`.
- Changing `handleConnect`.
- Changing `handleDisconnect`.
- Changing `handleSaveAndRun`.
- Changing command polling logic.
- Changing safety validation API calls.
- Changing FK/IK/collision detection/MoveL runner.
- Changing `generateLua`.
- Changing Zustand store behavior.

## Target Layout

```text
Top Bar
Left Robot/Connection Panel | Center 3D Viewport | Right Program Workflow Panel
Bottom Collapsible Console
```

Target desktop size:

```text
1920x1080
```

Recommended widths:

```text
Top bar height: 48px to 56px
Left panel width: 320px
Right panel width: 360px to 400px
Bottom console collapsed height: 40px to 44px
Bottom console expanded height: 30% to 35% viewport
```

## Visual Direction

Use current project stack:

- React
- TypeScript
- Tailwind classes
- lucide-react icons
- Monaco Editor
- Three.js viewport

Do not add:

- CDN Tailwind script
- Google Material Symbols
- external font CDN dependency
- unrelated UI framework

Color direction:

```text
Background: dark neutral
Surface: slightly lighter dark gray
Border: subtle gray
Primary: blue
Success: green
Warning: amber
Danger: red
Purple/violet: avoid as primary
```

Radius:

```text
Use 4px to 8px radius.
Avoid overly round dashboard cards.
```

## Files To Add

Add these UI shell components if useful:

```text
src/renderer/src/components/ui/CenterModal.tsx
src/renderer/src/components/ui/BottomConsole.tsx
src/renderer/src/components/ui/PanelButton.tsx
src/renderer/src/components/ui/StatusBadge.tsx
```

Suggested responsibilities:

### CenterModal.tsx

Reusable centered overlay panel for large secondary content.

Props:

```ts
interface CenterModalProps {
  title: string
  subtitle?: string
  icon?: React.ReactNode
  open: boolean
  onClose: () => void
  children: React.ReactNode
  size?: 'md' | 'lg' | 'xl'
}
```

Behavior:

- Render nothing if `open` is false.
- Fixed inset overlay.
- Semi-transparent backdrop.
- Centered panel.
- Close button in header.
- Escape key close is optional.
- Do not change child logic.

### BottomConsole.tsx

Reusable bottom drawer for secondary debug/output views.

Tabs:

```text
Console
LUA Preview
Command Log
```

Behavior:

- Collapsed by default.
- Expanded only when user opens it.
- `LUA Preview` should render existing `CodePanel`.
- `Console` and `Command Log` can be placeholder panels first if no existing content.

### PanelButton.tsx

Small consistent button for right panel actions such as:

```text
Safety Policy
Command History
Step Details
```

### StatusBadge.tsx

Optional badge for:

```text
Connected
Connecting
Offline
Running
Failed
Collision
```

## Files To Modify

### 1. App Shell

Modify:

```text
src/renderer/src/App.tsx
```

Current issues:

- `BackendSimulatorPanel` is rendered inside the center viewport area.
- `CodePanel` is open by default and takes fixed height.
- Center viewport loses focus.

Required changes:

- Remove `BackendSimulatorPanel` from center viewport.
- Add `BottomConsole` at the bottom of the center shell or entire app shell.
- Set LUA preview collapsed by default.
- Keep `Viewport3D` as the main center content.
- Keep `RobotSidebar`, `WorkflowPanel`, and `BackendProgramControls`.

Target structure:

```tsx
<div className="flex h-screen w-screen flex-col overflow-hidden ...">
  <Header />

  <div className="flex min-h-0 flex-1 overflow-hidden">
    <RobotSidebar />

    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="relative min-h-0 flex-1">
        <Viewport3D />
      </div>
      <BottomConsole />
    </main>

    <aside className="flex h-full w-[380px] shrink-0 flex-col overflow-hidden">
      <BackendProgramControls />
      <WorkflowPanel />
    </aside>
  </div>
</div>
```

Do not change data flow.

### 2. Backend Simulator Placement

Modify:

```text
src/renderer/src/components/robot/RobotSidebar.tsx
src/renderer/src/components/BackendSimulatorPanel.tsx
```

Current issue:

- Backend simulator is a floating panel in the viewport.

Required changes:

- Add a `Connection` tab in `RobotSidebar`.
- Keep existing `Robot` tab.
- Keep existing `Scene`/device list tab, but rename it consistently if needed.
- Render `BackendSimulatorPanel` inside the `Connection` tab.
- Convert `BackendSimulatorPanel` from absolute floating card to normal panel content.

Suggested tabs:

```text
Robot | Connection | Scene
```

Important:

- Keep all connect/disconnect behavior identical.
- Keep localStorage keys unchanged.
- Keep status formatting unchanged unless only visual.

### 3. Viewport Overlay Cleanup

Modify:

```text
src/renderer/src/components/viewport/Viewport3D.tsx
```

Only change JSX overlay near the return block.

Required changes:

- Collision warning becomes compact top-center banner.
- Shortcut hint becomes smaller and less dominant.
- Viewport toolbar stays right side.
- Joint tooltip remains compact.
- Do not add fake data unless clearly labeled.

Do not change:

- Scene initialization.
- Camera behavior.
- WASD logic.
- URDF loading.
- Collision detection.
- Measurement logic.
- TransformControls logic.
- FK/IK.
- MoveL runner.

### 4. Backend Program Controls

Modify:

```text
src/renderer/src/components/BackendProgramControls.tsx
```

Current issue:

- Safety Policy and Command History appear as dropdown/collapsible sections inside the right panel.
- When opened, they take vertical space and make lower workflow fields hard to see.
- Primary action uses violet, competing with blue.

Required changes:

- Replace inline Safety Policy section with a button:

```text
Safety Policy
```

- When clicked, open `CenterModal`.
- The modal body should render existing `RobotSafetyPolicyPanel`.
- Do not change `RobotSafetyPolicyPanel` logic.

- Replace inline Command History section with a button:

```text
Command History
```

- When clicked, open `CenterModal`.
- The modal body should render the existing command history list/detail content.
- Keep refresh button inside the modal header or modal body.
- Keep existing command polling logic.
- Keep detail popover logic if possible, or render details inside the modal.

- Change `Save, Publish and Run` primary button to blue.
- Keep error/result message compact under primary action.

Suggested right panel top:

```text
Backend Program
[Logged in status]
[Save, Publish & Run]
[Export Backend LUA] [Logout]
[compact status/error message]
[Safety Policy] [Command History]
```

Do not change:

- Login API behavior.
- Token storage.
- Save/publish/run flow.
- Safety diagnostics handling.
- Command history API calls.
- Backend LUA export.

### 5. Workflow Panel And Step Details

Modify:

```text
src/renderer/src/components/workflow/WorkflowPanel.tsx
src/renderer/src/components/workflow/BlockWorkspace.tsx
```

Current issue:

- Workflow steps currently show fields inline.
- For steps with editable fields, the right panel can become dense and hard to scan.

Required changes:

- Keep current workflow step list behavior.
- Keep add/reorder/delete behavior.
- Add a small `Details` or `Fields` icon/button on each workflow step card.
- When clicked, open a centered modal/panel showing full fields for that step.
- Inline step card should show only summary:

```text
Step number
Step type badge
Step label
Key params summary
Error state if any
Up/down/delete buttons
Details button
```

Step details modal should show editable fields currently shown inline, for example:

- WaitMs delay field.
- SetDO type/index/value fields.
- MoveJ joint values summary.
- MoveL TCP pose summary.
- Speed/acc fields if currently editable in that mode.

Important:

- Reuse existing `updateStep` calls.
- Do not change step model.
- Do not change `addStep`, `removeStep`, `reorderSteps`, or `setSelectedStepId`.
- If a field already edits inline, move the same input to the modal with the same update function.

### 6. Robot Sidebar Polish

Modify:

```text
src/renderer/src/components/robot/RobotSidebar.tsx
```

Required changes:

- Make robot header compact.
- Show:

```text
Fairino FR5
ACTIVE or CONNECTED
Payload 5kg
Reach 924mm
6-DOF
```

- Keep Joint/Cartesian mode.
- Keep units.
- Keep collision hitbox toggle.
- Keep J1-J6 sliders.
- Keep TCP pose readout.
- Keep Home button.

Emergency Stop:

- Add only if it uses existing logic safely.
- Suggested action:

```ts
cancelActiveCommand('Emergency stop triggered from Fairino Studio UI')
setPlaying(false)
setCurrentStepIndex(0)
setSelectedStepId(null)
setCollisionWarning(false)
```

Do not create a fake Emergency Stop button that only changes UI.

### 7. Code Panel

Modify:

```text
src/renderer/src/components/code/CodePanel.tsx
```

Required changes:

- Render cleanly inside `BottomConsole`.
- Keep Monaco read-only LUA preview.
- Keep copy behavior.
- No fixed global height assumption.

Do not change:

- `generateLua`.
- Clipboard copy logic except visual labels.

### 8. Header

Modify:

```text
src/renderer/src/components/layout/Header.tsx
```

Required changes:

- Keep compact top bar.
- Keep project name input.
- Keep new/open/save/import/export functions.
- Keep language selector.
- Make visual hierarchy quieter:
  - Export LUA can remain primary.
  - New/Open/Save/Import should be secondary icon buttons.

Do not change:

- File open/save logic.
- LUA import/export logic.
- Project serialization/deserialization.

### 9. CSS Tokens

Modify:

```text
src/renderer/src/assets/base.css
src/renderer/src/assets/main.css
```

Required changes:

- Add local Fairino design tokens.
- Avoid CDN or global external styles.

Suggested variables:

```css
:root {
  --fairino-bg: #11131b;
  --fairino-surface-lowest: #0c0e16;
  --fairino-surface-low: #141720;
  --fairino-surface: #1b1e27;
  --fairino-surface-high: #242833;
  --fairino-border: #343849;
  --fairino-text: #e1e7f5;
  --fairino-muted: #95a0b8;
  --fairino-primary: #2563eb;
  --fairino-primary-soft: rgba(37, 99, 235, 0.14);
  --fairino-success: #10b981;
  --fairino-warning: #f59e0b;
  --fairino-danger: #ef4444;
}
```

Then gradually replace noisy hard-coded colors in UI components.

## Files Not To Delete

Do not delete these:

```text
src/renderer/src/components/BackendSimulatorPanel.tsx
src/renderer/src/components/BackendProgramControls.tsx
src/renderer/src/components/RobotSafetyPolicyPanel.tsx
src/renderer/src/components/SafetyDiagnosticsPanel.tsx
src/renderer/src/components/workflow/WorkflowPanel.tsx
src/renderer/src/components/workflow/BlockWorkspace.tsx
src/renderer/src/components/code/CodePanel.tsx
src/renderer/src/components/viewport/Viewport3D.tsx
```

They may be moved, wrapped, or visually refactored, but their logic must remain.

## Files That May Be Added But Are Optional

```text
src/renderer/src/components/ui/CenterModal.tsx
src/renderer/src/components/ui/BottomConsole.tsx
src/renderer/src/components/ui/IconButton.tsx
src/renderer/src/components/ui/SectionHeader.tsx
src/renderer/src/components/workflow/WorkflowStepDetailsModal.tsx
src/renderer/src/components/backend/CommandHistoryModal.tsx
src/renderer/src/components/backend/SafetyPolicyModal.tsx
```

Use optional wrappers only if they reduce duplicated JSX.

## Modal Requirements

### Safety Policy Modal

Trigger:

```text
Right panel button: Safety Policy
```

Content:

```tsx
<RobotSafetyPolicyPanel backendUrl={cfg.backendUrl} robotId={cfg.robotId} token={token} />
```

UX:

- Center screen.
- Large enough for editing.
- Scroll inside modal body, not the whole app.
- Close button top-right.
- No dropdown behavior.

### Command History Modal

Trigger:

```text
Right panel button: Command History
```

Content:

- Existing command history list.
- Refresh command history button.
- Command status badges.
- Failed command message.
- Detail view for selected command.

UX:

- Center screen.
- Split layout is recommended:

```text
Left: command list
Right: selected command detail
```

- Do not let the history list push workflow content down.

### Workflow Step Details Modal

Trigger:

```text
Step card button: Fields or Details
```

Content depends on step type:

```text
MoveJ: joint angles, speed, acc
MoveL: tcp pose, joint solution summary if available, speed, acc
WaitMs: delayMs input
SetDO: doType, doIndex, doValue inputs
GripperOpen/Close: basic step info
Comment: comment text if supported
```

UX:

- Center modal.
- Keep card inline summary compact.
- All edits must use existing `updateStep`.

## Implementation Order

### Step 1: Add CenterModal

Add:

```text
src/renderer/src/components/ui/CenterModal.tsx
```

Verify:

```powershell
npm run typecheck
```

### Step 2: Add BottomConsole And Collapse LUA Preview

Add:

```text
src/renderer/src/components/ui/BottomConsole.tsx
```

Modify:

```text
src/renderer/src/App.tsx
src/renderer/src/components/code/CodePanel.tsx
```

Verify:

```powershell
npm run typecheck
```

### Step 3: Move Backend Simulator To Connection Tab

Modify:

```text
src/renderer/src/App.tsx
src/renderer/src/components/robot/RobotSidebar.tsx
src/renderer/src/components/BackendSimulatorPanel.tsx
```

Verify:

```powershell
npm run typecheck
```

Manual check:

```text
Connection tab opens.
Backend URL / Robot ID / Device Secret inputs still work.
Connect and Disconnect still work.
No simulator card floats over viewport.
```

### Step 4: Convert Safety Policy To Modal

Modify:

```text
src/renderer/src/components/BackendProgramControls.tsx
```

Optional add:

```text
src/renderer/src/components/backend/SafetyPolicyModal.tsx
```

Verify:

```powershell
npm run typecheck
```

Manual check:

```text
Click Safety Policy.
Centered panel opens.
Policy can still load/edit/save exactly as before.
Closing modal does not reset token or command state.
```

### Step 5: Convert Command History To Modal

Modify:

```text
src/renderer/src/components/BackendProgramControls.tsx
```

Optional add:

```text
src/renderer/src/components/backend/CommandHistoryModal.tsx
```

Verify:

```powershell
npm run typecheck
```

Manual check:

```text
Click Command History.
Centered panel opens.
Refresh still works.
Failure details are visible.
Command polling still updates history.
Right workflow panel no longer gets pushed down.
```

### Step 6: Add Workflow Step Details Modal

Modify:

```text
src/renderer/src/components/workflow/WorkflowPanel.tsx
src/renderer/src/components/workflow/BlockWorkspace.tsx
```

Optional add:

```text
src/renderer/src/components/workflow/WorkflowStepDetailsModal.tsx
```

Verify:

```powershell
npm run typecheck
```

Manual check:

```text
Step card stays compact.
Click Details/Fields.
Centered modal opens.
WaitMs delay can still be edited.
SetDO fields can still be edited.
MoveJ/MoveL data is still shown.
Selecting a step still updates robot pose when expected.
```

### Step 7: Clean Viewport Overlay

Modify:

```text
src/renderer/src/components/viewport/Viewport3D.tsx
```

Only edit JSX overlay.

Verify:

```powershell
npm run typecheck
```

Manual check:

```text
Robot renders.
Grid renders.
Joint selection still works.
Collision still stops simulation.
IK/FK still works.
```

### Step 8: Visual Token Cleanup

Modify:

```text
src/renderer/src/assets/base.css
src/renderer/src/assets/main.css
```

Then update classes in:

```text
src/renderer/src/components/layout/Header.tsx
src/renderer/src/components/robot/RobotSidebar.tsx
src/renderer/src/components/BackendProgramControls.tsx
src/renderer/src/components/workflow/WorkflowPanel.tsx
src/renderer/src/components/code/CodePanel.tsx
```

Verify:

```powershell
npm run typecheck
```

### Step 9: Encoding/Text Cleanup

Modify:

```text
src/renderer/src/i18n/translations.ts
src/renderer/src/components/**/*.tsx
```

Fix mojibake strings such as:

```text
Tiáº¿ng Viá»‡t
Äang Ä‘Äƒng nháº­p
LÆ°u, Publish vÃ  Cháº¡y
Â°
```

Preferred:

- Store Vietnamese strings in UTF-8.
- If encoding problems persist on Windows, use Vietnamese without accents temporarily.
- Do not change translation keys unless all usages are updated.

Verify:

```powershell
npm run typecheck
```

## Final Verification

Run:

```powershell
cd D:\EXE_SynTwin\Fairino-Studio
npm run typecheck
npm run build
```

Manual QA:

```text
1. App launches.
2. Robot 3D model loads.
3. Joint sliders J1-J6 move robot.
4. Home works.
5. IK mode still shows transform controls.
6. Collision detection still appears.
7. Backend Connection tab can connect/disconnect simulator.
8. Telemetry/heartbeat still reaches backend.
9. Save, Publish and Run still works.
10. Safety Policy opens as center modal and still loads/saves.
11. Command History opens as center modal and still refreshes.
12. Workflow steps add/reorder/delete still work.
13. Step Details modal edits WaitMs and SetDO using existing update logic.
14. LUA Preview opens from bottom console and copy still works.
15. No panel dropdown pushes workflow content out of view.
```

## Recommended Commit Strategy

Commit after each safe step:

```text
chore(ui): add modal shell
refactor(ui): collapse lua preview into bottom console
refactor(ui): move backend simulator into connection tab
refactor(ui): open safety policy in modal
refactor(ui): open command history in modal
refactor(ui): add workflow step details modal
style(ui): clean viewport overlays
style(ui): normalize Fairino color tokens
fix(ui): repair Vietnamese labels
```

## Success Criteria

The refactor is successful when:

- UI is cleaner and easier to scan.
- Center viewport is visually dominant.
- Safety Policy and Command History no longer expand inline in the right panel.
- Workflow step details are available in a centered modal.
- No robot/backend/program logic regresses.
- Typecheck and build pass.

## Antogravity Plan Review Notes

The Antogravity plan is mostly aligned with this document. Use it as a useful implementation outline, but apply the following decisions so the UI refactor does not accidentally change runtime behavior.

### Accepted From Antogravity

Keep these ideas:

- Add `CenterModal.tsx`.
- Add `BottomConsole.tsx`.
- Move `BackendSimulatorPanel` out of the center viewport.
- Add `Connection` tab in `RobotSidebar`.
- Open Safety Policy in a centered modal.
- Open Command History in a centered modal.
- Add `WorkflowStepDetailsModal.tsx`.
- Add a `Details`/gear button on workflow step cards.
- Keep step cards compact with summaries.
- Make collision warning top-center and compact.
- Make secondary header actions icon-first.
- Add Fairino dark industrial design tokens.
- Run `npm run typecheck` and `npm run build`.

### Use With Caution

Antogravity suggests:

```text
Hoist BackendSimulatorConfig and BackendSimulatorStatus state to App.tsx.
```

Reason:

```text
If BackendSimulatorPanel is mounted only inside the Connection tab, switching tabs can unmount it. The current BackendSimulatorPanel cleanup stops the simulator on unmount.
```

This is a real issue, but there are two possible solutions.

Preferred low-risk solution:

```text
Keep BackendSimulatorPanel mounted and only hide/show it with CSS when switching tabs.
```

Why this is safer:

- It avoids moving simulator state/control logic into `App.tsx`.
- It keeps `backendDeviceSimulator.start/stop` in the existing component.
- It reduces behavior risk.

Alternative higher-risk solution:

```text
Hoist config/status/control callbacks to App.tsx or a dedicated hook.
```

Only choose this if the keep-mounted approach becomes messy.

If hoisting is chosen, do not rewrite behavior. Extract existing logic carefully into:

```text
src/renderer/src/hooks/useBackendSimulatorController.ts
```

Then `BackendSimulatorPanel` becomes mostly presentational. This should be a separate commit, because it is no longer purely visual.

### Do Not Add Fake Runtime Data As Real UI

Antogravity suggests placeholders:

```text
Console placeholder with mock telemetry/system logs
Command Log placeholder listing executed actions
```

Allowed:

- Empty placeholder state.
- "No console output yet."
- "Command log will appear here."

Avoid:

- Fake telemetry that looks real.
- Fake command history.
- Fake FPS/LAT if there is no real source.

### Workflow Step Details Modal Scope

The modal should support both:

```text
WorkflowPanel.tsx
BlockWorkspace.tsx
```

But do not duplicate editing logic. Prefer one shared component:

```text
src/renderer/src/components/workflow/WorkflowStepDetailsModal.tsx
```

It should receive:

```ts
step: WorkflowStep | null
open: boolean
onClose: () => void
onUpdate: (stepId: string, patch: Partial<WorkflowStep>) => void
```

The parent component should still own selection and use the existing `updateStep`.

### Safety Policy And Command History Modal Scope

Safety Policy:

- OK to render existing `RobotSafetyPolicyPanel` inside `CenterModal`.
- Do not rewrite policy loading/saving.

Command History:

- Prefer extracting the existing command history UI from `BackendProgramControls.tsx` into a presentational section or modal component.
- Keep polling and command API logic where it currently lives unless intentionally refactored in a separate commit.
- A split modal layout is recommended:

```text
Left: command list
Right: selected command detail
```

### Final Decision

Implementation should follow this order:

```text
1. Add CenterModal.
2. Add BottomConsole.
3. Move BackendSimulatorPanel to Connection tab while keeping it mounted.
4. Convert Safety Policy to modal.
5. Convert Command History to modal.
6. Add shared WorkflowStepDetailsModal.
7. Clean viewport overlays.
8. Apply color tokens.
9. Fix text encoding.
```

Do not start with hoisting simulator state unless there is no clean keep-mounted solution.
