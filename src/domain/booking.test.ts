// Chép từ ../Fe bằng `npm run sync:domain`. Không sửa ở đây; sửa ở FE rồi chép lại.
import { describe, expect, it } from 'vitest'
import type { RentType, Settings, Stay } from './types'
import { findConflicts, isLate, stayWindow } from './booking'

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
const prices = { firstHour: 80_000, nextHour: 30_000, overnight: 300_000, day: 500_000, week: 0, month: 0 }
const at = (day: number, hour: number) => new Date(2026, 9, day, hour)

const stay = (id: string, status: Stay['status'], rentType: RentType, checkIn: Date, roomId = 'phong'): Stay => ({
  id,
  roomId,
  status,
  guestName: '',
  guestPhone: '',
  guestCount: 1,
  standardGuests: 2,
  extraGuestFee: 0,
  rentType,
  periods: 1,
  checkInAt: checkIn.toISOString(),
  checkOutAt: null,
  prices,
  items: [],
  photos: [],
  notes: [],
  finalCharge: null,
  shiftId: 'ca',
  checkOutShiftId: null,
})

const windowOf = (rentType: RentType, checkIn: Date) =>
  stayWindow({ rentType, periods: 1, checkInAt: checkIn.toISOString(), prices }, settings)

const conflictIds = (stays: Stay[], rentType: RentType, checkIn: Date, now = at(5, 10), except?: string) =>
  findConflicts(stays, 'phong', windowOf(rentType, checkIn), settings, now, except).map((s) => s.id)

describe('findConflicts', () => {
  const booked = stay('dat-toi', 'booked', 'overnight', at(5, 22))

  it('nhận khách thuê ngày vào phòng đã có người đặt tối nay thì báo trùng', () => {
    expect(conflictIds([booked], 'day', at(5, 14))).toEqual(['dat-toi'])
  })

  it('nhận khách thuê giờ buổi sáng, xong trước giờ khách đặt đến thì không trùng', () => {
    expect(conflictIds([booked], 'hour', at(5, 9))).toEqual([])
  })

  it('nhận khách thuê giờ sát giờ khách đặt đến thì báo trùng', () => {
    expect(conflictIds([booked], 'hour', at(5, 20))).toEqual(['dat-toi'])
  })

  it('hai lượt đặt cùng phòng cùng đêm thì báo trùng', () => {
    expect(conflictIds([booked], 'overnight', at(5, 23))).toEqual(['dat-toi'])
  })

  it('đặt cho đêm hôm sau thì không trùng', () => {
    expect(conflictIds([booked], 'overnight', at(6, 22))).toEqual([])
  })

  it('đặt vào lúc phòng đang có khách thuê ngày chưa đến hạn trả thì báo trùng', () => {
    const staying = stay('dang-o', 'active', 'day', at(5, 14))
    expect(conflictIds([staying], 'overnight', at(5, 22))).toEqual(['dang-o'])
    expect(conflictIds([staying], 'day', at(6, 14))).toEqual([])
  })

  it('khách đang ở đã quá hạn trả vẫn được coi là còn chiếm phòng', () => {
    const overdue = stay('qua-han', 'active', 'day', at(4, 14))
    expect(conflictIds([overdue], 'hour', at(5, 15), at(5, 16))).toEqual(['qua-han'])
  })

  it('bỏ qua phòng khác, lượt đã trả, lượt đã hủy và chính lượt đang sửa', () => {
    const others = [
      stay('phong-khac', 'booked', 'overnight', at(5, 22), 'phong-2'),
      stay('da-tra', 'done', 'overnight', at(5, 22)),
      stay('da-huy', 'cancelled', 'overnight', at(5, 22)),
    ]
    expect(conflictIds(others, 'overnight', at(5, 22))).toEqual([])
    expect(conflictIds([booked], 'overnight', at(5, 23), at(5, 10), 'dat-toi')).toEqual([])
  })
})

describe('isLate', () => {
  it('lượt đặt quá giờ hẹn là trễ hẹn, chưa đến giờ thì không', () => {
    const booked = stay('dat', 'booked', 'day', at(5, 14))
    expect(isLate(booked, at(5, 15))).toBe(true)
    expect(isLate(booked, at(5, 13))).toBe(false)
  })

  it('lượt đang ở không bao giờ là trễ hẹn', () => {
    expect(isLate(stay('o', 'active', 'day', at(5, 14)), at(6, 15))).toBe(false)
  })
})
