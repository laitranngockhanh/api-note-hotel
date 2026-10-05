// Chép từ ../Fe bằng `npm run sync:domain`. Không sửa ở đây; sửa ở FE rồi chép lại.
export type Role = 'owner' | 'staff'
export type ShiftLabel = 'Sáng' | 'Tối'
export type RentType = 'hour' | 'overnight' | 'day' | 'week' | 'month'
export type RoomCondition = 'ready' | 'cleaning' | 'maintenance'
export type PaymentMethod = 'cash' | 'transfer'
// discount là khoản giảm giá: lưu số dương, khi tính hóa đơn thì trừ đi.
export type ItemKind = 'service' | 'surcharge' | 'discount'
export type StayStatus = 'booked' | 'active' | 'done' | 'cancelled'

// Tài khoản dùng chung cho mọi cơ sở. Người đã nghỉ thì active = false chứ không xóa,
// để các ca cũ vẫn còn tên người trực.
export interface User {
  id: string
  name: string
  role: Role
  pin: string
  active: boolean
}

export interface Session {
  userId: string
  name: string
  role: Role
}

export interface PriceList {
  firstHour: number
  nextHour: number
  overnight: number
  day: number
  week: number
  month: number
}

// Cơ sở (một nhà nghỉ). Phòng, bảng giá, dịch vụ, ca và khoản chi đều thuộc một cơ sở.
// Tài khoản ngân hàng nhận chuyển khoản, dùng để tạo mã VietQR.
export interface BankAccount {
  bin: string
  accountNumber: string
  accountName: string
}

export interface Property {
  id: string
  name: string
  active: boolean
  bank: BankAccount | null
  // Quy tắc tính tiền riêng của cơ sở.
  settings: Settings
  // Người trực được phép làm ở cơ sở này. null là mọi người trực; chủ thì luôn vào được.
  staffIds: string[] | null
  // Người trực có được sửa giá lúc nhận phòng và đặt trước không.
  staffCanEditPrice: boolean
}

export interface RoomType {
  id: string
  propertyId: string
  name: string
  // Số người tiêu chuẩn của phòng; mỗi người vượt mức này phụ thu extraGuestFee.
  standardGuests: number
  extraGuestFee: number
  prices: PriceList
}

export interface Room {
  id: string
  propertyId: string
  number: string
  typeId: string
  floor: number
  row: number
  col: number
  condition: RoomCondition
}

export interface Service {
  id: string
  propertyId: string
  name: string
  price: number
}

export interface StayItem {
  id: string
  kind: ItemKind
  name: string
  qty: number
  unitPrice: number
  shiftId: string
}

// Ảnh giấy tờ của khách. Ở đây chỉ giữ mã ảnh; nội dung ảnh nằm trong kho ảnh riêng.
export interface StayPhoto {
  id: string
  at: string
}

// Ghi chú của một lượt thuê. Chỉ thêm, không sửa hay xóa: khi có nhầm lẫn thì ghi lại
// chuyện đã xảy ra thay vì sửa số liệu.
export interface StayNote {
  id: string
  text: string
  by: string
  at: string
  businessDate: string
}

// Lượt thuê, gồm cả đặt trước. prices là giá đã chốt lúc nhận hoặc đặt phòng.
// Với lượt đặt trước (booked), checkInAt là giờ khách dự kiến đến.
export interface Stay {
  id: string
  roomId: string
  status: StayStatus
  guestName: string
  guestPhone: string
  guestCount: number
  // Mức người tiêu chuẩn và phụ thu mỗi người thêm, chốt cùng lúc với giá.
  standardGuests: number
  extraGuestFee: number
  rentType: RentType
  periods: number
  checkInAt: string
  checkOutAt: string | null
  prices: PriceList
  items: StayItem[]
  photos: StayPhoto[]
  notes: StayNote[]
  finalCharge: number | null
  // shiftId là ca nhận phòng (hoặc ca nhận đặt); checkOutShiftId là ca trả phòng.
  shiftId: string
  checkOutShiftId: string | null
}

export interface Payment {
  id: string
  stayId: string
  amount: number
  method: PaymentMethod
  shiftId: string
  at: string
}

// businessDate là ngày ca bắt đầu; mọi khoản thu trong ca tính cho ngày đó.
export interface Shift {
  id: string
  propertyId: string
  userId: string
  userName: string
  label: ShiftLabel
  businessDate: string
  openedAt: string
  closedAt: string | null
  cashDiff: number | null
  note: string
}

export interface Expense {
  id: string
  propertyId: string
  name: string
  amount: number
  businessDate: string
  at: string
}

// Một mức phụ thu trả muộn: trả phòng trước untilHour thì cộng percent phần trăm giá ngày.
export interface LateFee {
  untilHour: number
  percent: number
}

export interface Settings {
  graceMinutes: number
  checkoutHour: number
  // Các mức phụ thu trả muộn, tăng dần theo giờ. Trả sau mức cuối là tính thêm một ngày.
  lateFees: LateFee[]
  // Khung giờ được nhận khách qua đêm, ví dụ từ 21 giờ đến 5 giờ sáng.
  overnightFromHour: number
  overnightToHour: number
}

export interface Db {
  users: User[]
  properties: Property[]
  roomTypes: RoomType[]
  rooms: Room[]
  services: Service[]
  stays: Stay[]
  payments: Payment[]
  shifts: Shift[]
  expenses: Expense[]
}
