import { and, eq, inArray, isNull } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { AuthUser } from './context'
import type { Database, Tx } from './db/client'
import * as t from './db/schema'
import { dateKey } from './domain/format'
import type { Payment, Property, Room, RoomType, Service, Shift, ShiftLabel, Stay } from './domain/types'
import { fail, found } from './lib/http'

// Đọc dữ liệu từ bảng thành đối tượng nghiệp vụ (cùng kiểu với FE), và các kiểm tra dùng chung.

export type Dbx = Database | Tx

export const newId = () => randomUUID()

type PropertyRow = typeof t.properties.$inferSelect
type ShiftRow = typeof t.shifts.$inferSelect
type StayRow = typeof t.stays.$inferSelect
type PaymentRow = typeof t.payments.$inferSelect

export const toProperty = (row: PropertyRow): Property => ({
  id: row.id,
  name: row.name,
  active: row.active,
  bank: row.bank ?? null,
  settings: row.settings,
  staffIds: row.staffIds ?? null,
  staffCanEditPrice: row.staffCanEditPrice,
})

export const toShift = (row: ShiftRow): Shift => ({
  ...row,
  openedAt: row.openedAt.toISOString(),
  closedAt: row.closedAt?.toISOString() ?? null,
})

export const toPayment = (row: PaymentRow): Payment => ({ ...row, at: row.at.toISOString() })

export const toRoom = (row: typeof t.rooms.$inferSelect): Room => row
export const toRoomType = (row: typeof t.roomTypes.$inferSelect): RoomType => row
export const toService = (row: typeof t.services.$inferSelect): Service => row

// Gắn dòng hóa đơn, ghi chú và danh sách ảnh (không kèm nội dung ảnh) vào các lượt thuê.
export async function loadStays(db: Dbx, rows: StayRow[]): Promise<Stay[]> {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const [items, notes, photos] = await Promise.all([
    db.select().from(t.stayItems).where(inArray(t.stayItems.stayId, ids)),
    db.select().from(t.stayNotes).where(inArray(t.stayNotes.stayId, ids)).orderBy(t.stayNotes.at),
    db
      .select({ id: t.stayPhotos.id, stayId: t.stayPhotos.stayId, at: t.stayPhotos.at })
      .from(t.stayPhotos)
      .where(inArray(t.stayPhotos.stayId, ids))
      .orderBy(t.stayPhotos.at),
  ])
  return rows.map((row) => ({
    ...row,
    checkInAt: row.checkInAt.toISOString(),
    checkOutAt: row.checkOutAt?.toISOString() ?? null,
    items: items
      .filter((item) => item.stayId === row.id)
      .map(({ stayId: _stayId, ...item }) => item),
    notes: notes
      .filter((note) => note.stayId === row.id)
      .map(({ stayId: _stayId, ...note }) => ({ ...note, at: note.at.toISOString() })),
    photos: photos
      .filter((photo) => photo.stayId === row.id)
      .map((photo) => ({ id: photo.id, at: photo.at.toISOString() })),
  }))
}

export async function paymentsOfStays(db: Dbx, stayIds: string[]): Promise<Payment[]> {
  if (stayIds.length === 0) return []
  const rows = await db.select().from(t.payments).where(inArray(t.payments.stayId, stayIds)).orderBy(t.payments.at)
  return rows.map(toPayment)
}

export async function getProperty(db: Dbx, propertyId: string): Promise<PropertyRow> {
  const [row] = await db.select().from(t.properties).where(eq(t.properties.id, propertyId))
  return found(row, 'cơ sở')
}

export async function getRoom(db: Dbx, roomId: string) {
  const [row] = await db.select().from(t.rooms).where(eq(t.rooms.id, roomId))
  return found(row, 'phòng')
}

export async function getStayRow(db: Dbx, stayId: string): Promise<StayRow> {
  const [row] = await db.select().from(t.stays).where(eq(t.stays.id, stayId))
  return found(row, 'lượt thuê')
}

export async function getStay(db: Dbx, stayId: string): Promise<Stay> {
  const [stay] = await loadStays(db, [await getStayRow(db, stayId)])
  return stay
}

// Người này có được làm việc ở cơ sở này không. Chủ luôn được; người trực thì tùy cơ sở
// có giới hạn danh sách hay không.
export function canWorkAt(user: AuthUser, property: PropertyRow): boolean {
  if (user.role === 'owner') return true
  return property.active && (!property.staffIds || property.staffIds.includes(user.id))
}

export async function assertAccess(db: Dbx, user: AuthUser, propertyId: string): Promise<PropertyRow> {
  const property = await getProperty(db, propertyId)
  if (!canWorkAt(user, property)) fail(403, 'Bạn chưa được phân công ở cơ sở này.')
  return property
}

// Kiểm tra quyền qua phòng, vì hầu hết thao tác bắt đầu từ một phòng hoặc một lượt thuê.
export async function accessByRoom(db: Dbx, user: AuthUser, roomId: string) {
  const room = await getRoom(db, roomId)
  const property = await assertAccess(db, user, room.propertyId)
  return { room, property }
}

export async function accessByStay(db: Dbx, user: AuthUser, stayId: string) {
  const stay = await getStayRow(db, stayId)
  return { stay, ...(await accessByRoom(db, user, stay.roomId)) }
}

export async function openShift(db: Dbx, propertyId: string): Promise<ShiftRow | undefined> {
  const [row] = await db
    .select()
    .from(t.shifts)
    .where(and(eq(t.shifts.propertyId, propertyId), isNull(t.shifts.closedAt)))
  return row
}

const shiftLabel = (now: Date): ShiftLabel => (now.getHours() >= 6 && now.getHours() < 18 ? 'Sáng' : 'Tối')

// Ca nhận các thao tác có ghi sổ. Chưa có ca nào mở thì mở luôn ca cho người đang thao tác:
// người trực đã có ca từ lúc đăng nhập, còn chủ thì đến lúc này mới mở.
export async function ensureShift(db: Dbx, propertyId: string, user: AuthUser, now: Date): Promise<ShiftRow> {
  const open = await openShift(db, propertyId)
  if (open) return open
  const [created] = await db
    .insert(t.shifts)
    .values({
      id: newId(),
      propertyId,
      userId: user.id,
      userName: user.name,
      label: shiftLabel(now),
      businessDate: dateKey(now),
      openedAt: now,
    })
    .returning()
  return created
}

// Ngày tính cho một ghi chú: ngày của ca đang mở, không có ca thì là hôm nay.
export async function businessDateNow(db: Dbx, propertyId: string, now: Date): Promise<string> {
  return (await openShift(db, propertyId))?.businessDate ?? dateKey(now)
}
