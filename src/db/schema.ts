import { sql } from 'drizzle-orm'
import { boolean, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import type {
  BankAccount,
  ItemKind,
  PaymentMethod,
  PriceList,
  RentType,
  Role,
  RoomCondition,
  Settings,
  ShiftLabel,
  StayStatus,
} from '../domain/types'

// Mọi mốc thời gian lưu kèm múi giờ. Tiền là số nguyên đồng. Mã bản ghi là UUID dạng chữ.
const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').$type<Role>().notNull(),
  // PIN mã hóa đọc lại được (chủ cần xem PIN của nhân viên), và HMAC của PIN để tìm tài
  // khoản lúc đăng nhập và bảo đảm không ai trùng PIN.
  pinCipher: text('pin_cipher').notNull(),
  pinLookup: text('pin_lookup').notNull().unique(),
  active: boolean('active').notNull().default(true),
})

export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: time('created_at').notNull(),
})

// Bộ đếm nhập sai PIN, theo địa chỉ IP.
export const pinGuards = pgTable('pin_guards', {
  key: text('key').primaryKey(),
  fails: integer('fails').notNull().default(0),
  lockedUntil: time('locked_until'),
})

export const properties = pgTable('properties', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  bank: jsonb('bank').$type<BankAccount | null>(),
  settings: jsonb('settings').$type<Settings>().notNull(),
  // null là mọi người trực đều làm được ở cơ sở này.
  staffIds: jsonb('staff_ids').$type<string[] | null>(),
  staffCanEditPrice: boolean('staff_can_edit_price').notNull().default(true),
})

export const roomTypes = pgTable('room_types', {
  id: text('id').primaryKey(),
  propertyId: text('property_id')
    .notNull()
    .references(() => properties.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  standardGuests: integer('standard_guests').notNull(),
  extraGuestFee: integer('extra_guest_fee').notNull(),
  prices: jsonb('prices').$type<PriceList>().notNull(),
})

export const rooms = pgTable(
  'rooms',
  {
    id: text('id').primaryKey(),
    propertyId: text('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    typeId: text('type_id')
      .notNull()
      .references(() => roomTypes.id),
    floor: integer('floor').notNull(),
    row: integer('row').notNull(),
    col: integer('col').notNull(),
    condition: text('condition').$type<RoomCondition>().notNull().default('ready'),
  },
  (t) => [uniqueIndex('rooms_number_per_property').on(t.propertyId, t.number)],
)

export const services = pgTable('services', {
  id: text('id').primaryKey(),
  propertyId: text('property_id')
    .notNull()
    .references(() => properties.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  price: integer('price').notNull(),
})

export const shifts = pgTable(
  'shifts',
  {
    id: text('id').primaryKey(),
    propertyId: text('property_id')
      .notNull()
      .references(() => properties.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    userName: text('user_name').notNull(),
    label: text('label').$type<ShiftLabel>().notNull(),
    // Ngày ca bắt đầu, dạng YYYY-MM-DD theo giờ Việt Nam. Báo cáo gom theo cột này.
    businessDate: text('business_date').notNull(),
    openedAt: time('opened_at').notNull(),
    closedAt: time('closed_at'),
    cashDiff: integer('cash_diff'),
    note: text('note').notNull().default(''),
  },
  (t) => [
    // Mỗi cơ sở chỉ có một ca mở tại một thời điểm.
    uniqueIndex('one_open_shift_per_property')
      .on(t.propertyId)
      .where(sql`${t.closedAt} is null`),
    index('shifts_by_business_date').on(t.propertyId, t.businessDate),
  ],
)

export const stays = pgTable(
  'stays',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id),
    status: text('status').$type<StayStatus>().notNull(),
    guestName: text('guest_name').notNull().default(''),
    guestPhone: text('guest_phone').notNull().default(''),
    guestCount: integer('guest_count').notNull(),
    standardGuests: integer('standard_guests').notNull(),
    extraGuestFee: integer('extra_guest_fee').notNull(),
    rentType: text('rent_type').$type<RentType>().notNull(),
    periods: integer('periods').notNull(),
    // Với lượt đặt trước, đây là giờ khách hẹn đến.
    checkInAt: time('check_in_at').notNull(),
    checkOutAt: time('check_out_at'),
    prices: jsonb('prices').$type<PriceList>().notNull(),
    finalCharge: integer('final_charge'),
    shiftId: text('shift_id')
      .notNull()
      .references(() => shifts.id),
    checkOutShiftId: text('check_out_shift_id').references(() => shifts.id),
  },
  (t) => [index('stays_by_room').on(t.roomId, t.status)],
)

export const stayItems = pgTable(
  'stay_items',
  {
    id: text('id').primaryKey(),
    stayId: text('stay_id')
      .notNull()
      .references(() => stays.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ItemKind>().notNull(),
    name: text('name').notNull(),
    qty: integer('qty').notNull(),
    unitPrice: integer('unit_price').notNull(),
    shiftId: text('shift_id')
      .notNull()
      .references(() => shifts.id),
  },
  (t) => [index('stay_items_by_stay').on(t.stayId)],
)

export const stayNotes = pgTable(
  'stay_notes',
  {
    id: text('id').primaryKey(),
    stayId: text('stay_id')
      .notNull()
      .references(() => stays.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    by: text('by').notNull(),
    at: time('at').notNull(),
    businessDate: text('business_date').notNull(),
  },
  (t) => [index('stay_notes_by_stay').on(t.stayId)],
)

// Ảnh giấy tờ của khách. Lưu ngay trong cơ sở dữ liệu vì ảnh nhỏ và chỉ giữ đến khi trả phòng.
export const stayPhotos = pgTable(
  'stay_photos',
  {
    id: text('id').primaryKey(),
    stayId: text('stay_id')
      .notNull()
      .references(() => stays.id, { onDelete: 'cascade' }),
    at: time('at').notNull(),
    contentType: text('content_type').notNull(),
    data: bytea('data').notNull(),
  },
  (t) => [index('stay_photos_by_stay').on(t.stayId)],
)

export const payments = pgTable(
  'payments',
  {
    id: text('id').primaryKey(),
    stayId: text('stay_id')
      .notNull()
      .references(() => stays.id),
    // Số âm là hoàn tiền.
    amount: integer('amount').notNull(),
    method: text('method').$type<PaymentMethod>().notNull(),
    shiftId: text('shift_id')
      .notNull()
      .references(() => shifts.id),
    at: time('at').notNull(),
  },
  (t) => [index('payments_by_stay').on(t.stayId), index('payments_by_shift').on(t.shiftId)],
)

export const expenses = pgTable(
  'expenses',
  {
    id: text('id').primaryKey(),
    propertyId: text('property_id')
      .notNull()
      .references(() => properties.id),
    name: text('name').notNull(),
    amount: integer('amount').notNull(),
    businessDate: text('business_date').notNull(),
    at: time('at').notNull(),
  },
  (t) => [index('expenses_by_business_date').on(t.propertyId, t.businessDate)],
)
