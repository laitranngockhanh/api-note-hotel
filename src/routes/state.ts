import { and, asc, desc, eq, ilike, inArray, like, or, sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { Router } from 'express'
import { z } from 'zod'
import { requireOwner } from '../auth'
import type { Context } from '../context'
import { userOf } from '../context'
import * as t from '../db/schema'
import { periodKey, periodReport } from '../domain/report'
import type { Db } from '../domain/types'
import { handle, parse } from '../lib/http'
import {
  assertAccess,
  loadStays,
  openShift,
  paymentsOfStays,
  toPayment,
  toProperty,
  toRoom,
  toRoomType,
  toService,
  toShift,
} from '../repo'

const MAX_LIST = 100

// inArray với danh sách rỗng là câu SQL sai, nên coi như điều kiện không bao giờ đúng.
const anyOf = (column: AnyPgColumn, ids: string[]): SQL => (ids.length > 0 ? inArray(column, ids) : sql`false`)

const stateQuery = z.object({ propertyId: z.string() })
const staysQuery = z.object({
  propertyId: z.string(),
  status: z.enum(['booked', 'active', 'done', 'cancelled']),
  q: z.string().trim().max(100).optional(),
})
const reportQuery = z.object({
  propertyId: z.string().optional(),
  mode: z.enum(['day', 'month', 'year']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

export function stateRouter({ db, now }: Context): Router {
  const router = Router()

  // Mọi thứ màn hình chính cần cho một cơ sở, trong một lần gọi. Giao diện gọi lại sau mỗi
  // thao tác và theo chu kỳ, để nhiều máy cùng thấy một trạng thái.
  router.get(
    '/state',
    handle(async (req, res) => {
      const { propertyId } = parse(stateQuery, req.query)
      const user = userOf(res)
      const property = await assertAccess(db, user, propertyId)
      const isOwner = user.role === 'owner'

      const [roomTypes, rooms, services, shift, stayRows, properties, users] = await Promise.all([
        db.select().from(t.roomTypes).where(eq(t.roomTypes.propertyId, propertyId)),
        db.select().from(t.rooms).where(eq(t.rooms.propertyId, propertyId)),
        db.select().from(t.services).where(eq(t.services.propertyId, propertyId)),
        openShift(db, propertyId),
        db
          .select({ stay: t.stays })
          .from(t.stays)
          .innerJoin(t.rooms, eq(t.rooms.id, t.stays.roomId))
          .where(and(eq(t.rooms.propertyId, propertyId), inArray(t.stays.status, ['booked', 'active']))),
        // Chủ thấy mọi cơ sở và mọi tài khoản để quản lý; người trực chỉ thấy cơ sở đang làm.
        isOwner ? db.select().from(t.properties) : [property],
        isOwner
          ? db.select({ id: t.users.id, name: t.users.name, role: t.users.role, active: t.users.active }).from(t.users)
          : [],
      ])

      // Mọi khoản thu của ca đang mở, và các lượt thuê liên quan đến ca đó (kể cả lượt đã trả
      // phòng), để màn hình kết thúc ca tính được tổng và ghi được số phòng cạnh từng khoản.
      const shiftPayments = shift
        ? (await db.select().from(t.payments).where(eq(t.payments.shiftId, shift.id))).map(toPayment)
        : []
      const shiftStayRows = shift
        ? await db
            .select({ stay: t.stays })
            .from(t.stays)
            .innerJoin(t.rooms, eq(t.rooms.id, t.stays.roomId))
            .where(
              and(
                eq(t.rooms.propertyId, propertyId),
                or(
                  eq(t.stays.shiftId, shift.id),
                  eq(t.stays.checkOutShiftId, shift.id),
                  anyOf(
                    t.stays.id,
                    shiftPayments.map((payment) => payment.stayId),
                  ),
                ),
              ),
            )
        : []
      const uniqueRows = [...new Map([...stayRows, ...shiftStayRows].map((row) => [row.stay.id, row.stay])).values()]
      const stays = await loadStays(db, uniqueRows)

      const stayPayments = await paymentsOfStays(
        db,
        stays.map((stay) => stay.id),
      )
      const payments = [...new Map([...stayPayments, ...shiftPayments].map((p) => [p.id, p])).values()]

      // Giờ của máy chủ đi kèm mỗi bản chụp, để giao diện chỉnh đồng hồ của nó theo: số tiền tạm
      // tính trên màn hình và số tiền máy chủ chốt lúc trả phòng phải dùng chung một đồng hồ.
      const at = now()
      return {
        now: at.toISOString(),
        utcOffsetMinutes: -at.getTimezoneOffset(),
        user,
        properties: properties.map(toProperty),
        users,
        roomTypes: roomTypes.map(toRoomType),
        rooms: rooms.map(toRoom),
        services: services.map(toService),
        stays,
        payments,
        shift: shift ? toShift(shift) : null,
      }
    }),
  )

  // Danh sách lượt thuê theo trạng thái, tìm theo tên khách, số điện thoại hoặc số phòng.
  router.get(
    '/stays',
    handle(async (req, res) => {
      const { propertyId, status, q } = parse(staysQuery, req.query)
      await assertAccess(db, userOf(res), propertyId)

      const filters = [eq(t.rooms.propertyId, propertyId), eq(t.stays.status, status)]
      if (q) {
        const digits = `%${q.replace(/\s/g, '')}%`
        filters.push(
          or(
            ilike(t.stays.guestName, `%${q}%`),
            sql`replace(${t.stays.guestPhone}, ' ', '') like ${digits}`,
            eq(t.rooms.number, q),
          )!,
        )
      }
      const rows = await db
        .select({ stay: t.stays })
        .from(t.stays)
        .innerJoin(t.rooms, eq(t.rooms.id, t.stays.roomId))
        .where(and(...filters))
        // Đặt trước xếp theo giờ hẹn gần nhất, còn lại mới nhất lên đầu.
        .orderBy(status === 'booked' ? asc(t.stays.checkInAt) : desc(t.stays.checkInAt))
        .limit(MAX_LIST)

      const stays = await loadStays(
        db,
        rows.map((row) => row.stay),
      )
      const payments = await paymentsOfStays(
        db,
        stays.map((stay) => stay.id),
      )
      // Tên người trực của ca đã ghi từng khoản thu, để hiện "ai thu" cạnh khoản đó.
      const shifts = await db
        .select({ id: t.shifts.id, userName: t.shifts.userName })
        .from(t.shifts)
        .where(anyOf(t.shifts.id, [...new Set(payments.map((payment) => payment.shiftId))]))
      return { stays, payments, collectors: Object.fromEntries(shifts.map((shift) => [shift.id, shift.userName])) }
    }),
  )

  // Báo cáo ngày, tháng, năm. Số liệu do chính hàm báo cáo của giao diện tính ra, máy chủ chỉ
  // lo việc gom đủ dữ liệu của kỳ. Không truyền propertyId thì gộp mọi cơ sở.
  router.get(
    '/reports',
    requireOwner,
    handle(async (req) => {
      const { propertyId, mode, date } = parse(reportQuery, req.query)
      const prefix = `${periodKey(mode, date)}%`
      const scoped = <C extends AnyPgColumn>(column: C) => (propertyId ? eq(column, propertyId) : undefined)

      const [shifts, expenses, rooms, properties] = await Promise.all([
        db
          .select()
          .from(t.shifts)
          .where(and(like(t.shifts.businessDate, prefix), scoped(t.shifts.propertyId))),
        db
          .select()
          .from(t.expenses)
          .where(and(like(t.expenses.businessDate, prefix), scoped(t.expenses.propertyId))),
        db.select().from(t.rooms).where(scoped(t.rooms.propertyId)),
        db.select().from(t.properties),
      ])
      const shiftIds = shifts.map((shift) => shift.id)
      const roomIds = rooms.map((room) => room.id)
      const payments = await db.select().from(t.payments).where(anyOf(t.payments.shiftId, shiftIds))

      // Lượt thuê liên quan đến kỳ: nhận hoặc trả phòng trong một ca của kỳ, có khoản thu
      // trong kỳ, hoặc có ghi chú được viết trong kỳ.
      const noted = await db
        .select({ stayId: t.stayNotes.stayId })
        .from(t.stayNotes)
        .where(like(t.stayNotes.businessDate, prefix))
      const stayIds = [...new Set([...payments.map((p) => p.stayId), ...noted.map((note) => note.stayId)])]
      const stayRows = await db
        .select()
        .from(t.stays)
        .where(
          and(
            anyOf(t.stays.roomId, roomIds),
            or(anyOf(t.stays.shiftId, shiftIds), anyOf(t.stays.checkOutShiftId, shiftIds), anyOf(t.stays.id, stayIds)),
          ),
        )
      const stays = await loadStays(db, stayRows)

      const data: Db = {
        users: [],
        properties: properties.map(toProperty),
        roomTypes: [],
        rooms: rooms.map(toRoom),
        services: [],
        stays,
        payments: payments.map(toPayment),
        shifts: shifts.map(toShift),
        expenses: expenses.map((expense) => ({ ...expense, at: expense.at.toISOString() })),
      }
      return {
        report: periodReport(data, propertyId ?? null, mode, date),
        // Đủ để giao diện ghi được số phòng và tên khách cạnh từng khoản thu.
        stays: stays.map((stay) => ({ id: stay.id, roomId: stay.roomId, guestName: stay.guestName })),
        rooms: rooms.map((room) => ({ id: room.id, number: room.number, propertyId: room.propertyId })),
        properties: properties.map((property) => ({ id: property.id, name: property.name })),
      }
    }),
  )

  return router
}
