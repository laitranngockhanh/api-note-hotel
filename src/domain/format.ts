// Chép từ ../Fe bằng `npm run sync:domain`. Không sửa ở đây; sửa ở FE rồi chép lại.
const moneyFormat = new Intl.NumberFormat('vi-VN')
const weekdayFormat = new Intl.DateTimeFormat('vi-VN', { weekday: 'long' })

const pad = (n: number) => String(n).padStart(2, '0')

// Số âm (khoản hoàn lại) viết bằng dấu trừ thật "−" cho dễ thấy và giống nhau ở mọi màn hình.
export const money = (amount: number) => (amount < 0 ? '−' : '') + moneyFormat.format(Math.abs(amount))

export function duration(minutes: number): string {
  const total = Math.max(0, Math.floor(minutes))
  const hours = Math.floor(total / 60)
  return hours > 0 ? `${hours} giờ ${pad(total % 60)}` : `${total} phút`
}

export function time(value: string | Date): string {
  const d = new Date(value)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function dayMonth(value: string | Date): string {
  const d = new Date(value)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
}

// Khóa ngày theo giờ máy, dạng YYYY-MM-DD.
export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function parseDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

export function shiftDateKey(key: string, days: number): string {
  const d = parseDateKey(key)
  d.setDate(d.getDate() + days)
  return dateKey(d)
}

export function longDate(key: string): string {
  const d = parseDateKey(key)
  const weekday = weekdayFormat.format(d)
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${dayMonth(d)}/${d.getFullYear()}`
}
