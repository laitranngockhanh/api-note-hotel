import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { at, checkIn, checkInBody, createTestEnv, IDS, PINS, type Client, type TestEnv } from './helpers'

let env: TestEnv
let owner: Client
let lan: Client

beforeAll(async () => {
  env = await createTestEnv()
})
afterAll(() => env.close())
beforeEach(async () => {
  await env.reset()
  owner = await env.login(PINS.owner)
  lan = await env.login(PINS.lan)
})

const state = async (propertyId = IDS.p1) => (await owner.get(`/state?propertyId=${propertyId}`)).body
const loginAs = (pin: string, propertyId = IDS.p1) => request(env.app).post('/api/login').send({ pin, propertyId })

describe('chỉ chủ mới vào được phần quản lý', () => {
  it('người trực bị từ chối ở mọi nhóm quản lý và báo cáo', async () => {
    const attempts = await Promise.all([
      lan.get('/users'),
      lan.get(`/users/${IDS.owner}/pin`),
      lan.post('/users', { name: 'Mai', role: 'owner', pin: '4321' }),
      lan.post('/properties', { name: 'Cơ sở lậu' }),
      lan.patch(`/properties/${IDS.p1}`, { staffCanEditPrice: true }),
      lan.put(`/room-types/${IDS.single}`, { name: 'x', standardGuests: 1, extraGuestFee: 0, prices: {} }),
      lan.post('/expenses', { propertyId: IDS.p1, name: 'Giặt là', amount: 1_000, businessDate: '2026-10-05' }),
      lan.get(`/reports?propertyId=${IDS.p1}&mode=day&date=2026-10-05`),
      lan.delete(`/rooms/${IDS.r103}`),
    ])
    expect(attempts.map((response) => response.status)).toEqual(Array(attempts.length).fill(403))
  })

  it('người trực không thấy danh sách tài khoản và cơ sở khác trong trạng thái', async () => {
    const body = (await lan.get(`/state?propertyId=${IDS.p1}`)).body
    expect(body.users).toEqual([])
    expect(body.properties.map((p: { id: string }) => p.id)).toEqual([IDS.p1])
    expect((await state()).users).toHaveLength(3)
  })
})

describe('nhân viên và mã PIN', () => {
  it('thêm nhân viên, đăng nhập bằng PIN mới, chủ xem lại được PIN', async () => {
    const created = await owner.post('/users', { name: 'Mai', role: 'staff', pin: '4321' })
    expect(created.status).toBe(200)
    expect((await loginAs('4321')).body.user.name).toBe('Mai')
    expect((await owner.get(`/users/${created.body.id}/pin`)).body).toEqual({ pin: '4321' })
  })

  it('danh sách tài khoản và trạng thái không bao giờ chứa PIN', async () => {
    const text = JSON.stringify([(await owner.get('/users')).body, await state()])
    for (const pin of Object.values(PINS)) expect(text).not.toContain(pin)
    expect(text).not.toMatch(/pinCipher|pinLookup/)
  })

  it('từ chối PIN sai định dạng hoặc trùng với người khác', async () => {
    expect((await owner.post('/users', { name: 'Mai', role: 'staff', pin: '12a4' })).body.error).toMatch(/4 chữ số/)
    expect((await owner.post('/users', { name: 'Mai', role: 'staff', pin: PINS.lan })).body.error).toMatch(/đang được dùng/)
    expect((await owner.patch(`/users/${IDS.hung}`, { pin: PINS.lan })).status).toBe(409)
  })

  it('đổi PIN thì PIN cũ hết hiệu lực; không gửi PIN thì giữ PIN cũ', async () => {
    await owner.patch(`/users/${IDS.hung}`, { name: 'Hùng Anh' })
    expect((await loginAs(PINS.hung)).body.user.name).toBe('Hùng Anh')

    await owner.patch(`/users/${IDS.hung}`, { pin: '7777' })
    expect((await loginAs(PINS.hung)).status).toBe(401)
    expect((await loginAs('7777')).status).toBe(200)
  })

  it('luôn giữ lại ít nhất một chủ, và không tự ngừng hay tự xóa chính mình', async () => {
    expect((await owner.patch(`/users/${IDS.owner}`, { role: 'staff' })).body.error).toMatch(/chủ duy nhất/)
    expect((await owner.patch(`/users/${IDS.owner}`, { active: false })).status).toBe(409)
    expect((await owner.delete(`/users/${IDS.owner}`)).status).toBe(409)

    // Có chủ thứ hai rồi thì chủ thứ nhất vẫn không tự ngừng chính mình được.
    await owner.post('/users', { name: 'Chủ hai', role: 'owner', pin: '5555' })
    expect((await owner.patch(`/users/${IDS.owner}`, { active: false })).body.error).toMatch(/chính mình/)
  })

  it('người đã trực ca chỉ ngừng được, không xóa được; người đang có ca mở thì chưa ngừng được', async () => {
    expect((await owner.delete(`/users/${IDS.lan}`)).body.error).toMatch(/đã từng trực ca/)
    expect((await owner.patch(`/users/${IDS.lan}`, { active: false })).body.error).toMatch(/đang có ca mở/)

    await lan.post(`/shifts/${(await state()).shift.id}/close`, { cashDiff: 0 })
    expect((await owner.patch(`/users/${IDS.lan}`, { active: false })).status).toBe(200)
    expect((await loginAs(PINS.lan)).status).toBe(401)
  })

  it('xóa nhân viên chưa trực ca nào thì gỡ luôn khỏi danh sách của các cơ sở', async () => {
    await owner.patch(`/properties/${IDS.p2}`, { staffIds: [IDS.hung, IDS.lan] })
    expect((await owner.delete(`/users/${IDS.hung}`)).status).toBe(200)
    const p2 = (await owner.get('/properties')).body.find((p: { id: string }) => p.id === IDS.p2)
    expect(p2.staffIds).toEqual([IDS.lan])
  })
})

describe('cơ sở', () => {
  it('cơ sở mới chép loại phòng, giá, dịch vụ và quy tắc, nhưng không chép phòng và ngân hàng', async () => {
    await owner.patch(`/properties/${IDS.p1}`, {
      bank: { bin: '970436', accountNumber: '0123456789', accountName: 'Thử' },
      settings: { graceMinutes: 20, checkoutHour: 11, lateFees: [{ untilHour: 14, percent: 40 }], overnightFromHour: 21, overnightToHour: 6 },
    })
    const id = (await owner.post('/properties', { name: 'Sao Mai', copyFromId: IDS.p1 })).body.id

    const created = await state(id)
    expect(created.properties.find((p: { id: string }) => p.id === id)).toMatchObject({
      name: 'Sao Mai',
      active: true,
      bank: null,
      staffIds: null,
      settings: { graceMinutes: 20, checkoutHour: 11 },
    })
    expect(created.roomTypes.map((type: { name: string }) => type.name).sort()).toEqual(['Phòng đôi', 'Phòng đơn'])
    expect(created.services).toMatchObject([{ name: 'Nước suối', price: 10_000 }])
    expect(created.rooms).toEqual([])
  })

  it('quy tắc tính tiền là riêng của từng cơ sở', async () => {
    await owner.patch(`/properties/${IDS.p1}`, {
      settings: { graceMinutes: 0, checkoutHour: 12, lateFees: [], overnightFromHour: 14, overnightToHour: 5 },
    })
    // Hoa Mai giờ nhận qua đêm từ 14:00; Bình Minh vẫn từ 22:00.
    expect((await owner.post('/stays/check-in', checkInBody({ rentType: 'overnight' }))).status).toBe(200)
    const other = await owner.post('/stays/check-in', checkInBody({ roomId: IDS.otherRoom, rentType: 'overnight' }))
    expect(other.status).toBe(400)
  })

  it('không ngừng được cơ sở đang có ca mở hoặc còn khách; ngừng rồi thì biến mất khỏi màn chọn cơ sở', async () => {
    expect((await owner.patch(`/properties/${IDS.p1}`, { active: false })).body.error).toMatch(/ca mở/)

    const id = await checkIn(lan)
    await lan.post(`/shifts/${(await state()).shift.id}/close`, { cashDiff: 0 })
    expect((await owner.patch(`/properties/${IDS.p1}`, { active: false })).body.error).toMatch(/khách đang ở/)

    await owner.post(`/stays/${id}/check-out`, { method: 'cash' })
    await owner.post(`/shifts/${(await state()).shift.id}/close`, { cashDiff: 0 })
    expect((await owner.patch(`/properties/${IDS.p1}`, { active: false })).status).toBe(200)

    expect((await request(env.app).get('/api/properties/public')).body).toEqual([{ id: IDS.p2, name: 'Bình Minh' }])
    expect((await loginAs(PINS.lan)).status).toBe(403)
    expect((await owner.patch(`/properties/${IDS.p2}`, { active: false })).body.error).toMatch(/ít nhất một cơ sở/)
  })

  it('chỉ xóa được cơ sở chưa có dữ liệu', async () => {
    expect((await owner.delete(`/properties/${IDS.p1}`)).body.error).toMatch(/đã có dữ liệu/)

    const id = (await owner.post('/properties', { name: 'Sao Mai', copyFromId: IDS.p1 })).body.id
    expect((await owner.delete(`/properties/${id}`)).status).toBe(200)
    expect((await owner.get('/properties')).body.map((p: { id: string }) => p.id)).not.toContain(id)
  })

  it('từ chối tài khoản ngân hàng và quy tắc sai định dạng', async () => {
    const badBank = await owner.patch(`/properties/${IDS.p1}`, { bank: { bin: '970436', accountNumber: 'abc', accountName: 'Thử' } })
    expect(badBank.status).toBe(400)
    const badRules = await owner.patch(`/properties/${IDS.p1}`, {
      settings: { graceMinutes: 10, checkoutHour: 25, lateFees: [], overnightFromHour: 22, overnightToHour: 5 },
    })
    expect(badRules.status).toBe(400)
  })
})

describe('sơ đồ phòng, loại phòng, dịch vụ', () => {
  it('thêm, sửa, chuyển chỗ phòng; số phòng không được trùng trong cùng cơ sở', async () => {
    const created = await owner.post('/rooms', { propertyId: IDS.p1, number: '104', typeId: IDS.single, floor: 1, row: 1, col: 4 })
    expect(created.status).toBe(200)
    expect((await owner.post('/rooms', { propertyId: IDS.p1, number: '104', typeId: IDS.single, floor: 1, row: 2, col: 1 })).body.error).toBe('Số phòng này đã có.')
    // Cơ sở khác thì dùng lại số phòng được.
    expect((await owner.post('/rooms', { propertyId: IDS.p2, number: '104', typeId: IDS.otherType, floor: 1, row: 1, col: 2 })).status).toBe(200)

    await owner.patch(`/rooms/${created.body.id}`, { number: '105', floor: 2, row: 1, col: 2, typeId: IDS.double })
    const room = (await state()).rooms.find((r: { id: string }) => r.id === created.body.id)
    expect(room).toMatchObject({ number: '105', floor: 2, col: 2, typeId: IDS.double })
    expect((await owner.patch(`/rooms/${created.body.id}`, { number: '101' })).status).toBe(409)
    expect((await owner.patch(`/rooms/${created.body.id}`, { typeId: IDS.otherType })).status).toBe(400)
  })

  it('chỉ xóa được phòng chưa có lượt thuê, và loại phòng chưa có phòng nào dùng', async () => {
    await checkIn(lan)
    expect((await owner.delete(`/rooms/${IDS.r101}`)).status).toBe(409)
    expect((await owner.delete(`/rooms/${IDS.r103}`)).status).toBe(200)
    expect((await owner.delete(`/room-types/${IDS.single}`)).body.error).toMatch(/Đang có phòng/)
  })

  it('đổi bảng giá chỉ ảnh hưởng lượt thuê mới', async () => {
    const before = await checkIn(lan)
    const single = (await state()).roomTypes.find((type: { id: string }) => type.id === IDS.single)
    await owner.put(`/room-types/${IDS.single}`, {
      name: single.name,
      standardGuests: 1,
      extraGuestFee: 50_000,
      prices: { ...single.prices, firstHour: 120_000 },
    })
    const after = await checkIn(lan, { roomId: IDS.r102, prices: { ...single.prices, firstHour: 120_000 } })

    const stays = (await state()).stays
    expect(stays.find((s: { id: string }) => s.id === before)).toMatchObject({ prices: { firstHour: 80_000 }, standardGuests: 2 })
    expect(stays.find((s: { id: string }) => s.id === after)).toMatchObject({ prices: { firstHour: 120_000 }, standardGuests: 1, extraGuestFee: 50_000 })
  })

  it('thêm, sửa, xóa dịch vụ', async () => {
    const id = (await owner.post('/services', { propertyId: IDS.p1, name: 'Bia', price: 20_000 })).body.id
    await owner.put(`/services/${id}`, { name: 'Bia lon', price: 25_000 })
    expect((await state()).services).toContainEqual({ id, propertyId: IDS.p1, name: 'Bia lon', price: 25_000 })
    await owner.delete(`/services/${id}`)
    expect((await state()).services.map((s: { id: string }) => s.id)).not.toContain(id)
  })
})

describe('báo cáo', () => {
  const report = async (query: string) => (await owner.get(`/reports?${query}`)).body

  it('báo cáo ngày theo ca: tiền mặt, chuyển khoản, lượt thuê, chênh lệch, khoản chi, cơ cấu doanh thu, ghi chú', async () => {
    // Ca sáng của Lan: một lượt giờ trả tiền mặt (80.000) có nước suối (10.000), một lượt
    // thu trước chuyển khoản 200.000 chưa trả phòng.
    const first = await checkIn(lan)
    await lan.post(`/stays/${first}/items`, { kind: 'service', name: 'Nước suối', unitPrice: 10_000 })
    env.setClock(at(5, 14, 40))
    await lan.post(`/stays/${first}/check-out`, { method: 'cash' })
    const second = await checkIn(lan, { roomId: IDS.r102, rentType: 'day', guestCount: 3 })
    await lan.post(`/stays/${second}/payments`, { amount: 200_000, method: 'transfer' })
    await lan.post(`/stays/${first}/notes`, { text: 'Khách quen' })
    await lan.post(`/shifts/${(await state()).shift.id}/close`, { cashDiff: -10_000, note: 'Thối nhầm' })

    // Ca tối của Hùng: lượt thuê ngày trả phòng 12:00 hôm sau, vẫn tính cho ngày 05.
    env.setClock(at(5, 18))
    const hung = await env.login(PINS.hung)
    env.setClock(at(6, 12))
    await hung.post(`/stays/${second}/check-out`, { method: 'cash' })
    await hung.post(`/shifts/${(await state()).shift.id}/close`, { cashDiff: 0 })

    await owner.post('/expenses', { propertyId: IDS.p1, name: 'Giặt là', amount: 60_000, businessDate: '2026-10-05' })

    const { report: day, rooms, stays } = await report(`propertyId=${IDS.p1}&mode=day&date=2026-10-05`)
    expect(day.shifts.map((row: { shift: { label: string; userName: string }; cash: number; transfer: number; checkIns: number; cashDiff: number }) => [
      row.shift.label,
      row.shift.userName,
      row.cash,
      row.transfer,
      row.checkIns,
      row.cashDiff,
    ])).toEqual([
      ['Sáng', 'Lan', 90_000, 200_000, 2, -10_000],
      // 500.000 tiền phòng + 100.000 thêm người − 200.000 đã thu trước.
      ['Tối', 'Hùng', 400_000, 0, 0, 0],
    ])
    expect(day.totals).toEqual({ checkIns: 2, cash: 490_000, transfer: 200_000, spent: 60_000, cashDiff: -10_000 })
    expect(day.revenue).toEqual({ stays: 2, room: 580_000, service: 10_000, surcharge: 100_000, discount: 0 })
    expect(day.notes.map((note: { subject: string; text: string }) => [note.subject, note.text])).toEqual([
      ['Ca sáng', 'Thối nhầm'],
      ['Phòng 101', 'Khách quen'],
    ])
    expect(rooms).toHaveLength(4)
    expect(stays.map((stay: { id: string }) => stay.id).sort()).toEqual([first, second].sort())

    // Ngày 06 không có ca nào bắt đầu, nên báo cáo ngày 06 trống dù có khoản thu lúc 12:00.
    expect((await report(`propertyId=${IDS.p1}&mode=day&date=2026-10-06`)).report.totals.cash).toBe(0)
    expect((await report(`propertyId=${IDS.p1}&mode=month&date=2026-10-01`)).report.totals.cash).toBe(490_000)
    expect((await report(`propertyId=${IDS.p1}&mode=year&date=2026-01-01`)).report.totals.transfer).toBe(200_000)
  })

  it('gộp mọi cơ sở khi không truyền propertyId, và không lẫn số liệu khi truyền', async () => {
    const first = await checkIn(lan)
    await lan.post(`/stays/${first}/check-out`, { method: 'cash' })
    const hung = await env.login(PINS.hung, IDS.p2)
    const other = (await hung.post('/stays/check-in', checkInBody({ roomId: IDS.otherRoom }))).body.id
    await hung.post(`/stays/${other}/check-out`, { method: 'transfer' })

    expect((await report(`propertyId=${IDS.p1}&mode=day&date=2026-10-05`)).report.totals).toMatchObject({ cash: 80_000, transfer: 0 })
    expect((await report(`propertyId=${IDS.p2}&mode=day&date=2026-10-05`)).report.totals).toMatchObject({ cash: 0, transfer: 80_000 })
    const all = await report('mode=day&date=2026-10-05')
    expect(all.report.totals).toMatchObject({ cash: 80_000, transfer: 80_000, checkIns: 2 })
    expect(all.report.shifts).toHaveLength(2)
  })

  it('chủ ghi chú thêm cho ca đã đóng; bỏ được khoản chi nhập nhầm', async () => {
    const shiftId = (await state()).shift.id
    await lan.post(`/shifts/${shiftId}/close`, { cashDiff: -5_000, note: 'Thiếu 5 nghìn' })
    await owner.post(`/shifts/${shiftId}/notes`, { text: 'Đã tìm ra' })
    const expense = (await owner.post('/expenses', { propertyId: IDS.p1, name: 'Nhầm', amount: 999_000, businessDate: '2026-10-05' })).body.id

    let day = (await report(`propertyId=${IDS.p1}&mode=day&date=2026-10-05`)).report
    expect(day.notes[0].text).toBe('Thiếu 5 nghìn · Đã tìm ra')
    expect(day.totals.spent).toBe(999_000)

    await owner.delete(`/expenses/${expense}`)
    day = (await report(`propertyId=${IDS.p1}&mode=day&date=2026-10-05`)).report
    expect(day.totals.spent).toBe(0)
  })
})
