// Chép từ ../Fe bằng `npm run sync:domain`. Không sửa ở đây; sửa ở FE rồi chép lại.
import { describe, expect, it } from 'vitest'
import type { Payment, Settings, Stay, StayItem } from './types'
import { stayBill } from './bill'

// Công thức hóa đơn trong tài liệu nghiệp vụ:
// tổng = tiền phòng + phụ thu trả muộn + phụ thu thêm người + dịch vụ − giảm giá.
const settings: Settings = {
  graceMinutes: 10,
  checkoutHour: 12,
  lateFees: [
    { untilHour: 15, percent: 30 },
    { untilHour: 18, percent: 50 },
  ],
  overnightFromHour: 22,
  overnightToHour: 5,
}

const item = (kind: StayItem['kind'], name: string, unitPrice: number): StayItem => ({
  id: name,
  kind,
  name,
  qty: 1,
  unitPrice,
  shiftId: 'ca',
})

const stay = (extra: Partial<Stay> = {}): Stay => ({
  id: 'luot',
  roomId: 'phong',
  status: 'active',
  guestName: '',
  guestPhone: '',
  guestCount: 2,
  standardGuests: 2,
  extraGuestFee: 100_000,
  rentType: 'day',
  periods: 1,
  checkInAt: new Date(2026, 9, 5, 14).toISOString(),
  checkOutAt: null,
  prices: { firstHour: 80_000, nextHour: 30_000, overnight: 300_000, day: 500_000, week: 0, month: 0 },
  items: [],
  photos: [],
  notes: [],
  finalCharge: null,
  shiftId: 'ca',
  checkOutShiftId: null,
  ...extra,
})

const at = (day: number, hour: number) => new Date(2026, 9, day, hour)
const noPayments: Payment[] = []

describe('stayBill', () => {
  it('ra đúng ví dụ 845.000 của tài liệu', () => {
    // Thuê 1 ngày, trả lúc 14:00 (phụ thu 30%), 3 người (thêm 1 người), dịch vụ 95.000.
    const bill = stayBill(
      stay({
        guestCount: 3,
        items: [item('service', 'Nước suối', 20_000), item('service', 'Mì ly', 25_000), item('service', 'Giặt ủi', 50_000)],
      }),
      noPayments,
      at(6, 14),
      settings,
    )
    expect(bill.charge.amount).toBe(650_000)
    expect(bill.extraGuestAmount).toBe(100_000)
    expect(bill.itemsTotal).toBe(95_000)
    expect(bill.total).toBe(845_000)
  })

  it('không phụ thu khi số người không vượt mức tiêu chuẩn', () => {
    expect(stayBill(stay({ guestCount: 1 }), noPayments, at(6, 12), settings).extraGuestAmount).toBe(0)
  })

  it('phụ thu thêm người tính một lần cho cả lượt, dù thuê nhiều ngày', () => {
    const bill = stayBill(stay({ guestCount: 4, periods: 3 }), noPayments, at(8, 12), settings)
    expect(bill.extraGuestAmount).toBe(200_000)
    expect(bill.total).toBe(1_700_000)
  })

  it('giảm giá được trừ khỏi tổng', () => {
    const bill = stayBill(
      stay({ items: [item('service', 'Nước suối', 20_000), item('discount', 'Khách quen', 50_000)] }),
      noPayments,
      at(6, 12),
      settings,
    )
    expect(bill.itemsTotal).toBe(-30_000)
    expect(bill.total).toBe(470_000)
  })

  it('lượt đặt trước chưa phát sinh tiền phòng hay phụ thu thêm người', () => {
    const bill = stayBill(stay({ status: 'booked', guestCount: 5 }), noPayments, at(6, 12), settings)
    expect(bill.total).toBe(0)
  })

  it('trừ khoản đã thu để ra số còn phải thu', () => {
    const paid: Payment[] = [{ id: 'thu', stayId: 'luot', amount: 200_000, method: 'cash', shiftId: 'ca', at: '' }]
    expect(stayBill(stay(), paid, at(6, 12), settings).due).toBe(300_000)
  })
})
