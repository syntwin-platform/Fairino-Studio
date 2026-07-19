export interface CommandFailurePresentation {
  code:
    | 'TRACE_INCOMPLETE'
    | 'COMMAND_BUSY'
    | 'MOVEL_UNREACHABLE'
    | 'EMERGENCY_STOP'
    | 'COMMAND_FAILED'
  title: string
  detail: string
  suggestion: string
  technicalDetail: string
}

const ROBOT_MOTION_BLOCKED_PREFIX = /^Robot\s+[0-9a-f-]+\s+motion blocked:\s*/i

function stripTransportPrefixes(message: string): string {
  let normalized = message.trim()

  for (let pass = 0; pass < 3; pass += 1) {
    const previous = normalized
    normalized = normalized
      .replace(/^Execution:\s*/i, '')
      .replace(/^Command failed:\s*/i, '')
      .replace(ROBOT_MOTION_BLOCKED_PREFIX, '')
      .trim()

    if (normalized === previous) break
  }

  return normalized
}

export function buildCommandFailurePresentation(rawMessage: string): CommandFailurePresentation {
  const technicalDetail = rawMessage.trim() || 'Unknown command execution error.'
  const message = stripTransportPrefixes(technicalDetail)

  const traceStartMatch = message.match(
    /Trace\s+([^\s]+)\s+must start at sample 0, received\s+(\d+)/i
  )

  if (traceStartMatch) {
    return {
      code: 'TRACE_INCOMPLETE',
      title: 'Quỹ đạo ghi lại không đầy đủ',
      detail:
        `Quỹ đạo bắt đầu từ điểm ${traceStartMatch[2]} thay vì điểm 0 nên robot không thể ` +
        'tái hiện chuyển động một cách an toàn.',
      suggestion:
        'Nhấn khôi phục để mở khóa robot. Với file cũ, hãy import và chạy lại; với quỹ đạo mới, hãy ghi hoặc xuất lại nếu lỗi còn xuất hiện.',
      technicalDetail
    }
  }

  if (/already (has|executing)|already executing|active command/i.test(message)) {
    return {
      code: 'COMMAND_BUSY',
      title: 'Robot đang giữ một lệnh chưa kết thúc',
      detail:
        'Lệnh trước chưa giải phóng trạng thái thực thi nên chương trình mới chưa thể bắt đầu.',
      suggestion: 'Nhấn khôi phục để dừng lệnh cục bộ còn lại và cho phép chạy chương trình mới.',
      technicalDetail
    }
  }

  if (/MoveL.*(could not reach|planning|unreachable)|Cartesian waypoint/i.test(message)) {
    return {
      code: 'MOVEL_UNREACHABLE',
      title: 'Không thể lập quỹ đạo MoveL',
      detail:
        'Một waypoint nằm ngoài vùng với tới hoặc không có nghiệm IK liên tục từ tư thế hiện tại.',
      suggestion:
        'Khôi phục robot, sau đó chỉnh hoặc ghi lại waypoint được nêu trong chi tiết kỹ thuật.',
      technicalDetail
    }
  }

  if (/global emergency stop|global e-?stop|emergency stop/i.test(message)) {
    return {
      code: 'EMERGENCY_STOP',
      title: 'Robot đang bị dừng khẩn cấp',
      detail: 'Global E-Stop đang chặn mọi chuyển động và không thể được xóa bằng reset command.',
      suggestion: 'Xác nhận vùng làm việc an toàn và thực hiện quy trình reset E-Stop riêng.',
      technicalDetail
    }
  }

  return {
    code: 'COMMAND_FAILED',
    title: 'Chương trình thực thi thất bại',
    detail: message || 'Robot không thể hoàn tất command hiện tại.',
    suggestion: 'Xem chi tiết kỹ thuật, khôi phục trạng thái command rồi chạy chương trình khác.',
    technicalDetail
  }
}
