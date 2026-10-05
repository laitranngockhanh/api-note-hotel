import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAX_PIN_FAILS, SESSION_DAYS } from '../src/auth'
import { at, createTestEnv, IDS, PINS, type TestEnv } from './helpers'

let env: TestEnv
beforeAll(async () => {
  env = await createTestEnv()
})
afterAll(() => env.close())
beforeEach(() => env.reset())

const loginAs = (pin: string, propertyId = IDS.p1) => request(env.app).post('/api/login').send({ pin, propertyId })

describe('kiểm tra máy chủ còn sống', () => {
  it('trả lời được mà không cần đăng nhập, sau khi đã hỏi được cơ sở dữ liệu', async () => {
    const response = await request(env.app).get('/api/health')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
  })
})

describe('giờ của máy chủ', () => {
  it('đi kèm mỗi bản chụp, cùng múi giờ Việt Nam, để giao diện chỉnh đồng hồ theo', async () => {
    const owner = await env.login(PINS.owner)
    env.setClock(at(5, 14, 37))
    const { body } = await owner.get(`/state?propertyId=${IDS.p1}`)
    expect(body.now).toBe(at(5, 14, 37).toISOString())
    expect(body.utcOffsetMinutes).toBe(7 * 60)
  })
})

describe('chọn cơ sở và đăng nhập', () => {
  it('ai cũng xem được tên các cơ sở đang hoạt động, không cần đăng nhập', async () => {
    const response = await request(env.app).get('/api/properties/public')
    expect(response.body).toEqual([
      { id: IDS.p1, name: 'Hoa Mai' },
      { id: IDS.p2, name: 'Bình Minh' },
    ])
  })

  it('PIN đúng thì nhận mã phiên và thông tin tài khoản', async () => {
    const response = await loginAs(PINS.lan)
    expect(response.status).toBe(200)
    expect(response.body.user).toEqual({ id: IDS.lan, name: 'Lan', role: 'staff' })
    expect(response.body.token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('người trực đăng nhập là ca tự mở; chủ đăng nhập thì không', async () => {
    const owner = await env.login(PINS.owner)
    expect((await owner.get(`/state?propertyId=${IDS.p1}`)).body.shift).toBeNull()

    await env.login(PINS.lan)
    const { shift } = (await owner.get(`/state?propertyId=${IDS.p1}`)).body
    expect(shift).toMatchObject({ userId: IDS.lan, userName: 'Lan', label: 'Sáng', businessDate: '2026-10-05', closedAt: null })
  })

  it('không có mã phiên hoặc mã phiên sai thì bị từ chối', async () => {
    expect((await request(env.app).get('/api/me')).status).toBe(401)
    expect((await env.client('ma-phien-bia').get('/me')).status).toBe(401)
  })

  it('phiên tự hết hạn sau 30 ngày, phải nhập lại PIN', async () => {
    const owner = await env.login(PINS.owner)
    env.setClock(at(5 + SESSION_DAYS, 13))
    expect((await owner.get('/me')).status).toBe(200)

    env.setClock(at(5 + SESSION_DAYS, 15))
    const expired = await owner.get('/me')
    expect(expired.status).toBe(401)
    expect(expired.body.error).toBe('Phiên đăng nhập đã hết hạn.')
    expect((await loginAs(PINS.owner)).status).toBe(200)
  })

  it('đăng xuất thì mã phiên hết hiệu lực', async () => {
    const lan = await env.login(PINS.lan)
    expect((await lan.get('/me')).body).toMatchObject({ name: 'Lan' })
    await lan.post('/logout')
    expect((await lan.get('/me')).status).toBe(401)
  })
})

describe('chặn đoán PIN', () => {
  it('báo số lần còn lại sau mỗi lần sai', async () => {
    const response = await loginAs('0000')
    expect(response.status).toBe(401)
    expect(response.body.error).toBe(`Mã PIN không đúng. Còn ${MAX_PIN_FAILS - 1} lần thử.`)
  })

  it('sai đủ số lần thì khóa, PIN đúng cũng bị từ chối cho đến khi hết thời gian khóa', async () => {
    for (let i = 0; i < MAX_PIN_FAILS; i += 1) await loginAs('0000')

    const locked = await loginAs(PINS.lan)
    expect(locked.status).toBe(429)
    expect(locked.body.error).toMatch(/Thử lại sau \d+ giây/)

    env.setClock(at(5, 14, 2))
    expect((await loginAs(PINS.lan)).status).toBe(200)
  })

  it('nhập đúng thì bộ đếm về 0', async () => {
    for (let i = 0; i < MAX_PIN_FAILS - 1; i += 1) await loginAs('0000')
    await loginAs(PINS.lan)
    const response = await loginAs('0000')
    expect(response.body.error).toBe(`Mã PIN không đúng. Còn ${MAX_PIN_FAILS - 1} lần thử.`)
  })
})

describe('phân công theo cơ sở', () => {
  it('người trực không được chọn thì không đăng nhập được vào cơ sở đó, và không bị tính là nhập sai', async () => {
    const owner = await env.login(PINS.owner)
    await owner.patch(`/properties/${IDS.p1}`, { staffIds: [IDS.lan] })

    const refused = await loginAs(PINS.hung)
    expect(refused.status).toBe(403)
    expect(refused.body.error).toBe('Hùng chưa được phân công trực ở cơ sở này.')

    expect((await loginAs(PINS.hung, IDS.p2)).status).toBe(200)
    expect((await loginAs(PINS.lan)).status).toBe(200)
    expect((await loginAs(PINS.owner)).status).toBe(200)
  })

  it('người trực bị gỡ khỏi cơ sở thì phiên đang mở không thao tác được ở đó nữa', async () => {
    const owner = await env.login(PINS.owner)
    const hung = await env.login(PINS.hung)
    expect((await hung.get(`/state?propertyId=${IDS.p1}`)).status).toBe(200)

    await owner.patch(`/properties/${IDS.p1}`, { staffIds: [IDS.lan] })
    expect((await hung.get(`/state?propertyId=${IDS.p1}`)).status).toBe(403)
  })

  it('tài khoản bị ngừng thì phiên cũ hết hiệu lực và không đăng nhập lại được', async () => {
    const owner = await env.login(PINS.owner)
    const hung = await env.login(PINS.hung, IDS.p2)
    await hung.post(`/shifts/${(await hung.get(`/state?propertyId=${IDS.p2}`)).body.shift.id}/close`, { cashDiff: 0 })

    expect((await owner.patch(`/users/${IDS.hung}`, { active: false })).status).toBe(200)
    expect((await hung.get('/me')).status).toBe(401)
    expect((await loginAs(PINS.hung, IDS.p2)).status).toBe(401)
  })
})
