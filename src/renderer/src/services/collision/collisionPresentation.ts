import type {
  RobotFaultState,
  RobotSafetyContactKind,
  RobotSafetyContactState
} from '../../types/robotFault.types'

export type CollisionPresentationLanguage = 'vi' | 'en'

export interface CollisionRobotIdentity {
  id: string
  name: string
}

export interface CollisionAlertPresentation {
  robotIds: string[]
  level: 'proximity' | 'collision'
  title: string
  detail: string
  isLive: boolean
}

export interface RobotCollisionPresentation {
  title: string
  detail: string
}

function isCollisionFault(fault: RobotFaultState | undefined): boolean {
  return Boolean(
    fault?.active && (fault.kind === 'collision' || fault.code.startsWith('COLLISION_'))
  )
}

function getFaultCollisionKind(fault: RobotFaultState | undefined): RobotSafetyContactKind {
  const code = fault?.code.toUpperCase() ?? ''

  if (code.includes('ROBOT')) return 'robot'
  if (code.includes('GROUND')) return 'ground'
  if (code.includes('SELF')) return 'self'
  if (code.includes('OBSTACLE')) return 'obstacle'

  return 'unknown'
}

function selectCollisionKind(
  contacts: Record<string, RobotSafetyContactState>,
  faults: Record<string, RobotFaultState>,
  level: 'proximity' | 'collision'
): RobotSafetyContactKind {
  const liveKinds = Object.values(contacts)
    .filter((contact) => contact.level === level)
    .map((contact) => contact.kind)

  for (const preferredKind of ['robot', 'self', 'ground', 'obstacle'] as const) {
    if (liveKinds.includes(preferredKind)) return preferredKind
  }

  const faultKinds = Object.values(faults).filter(isCollisionFault).map(getFaultCollisionKind)

  for (const preferredKind of ['robot', 'self', 'ground', 'obstacle'] as const) {
    if (faultKinds.includes(preferredKind)) return preferredKind
  }

  return 'unknown'
}

function getRobotName(
  robotId: string,
  robots: readonly CollisionRobotIdentity[],
  language: CollisionPresentationLanguage
): string {
  const name = robots.find((robot) => robot.id === robotId)?.name.trim()
  if (name) return name

  if (robotId === '__viewport_preview_robot__') {
    return language === 'vi' ? 'Robot đang huấn luyện' : 'Training robot'
  }

  return language === 'vi' ? 'Robot chưa đặt tên' : 'Unnamed robot'
}

function getSafetyRobotIds(
  contacts: Record<string, RobotSafetyContactState>,
  faults: Record<string, RobotFaultState>,
  level: 'proximity' | 'collision'
): string[] {
  const ids = new Set<string>()

  for (const [robotId, contact] of Object.entries(contacts)) {
    if (contact.level !== level) continue
    ids.add(robotId)
    contact.counterpartRobotIds.forEach((counterpartId) => ids.add(counterpartId))
  }

  if (level === 'collision') {
    for (const [robotId, fault] of Object.entries(faults)) {
      if (isCollisionFault(fault)) ids.add(robotId)
    }
  }

  return [...ids]
}

export function buildCollisionAlertPresentation(
  robots: readonly CollisionRobotIdentity[],
  contacts: Record<string, RobotSafetyContactState>,
  _faults: Record<string, RobotFaultState>,
  language: CollisionPresentationLanguage
): CollisionAlertPresentation | null {
  const hasLiveContact = Object.keys(contacts).length > 0
  if (!hasLiveContact) return null

  const hasCollision = Object.values(contacts).some((contact) => contact.level === 'collision')
  const level = hasCollision ? 'collision' : 'proximity'
  const robotIds = getSafetyRobotIds(contacts, {}, level)
  if (robotIds.length === 0) return null

  const names = robotIds.map((robotId) => getRobotName(robotId, robots, language))
  const kind = selectCollisionKind(contacts, {}, level)
  const isLive = true

  if (level === 'proximity') {
    const subject = names.join(language === 'vi' ? ' và ' : ' & ')
    const titleByKind: Record<RobotSafetyContactKind, string> =
      language === 'vi'
        ? {
            robot: 'Các robot đang ở quá gần nhau',
            self: 'Các bộ phận robot đang ở quá gần nhau',
            ground: 'Robot đang ở sát mặt phẳng an toàn của sàn',
            obstacle: 'Robot đang ở quá gần vật cản',
            unknown: 'Robot đã vào vùng cảnh báo'
          }
        : {
            robot: 'Robots are too close',
            self: 'Robot links are too close',
            ground: 'Robot is close to the ground safety plane',
            obstacle: 'Robot is too close to an obstacle',
            unknown: 'Robot entered a warning zone'
          }
    const detailByKind: Record<RobotSafetyContactKind, string> =
      language === 'vi'
        ? {
            robot: `${subject} đã đi vào vùng cảnh báo robot–robot.`,
            self: `${subject} có các bộ phận đi vào vùng cảnh báo tự va chạm.`,
            ground: `${subject} đang ở trong vùng cảnh báo gần sàn.`,
            obstacle: `${subject} đang ở trong vùng cảnh báo của vật cản.`,
            unknown: `${subject} đã đi vào vùng cảnh báo an toàn.`
          }
        : {
            robot: `${subject} entered the robot-to-robot warning zone.`,
            self: `${subject} has links inside its self-collision warning zone.`,
            ground: `${subject} is inside the ground warning zone.`,
            obstacle: `${subject} is inside an obstacle warning zone.`,
            unknown: `${subject} entered a safety warning zone.`
          }

    return {
      robotIds,
      level,
      title: titleByKind[kind],
      detail: detailByKind[kind],
      isLive
    }
  }

  if (language === 'en') {
    const title = isLive ? 'Collision detected' : 'Robots stopped safely after a collision'
    const subject = names.join(' & ')
    const detailByKind: Record<RobotSafetyContactKind, string> = {
      robot: `${subject}: robot-to-robot collision. Only involved robots were stopped.`,
      self: `${subject}: self-collision detected. Other safe robots continue running.`,
      ground: `${subject}: ground safety-plane collision detected.`,
      obstacle: `${subject}: obstacle collision detected. Other safe robots continue running.`,
      unknown: `${subject}: check the work area before restarting the affected robot.`
    }

    return { robotIds, level, title, detail: detailByKind[kind], isLive }
  }

  const title = isLive ? 'Phát hiện va chạm' : 'Robot đã dừng an toàn sau va chạm'
  const subject = names.join(' và ')
  const detailByKind: Record<RobotSafetyContactKind, string> = {
    robot: `${subject}: va chạm giữa các robot. Hệ thống chỉ dừng các robot liên quan.`,
    self: `${subject}: phát hiện tự va chạm. Các robot an toàn khác vẫn tiếp tục chạy.`,
    ground: `${subject}: va chạm với mặt phẳng an toàn của sàn.`,
    obstacle: `${subject}: va chạm với vật cản. Các robot an toàn khác vẫn tiếp tục chạy.`,
    unknown: `${subject}: hãy kiểm tra vùng làm việc trước khi chạy lại robot bị ảnh hưởng.`
  }

  return { robotIds, level, title, detail: detailByKind[kind], isLive }
}

export function buildRobotCollisionPresentation(
  robotId: string,
  robots: readonly CollisionRobotIdentity[],
  contacts: Record<string, RobotSafetyContactState>,
  faults: Record<string, RobotFaultState>,
  language: CollisionPresentationLanguage
): RobotCollisionPresentation | null {
  const contact = contacts[robotId]
  const fault = faults[robotId]
  const hasCollisionContact = contact?.level === 'collision'
  if (!hasCollisionContact && !isCollisionFault(fault)) return null

  const kind = hasCollisionContact ? contact.kind : getFaultCollisionKind(fault)
  const counterpartNames = (contact?.counterpartRobotIds ?? []).map((counterpartId) =>
    getRobotName(counterpartId, robots, language)
  )
  const isStopped = isCollisionFault(fault)

  if (language === 'en') {
    const titleByKind: Record<RobotSafetyContactKind, string> = {
      robot:
        counterpartNames.length > 0
          ? `Collision with ${counterpartNames.join(' & ')}`
          : 'Robot-to-robot collision',
      self: 'Robot self-collision',
      ground: 'Ground safety-plane collision',
      obstacle: 'Obstacle collision',
      unknown: 'Collision detected'
    }

    return {
      title: isStopped ? `Stopped safely: ${titleByKind[kind]}` : titleByKind[kind],
      detail: isStopped
        ? 'Motion is locked for this robot. Other safe robots continue running.'
        : 'Collision is currently active. Check the work area.'
    }
  }

  const titleByKind: Record<RobotSafetyContactKind, string> = {
    robot:
      counterpartNames.length > 0
        ? `Va chạm với ${counterpartNames.join(' và ')}`
        : 'Va chạm giữa các robot',
    self: 'Robot tự va chạm',
    ground: 'Robot chạm mặt phẳng an toàn của sàn',
    obstacle: 'Robot va chạm với vật cản',
    unknown: 'Phát hiện va chạm'
  }

  return {
    title: isStopped ? `Đã dừng an toàn: ${titleByKind[kind]}` : titleByKind[kind],
    detail: isStopped
      ? 'Robot này đã bị khóa chuyển động. Các robot an toàn khác vẫn tiếp tục chạy.'
      : 'Va chạm đang diễn ra. Hãy kiểm tra vùng làm việc.'
  }
}

export function isTechnicalCollisionError(message: string | undefined): boolean {
  if (!message) return false

  const normalizedMessage = message.toLowerCase()
  return (
    normalizedMessage.includes('motion blocked') ||
    normalizedMessage.includes('intersects robot') ||
    normalizedMessage.includes('self-collision') ||
    normalizedMessage.includes('ground safety plane')
  )
}
