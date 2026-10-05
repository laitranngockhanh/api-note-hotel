// Chép từ ../Fe bằng `npm run sync:domain`. Không sửa ở đây; sửa ở FE rồi chép lại.
import type { Settings, Stay } from './types'
import { PERIOD_UNIT } from './labels'

// Hàm tính tiền phòng. Thuần, không phụ thuộc giao diện hay nơi lưu dữ liệu,
// để dùng chung cho ô tạm tính, hóa đơn và sau này là BE.

export type ChargeInput = Pick<Stay, 'rentType' | 'periods' | 'checkInAt' | 'prices'>

export interface ChargeLine {
  label: string
  amount: number
}

export interface RoomCharge {
  amount: number
  lines: ChargeLine[]
  dueAt: Date | null
  overdueMinutes: number
}

const MINUTE_MS = 60_000
const DAY_MINUTES = 24 * 60

// Số đơn vị phải tính: phần lẻ chỉ tính thêm một đơn vị khi vượt quá ân hạn.
function billableUnits(minutes: number, unitMinutes: number, graceMinutes: number): number {
  if (minutes <= 0) return 0
  const whole = Math.floor(minutes / unitMinutes)
  return whole + (minutes % unitMinutes > graceMinutes ? 1 : 0)
}

// Giờ vào có nằm trong khung nhận khách qua đêm không. Khung thường vắt qua nửa đêm.
export function overnightAllowed(checkIn: Date, settings: Settings): boolean {
  const hour = checkIn.getHours()
  const { overnightFromHour: from, overnightToHour: to } = settings
  return from > to ? hour >= from || hour < to : hour >= from && hour < to
}

export function overnightWindowLabel(settings: Settings): string {
  const pad = (hour: number) => `${String(hour).padStart(2, '0')}:00`
  return `${pad(settings.overnightFromHour)} đến ${pad(settings.overnightToHour)}`
}

export function dueAt(input: ChargeInput, settings: Settings): Date | null {
  const due = new Date(input.checkInAt)
  switch (input.rentType) {
    case 'hour':
      return null
    case 'overnight':
      // Vào sau nửa đêm thì trả phòng trưa cùng ngày, còn lại là trưa hôm sau.
      if (due.getHours() >= settings.checkoutHour) due.setDate(due.getDate() + 1)
      due.setHours(settings.checkoutHour, 0, 0, 0)
      return due
    case 'day':
      due.setDate(due.getDate() + input.periods)
      due.setHours(settings.checkoutHour, 0, 0, 0)
      return due
    case 'week':
      due.setDate(due.getDate() + 7 * input.periods)
      return due
    case 'month':
      due.setMonth(due.getMonth() + input.periods)
      return due
  }
}

const sum = (lines: ChargeLine[]) => lines.reduce((total, line) => total + line.amount, 0)

// Phần trăm của giá ngày, làm tròn đến nghìn đồng.
const percentOf = (amount: number, percent: number) => Math.round((amount * percent) / 100 / 1000) * 1000

// Phụ thu trả muộn sau mốc trả phòng, cho thuê ngày và qua đêm. Một ngày thuê kết thúc ở
// mốc trả phòng chứ không phải sau 24 tiếng: trả muộn trong các mức giờ thì phụ thu theo
// phần trăm giá ngày; quá mức cuối thì tính thêm trọn một ngày và mốc trả phòng dời sang
// trưa hôm sau, rồi xét tiếp từ mốc mới.
function lateLines(due: Date, until: Date, dayPrice: number, settings: Settings): ChargeLine[] {
  const tiers = [...settings.lateFees].sort((a, b) => a.untilHour - b.untilHour)
  const nextDue = new Date(due)
  let extraDays = 0
  let surcharge: ChargeLine | null = null

  for (;;) {
    const late = (until.getTime() - nextDue.getTime()) / MINUTE_MS
    if (late <= settings.graceMinutes) break
    const tier = tiers.find(
      (t) => late <= (t.untilHour - settings.checkoutHour) * 60 + settings.graceMinutes,
    )
    if (tier) {
      surcharge = {
        label: `Trả muộn trước ${tier.untilHour}:00 (+${tier.percent}%)`,
        amount: percentOf(dayPrice, tier.percent),
      }
      break
    }
    extraDays += 1
    nextDue.setDate(nextDue.getDate() + 1)
  }

  const lines: ChargeLine[] = []
  if (extraDays > 0) lines.push({ label: `Thêm ${extraDays} ngày do trả muộn`, amount: extraDays * dayPrice })
  if (surcharge) lines.push(surcharge)
  return lines
}

export function calcRoomCharge(input: ChargeInput, until: Date, settings: Settings): RoomCharge {
  const { prices, periods, rentType } = input
  const grace = settings.graceMinutes
  const start = new Date(input.checkInAt)

  if (rentType === 'hour') {
    const elapsed = (until.getTime() - start.getTime()) / MINUTE_MS
    const extraHours = billableUnits(elapsed - 60, 60, grace)
    const byHour = prices.firstHour + extraHours * prices.nextHour
    // Tiền giờ không vượt quá số tiền nếu khách thuê theo ngày từ cùng giờ vào. Nhờ vậy
    // khách thuê giờ mà ở qua nhiều ngày vẫn bị tính đủ số ngày.
    const byDay = calcRoomCharge({ ...input, rentType: 'day', periods: 1 }, until, settings)
    if (byHour > byDay.amount) {
      return {
        amount: byDay.amount,
        lines: [{ ...byDay.lines[0], label: 'Thuê giờ, tính theo giá ngày' }, ...byDay.lines.slice(1)],
        dueAt: null,
        overdueMinutes: 0,
      }
    }
    const lines: ChargeLine[] = [{ label: 'Giờ đầu', amount: prices.firstHour }]
    if (extraHours > 0) {
      lines.push({ label: `${extraHours} giờ tiếp theo`, amount: extraHours * prices.nextHour })
    }
    return { amount: byHour, lines, dueAt: null, overdueMinutes: 0 }
  }

  const due = dueAt(input, settings)!
  const overdueMinutes = Math.max(0, (until.getTime() - due.getTime()) / MINUTE_MS)

  const base: ChargeLine =
    rentType === 'overnight'
      ? { label: 'Qua đêm', amount: prices.overnight }
      : { label: `${periods} ${PERIOD_UNIT[rentType]}`, amount: periods * prices[rentType] }
  const lines = [base]

  if (rentType === 'overnight' || rentType === 'day') {
    lines.push(...lateLines(due, until, prices.day, settings))
  } else {
    const extraDays = billableUnits(overdueMinutes, DAY_MINUTES, grace)
    if (extraDays > 0) {
      lines.push({ label: `${extraDays} ngày lẻ`, amount: extraDays * prices.day })
    }
  }

  return { amount: sum(lines), lines, dueAt: due, overdueMinutes }
}
