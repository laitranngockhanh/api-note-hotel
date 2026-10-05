import { and, eq, lt, sql } from 'drizzle-orm'
import type { RequestHandler } from 'express'
import { Router } from 'express'
import { z } from 'zod'
import type { AuthUser, Context } from './context'
import { userOf } from './context'
import * as t from './db/schema'
import { fail, handle, parse, requiredText } from './lib/http'
import { hashToken, isValidPin, newToken, PIN_LENGTH } from './lib/pin'
import { canWorkAt, ensureShift, getProperty, newId } from './repo'
import { DEFAULT_SETTINGS } from './routes/admin'

// PIN là thứ duy nhất dùng để đăng nhập, nên việc chặn đoán mò phải nằm ở máy chủ:
// sai liên tiếp MAX_PIN_FAILS lần từ một địa chỉ IP thì khóa địa chỉ đó một lúc.
export const MAX_PIN_FAILS = 5
const PIN_LOCK_MS = 60_000

// Phiên đăng nhập sống tối đa chừng này ngày kể từ lúc nhập PIN. Người trực nhập PIN mỗi ca
// nên không bị ảnh hưởng; máy bỏ quên đang đăng nhập thì tự hết quyền sau một tháng.
export const SESSION_DAYS = 30
const DAY_MS = 86_400_000

const ALREADY_SET_UP = 'Hệ thống đã được cài đặt. Đăng nhập bằng mã PIN.'
const SETUP_LOCK = 7001

const loginBody = z.object({ pin: z.string(), propertyId: z.string() })
const setupBody = z.object({
  ownerName: requiredText(100),
  propertyName: requiredText(100),
  pin: z.string(),
  code: z.string().optional(),
})

export function authRouter({ db, pins, now, setupCode }: Context): Router {
  const router = Router()

  // Cài đặt lần đầu. Hệ thống mới chưa có tài khoản nào, nên chưa ai đăng nhập được; bước
  // này cho chủ sở hữu tự tạo tài khoản, mã PIN và nhà nghỉ đầu tiên. Khi đã có ít nhất một
  // tài khoản thì bước này đóng lại vĩnh viễn.
  const hasUsers = async () => (await db.select({ id: t.users.id }).from(t.users).limit(1)).length > 0

  router.get(
    '/setup',
    handle(async () => ({ needsSetup: !(await hasUsers()), codeRequired: Boolean(setupCode) })),
  )

  router.post(
    '/setup',
    handle(async (req) => {
      const input = parse(setupBody, req.body)
      if (await hasUsers()) fail(409, ALREADY_SET_UP)
      // Trang nằm công khai trên mạng, nên ai mở trước cũng có thể tự nhận làm chủ. Mã cài
      // đặt (biến SETUP_CODE) chặn việc đó: chỉ người triển khai máy chủ mới biết mã.
      if (setupCode && input.code !== setupCode) fail(403, 'Mã cài đặt không đúng.')
      if (!isValidPin(input.pin)) fail(400, `Mã PIN phải gồm đúng ${PIN_LENGTH} chữ số.`)

      const user: AuthUser = { id: newId(), name: input.ownerName, role: 'owner' }
      const propertyId = newId()
      const token = newToken()
      await db.transaction(async (tx) => {
        // Hai máy bấm cùng lúc thì chỉ một máy được làm chủ: khóa lại rồi mới kiểm tra lần nữa.
        await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`)
        if ((await tx.select({ id: t.users.id }).from(t.users).limit(1)).length > 0) fail(409, ALREADY_SET_UP)
        await tx.insert(t.users).values({
          ...user,
          pinCipher: pins.encrypt(input.pin),
          pinLookup: pins.lookup(input.pin),
        })
        await tx.insert(t.properties).values({ id: propertyId, name: input.propertyName, settings: DEFAULT_SETTINGS })
        await tx.insert(t.sessions).values({ tokenHash: hashToken(token), userId: user.id, createdAt: now() })
      })
      // Trả về mã phiên để chủ vào thẳng ứng dụng, không phải nhập lại PIN vừa tạo.
      return { token, user, propertyId }
    }),
  )

  // Tên các cơ sở đang hoạt động, để máy chọn cơ sở trước khi có ai đăng nhập.
  router.get(
    '/properties/public',
    handle(async () => {
      const rows = await db.select().from(t.properties).where(eq(t.properties.active, true))
      return rows.map((row) => ({ id: row.id, name: row.name }))
    }),
  )

  router.post(
    '/login',
    handle(async (req) => {
      const { pin, propertyId } = parse(loginBody, req.body)
      const key = req.ip ?? 'unknown'
      const at = now()

      const [guard] = await db.select().from(t.pinGuards).where(eq(t.pinGuards.key, key))
      if (guard?.lockedUntil && guard.lockedUntil > at) {
        const seconds = Math.ceil((guard.lockedUntil.getTime() - at.getTime()) / 1000)
        fail(429, `Nhập sai ${MAX_PIN_FAILS} lần liên tiếp. Thử lại sau ${seconds} giây.`)
      }

      const [user] = await db
        .select()
        .from(t.users)
        .where(and(eq(t.users.pinLookup, pins.lookup(pin)), eq(t.users.active, true)))

      if (!user) {
        const fails = (guard?.fails ?? 0) + 1
        const locked = fails >= MAX_PIN_FAILS
        const next = { fails: locked ? 0 : fails, lockedUntil: locked ? new Date(at.getTime() + PIN_LOCK_MS) : null }
        await db
          .insert(t.pinGuards)
          .values({ key, ...next })
          .onConflictDoUpdate({ target: t.pinGuards.key, set: next })
        fail(401, locked ? `Nhập sai ${MAX_PIN_FAILS} lần liên tiếp. Thử lại sau 60 giây.` : `Mã PIN không đúng. Còn ${MAX_PIN_FAILS - fails} lần thử.`)
      }

      // PIN đúng thì xóa bộ đếm, kể cả khi người này không được phân công ở cơ sở đang chọn.
      await db.delete(t.pinGuards).where(eq(t.pinGuards.key, key))

      const authUser: AuthUser = { id: user.id, name: user.name, role: user.role }
      const property = await getProperty(db, propertyId)
      if (!canWorkAt(authUser, property)) fail(403, `${user.name} chưa được phân công trực ở cơ sở này.`)

      const token = newToken()
      // Nhân lúc đăng nhập, dọn các phiên đã hết hạn để bảng không phình mãi.
      await db.delete(t.sessions).where(lt(t.sessions.createdAt, new Date(at.getTime() - SESSION_DAYS * DAY_MS)))
      await db.insert(t.sessions).values({ tokenHash: hashToken(token), userId: user.id, createdAt: at })
      // Người trực vào là mở ca luôn. Chủ thì không, vì chủ hay vào chỉ để xem.
      if (user.role === 'staff') await ensureShift(db, propertyId, authUser, at)

      return { token, user: authUser }
    }),
  )

  return router
}

// Mọi route đứng sau bước này đều có người đăng nhập hợp lệ trong res.locals.user.
export function authenticate({ db, now }: Context): RequestHandler {
  return async (req, res, next) => {
    const header = req.get('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token) fail(401, 'Chưa đăng nhập.')

    const [row] = await db
      .select({
        id: t.users.id,
        name: t.users.name,
        role: t.users.role,
        active: t.users.active,
        createdAt: t.sessions.createdAt,
      })
      .from(t.sessions)
      .innerJoin(t.users, eq(t.users.id, t.sessions.userId))
      .where(eq(t.sessions.tokenHash, hashToken(token)))
    // Tài khoản bị ngừng thì phiên cũ hết hiệu lực ngay; phiên quá hạn thì phải nhập lại PIN.
    const expired = row && now().getTime() - row.createdAt.getTime() > SESSION_DAYS * DAY_MS
    if (!row || !row.active || expired) fail(401, 'Phiên đăng nhập đã hết hạn.')

    res.locals.user = { id: row.id, name: row.name, role: row.role } satisfies AuthUser
    res.locals.tokenHash = hashToken(token)
    next()
  }
}

export const requireOwner: RequestHandler = (_req, res, next) => {
  if (userOf(res).role !== 'owner') fail(403, 'Chỉ chủ mới làm được việc này.')
  next()
}

export function sessionRouter({ db }: Context): Router {
  const router = Router()

  router.get(
    '/me',
    handle(async (_req, res) => userOf(res)),
  )

  router.post(
    '/logout',
    handle(async (_req, res) => {
      await db.delete(t.sessions).where(eq(t.sessions.tokenHash, res.locals.tokenHash as string))
    }),
  )

  return router
}
