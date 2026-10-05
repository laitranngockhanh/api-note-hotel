import { and, eq, inArray, isNull, ne } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import type { Context } from '../context'
import { userOf } from '../context'
import * as t from '../db/schema'
import type { Settings } from '../domain/types'
import { fail, found, handle, money, param, parse, requiredText } from '../lib/http'
import { isValidPin, PIN_LENGTH } from '../lib/pin'
import { getProperty, getRoom, newId, toProperty, type Dbx } from '../repo'

// Mọi route trong file này chỉ dành cho chủ (app.ts gắn requireOwner trước router).

export const DEFAULT_SETTINGS: Settings = {
  graceMinutes: 10,
  checkoutHour: 12,
  lateFees: [
    { untilHour: 15, percent: 30 },
    { untilHour: 18, percent: 50 },
  ],
  overnightFromHour: 22,
  overnightToHour: 5,
}

const hour = z.number().int().min(0).max(23)
const position = { floor: z.number().int().min(1).max(50), row: z.number().int().min(1).max(10), col: z.number().int().min(1).max(20) }
const prices = z.object({
  firstHour: money,
  nextHour: money,
  overnight: money,
  day: money,
  week: money,
  month: money,
})
const roomTypeBody = z.object({
  name: requiredText(100),
  standardGuests: z.number().int().min(1).max(50),
  extraGuestFee: money,
  prices,
})
const serviceBody = z.object({ name: requiredText(100), price: money.min(1) })
const settingsBody = z.object({
  graceMinutes: z.number().int().min(0).max(59),
  checkoutHour: hour,
  lateFees: z.array(z.object({ untilHour: hour, percent: z.number().int().min(0).max(100) })).max(5),
  overnightFromHour: hour,
  overnightToHour: hour,
})
const bankBody = z.object({
  bin: requiredText(20),
  accountNumber: z.string().regex(/^\d{6,19}$/),
  accountName: requiredText(100),
})
const propertyPatch = z.object({
  name: requiredText(100).optional(),
  active: z.boolean().optional(),
  bank: bankBody.nullable().optional(),
  settings: settingsBody.optional(),
  staffIds: z.array(z.string()).nullable().optional(),
  staffCanEditPrice: z.boolean().optional(),
})
const role = z.enum(['owner', 'staff'])
const userPatch = z.object({
  name: requiredText(100).optional(),
  role: role.optional(),
  pin: z.string().optional(),
  active: z.boolean().optional(),
})

export function adminRouter({ db, pins, now }: Context): Router {
  const router = Router()

  // ----- Sơ đồ phòng -----

  async function assertRoomNumberFree(propertyId: string, number: string, exceptRoomId?: string) {
    const same = await db
      .select({ id: t.rooms.id })
      .from(t.rooms)
      .where(and(eq(t.rooms.propertyId, propertyId), eq(t.rooms.number, number)))
    if (same.some((room) => room.id !== exceptRoomId)) fail(409, 'Số phòng này đã có.')
  }

  async function assertTypeOf(propertyId: string, typeId: string) {
    const [type] = await db.select().from(t.roomTypes).where(eq(t.roomTypes.id, typeId))
    if (!type || type.propertyId !== propertyId) fail(400, 'Loại phòng không thuộc cơ sở này.')
  }

  router.post(
    '/rooms',
    handle(async (req) => {
      const input = parse(
        z.object({ propertyId: z.string(), number: requiredText(20), typeId: z.string(), ...position }),
        req.body,
      )
      await getProperty(db, input.propertyId)
      await assertTypeOf(input.propertyId, input.typeId)
      await assertRoomNumberFree(input.propertyId, input.number)
      const id = newId()
      await db.insert(t.rooms).values({ id, ...input })
      return { id }
    }),
  )

  router.patch(
    '/rooms/:id',
    handle(async (req) => {
      const input = parse(
        z.object({ number: requiredText(20), typeId: z.string(), ...position }).partial(),
        req.body,
      )
      const room = await getRoom(db, param(req, 'id'))
      if (input.typeId) await assertTypeOf(room.propertyId, input.typeId)
      if (input.number) await assertRoomNumberFree(room.propertyId, input.number, room.id)
      if (Object.keys(input).length > 0) await db.update(t.rooms).set(input).where(eq(t.rooms.id, room.id))
    }),
  )

  // Chỉ xóa được phòng chưa từng có lượt thuê, để lịch sử và báo cáo cũ không mất chỗ tham chiếu.
  router.delete(
    '/rooms/:id',
    handle(async (req) => {
      const room = await getRoom(db, param(req, 'id'))
      const used = await db.select({ id: t.stays.id }).from(t.stays).where(eq(t.stays.roomId, room.id)).limit(1)
      if (used.length > 0) {
        fail(409, 'Phòng đã có lượt thuê nên không xóa được. Chuyển sang bảo trì nếu không dùng nữa.')
      }
      await db.delete(t.rooms).where(eq(t.rooms.id, room.id))
    }),
  )

  // ----- Loại phòng và giá -----

  router.post(
    '/room-types',
    handle(async (req) => {
      const input = parse(roomTypeBody.extend({ propertyId: z.string() }), req.body)
      await getProperty(db, input.propertyId)
      const id = newId()
      await db.insert(t.roomTypes).values({ id, ...input })
      return { id }
    }),
  )

  // Đổi bảng giá chỉ ảnh hưởng lượt thuê mới; lượt đang ở giữ giá đã chốt.
  router.put(
    '/room-types/:id',
    handle(async (req) => {
      const input = parse(roomTypeBody, req.body)
      const updated = await db
        .update(t.roomTypes)
        .set(input)
        .where(eq(t.roomTypes.id, param(req, 'id')))
        .returning({ id: t.roomTypes.id })
      found(updated[0], 'loại phòng')
    }),
  )

  router.delete(
    '/room-types/:id',
    handle(async (req) => {
      const used = await db.select({ id: t.rooms.id }).from(t.rooms).where(eq(t.rooms.typeId, param(req, 'id'))).limit(1)
      if (used.length > 0) fail(409, 'Đang có phòng thuộc loại này nên không xóa được.')
      await db.delete(t.roomTypes).where(eq(t.roomTypes.id, param(req, 'id')))
    }),
  )

  // ----- Dịch vụ -----

  router.post(
    '/services',
    handle(async (req) => {
      const input = parse(serviceBody.extend({ propertyId: z.string() }), req.body)
      await getProperty(db, input.propertyId)
      const id = newId()
      await db.insert(t.services).values({ id, ...input })
      return { id }
    }),
  )

  router.put(
    '/services/:id',
    handle(async (req) => {
      const input = parse(serviceBody, req.body)
      const updated = await db
        .update(t.services)
        .set(input)
        .where(eq(t.services.id, param(req, 'id')))
        .returning({ id: t.services.id })
      found(updated[0], 'dịch vụ')
    }),
  )

  // Xóa dịch vụ không ảnh hưởng hóa đơn cũ, vì tên và giá đã được chép vào từng dòng hóa đơn.
  router.delete(
    '/services/:id',
    handle(async (req) => {
      await db.delete(t.services).where(eq(t.services.id, param(req, 'id')))
    }),
  )

  // ----- Cơ sở -----

  router.get(
    '/properties',
    handle(async () => (await db.select().from(t.properties)).map(toProperty)),
  )

  // Cơ sở mới chép loại phòng, giá, dịch vụ và quy tắc tính tiền từ một cơ sở có sẵn. Sơ đồ
  // phòng và tài khoản ngân hàng thì không chép, vì hai thứ này gần như chắc chắn khác nhau.
  router.post(
    '/properties',
    handle(async (req) => {
      const input = parse(z.object({ name: requiredText(100), copyFromId: z.string().optional() }), req.body)
      const id = newId()
      await db.transaction(async (tx) => {
        const [source] = input.copyFromId
          ? await tx.select().from(t.properties).where(eq(t.properties.id, input.copyFromId))
          : []
        await tx.insert(t.properties).values({
          id,
          name: input.name,
          settings: source?.settings ?? DEFAULT_SETTINGS,
          staffCanEditPrice: source?.staffCanEditPrice ?? true,
        })
        if (!source) return
        const types = await tx.select().from(t.roomTypes).where(eq(t.roomTypes.propertyId, source.id))
        if (types.length > 0) {
          await tx.insert(t.roomTypes).values(types.map((type) => ({ ...type, id: newId(), propertyId: id })))
        }
        const services = await tx.select().from(t.services).where(eq(t.services.propertyId, source.id))
        if (services.length > 0) {
          await tx.insert(t.services).values(services.map((service) => ({ ...service, id: newId(), propertyId: id })))
        }
      })
      return { id }
    }),
  )

  async function roomIdsOf(tx: Dbx, propertyId: string): Promise<string[]> {
    const rows = await tx.select({ id: t.rooms.id }).from(t.rooms).where(eq(t.rooms.propertyId, propertyId))
    return rows.map((row) => row.id)
  }

  router.patch(
    '/properties/:id',
    handle(async (req) => {
      const input = parse(propertyPatch, req.body)
      await db.transaction(async (tx) => {
        const property = await getProperty(tx, param(req, 'id'))
        // Ngừng hoạt động: cơ sở biến mất khỏi màn chọn cơ sở, lịch sử và báo cáo vẫn còn.
        if (input.active === false && property.active) {
          const others = await tx
            .select({ id: t.properties.id })
            .from(t.properties)
            .where(and(eq(t.properties.active, true), ne(t.properties.id, property.id)))
          if (others.length === 0) fail(409, 'Phải còn ít nhất một cơ sở hoạt động.')
          const open = await tx
            .select({ id: t.shifts.id })
            .from(t.shifts)
            .where(and(eq(t.shifts.propertyId, property.id), isNull(t.shifts.closedAt)))
          if (open.length > 0) fail(409, 'Cơ sở đang có ca mở. Kết thúc ca trước.')
          const roomIds = await roomIdsOf(tx, property.id)
          const busy =
            roomIds.length > 0 &&
            (
              await tx
                .select({ id: t.stays.id })
                .from(t.stays)
                .where(and(inArray(t.stays.roomId, roomIds), inArray(t.stays.status, ['booked', 'active'])))
                .limit(1)
            ).length > 0
          if (busy) fail(409, 'Cơ sở còn khách đang ở hoặc lượt đặt trước.')
        }
        if (Object.keys(input).length > 0) await tx.update(t.properties).set(input).where(eq(t.properties.id, property.id))
      })
    }),
  )

  // Chỉ xóa hẳn được cơ sở chưa có lượt thuê, ca hay khoản chi nào.
  router.delete(
    '/properties/:id',
    handle(async (req) => {
      await db.transaction(async (tx) => {
        const property = await getProperty(tx, param(req, 'id'))
        const all = await tx.select({ id: t.properties.id }).from(t.properties)
        if (all.length === 1) fail(409, 'Phải còn ít nhất một cơ sở.')
        const roomIds = await roomIdsOf(tx, property.id)
        const [stay, shift, expense] = await Promise.all([
          roomIds.length > 0
            ? tx.select({ id: t.stays.id }).from(t.stays).where(inArray(t.stays.roomId, roomIds)).limit(1)
            : [],
          tx.select({ id: t.shifts.id }).from(t.shifts).where(eq(t.shifts.propertyId, property.id)).limit(1),
          tx.select({ id: t.expenses.id }).from(t.expenses).where(eq(t.expenses.propertyId, property.id)).limit(1),
        ])
        if (stay.length + shift.length + expense.length > 0) {
          fail(409, 'Cơ sở đã có dữ liệu nên không xóa được. Dùng Ngừng hoạt động.')
        }
        // Phòng phải xóa trước loại phòng vì phòng tham chiếu loại phòng.
        await tx.delete(t.rooms).where(eq(t.rooms.propertyId, property.id))
        await tx.delete(t.properties).where(eq(t.properties.id, property.id))
      })
    }),
  )

  // ----- Nhân viên và mã PIN -----

  async function assertPinFree(tx: Dbx, pin: string, exceptUserId?: string) {
    if (!isValidPin(pin)) fail(400, `Mã PIN phải gồm đúng ${PIN_LENGTH} chữ số.`)
    // PIN vừa là mật khẩu vừa là thứ nhận ra người trực, nên không được trùng nhau.
    const same = await tx.select({ id: t.users.id }).from(t.users).where(eq(t.users.pinLookup, pins.lookup(pin)))
    if (same.some((user) => user.id !== exceptUserId)) fail(409, 'Mã PIN này đang được dùng. Chọn mã khác.')
  }

  // Luôn phải còn ít nhất một chủ đang hoạt động, nếu không sẽ không ai vào được phần quản lý.
  async function isLastOwner(tx: Dbx, userId: string): Promise<boolean> {
    const owners = await tx
      .select({ id: t.users.id })
      .from(t.users)
      .where(and(eq(t.users.role, 'owner'), eq(t.users.active, true)))
    return owners.length === 1 && owners[0].id === userId
  }

  const getUser = async (tx: Dbx, userId: string) =>
    found((await tx.select().from(t.users).where(eq(t.users.id, userId)))[0], 'tài khoản')

  router.get(
    '/users',
    handle(async () =>
      db.select({ id: t.users.id, name: t.users.name, role: t.users.role, active: t.users.active }).from(t.users),
    ),
  )

  router.post(
    '/users',
    handle(async (req) => {
      const input = parse(z.object({ name: requiredText(100), role, pin: z.string() }), req.body)
      await assertPinFree(db, input.pin)
      const id = newId()
      await db.insert(t.users).values({
        id,
        name: input.name,
        role: input.role,
        pinCipher: pins.encrypt(input.pin),
        pinLookup: pins.lookup(input.pin),
      })
      return { id }
    }),
  )

  router.patch(
    '/users/:id',
    handle(async (req, res) => {
      const input = parse(userPatch, req.body)
      const acting = userOf(res)
      await db.transaction(async (tx) => {
        const user = await getUser(tx, param(req, 'id'))
        const set: Partial<typeof t.users.$inferInsert> = {}
        if (input.name !== undefined) set.name = input.name
        if (input.role !== undefined && input.role !== user.role) {
          if (input.role !== 'owner' && (await isLastOwner(tx, user.id))) {
            fail(409, 'Đây là chủ duy nhất, không đổi thành người trực được.')
          }
          set.role = input.role
        }
        // Để trống PIN nghĩa là giữ PIN cũ.
        if (input.pin) {
          await assertPinFree(tx, input.pin, user.id)
          set.pinCipher = pins.encrypt(input.pin)
          set.pinLookup = pins.lookup(input.pin)
        }
        if (input.active !== undefined && input.active !== user.active) {
          if (!input.active) {
            if (user.id === acting.id) fail(409, 'Không tự ngừng tài khoản của chính mình được.')
            if (await isLastOwner(tx, user.id)) fail(409, 'Đây là chủ duy nhất, không ngừng được.')
            const open = await tx
              .select({ id: t.shifts.id })
              .from(t.shifts)
              .where(and(eq(t.shifts.userId, user.id), isNull(t.shifts.closedAt)))
            if (open.length > 0) fail(409, 'Người này đang có ca mở. Kết thúc ca trước.')
          }
          set.active = input.active
        }
        if (Object.keys(set).length > 0) await tx.update(t.users).set(set).where(eq(t.users.id, user.id))
      })
    }),
  )

  // Chỉ xóa hẳn được tài khoản chưa từng trực ca; còn lại thì ngừng hoạt động.
  router.delete(
    '/users/:id',
    handle(async (req, res) => {
      const acting = userOf(res)
      await db.transaction(async (tx) => {
        const user = await getUser(tx, param(req, 'id'))
        if (user.id === acting.id) fail(409, 'Không tự xóa tài khoản của chính mình được.')
        if (await isLastOwner(tx, user.id)) fail(409, 'Đây là chủ duy nhất, không xóa được.')
        const worked = await tx.select({ id: t.shifts.id }).from(t.shifts).where(eq(t.shifts.userId, user.id)).limit(1)
        if (worked.length > 0) fail(409, 'Người này đã từng trực ca nên không xóa được. Dùng Ngừng hoạt động.')
        // Gỡ người này khỏi danh sách được trực của các cơ sở.
        for (const property of await tx.select().from(t.properties)) {
          if (property.staffIds?.includes(user.id)) {
            await tx
              .update(t.properties)
              .set({ staffIds: property.staffIds.filter((id) => id !== user.id) })
              .where(eq(t.properties.id, property.id))
          }
        }
        await tx.delete(t.users).where(eq(t.users.id, user.id))
      })
    }),
  )

  // Chủ xem PIN của một người để nhắc lại khi họ quên, không cần đặt PIN mới.
  router.get(
    '/users/:id/pin',
    handle(async (req) => ({ pin: pins.decrypt((await getUser(db, param(req, 'id'))).pinCipher) })),
  )

  // ----- Khoản chi -----

  router.post(
    '/expenses',
    handle(async (req) => {
      const input = parse(
        z.object({
          propertyId: z.string(),
          name: requiredText(100),
          amount: money.min(1),
          businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
        req.body,
      )
      await getProperty(db, input.propertyId)
      const id = newId()
      await db.insert(t.expenses).values({ id, ...input, at: now() })
      return { id }
    }),
  )

  router.delete(
    '/expenses/:id',
    handle(async (req) => {
      await db.delete(t.expenses).where(eq(t.expenses.id, param(req, 'id')))
    }),
  )

  return router
}
