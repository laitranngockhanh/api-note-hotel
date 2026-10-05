// Chép từ ../Fe bằng `npm run sync:domain`. Không sửa ở đây; sửa ở FE rồi chép lại.
import type { Db, Expense, Payment, Shift } from './types'

// Số liệu báo cáo. Mọi khoản thu tính cho ngày của ca (businessDate), nên báo cáo
// ngày, tháng, năm chỉ là gom các ca theo phần đầu của khóa ngày YYYY-MM-DD.

export type ReportMode = 'day' | 'month' | 'year'

const KEY_LENGTH: Record<ReportMode, number> = { day: 10, month: 7, year: 4 }

export function periodKey(mode: ReportMode, date: string): string {
  return date.slice(0, KEY_LENGTH[mode])
}

export function periodTitle(mode: ReportMode, date: string): string {
  const [year, month] = date.split('-')
  return mode === 'year' ? `Năm ${year}` : `Tháng ${Number(month)}/${year}`
}

export interface Totals {
  checkIns: number
  cash: number
  transfer: number
  spent: number
  cashDiff: number
}

export interface ShiftRow extends Totals {
  shift: Shift
  payments: Payment[]
}

// Cơ cấu doanh thu của các lượt đã trả phòng trong kỳ. Tính theo hóa đơn của lượt thuê
// chứ không theo tiền thu, nên có thể lệch với tổng thu khi có tiền cọc hoặc thu trước.
// surcharge gồm cả phụ thu thêm người; discount là tổng giảm giá, phải trừ khi cộng.
export interface Revenue {
  stays: number
  room: number
  service: number
  surcharge: number
  discount: number
}

export const revenueTotal = (revenue: Revenue) =>
  revenue.room + revenue.service + revenue.surcharge - revenue.discount

// Ghi chú của ca hoặc của lượt thuê, gom lại để chủ đọc cùng với số liệu của kỳ.
export interface ReportNote {
  date: string
  propertyId: string
  subject: string
  by: string
  text: string
}

export interface PeriodReport {
  shifts: ShiftRow[]
  payments: Payment[]
  expenses: Expense[]
  totals: Totals
  revenue: Revenue
  notes: ReportNote[]
}

const zero = (): Totals => ({ checkIns: 0, cash: 0, transfer: 0, spent: 0, cashDiff: 0 })

function add(target: Totals, source: Totals): Totals {
  target.checkIns += source.checkIns
  target.cash += source.cash
  target.transfer += source.transfer
  target.spent += source.spent
  target.cashDiff += source.cashDiff
  return target
}

// propertyId là null thì gộp mọi cơ sở.
export function periodReport(db: Db, propertyId: string | null, mode: ReportMode, date: string): PeriodReport {
  const prefix = periodKey(mode, date)
  const inScope = (id: string) => propertyId === null || id === propertyId
  const shifts = db.shifts
    .filter((shift) => inScope(shift.propertyId) && shift.businessDate.startsWith(prefix))
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt))
    .map((shift): ShiftRow => {
      const payments = db.payments.filter((payment) => payment.shiftId === shift.id)
      const sumOf = (method: string) =>
        payments.filter((p) => p.method === method).reduce((sum, p) => sum + p.amount, 0)
      return {
        shift,
        payments,
        // Chỉ đếm lượt khách đã thật sự vào ở; đặt trước và đã hủy không tính.
        checkIns: db.stays.filter(
          (stay) => stay.shiftId === shift.id && (stay.status === 'active' || stay.status === 'done'),
        ).length,
        cash: sumOf('cash'),
        transfer: sumOf('transfer'),
        spent: 0,
        cashDiff: shift.cashDiff ?? 0,
      }
    })
  const expenses = db.expenses.filter(
    (expense) => inScope(expense.propertyId) && expense.businessDate.startsWith(prefix),
  )
  const totals = shifts.reduce(add, zero())
  totals.spent = expenses.reduce((sum, expense) => sum + expense.amount, 0)
  const payments = shifts.flatMap((row) => row.payments).sort((a, b) => a.at.localeCompare(b.at))

  const shiftIds = new Set(shifts.map((row) => row.shift.id))
  const revenue: Revenue = { stays: 0, room: 0, service: 0, surcharge: 0, discount: 0 }
  for (const stay of db.stays) {
    if (stay.status !== 'done' || stay.checkOutShiftId === null || !shiftIds.has(stay.checkOutShiftId)) continue
    revenue.stays += 1
    revenue.room += stay.finalCharge ?? 0
    revenue.surcharge += Math.max(0, stay.guestCount - stay.standardGuests) * stay.extraGuestFee
    for (const item of stay.items) revenue[item.kind] += item.qty * item.unitPrice
  }

  const notes: ReportNote[] = shifts
    .filter((row) => row.shift.note)
    .map((row) => ({
      date: row.shift.businessDate,
      propertyId: row.shift.propertyId,
      subject: `Ca ${row.shift.label.toLowerCase()}`,
      by: row.shift.userName,
      text: row.shift.note,
    }))
  const roomsInScope = new Map(db.rooms.filter((room) => inScope(room.propertyId)).map((room) => [room.id, room]))
  for (const stay of db.stays) {
    const room = roomsInScope.get(stay.roomId)
    if (room === undefined) continue
    for (const note of stay.notes) {
      if (!note.businessDate.startsWith(prefix)) continue
      notes.push({
        date: note.businessDate,
        propertyId: room.propertyId,
        subject: `Phòng ${room.number}`,
        by: note.by,
        text: note.text,
      })
    }
  }
  notes.sort((a, b) => a.date.localeCompare(b.date))

  return { shifts, payments, expenses, totals, revenue, notes }
}

// Gom số liệu của kỳ theo ngày (báo cáo tháng) hoặc theo tháng (báo cáo năm).
export function groupTotals(report: PeriodReport, keyLength: number): Map<string, Totals> {
  const groups = new Map<string, Totals>()
  const groupOf = (date: string) => {
    const key = date.slice(0, keyLength)
    let group = groups.get(key)
    if (!group) {
      group = zero()
      groups.set(key, group)
    }
    return group
  }
  for (const row of report.shifts) add(groupOf(row.shift.businessDate), row)
  for (const expense of report.expenses) groupOf(expense.businessDate).spent += expense.amount
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)))
}

// Chia số liệu của kỳ theo cơ sở, để báo cáo gộp mọi cơ sở vẫn thấy rõ phần của từng nơi.
// Cơ sở nào trong danh sách mà không có ca hay khoản chi trong kỳ thì vẫn có một dòng toàn số 0.
export function propertyTotals(report: PeriodReport, propertyIds: string[]): Map<string, Totals> {
  const groups = new Map(propertyIds.map((id) => [id, zero()]))
  for (const row of report.shifts) add(groups.get(row.shift.propertyId) ?? zero(), row)
  for (const expense of report.expenses) {
    const group = groups.get(expense.propertyId)
    if (group) group.spent += expense.amount
  }
  return groups
}

