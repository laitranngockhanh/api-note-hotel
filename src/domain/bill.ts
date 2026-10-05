// Chép từ ../Fe bằng `npm run sync:domain`. Không sửa ở đây; sửa ở FE rồi chép lại.
import type { Db, Payment, Settings, Stay, StayItem } from './types'
import { calcRoomCharge, type RoomCharge } from './pricing'

// Quy tắc tính tiền là của từng cơ sở, nên phải tra theo cơ sở của phòng.
export function settingsOfRoom(db: Db, roomId: string): Settings {
  const room = db.rooms.find((r) => r.id === roomId)!
  return db.properties.find((p) => p.id === room.propertyId)!.settings
}

// Hóa đơn của một lượt thuê:
// tổng = tiền phòng (gồm phụ thu trả muộn) + phụ thu thêm người + dịch vụ và phụ thu − giảm giá.
export interface Bill {
  charge: RoomCharge
  // Số người vượt mức tiêu chuẩn của phòng và số tiền phụ thu tương ứng.
  extraGuests: number
  extraGuestAmount: number
  // Dịch vụ cộng phụ thu trừ giảm giá.
  itemsTotal: number
  total: number
  paid: number
  due: number
}

// Số tiền của một dòng trong hóa đơn; giảm giá mang dấu âm.
export function itemAmount(item: StayItem): number {
  const amount = item.qty * item.unitPrice
  return item.kind === 'discount' ? -amount : amount
}

export function stayBill(stay: Stay, payments: Payment[], until: Date, settings: Settings): Bill {
  // Chỉ lượt đang ở mới tính tiền theo thời gian. Lượt đã trả dùng số tiền phòng đã
  // chốt; lượt đặt trước hoặc đã hủy chưa phát sinh tiền phòng.
  let charge: RoomCharge
  if (stay.status === 'active') {
    charge = calcRoomCharge(stay, until, settings)
  } else {
    const amount = stay.finalCharge ?? 0
    charge = {
      amount,
      lines: amount > 0 ? [{ label: 'Tiền phòng', amount }] : [],
      dueAt: null,
      overdueMinutes: 0,
    }
  }
  // Phụ thu thêm người tính một lần cho cả lượt, và chỉ khi khách đã thật sự vào ở.
  const stayed = stay.status === 'active' || stay.status === 'done'
  const extraGuests = stayed ? Math.max(0, stay.guestCount - stay.standardGuests) : 0
  const extraGuestAmount = extraGuests * stay.extraGuestFee

  const itemsTotal = stay.items.reduce((sum, item) => sum + itemAmount(item), 0)
  const paid = payments
    .filter((payment) => payment.stayId === stay.id)
    .reduce((sum, payment) => sum + payment.amount, 0)
  const total = charge.amount + extraGuestAmount + itemsTotal
  return { charge, extraGuests, extraGuestAmount, itemsTotal, total, paid, due: total - paid }
}
