// Chép từ ../Fe bằng `npm run sync:domain`. Không sửa ở đây; sửa ở FE rồi chép lại.
import { describe, expect, it } from 'vitest'
import type { PriceList, RentType, Settings } from './types'
import { calcRoomCharge, overnightAllowed } from './pricing'

// Bảng giá và quy tắc do nhà nghỉ cung cấp: giờ đầu 80.000, mỗi giờ tiếp 30.000, qua đêm
// 300.000 (22:00 đến 12:00), theo ngày 500.000 (14:00 đến 12:00 hôm sau), trả muộn trước
// 15:00 phụ thu 30%, trước 18:00 phụ thu 50%, sau 18:00 tính thêm một ngày.
// Giá tuần và tháng là số ví dụ.
const prices: PriceList = {
  firstHour: 80_000,
  nextHour: 30_000,
  overnight: 300_000,
  day: 500_000,
  week: 3_000_000,
  month: 9_000_000,
}
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

// Tháng 10/2026; tháng trong Date tính từ 0.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute)

function charge(rentType: RentType, periods: number, checkIn: Date, checkOut: Date): number {
  const input = { rentType, periods, checkInAt: checkIn.toISOString(), prices }
  return calcRoomCharge(input, checkOut, settings).amount
}

describe('overnightAllowed', () => {
  it.each([
    ['22:00, đầu khung', at(5, 22), true],
    ['23:30', at(5, 23, 30), true],
    ['02:00 sáng', at(6, 2), true],
    ['05:00, hết khung', at(6, 5), false],
    ['11:43 trưa', at(5, 11, 43), false],
    ['21:59', at(5, 21, 59), false],
  ] as const)('%s', (_name, checkIn, expected) => {
    expect(overnightAllowed(checkIn, settings)).toBe(expected)
  })

  it('khung không vắt qua nửa đêm', () => {
    const daytime = { ...settings, overnightFromHour: 8, overnightToHour: 17 }
    expect(overnightAllowed(at(5, 12), daytime)).toBe(true)
    expect(overnightAllowed(at(5, 20), daytime)).toBe(false)
  })
})

describe('thuê giờ', () => {
  it.each([
    ['ra trong giờ đầu', at(5, 14), at(5, 14, 50), 80_000],
    ['trễ 8 phút, trong ân hạn', at(5, 14), at(5, 15, 8), 80_000],
    ['giờ đầu + 1 giờ', at(5, 14), at(5, 15, 20), 110_000],
    ['giờ đầu + 3 giờ', at(5, 14), at(5, 17, 30), 170_000],
    ['11 tiếng, vẫn rẻ hơn giá ngày', at(5, 14), at(6, 1), 380_000],
    ['20 tiếng, dừng ở giá một ngày', at(5, 14), at(6, 10), 500_000],
    ['qua mốc 12:00 hôm sau, thêm phụ thu trả muộn 30%', at(5, 14), at(6, 15), 650_000],
    ['ở sang ngày thứ hai, tính hai ngày chứ không dừng ở một ngày', at(5, 14), at(7, 10), 1_000_000],
  ] as const)('%s', (_name, checkIn, checkOut, expected) => {
    expect(charge('hour', 1, checkIn, checkOut)).toBe(expected)
  })
})

describe('qua đêm', () => {
  it.each([
    ['trả trước 12:00', at(5, 22), at(6, 7), 300_000],
    ['vào sau nửa đêm, trả trưa cùng ngày', at(6, 1), at(6, 11), 300_000],
    ['trả 13:00, phụ thu 30% giá ngày', at(5, 22), at(6, 13), 450_000],
    ['trả 17:00, phụ thu 50% giá ngày', at(5, 22), at(6, 17), 550_000],
    ['trả 19:00, tính thêm một ngày', at(5, 22), at(6, 19), 800_000],
  ] as const)('%s', (_name, checkIn, checkOut, expected) => {
    expect(charge('overnight', 1, checkIn, checkOut)).toBe(expected)
  })
})

describe('theo ngày', () => {
  it.each([
    ['trả đúng 12:00 hôm sau', 1, at(6, 12), 500_000],
    ['trả 12:08, trong ân hạn', 1, at(6, 12, 8), 500_000],
    ['trả 14:30, phụ thu 30%', 1, at(6, 14, 30), 650_000],
    ['trả đúng 15:00, vẫn là mức 30%', 1, at(6, 15), 650_000],
    ['trả 16:30, phụ thu 50%', 1, at(6, 16, 30), 750_000],
    ['trả đúng 18:00, vẫn là mức 50%', 1, at(6, 18), 750_000],
    ['trả 19:00, tính thêm một ngày', 1, at(6, 19), 1_000_000],
    ['ở lố sang trưa ngày kế, thêm một ngày và phụ thu 30%', 1, at(7, 13), 1_150_000],
    ['ở lố hai ngày, không dừng ở một ngày', 1, at(7, 19), 1_500_000],
    ['đặt 2 ngày, trả đúng 12:00', 2, at(7, 12), 1_000_000],
  ] as const)('%s', (_name, periods, checkOut, expected) => {
    expect(charge('day', periods, at(5, 14), checkOut)).toBe(expected)
  })

  it('một ngày tính theo mốc trả phòng, không phải đủ 24 tiếng', () => {
    // Vào 08:00 thì vẫn hết ngày lúc 12:00 hôm sau, dù đã 28 tiếng.
    expect(charge('day', 1, at(5, 8), at(6, 12))).toBe(500_000)
  })
})

describe('theo tuần và theo tháng', () => {
  it('ở thêm 2 ngày sau khi hết tuần thì tính thêm 2 ngày lẻ', () => {
    expect(charge('week', 1, at(5, 14), at(14, 14))).toBe(4_000_000)
  })

  it('gia hạn thêm một tháng', () => {
    expect(charge('month', 2, at(5, 14), at(30, 9))).toBe(18_000_000)
  })
})
