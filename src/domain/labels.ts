// Chép từ ../Fe bằng `npm run sync:domain`. Không sửa ở đây; sửa ở FE rồi chép lại.
import type { PaymentMethod, RentType, RoomCondition, StayStatus } from './types'

export const STAY_STATUS_LABEL: Record<StayStatus, string> = {
  booked: 'Đặt trước',
  active: 'Đang ở',
  done: 'Đã trả',
  cancelled: 'Đã hủy',
}

export const RENT_TYPES: RentType[] = ['hour', 'overnight', 'day', 'week', 'month']

export const RENT_LABEL: Record<RentType, string> = {
  hour: 'Theo giờ',
  overnight: 'Qua đêm',
  day: 'Theo ngày',
  week: 'Theo tuần',
  month: 'Theo tháng',
}

export const PERIOD_UNIT: Partial<Record<RentType, string>> = {
  day: 'ngày',
  week: 'tuần',
  month: 'tháng',
}

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'Tiền mặt',
  transfer: 'Chuyển khoản',
}

export const CONDITION_LABEL: Record<RoomCondition, string> = {
  ready: 'Trống',
  cleaning: 'Chờ dọn',
  maintenance: 'Bảo trì',
}
