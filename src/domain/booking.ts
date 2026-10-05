// Chép từ ../Fe bằng `npm run sync:domain`. Không sửa ở đây; sửa ở FE rồi chép lại.
import type { Settings, Stay } from './types'
import { dueAt, type ChargeInput } from './pricing'

// Kiểm tra trùng lịch của một phòng: lượt sắp nhận hoặc sắp đặt có đè lên lượt đặt trước
// hay lượt đang ở nào khác không. Chỉ để cảnh báo; người trực vẫn được quyết định làm tiếp.

// Thuê giờ không có hạn trả, nên tạm coi mỗi lượt giờ chiếm phòng chừng này để so lịch.
const HOURLY_WINDOW_MS = 3 * 60 * 60 * 1000

export interface Window {
  start: Date
  end: Date
}

export function stayWindow(input: ChargeInput, settings: Settings): Window {
  const start = new Date(input.checkInAt)
  return { start, end: dueAt(input, settings) ?? new Date(start.getTime() + HOURLY_WINDOW_MS) }
}

// Các lượt khác của cùng phòng có khoảng thời gian đè lên khoảng đang xét.
export function findConflicts(
  stays: Stay[],
  roomId: string,
  window: Window,
  settings: Settings,
  now: Date,
  exceptStayId?: string,
): Stay[] {
  return stays.filter((stay) => {
    if (stay.roomId !== roomId || stay.id === exceptStayId) return false
    if (stay.status !== 'booked' && stay.status !== 'active') return false
    const other = stayWindow(stay, settings)
    // Khách đang ở thì chắc chắn còn chiếm phòng đến lúc này, dù đã quá hạn trả.
    const otherEnd = stay.status === 'active' && other.end < now ? now : other.end
    return other.start < window.end && window.start < otherEnd
  })
}

// Lượt đặt trước đã quá giờ hẹn mà khách chưa đến.
export function isLate(stay: Stay, now: Date): boolean {
  return stay.status === 'booked' && new Date(stay.checkInAt) < now
}
