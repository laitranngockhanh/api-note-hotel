import { and, eq, isNull } from 'drizzle-orm'
import express, { Router } from 'express'
import { z } from 'zod'
import type { AuthUser, Context } from '../context'
import { userOf } from '../context'
import * as t from '../db/schema'
import { stayBill } from '../domain/bill'
import { money as formatMoney } from '../domain/format'
import { PERIOD_UNIT } from '../domain/labels'
import { overnightAllowed, overnightWindowLabel } from '../domain/pricing'
import type { StayStatus } from '../domain/types'
import { fail, found, handle, money, param, parse, requiredText, text } from '../lib/http'
import {
  accessByRoom,
  accessByStay,
  businessDateNow,
  ensureShift,
  getRoom,
  getStay,
  newId,
  paymentsOfStays,
  type Dbx,
} from '../repo'

export const MAX_STAY_PHOTOS = 6

const rentType = z.enum(['hour', 'overnight', 'day', 'week', 'month'])
const method = z.enum(['cash', 'transfer'])
const prices = z.object({
  firstHour: money,
  nextHour: money,
  overnight: money,
  day: money,
  week: money,
  month: money,
})
const guestCount = z.number().int().min(1).max(50)

const checkInBody = z.object({
  roomId: z.string(),
  rentType,
  periods: z.number().int().min(1).max(120),
  prices,
  guestName: text(100).default(''),
  guestPhone: text(30).default(''),
  guestCount,
})
const bookBody = checkInBody.extend({
  expectedAt: z.iso.datetime(),
  deposit: money.default(0),
  depositMethod: method.default('cash'),
})
const patchBody = z.object({
  guestName: text(100).optional(),
  guestPhone: text(30).optional(),
  guestCount: guestCount.optional(),
  rentType: rentType.optional(),
  expectedAt: z.iso.datetime().optional(),
})
const itemBody = z.object({
  kind: z.enum(['service', 'surcharge', 'discount']),
  name: requiredText(100),
  unitPrice: money.min(1),
})
const paymentBody = z.object({ amount: money.min(1), method })

const STATUS_TEXT: Record<StayStatus, string> = {
  booked: 'đang ở trạng thái đặt trước',
  active: 'đang có khách ở',
  done: 'đã trả phòng',
  cancelled: 'đã hủy',
}

function requireStatus(stay: { status: StayStatus }, ...allowed: StayStatus[]): void {
  if (!allowed.includes(stay.status)) fail(409, `Lượt thuê này ${STATUS_TEXT[stay.status]}, không làm được việc này.`)
}

async function hasActiveStay(db: Dbx, roomId: string): Promise<boolean> {
  const rows = await db
    .select({ id: t.stays.id })
    .from(t.stays)
    .where(and(eq(t.stays.roomId, roomId), eq(t.stays.status, 'active')))
  return rows.length > 0
}

const canEditPrice = (user: AuthUser, property: { staffCanEditPrice: boolean }) =>
  user.role === 'owner' || property.staffCanEditPrice

export function staysRouter({ db, now }: Context): Router {
  const router = Router()

  // Giá, số người tiêu chuẩn và phụ thu thêm người được chốt vào lượt thuê lúc tạo.
  // Người không có quyền sửa giá thì luôn dùng giá của loại phòng, bất kể máy khách gửi gì.
  async function stayTerms(tx: Dbx, user: AuthUser, roomId: string, input: z.infer<typeof checkInBody>) {
    const { room, property } = await accessByRoom(tx, user, roomId)
    const [type] = await tx.select().from(t.roomTypes).where(eq(t.roomTypes.id, room.typeId))
    return {
      room,
      property,
      values: {
        id: newId(),
        roomId,
        guestName: input.guestName,
        guestPhone: input.guestPhone,
        guestCount: input.guestCount,
        standardGuests: type.standardGuests,
        extraGuestFee: type.extraGuestFee,
        rentType: input.rentType,
        periods: PERIOD_UNIT[input.rentType] ? input.periods : 1,
        prices: canEditPrice(user, property) ? input.prices : type.prices,
      },
    }
  }

  router.post(
    '/stays/check-in',
    handle(async (req, res) => {
      const input = parse(checkInBody, req.body)
      const user = userOf(res)
      const at = now()
      return db.transaction(async (tx) => {
        const { room, property, values } = await stayTerms(tx, user, input.roomId, input)
        if (room.condition !== 'ready') fail(409, 'Phòng chưa sẵn sàng để nhận khách.')
        if (await hasActiveStay(tx, room.id)) fail(409, 'Phòng đang có khách.')
        if (input.rentType === 'overnight' && !overnightAllowed(at, property.settings)) {
          fail(400, `Qua đêm chỉ nhận từ ${overnightWindowLabel(property.settings)}.`)
        }
        const shift = await ensureShift(tx, property.id, user, at)
        await tx.insert(t.stays).values({ ...values, status: 'active', checkInAt: at, shiftId: shift.id })
        return { id: values.id }
      })
    }),
  )

  // Đặt trước là một lượt thuê ở trạng thái booked; tiền cọc là một khoản thu của lượt đó.
  // Trùng lịch không bị chặn ở đây: giao diện cảnh báo và người trực quyết định.
  router.post(
    '/stays/book',
    handle(async (req, res) => {
      const input = parse(bookBody, req.body)
      const user = userOf(res)
      const at = now()
      const expectedAt = new Date(input.expectedAt)
      return db.transaction(async (tx) => {
        const { room, property, values } = await stayTerms(tx, user, input.roomId, input)
        if (room.condition === 'maintenance') fail(409, 'Phòng đang bảo trì.')
        if (input.rentType === 'overnight' && !overnightAllowed(expectedAt, property.settings)) {
          fail(400, `Qua đêm chỉ nhận từ ${overnightWindowLabel(property.settings)}.`)
        }
        const shift = await ensureShift(tx, property.id, user, at)
        await tx.insert(t.stays).values({ ...values, status: 'booked', checkInAt: expectedAt, shiftId: shift.id })
        if (input.deposit > 0) {
          await tx.insert(t.payments).values({
            id: newId(),
            stayId: values.id,
            amount: input.deposit,
            method: input.depositMethod,
            shiftId: shift.id,
            at,
          })
        }
        return { id: values.id }
      })
    }),
  )

  // Khách đặt trước đến: lượt đặt thành lượt đang ở, giờ vào tính từ lúc này.
  router.post(
    '/stays/:id/arrive',
    handle(async (req, res) => {
      const user = userOf(res)
      const at = now()
      await db.transaction(async (tx) => {
        const { stay, room, property } = await accessByStay(tx, user, param(req, 'id'))
        requireStatus(stay, 'booked')
        if (room.condition !== 'ready') fail(409, 'Phòng chưa sẵn sàng để nhận khách.')
        if (await hasActiveStay(tx, room.id)) fail(409, 'Phòng đang có khách.')
        const shift = await ensureShift(tx, property.id, user, at)
        await tx
          .update(t.stays)
          .set({ status: 'active', checkInAt: at, shiftId: shift.id })
          .where(eq(t.stays.id, stay.id))
      })
    }),
  )

  // Hủy đặt. Có refundMethod thì hoàn lại toàn bộ tiền cọc bằng một khoản thu âm.
  router.post(
    '/stays/:id/cancel',
    handle(async (req, res) => {
      const { refundMethod } = parse(z.object({ refundMethod: method.optional() }), req.body ?? {})
      const user = userOf(res)
      const at = now()
      await db.transaction(async (tx) => {
        const { stay, property } = await accessByStay(tx, user, param(req, 'id'))
        requireStatus(stay, 'booked')
        await tx.update(t.stays).set({ status: 'cancelled' }).where(eq(t.stays.id, stay.id))
        await tx.delete(t.stayPhotos).where(eq(t.stayPhotos.stayId, stay.id))
        const deposit = (await paymentsOfStays(tx, [stay.id])).reduce((sum, p) => sum + p.amount, 0)
        if (refundMethod && deposit > 0) {
          const shift = await ensureShift(tx, property.id, user, at)
          await tx
            .insert(t.payments)
            .values({ id: newId(), stayId: stay.id, amount: -deposit, method: refundMethod, shiftId: shift.id, at })
        }
      })
    }),
  )

  // Trả phòng: chốt tiền phòng bằng chính hàm tính tiền của giao diện, ghi nhận phần còn
  // lại là đã thu (số âm là hoàn tiền), xóa ảnh giấy tờ, chuyển phòng sang chờ dọn.
  router.post(
    '/stays/:id/check-out',
    handle(async (req, res) => {
      // expectedDue là số tiền người trực đang thấy trên màn hình lúc bấm trả phòng.
      const input = parse(z.object({ method, expectedDue: z.number().int().optional() }), req.body)
      const user = userOf(res)
      const at = now()
      return db.transaction(async (tx) => {
        const { stay: row, property } = await accessByStay(tx, user, param(req, 'id'))
        requireStatus(row, 'active')
        const stay = await getStay(tx, row.id)
        const bill = stayBill(stay, await paymentsOfStays(tx, [stay.id]), at, property.settings)
        // Tiền người trực thu của khách phải đúng bằng tiền ghi vào sổ. Số trên màn hình có thể đã
        // cũ (vừa sang mốc giờ mới, hoặc máy khác vừa thêm dịch vụ hay thu trước), nên lệch thì
        // từ chối và báo số mới, không âm thầm ghi một số khác với số đã thu.
        if (input.expectedDue !== undefined && input.expectedDue !== bill.due) {
          const current =
            bill.due > 0
              ? `phải thu ${formatMoney(bill.due)} đ`
              : bill.due < 0
                ? `phải hoàn cho khách ${formatMoney(-bill.due)} đ`
                : 'khách đã trả đủ'
          fail(409, `Số tiền của phòng này vừa thay đổi: bây giờ ${current}. Xem lại rồi bấm lại.`)
        }
        const shift = await ensureShift(tx, property.id, user, at)
        await tx
          .update(t.stays)
          .set({ status: 'done', finalCharge: bill.charge.amount, checkOutAt: at, checkOutShiftId: shift.id })
          .where(eq(t.stays.id, stay.id))
        if (bill.due !== 0) {
          await tx
            .insert(t.payments)
            .values({ id: newId(), stayId: stay.id, amount: bill.due, method: input.method, shiftId: shift.id, at })
        }
        await tx.delete(t.stayPhotos).where(eq(t.stayPhotos.stayId, stay.id))
        await tx.update(t.rooms).set({ condition: 'cleaning' }).where(eq(t.rooms.id, stay.roomId))
        return { total: bill.total, collected: bill.due }
      })
    }),
  )

  router.patch(
    '/stays/:id',
    handle(async (req, res) => {
      const input = parse(patchBody, req.body)
      const user = userOf(res)
      await db.transaction(async (tx) => {
        const { stay, property } = await accessByStay(tx, user, param(req, 'id'))
        const set: Partial<typeof t.stays.$inferInsert> = {}
        // Tên và số điện thoại sửa được ở mọi trạng thái, để chữa lỗi gõ nhầm.
        if (input.guestName !== undefined) set.guestName = input.guestName
        if (input.guestPhone !== undefined) set.guestPhone = input.guestPhone
        if (input.guestCount !== undefined) {
          requireStatus(stay, 'booked', 'active')
          set.guestCount = input.guestCount
        }
        if (input.expectedAt !== undefined) {
          requireStatus(stay, 'booked')
          set.checkInAt = new Date(input.expectedAt)
        }
        if (input.rentType !== undefined) {
          // Đổi kiểu thuê: tiền tính lại từ giờ vào theo kiểu mới.
          requireStatus(stay, 'active')
          if (input.rentType === 'overnight' && !overnightAllowed(stay.checkInAt, property.settings)) {
            fail(400, `Qua đêm chỉ áp dụng khi khách vào từ ${overnightWindowLabel(property.settings)}.`)
          }
          set.rentType = input.rentType
          set.periods = 1
        }
        if (Object.keys(set).length > 0) await tx.update(t.stays).set(set).where(eq(t.stays.id, stay.id))
      })
    }),
  )

  router.post(
    '/stays/:id/extend',
    handle(async (req, res) => {
      const { stay } = await accessByStay(db, userOf(res), param(req, 'id'))
      requireStatus(stay, 'active')
      if (!PERIOD_UNIT[stay.rentType]) fail(400, 'Kiểu thuê này không gia hạn theo kỳ.')
      await db.update(t.stays).set({ periods: stay.periods + 1 }).where(eq(t.stays.id, stay.id))
    }),
  )

  // Đổi phòng: giữ nguyên giờ vào, giá và hóa đơn. Với khách đang ở, phòng cũ đã dùng nên
  // chuyển sang chờ dọn. Tự ghi lại một ghi chú để biết đã đổi phòng.
  router.post(
    '/stays/:id/move',
    handle(async (req, res) => {
      const { roomId } = parse(z.object({ roomId: z.string() }), req.body)
      const user = userOf(res)
      const at = now()
      await db.transaction(async (tx) => {
        const { stay, room: from, property } = await accessByStay(tx, user, param(req, 'id'))
        requireStatus(stay, 'booked', 'active')
        const to = await getRoom(tx, roomId)
        if (to.propertyId !== from.propertyId || to.id === from.id) fail(400, 'Chọn một phòng khác trong cùng cơ sở.')
        if (stay.status === 'active') {
          if (to.condition !== 'ready' || (await hasActiveStay(tx, to.id))) fail(409, 'Phòng muốn chuyển sang chưa trống.')
          await tx.update(t.rooms).set({ condition: 'cleaning' }).where(eq(t.rooms.id, from.id))
        } else if (to.condition === 'maintenance') {
          fail(409, 'Phòng muốn chuyển sang đang bảo trì.')
        }
        await tx.update(t.stays).set({ roomId: to.id }).where(eq(t.stays.id, stay.id))
        await tx.insert(t.stayNotes).values({
          id: newId(),
          stayId: stay.id,
          text: `Đổi từ phòng ${from.number} sang phòng ${to.number}`,
          by: user.name,
          at,
          businessDate: await businessDateNow(tx, property.id, at),
        })
      })
    }),
  )

  router.post(
    '/stays/:id/items',
    handle(async (req, res) => {
      const input = parse(itemBody, req.body)
      const user = userOf(res)
      await db.transaction(async (tx) => {
        const { stay, property } = await accessByStay(tx, user, param(req, 'id'))
        requireStatus(stay, 'active')
        // Giảm giá cũng là sửa giá, nên dùng chung quyền.
        if (input.kind === 'discount' && !canEditPrice(user, property)) {
          fail(403, 'Cơ sở này không cho người trực giảm giá.')
        }
        // Thêm lại cùng một món thì tăng số lượng thay vì thêm dòng mới.
        const [same] = await tx
          .select()
          .from(t.stayItems)
          .where(
            and(
              eq(t.stayItems.stayId, stay.id),
              eq(t.stayItems.kind, input.kind),
              eq(t.stayItems.name, input.name),
              eq(t.stayItems.unitPrice, input.unitPrice),
            ),
          )
        if (same) {
          await tx.update(t.stayItems).set({ qty: same.qty + 1 }).where(eq(t.stayItems.id, same.id))
          return
        }
        const shift = await ensureShift(tx, property.id, user, now())
        await tx.insert(t.stayItems).values({ id: newId(), stayId: stay.id, ...input, qty: 1, shiftId: shift.id })
      })
    }),
  )

  router.delete(
    '/stays/:id/items/:itemId',
    handle(async (req, res) => {
      const { stay } = await accessByStay(db, userOf(res), param(req, 'id'))
      requireStatus(stay, 'active')
      await db
        .delete(t.stayItems)
        .where(and(eq(t.stayItems.id, param(req, 'itemId')), eq(t.stayItems.stayId, stay.id)))
    }),
  )

  router.post(
    '/stays/:id/payments',
    handle(async (req, res) => {
      const input = parse(paymentBody, req.body)
      const user = userOf(res)
      const at = now()
      await db.transaction(async (tx) => {
        const { stay, property } = await accessByStay(tx, user, param(req, 'id'))
        requireStatus(stay, 'booked', 'active')
        const shift = await ensureShift(tx, property.id, user, at)
        await tx.insert(t.payments).values({ id: newId(), stayId: stay.id, ...input, shiftId: shift.id, at })
      })
    }),
  )

  // Bỏ một khoản thu nhập nhầm, chỉ khi ca ghi nó còn mở. Sau đó thì ghi chú.
  router.delete(
    '/payments/:id',
    handle(async (req, res) => {
      const rows = await db.select().from(t.payments).where(eq(t.payments.id, param(req, 'id')))
      const payment = found(rows[0], 'khoản thu')
      await accessByStay(db, userOf(res), payment.stayId)
      const [open] = await db
        .select({ id: t.shifts.id })
        .from(t.shifts)
        .where(and(eq(t.shifts.id, payment.shiftId), isNull(t.shifts.closedAt)))
      if (!open) fail(409, 'Ca ghi khoản thu này đã kết thúc. Thêm ghi chú thay vì bỏ khoản thu.')
      await db.delete(t.payments).where(eq(t.payments.id, payment.id))
    }),
  )

  // Ghi chú chỉ thêm, không sửa, không xóa; thêm được cả sau khi khách đã trả phòng.
  router.post(
    '/stays/:id/notes',
    handle(async (req, res) => {
      const input = parse(z.object({ text: requiredText(500) }), req.body)
      const user = userOf(res)
      const at = now()
      const { stay, property } = await accessByStay(db, user, param(req, 'id'))
      await db.insert(t.stayNotes).values({
        id: newId(),
        stayId: stay.id,
        text: input.text,
        by: user.name,
        at,
        businessDate: await businessDateNow(db, property.id, at),
      })
    }),
  )

  // Ảnh giấy tờ: thân yêu cầu là chính file ảnh, đã được giao diện thu nhỏ.
  router.post(
    '/stays/:id/photos',
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '1mb' }),
    handle(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) fail(400, 'Chỉ nhận file ảnh JPEG, PNG hoặc WebP.')
      const { stay } = await accessByStay(db, userOf(res), param(req, 'id'))
      requireStatus(stay, 'booked', 'active')
      const existing = await db
        .select({ id: t.stayPhotos.id })
        .from(t.stayPhotos)
        .where(eq(t.stayPhotos.stayId, stay.id))
      if (existing.length >= MAX_STAY_PHOTOS) fail(409, `Mỗi lượt thuê tối đa ${MAX_STAY_PHOTOS} ảnh.`)
      const id = newId()
      await db
        .insert(t.stayPhotos)
        .values({ id, stayId: stay.id, at: now(), contentType: req.get('content-type')!, data: req.body })
      return { id }
    }),
  )

  router.get(
    '/photos/:id',
    handle(async (req, res) => {
      const rows = await db.select().from(t.stayPhotos).where(eq(t.stayPhotos.id, param(req, 'id')))
      const photo = found(rows[0], 'ảnh')
      await accessByStay(db, userOf(res), photo.stayId)
      // Ảnh giấy tờ không được nằm lại trong bộ nhớ đệm của trình duyệt hay máy chủ trung gian.
      res.set('Cache-Control', 'no-store').type(photo.contentType).send(Buffer.from(photo.data))
    }),
  )

  router.delete(
    '/stays/:id/photos/:photoId',
    handle(async (req, res) => {
      const { stay } = await accessByStay(db, userOf(res), param(req, 'id'))
      await db
        .delete(t.stayPhotos)
        .where(and(eq(t.stayPhotos.id, param(req, 'photoId')), eq(t.stayPhotos.stayId, stay.id)))
    }),
  )

  return router
}
