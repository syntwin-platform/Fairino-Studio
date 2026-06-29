export const translations = {
  vi: {
    // Header
    newProject: 'Mới',
    openProject: 'Mở',
    saveProject: 'Lưu',
    exportLua: 'Xuất LUA',
    importLua: 'Nạp LUA',
    collisionWarning: 'Va chạm!',
    projectNamePlaceholder: 'Tên dự án...',
    newProjectConfirm:
      'Bạn có chắc chắn muốn tạo dự án mới? Toàn bộ các bước workflow hiện tại sẽ bị xóa.',
    projectCompatError: 'Phiên bản dự án không tương thích!',
    projectOpenSuccess: 'Đã mở dự án thành công!',
    projectReadError: 'Lỗi đọc file dự án:',
    projectSaveSuccess: 'Lưu dự án thành công!',
    projectSaveError: 'Lỗi khi lưu:',
    luaExportSuccess: 'Xuất mã nguồn Lua thành công!',
    luaExportError: 'Lỗi xuất file:',
    luaImportSuccess: 'Nạp mã nguồn LUA thành công!',
    luaImportError: 'Lỗi nạp file LUA:',
    selfDistance: 'Khoảng cách tự thân',
    aboutTitle: 'Về FaiRobot Studio',
    aboutDetail: 'Ứng dụng mô phỏng và lập trình kéo thả trực quan cho robot Fairino FR5.',

    // RobotSidebar
    controlMode: 'Chế độ điều khiển',
    jointSpace: 'Không gian khớp',
    toolCenterPoint: 'Điểm đầu công tác (TCP)',
    reset: 'Đặt lại',
    payload: 'Tải trọng',
    reach: 'Tầm với',
    jointLimitTitle: 'Khớp',

    // ScenePanel
    upload3D: 'Tải lên Thiết bị 3D',
    supportFormats: 'Hỗ trợ GLTF, GLB, STL',
    deviceList: 'Danh sách thiết bị',
    noDevices: 'Chưa có thiết bị phụ trợ nào được thêm vào.',
    transform: 'Biến đổi (Transform)',
    position: 'Vị trí (XYZ - mm)',
    rotation: 'Góc xoay (RxRyRz - độ)',
    scale: 'Tỉ lệ (Scale)',
    importFormatError: 'Chỉ hỗ trợ import file .gltf, .glb hoặc .stl!',

    // WorkflowPanel
    programmingMode: 'Chế độ lập trình',
    simpleScratch: 'Đơn giản (Scratch)',
    advancedList: 'Nâng cao (List)',
    recordWaypoint: 'Ghi tọa độ',
    recordMoveJ: 'Ghi MoveJ',
    recordMoveL: 'Ghi MoveL',
    setDO: 'Set DO',
    waitDelay: 'Đợi trễ',
    workflowSteps: 'Các bước Workflow',
    noSteps: 'Chưa có bước workflow nào.',
    useButtonsHint: 'Sử dụng nút Record Waypoint hoặc + Set DO để bắt đầu lập trình.',
    simulation: 'Mô phỏng',
    play: 'Chạy thử',
    pause: 'Tạm dừng',
    stop: 'Dừng',

    // BlockWorkspace
    dragDropHint: 'Kéo thả hoặc nhấn để thêm Khối Lệnh',
    emptyWorkspace: 'Không gian ghép lệnh đang trống',
    emptyWorkspaceHint:
      'Kéo thả các khối lệnh từ Palette ở phía trên vào đây để bắt đầu chương trình của bạn.',
    rotateJointBlock: 'Quay',
    moveTCPBlock: 'Dịch TCP trục',
    setDOBlock: 'Cài đặt cổng DO',
    cabinetDO: 'DO Tủ điều khiển',
    toolDO: 'DO Cổ tay (Tool)',
    debugHitbox: 'Hiện hộp va chạm (Hitbox)',
    waitMsBlock: 'Chờ trễ thời gian',
    gripperOpenBlock: 'Mở tay gắp',
    gripperCloseBlock: 'Đóng tay gắp',
    toAngle: 'đến góc',
    byDegrees: 'thêm',
    degrees: 'độ',
    toCoordinate: 'đến tọa độ',
    ms: 'ms',
    turnOn: 'BẬT (1)',
    turnOff: 'TẮT (0)',
    changeToOpen: 'Đổi sang Mở',
    changeToClose: 'Đổi sang Đóng',

    // Settings menu
    language: 'Ngôn ngữ',
    settings: 'Cài đặt',

    // Tooltips
    tooltipFK:
      'Động học thuận (Joint Space): Điều khiển robot bằng cách xoay trực tiếp từng khớp đơn lẻ (khớp 1 đến 6).',
    tooltipIK:
      'Động học nghịch (Cartesian Space): Điều khiển robot bằng cách kéo thả toạ độ đầu gắp (X, Y, Z). Các khớp sẽ tự động tính toán xoay theo.',
    tooltipTCP:
      'Tool Center Point: Điểm trung tâm của dụng cụ đầu gắp robot, xác định toạ độ làm việc thực tế của robot trong không gian.',
    tooltipMoveJ:
      'Di chuyển nội suy khớp: Robot quay các khớp đồng thời để đầu gắp đi tới đích theo đường cong tự nhiên. Tốc độ nhanh và tránh vật cản tốt.',
    tooltipMoveL:
      'Di chuyển nội suy thẳng: Robot di chuyển đầu gắp đi tới đích theo một đường thẳng tuyệt đối. Thường dùng khi cần cắt, hàn, hoặc gắp đặt thẳng đứng.',
    tooltipDO:
      'Digital Output (Cổng ra kỹ thuật số): Cổng tín hiệu điện dùng để điều khiển thiết bị ngoại vi như bật/tắt bơm, van khí, hay tay gắp.',
    tooltipDOVal:
      'Tín hiệu DO: Cài đặt trạng thái cổng DO. Trạng thái 1 (BẬT) kích hoạt thiết bị, trạng thái 0 (T T) ngắt hoạt động thiết bị.',
    tooltipDelay:
      'Đợi trễ: Tạm dừng chương trình trong một khoảng thời gian xác định (tính bằng mili-giây, 1s = 1000ms) trước khi thực hiện bước tiếp theo.'
  },
  en: {
    // Header
    newProject: 'New',
    openProject: 'Open',
    saveProject: 'Save',
    exportLua: 'Export LUA',
    importLua: 'Import LUA',
    collisionWarning: 'Collision!',
    projectNamePlaceholder: 'Project name...',
    newProjectConfirm:
      'Are you sure you want to create a new project? All current workflow steps will be cleared.',
    projectCompatError: 'Incompatible project version!',
    projectOpenSuccess: 'Project opened successfully!',
    projectReadError: 'Error reading project file:',
    projectSaveSuccess: 'Project saved successfully!',
    projectSaveError: 'Error saving project:',
    luaExportSuccess: 'Lua script exported successfully!',
    luaExportError: 'Error exporting file:',
    luaImportSuccess: 'LUA script imported successfully!',
    luaImportError: 'Error importing LUA file:',
    selfDistance: 'Self Distance',
    aboutTitle: 'About FaiRobot Studio',
    aboutDetail: 'Simulation and visual block programming app for the Fairino FR5 robot.',

    // RobotSidebar
    controlMode: 'Control Mode',
    jointSpace: 'Joint Space',
    toolCenterPoint: 'Tool Center Point (TCP)',
    reset: 'Reset',
    payload: 'Payload',
    reach: 'Reach',
    jointLimitTitle: 'Joint',

    // ScenePanel
    upload3D: 'Upload 3D Device',
    supportFormats: 'Supports GLTF, GLB, STL',
    deviceList: 'Device List',
    noDevices: 'No auxiliary devices added yet.',
    transform: 'Transform Settings',
    position: 'Position (XYZ - mm)',
    rotation: 'Rotation (RxRyRz - deg)',
    scale: 'Scale',
    importFormatError: 'Only .gltf, .glb, or .stl file types are supported!',

    // WorkflowPanel
    programmingMode: 'Programming Mode',
    simpleScratch: 'Simple (Scratch)',
    advancedList: 'Advanced (List)',
    recordWaypoint: 'Record Waypoint',
    recordMoveJ: 'Record MoveJ',
    recordMoveL: 'Record MoveL',
    setDO: 'Set DO',
    waitDelay: 'Wait Delay',
    workflowSteps: 'Workflow Steps',
    noSteps: 'No workflow steps recorded.',
    useButtonsHint: 'Use Record Waypoint or + Set DO buttons to start programming.',
    simulation: 'Simulation',
    play: 'Play',
    pause: 'Pause',
    stop: 'Stop',

    // BlockWorkspace
    dragDropHint: 'Drag & drop or click to add blocks',
    emptyWorkspace: 'Programming workspace is empty',
    emptyWorkspaceHint: 'Drag blocks from the palette above here to start your program.',
    rotateJointBlock: 'Rotate',
    moveTCPBlock: 'Move TCP axis',
    setDOBlock: 'Set DO port',
    cabinetDO: 'Cabinet DO',
    toolDO: 'Tool DO (Wrist)',
    debugHitbox: 'Show Hitboxes (Collision)',
    waitMsBlock: 'Wait delay duration',
    gripperOpenBlock: 'Open gripper',
    gripperCloseBlock: 'Close gripper',
    toAngle: 'to angle',
    byDegrees: 'by',
    degrees: 'deg',
    toCoordinate: 'to coordinate',
    ms: 'ms',
    turnOn: 'ON (1)',
    turnOff: 'OFF (0)',
    changeToOpen: 'Switch to Open',
    changeToClose: 'Switch to Close',

    // Settings menu
    language: 'Language',
    settings: 'Settings',

    // Tooltips
    tooltipFK:
      'Forward Kinematics (Joint Space): Control the robot by directly rotating individual joints (Joints 1 to 6).',
    tooltipIK:
      'Inverse Kinematics (Cartesian Space): Control the robot by dragging the end-effector (X, Y, Z) coordinates. Joint rotations are computed automatically.',
    tooltipTCP:
      'Tool Center Point: The center point of the robot gripper/tool, defining the actual working coordinates of the robot in space.',
    tooltipMoveJ:
      'Joint Motion: The robot rotates joints simultaneously to move the end-effector to the target in a natural curve. Fast and good for obstacle avoidance.',
    tooltipMoveL:
      'Linear Motion: The robot moves the end-effector to the target in an absolute straight line. Commonly used for welding, cutting, or vertical pick & place.',
    tooltipDO:
      'Digital Output: Electrical signal port used to control peripheral devices like turning on/off pumps, pneumatic valves, or grippers.',
    tooltipDOVal:
      'DO Signal State: Sets the DO port value. Value 1 (ON) activates the device, Value 0 (OFF) deactivates it.',
    tooltipDelay:
      'Delay: Pauses the execution of the program for a specified time (in milliseconds, 1s = 1000ms) before continuing to the next step.'
  }
}

export type LanguageType = 'vi' | 'en'
export type TranslationKeys = keyof typeof translations.vi
