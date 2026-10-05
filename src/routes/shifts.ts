import { and, eq, isNull } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import { requireOwner } from '../auth'
import type { Context } from '../context'
import { userOf } from '../context'
import * as t from '../db/schema'
import { fail, found, handle, param, parse, requiredText, text } from '../lib/http'
import { accessByRoom, assertAccess, ensureShift, toShift } from '../repo'

const closeBody = z.object({
  // 0 là khớp; số âm là thiếu tiền mặt, số dương là thừa.
  cashDiff: z.number().int().min(-1_000_000_000).max(1_000_000_000),
  note: text(500).default(''),
})

export function shiftsRouter({ db, now }: Context): Router {
  const router = Router()

  router.post(
    '/shifts/start',
    handle(async (req, res) => {
      const { propertyId } = parse(z.object({ propertyId: z.string() }), req.body)
      const user = userOf(res)
      await assertAccess(db, user, propertyId)
      return toShift(await ensureShift(db, propertyId, user, now()))
    }),
  )

  // Ai đang làm ở cơ sở cũng đóng được ca: người trực đến sau phải xác nhận đóng ca của
  // người trước nếu họ quên.
  router.post(
    '/shifts/:id/close',
    handle(async (req, res) => {
      const input = parse(closeBody, req.body)
      const rows = await db.select().from(t.shifts).where(eq(t.shifts.id, param(req, 'id')))
      const shift = found(rows[0], 'ca')
      await assertAccess(db, userOf(res), shift.propertyId)
      const closed = await db
        .update(t.shifts)
        .set({ closedAt: now(), cashDiff: input.cashDiff, note: appendNote(shift.note, input.note) })
        .where(and(eq(t.shifts.id, shift.id), isNull(t.shifts.closedAt)))
        .returning({ id: t.shifts.id })
      if (closed.length === 0) fail(409, 'Ca này đã kết thúc rồi.')
    }),
  )

  // Chủ ghi chú thêm cho một ca, kể cả ca đã đóng. Nối vào ghi chú cũ chứ không ghi đè.
  router.post(
    '/shifts/:id/notes',
    requireOwner,
    handle(async (req) => {
      const input = parse(z.object({ text: requiredText(500) }), req.body)
      const rows = await db.select().from(t.shifts).where(eq(t.shifts.id, param(req, 'id')))
      const shift = found(rows[0], 'ca')
      await db
        .update(t.shifts)
        .set({ note: appendNote(shift.note, input.text) })
        .where(eq(t.shifts.id, shift.id))
    }),
  )

  router.post(
    '/rooms/:id/condition',
    handle(async (req, res) => {
      const { condition } = parse(z.object({ condition: z.enum(['ready', 'cleaning', 'maintenance']) }), req.body)
      const { room } = await accessByRoom(db, userOf(res), param(req, 'id'))
      if (condition === 'maintenance') {
        const active = await db
          .select({ id: t.stays.id })
          .from(t.stays)
          .where(and(eq(t.stays.roomId, room.id), eq(t.stays.status, 'active')))
        if (active.length > 0) fail(409, 'Phòng đang có khách, chưa chuyển sang bảo trì được.')
      }
      await db.update(t.rooms).set({ condition }).where(eq(t.rooms.id, room.id))
    }),
  )

  return router
}

const appendNote = (existing: string, added: string) => (existing && added ? `${existing} · ${added}` : existing || added)
