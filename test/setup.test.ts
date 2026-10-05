import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestEnv, type TestEnv } from './helpers'

// Mã PIN ở đây chỉ dùng trong kiểm thử.
const PIN = '4821'
const body = (extra: object = {}) => ({ ownerName: 'Bác Tâm', propertyName: 'Hoa Mai', pin: PIN, ...extra })

describe('cài đặt lần đầu', () => {
  let env: TestEnv
  beforeAll(async () => {
    env = await createTestEnv()
  })
  afterAll(() => env.close())
  beforeEach(() => env.clear())

  const setup = (input: object) => request(env.app).post('/api/setup').send(input)
  const status = async () => (await request(env.app).get('/api/setup')).body

  it('hệ thống mới chưa có tài khoản thì báo cần cài đặt', async () => {
    expect(await status()).toEqual({ needsSetup: true, codeRequired: false })
    expect((await request(env.app).get('/api/properties/public')).body).toEqual([])
  })

  it('chủ tự tạo tài khoản, mã PIN và cơ sở đầu tiên, rồi vào thẳng ứng dụng', async () => {
    const response = await setup(body())
    expect(response.status).toBe(200)
    expect(response.body.user).toMatchObject({ name: 'Bác Tâm', role: 'owner' })

    const { propertyId, token } = response.body
    const owner = env.client(token)
    expect((await owner.get('/me')).body).toMatchObject({ name: 'Bác Tâm', role: 'owner' })

    // Cơ sở mới chưa có phòng, loại phòng hay dịch vụ: chủ tự nhập, không có dữ liệu mẫu.
    const state = (await owner.get(`/state?propertyId=${propertyId}`)).body
    expect(state.properties).toMatchObject([{ id: propertyId, name: 'Hoa Mai' }])
    expect(state.rooms).toEqual([])
    expect(state.roomTypes).toEqual([])
    expect(state.services).toEqual([])

    expect(await status()).toMatchObject({ needsSetup: false })
  })

  it('mã PIN vừa tạo dùng để đăng nhập những lần sau', async () => {
    const { propertyId } = (await setup(body())).body
    const login = await request(env.app).post('/api/login').send({ pin: PIN, propertyId })
    expect(login.status).toBe(200)
    expect(login.body.user).toMatchObject({ name: 'Bác Tâm', role: 'owner' })
  })

  it('đã có tài khoản thì không cài đặt lại được', async () => {
    await setup(body())
    const again = await setup(body({ ownerName: 'Người lạ', pin: '1357' }))
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('Hệ thống đã được cài đặt. Đăng nhập bằng mã PIN.')
  })

  it('hai máy bấm cùng lúc thì chỉ một máy thành chủ', async () => {
    const results = await Promise.all([setup(body()), setup(body({ ownerName: 'Người lạ', pin: '1357' }))])
    expect(results.map((result) => result.status).sort()).toEqual([200, 409])
  })

  it('từ chối mã PIN không đúng 4 chữ số và tên bỏ trống', async () => {
    for (const pin of ['123', '12345', 'abcd', '']) {
      const response = await setup(body({ pin }))
      expect(response.status).toBe(400)
      expect(response.body.error).toBe('Mã PIN phải gồm đúng 4 chữ số.')
    }
    expect((await setup(body({ ownerName: '  ' }))).status).toBe(400)
    expect((await setup(body({ propertyName: '' }))).status).toBe(400)
    expect(await status()).toMatchObject({ needsSetup: true })
  })
})

describe('cài đặt lần đầu khi máy chủ đặt mã cài đặt', () => {
  let env: TestEnv
  beforeAll(async () => {
    env = await createTestEnv({ setupCode: 'ma-cai-dat-kiem-thu' })
  })
  afterAll(() => env.close())
  beforeEach(() => env.clear())

  const setup = (input: object) => request(env.app).post('/api/setup').send(input)

  it('báo cho giao diện biết phải hỏi mã', async () => {
    expect((await request(env.app).get('/api/setup')).body).toEqual({ needsSetup: true, codeRequired: true })
  })

  it('thiếu mã hoặc sai mã thì không tạo được chủ', async () => {
    for (const extra of [{}, { code: 'sai' }]) {
      const response = await setup(body(extra))
      expect(response.status).toBe(403)
      expect(response.body.error).toBe('Mã cài đặt không đúng.')
    }
    expect((await request(env.app).get('/api/setup')).body.needsSetup).toBe(true)
  })

  it('đúng mã thì tạo được', async () => {
    expect((await setup(body({ code: 'ma-cai-dat-kiem-thu' }))).status).toBe(200)
  })
})
