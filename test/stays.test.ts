import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { at, checkIn, checkInBody, createTestEnv, IDS, PINS, type Client, type TestEnv } from './helpers'

let env: TestEnv
let lan: Client
let owner: Client

beforeAll(async () => {
  env = await createTestEnv()
})
afterAll(() => env.close())
beforeEach(async () => {
  await env.reset()
  owner = await env.login(PINS.owner)
  lan = await env.login(PINS.lan)
})

const state = async (api: Client = lan) => (await api.get(`/state?propertyId=${IDS.p1}`)).body
const roomOf = async (roomId: string) => (await state()).rooms.find((room: { id: string }) => room.id === roomId)
const stayOf = async (stayId: string) => (await state()).stays.find((stay: { id: string }) => stay.id === stayId)
const paymentsOf = async (stayId: string) =>
  (await state()).payments.filter((payment: { stayId: string }) => payment.stayId === stayId)
const sum = (rows: { amount: number }[]) => rows.reduce((total, row) => total + row.amount, 0)

describe('nhận phòng và trả phòng', () => {
  it('đi trọn luồng: nhận phòng, thêm dịch vụ, thu trước, trả phòng', async () => {
    const id = await checkIn(lan)
    expect(await stayOf(id)).toMatchObject({ status: 'active', roomId: IDS.r101, guestName: 'Anh Minh', standardGuests: 2 })

    await lan.post(`/stays/${id}/items`, { kind: 'service', name: 'Nước suối', unitPrice: 10_000 })
    await lan.post(`/stays/${id}/items`, { kind: 'service', name: 'Nước suối', unitPrice: 10_000 })
    expect((await stayOf(id)).items).toMatchObject([{ name: 'Nước suối', qty: 2 }])

    await lan.post(`/stays/${id}/payments`, { amount: 50_000, method: 'transfer' })

    // Vào 14:00, ra 16:35: giờ đầu 80.000 + 2 giờ tiếp × 30.000 = 140.000, cộng nước 20.000.
    env.setClock(at(5, 16, 35))
    const out = await lan.post(`/stays/${id}/check-out`, { method: 'cash' })
    expect(out.body).toEqual({ total: 160_000, collected: 110_000 })

    expect((await roomOf(IDS.r101)).condition).toBe('cleaning')
    const done = (await lan.get(`/stays?propertyId=${IDS.p1}&status=done`)).body
    expect(done.stays).toMatchObject([{ id, status: 'done', finalCharge: 140_000 }])
    expect(done.payments.map((p: { amount: number; method: string }) => [p.amount, p.method])).toEqual([
      [50_000, 'transfer'],
      [110_000, 'cash'],
    ])
    expect(Object.values(done.collectors)).toEqual(['Lan'])
  })

  it('không nhận được vào phòng đang có khách, chờ dọn hoặc bảo trì', async () => {
    await checkIn(lan)
    expect((await lan.post('/stays/check-in', checkInBody())).body.error).toBe('Phòng đang có khách.')

    await lan.post(`/rooms/${IDS.r102}/condition`, { condition: 'maintenance' })
    const refused = await lan.post('/stays/check-in', checkInBody({ roomId: IDS.r102 }))
    expect(refused.status).toBe(409)
  })

  it('qua đêm chỉ nhận trong khung giờ của cơ sở', async () => {
    const refused = await lan.post('/stays/check-in', checkInBody({ rentType: 'overnight' }))
    expect(refused.status).toBe(400)
    expect(refused.body.error).toBe('Qua đêm chỉ nhận từ 22:00 đến 05:00.')

    env.setClock(at(5, 22, 30))
    expect((await lan.post('/stays/check-in', checkInBody({ rentType: 'overnight' }))).status).toBe(200)
  })

  it('thuê ngày trả muộn và có thêm người: tiền chốt theo đúng công thức hóa đơn', async () => {
    const id = await checkIn(lan, { rentType: 'day', guestCount: 3 })
    // Trả 14:00 hôm sau: 500.000 + 30% trả muộn 150.000 + thêm 1 người 100.000.
    env.setClock(at(6, 14))
    const out = await lan.post(`/stays/${id}/check-out`, { method: 'transfer' })
    expect(out.body.total).toBe(750_000)
  })

  it('trả thừa thì lúc trả phòng ghi một khoản hoàn tiền', async () => {
    const id = await checkIn(lan)
    await lan.post(`/stays/${id}/payments`, { amount: 200_000, method: 'cash' })
    env.setClock(at(5, 14, 30))
    const out = await lan.post(`/stays/${id}/check-out`, { method: 'cash' })
    expect(out.body).toEqual({ total: 80_000, collected: -120_000 })
  })

  it('số tiền trên màn hình đã cũ vì vừa sang giờ mới: từ chối, báo số mới, chưa ghi gì vào sổ', async () => {
    const id = await checkIn(lan)
    // Vào 14:00. Màn hình tính lúc 15:09 (còn trong 10 phút ân hạn): 80.000. Bấm trả lúc 15:11
    // thì đã sang giờ thứ hai: 110.000.
    env.setClock(at(5, 15, 11))
    const refused = await lan.post(`/stays/${id}/check-out`, { method: 'cash', expectedDue: 80_000 })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('Số tiền của phòng này vừa thay đổi: bây giờ phải thu 110.000 đ. Xem lại rồi bấm lại.')
    expect(await stayOf(id)).toMatchObject({ status: 'active', finalCharge: null })
    expect(await paymentsOf(id)).toEqual([])
    expect((await roomOf(IDS.r101)).condition).toBe('ready')

    const out = await lan.post(`/stays/${id}/check-out`, { method: 'cash', expectedDue: 110_000 })
    expect(out.body).toEqual({ total: 110_000, collected: 110_000 })
  })

  it('máy khác vừa thu trước: số trên màn hình này đã cũ thì cũng bị từ chối', async () => {
    const id = await checkIn(lan)
    env.setClock(at(5, 14, 30))
    await owner.post(`/stays/${id}/payments`, { amount: 80_000, method: 'transfer' })
    const refused = await lan.post(`/stays/${id}/check-out`, { method: 'cash', expectedDue: 80_000 })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('Số tiền của phòng này vừa thay đổi: bây giờ khách đã trả đủ. Xem lại rồi bấm lại.')

    await owner.post(`/stays/${id}/payments`, { amount: 50_000, method: 'cash' })
    const again = await lan.post(`/stays/${id}/check-out`, { method: 'cash', expectedDue: 0 })
    expect(again.body.error).toBe(
      'Số tiền của phòng này vừa thay đổi: bây giờ phải hoàn cho khách 50.000 đ. Xem lại rồi bấm lại.',
    )
    expect((await lan.post(`/stays/${id}/check-out`, { method: 'cash', expectedDue: -50_000 })).status).toBe(200)
  })

  it('lượt đã trả phòng thì không thêm dịch vụ hay trả phòng lần nữa được', async () => {
    const id = await checkIn(lan)
    await lan.post(`/stays/${id}/check-out`, { method: 'cash' })
    const again = await lan.post(`/stays/${id}/check-out`, { method: 'cash' })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('Lượt thuê này đã trả phòng, không làm được việc này.')
    expect((await lan.post(`/stays/${id}/items`, { kind: 'service', name: 'Bia', unitPrice: 20_000 })).status).toBe(409)
  })
})

describe('ca của chủ', () => {
  it('chủ nhận phòng khi chưa có ca thì ca của chủ tự mở; chỉ xem thì không', async () => {
    const p2 = await env.login(PINS.owner, IDS.p2)
    expect((await p2.get(`/state?propertyId=${IDS.p2}`)).body.shift).toBeNull()

    await p2.post('/stays/check-in', checkInBody({ roomId: IDS.otherRoom }))
    expect((await p2.get(`/state?propertyId=${IDS.p2}`)).body.shift).toMatchObject({ userId: IDS.owner })
  })

  it('khi người trực đang có ca thì thao tác của chủ tính vào ca đó', async () => {
    const lanShift = (await state()).shift.id
    const id = await checkIn(owner)
    expect((await stayOf(id)).shiftId).toBe(lanShift)
  })
})

describe('quyền sửa giá', () => {
  const cheap = { firstHour: 1_000, nextHour: 1_000, overnight: 1_000, day: 1_000, week: 1_000, month: 1_000 }

  it('cơ sở cho phép thì người trực sửa được giá và giảm giá', async () => {
    const id = await checkIn(lan, { prices: cheap })
    expect((await stayOf(id)).prices.firstHour).toBe(1_000)
    expect((await lan.post(`/stays/${id}/items`, { kind: 'discount', name: 'Khách quen', unitPrice: 500 })).status).toBe(200)
  })

  it('cơ sở không cho phép thì giá người trực gửi lên bị bỏ qua và không giảm giá được; chủ vẫn làm được', async () => {
    await owner.patch(`/properties/${IDS.p1}`, { staffCanEditPrice: false })

    const id = await checkIn(lan, { prices: cheap })
    expect((await stayOf(id)).prices.firstHour).toBe(80_000)
    const refused = await lan.post(`/stays/${id}/items`, { kind: 'discount', name: 'Khách quen', unitPrice: 500 })
    expect(refused.status).toBe(403)

    expect((await owner.post(`/stays/${id}/items`, { kind: 'discount', name: 'Khách quen', unitPrice: 500 })).status).toBe(200)
    const byOwner = await checkIn(owner, { roomId: IDS.r102, prices: cheap })
    expect((await stayOf(byOwner)).prices.firstHour).toBe(1_000)
  })
})

describe('đặt trước', () => {
  const book = async (extra: object = {}) =>
    (
      await lan.post('/stays/book', {
        ...checkInBody({ rentType: 'day' }),
        expectedAt: at(5, 18).toISOString(),
        deposit: 100_000,
        depositMethod: 'transfer',
        ...extra,
      })
    ).body.id as string

  it('đặt trước có cọc; khách đến thì giờ vào tính từ lúc đến và cọc được trừ', async () => {
    const id = await book()
    expect(await stayOf(id)).toMatchObject({ status: 'booked', checkInAt: at(5, 18).toISOString() })
    expect((await roomOf(IDS.r101)).condition).toBe('ready')

    env.setClock(at(5, 19))
    await lan.post(`/stays/${id}/arrive`)
    expect(await stayOf(id)).toMatchObject({ status: 'active', checkInAt: at(5, 19).toISOString() })

    env.setClock(at(6, 12))
    const out = await lan.post(`/stays/${id}/check-out`, { method: 'cash' })
    expect(out.body).toEqual({ total: 500_000, collected: 400_000 })
  })

  it('hủy và giữ cọc thì tiền cọc vẫn nằm trong sổ', async () => {
    const id = await book()
    await lan.post(`/stays/${id}/cancel`)
    const cancelled = (await lan.get(`/stays?propertyId=${IDS.p1}&status=cancelled`)).body
    expect(cancelled.stays).toMatchObject([{ id, status: 'cancelled' }])
    expect(sum(cancelled.payments)).toBe(100_000)
  })

  it('hủy và hoàn cọc thì ghi một khoản âm đúng bằng tiền cọc', async () => {
    const id = await book()
    await lan.post(`/stays/${id}/cancel`, { refundMethod: 'cash' })
    const { payments } = (await lan.get(`/stays?propertyId=${IDS.p1}&status=cancelled`)).body
    expect(payments.map((p: { amount: number; method: string }) => [p.amount, p.method])).toEqual([
      [100_000, 'transfer'],
      [-100_000, 'cash'],
    ])
  })

  it('đổi giờ hẹn được; khách chưa đến thì không trả phòng được', async () => {
    const id = await book()
    await lan.patch(`/stays/${id}`, { expectedAt: at(5, 21).toISOString() })
    expect((await stayOf(id)).checkInAt).toBe(at(5, 21).toISOString())
    expect((await lan.post(`/stays/${id}/check-out`, { method: 'cash' })).status).toBe(409)
  })

  it('phòng đang có khách thì khách đặt chưa nhận phòng được', async () => {
    const id = await book()
    await checkIn(lan)
    expect((await lan.post(`/stays/${id}/arrive`)).body.error).toBe('Phòng đang có khách.')
  })
})

describe('sửa lượt thuê', () => {
  it('sửa tên, số điện thoại và số người', async () => {
    const id = await checkIn(lan)
    await lan.patch(`/stays/${id}`, { guestName: 'Anh Minh Trí', guestPhone: '0900 999 888', guestCount: 4 })
    expect(await stayOf(id)).toMatchObject({ guestName: 'Anh Minh Trí', guestPhone: '0900 999 888', guestCount: 4 })
  })

  it('đổi kiểu thuê thì số kỳ về 1; gia hạn chỉ áp dụng cho ngày, tuần, tháng', async () => {
    const id = await checkIn(lan)
    expect((await lan.post(`/stays/${id}/extend`)).status).toBe(400)

    await lan.patch(`/stays/${id}`, { rentType: 'day' })
    await lan.post(`/stays/${id}/extend`)
    expect(await stayOf(id)).toMatchObject({ rentType: 'day', periods: 2 })

    await lan.patch(`/stays/${id}`, { rentType: 'week' })
    expect((await stayOf(id)).periods).toBe(1)
  })

  it('đổi phòng: giữ nguyên lượt thuê, phòng cũ chờ dọn, tự thêm ghi chú', async () => {
    const id = await checkIn(lan)
    const before = await stayOf(id)

    await lan.post(`/stays/${id}/move`, { roomId: IDS.r103 })

    const after = await stayOf(id)
    expect(after).toMatchObject({ roomId: IDS.r103, checkInAt: before.checkInAt, prices: before.prices })
    expect(after.notes).toMatchObject([{ text: 'Đổi từ phòng 101 sang phòng 103', by: 'Lan' }])
    expect((await roomOf(IDS.r101)).condition).toBe('cleaning')
  })

  it('không đổi được sang phòng đang có khách hoặc phòng của cơ sở khác', async () => {
    const id = await checkIn(lan)
    await checkIn(lan, { roomId: IDS.r102 })
    expect((await lan.post(`/stays/${id}/move`, { roomId: IDS.r102 })).status).toBe(409)
    expect((await lan.post(`/stays/${id}/move`, { roomId: IDS.otherRoom })).status).toBe(400)
  })
})

describe('khoản thu và ghi chú', () => {
  it('bỏ được khoản thu khi ca còn mở; ca đã đóng thì không', async () => {
    const id = await checkIn(lan)
    await lan.post(`/stays/${id}/payments`, { amount: 500_000, method: 'cash' })
    const [wrong] = await paymentsOf(id)
    expect((await lan.delete(`/payments/${wrong.id}`)).status).toBe(200)
    expect(await paymentsOf(id)).toEqual([])

    await lan.post(`/stays/${id}/payments`, { amount: 50_000, method: 'cash' })
    const [kept] = await paymentsOf(id)
    await lan.post(`/shifts/${(await state()).shift.id}/close`, { cashDiff: 0 })

    const refused = await owner.delete(`/payments/${kept.id}`)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/Thêm ghi chú/)
  })

  it('ghi chú chỉ thêm vào, kèm tên người ghi, thêm được cả sau khi trả phòng', async () => {
    const id = await checkIn(lan)
    await lan.post(`/stays/${id}/check-out`, { method: 'cash' })
    await lan.post(`/stays/${id}/notes`, { text: 'Khách chuyển khoản, bấm nhầm tiền mặt' })
    await owner.post(`/stays/${id}/notes`, { text: 'Đã rõ' })

    const { stays } = (await lan.get(`/stays?propertyId=${IDS.p1}&status=done`)).body
    expect(stays[0].notes.map((note: { text: string; by: string }) => [note.text, note.by])).toEqual([
      ['Khách chuyển khoản, bấm nhầm tiền mặt', 'Lan'],
      ['Đã rõ', 'Bác Tâm'],
    ])
    expect(stays[0].notes[0].businessDate).toBe('2026-10-05')
  })
})

describe('ảnh giấy tờ', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

  it('tải lên, xem lại, và tự xóa khi trả phòng', async () => {
    const id = await checkIn(lan)
    const uploaded = await lan.upload(`/stays/${id}/photos`, jpeg, 'image/jpeg')
    expect(uploaded.status).toBe(200)
    expect((await stayOf(id)).photos).toMatchObject([{ id: uploaded.body.id }])

    const shown = await lan.get(`/photos/${uploaded.body.id}`)
    expect(shown.headers['content-type']).toMatch(/image\/jpeg/)
    expect(shown.headers['cache-control']).toBe('no-store')
    expect(Buffer.from(shown.body)).toEqual(jpeg)

    await lan.post(`/stays/${id}/check-out`, { method: 'cash' })
    expect((await lan.get(`/photos/${uploaded.body.id}`)).status).toBe(404)
  })

  it('từ chối file không phải ảnh, và ảnh thứ bảy', async () => {
    const id = await checkIn(lan)
    expect((await lan.upload(`/stays/${id}/photos`, Buffer.from('ghi chu'), 'text/plain')).status).toBe(400)

    for (let i = 0; i < 6; i += 1) await lan.upload(`/stays/${id}/photos`, jpeg, 'image/jpeg')
    const seventh = await lan.upload(`/stays/${id}/photos`, jpeg, 'image/jpeg')
    expect(seventh.status).toBe(409)
    expect(seventh.body.error).toBe('Mỗi lượt thuê tối đa 6 ảnh.')
  })

  it('hủy đặt cũng xóa ảnh; bỏ từng ảnh được', async () => {
    const booked = (
      await lan.post('/stays/book', { ...checkInBody({ rentType: 'day' }), expectedAt: at(5, 18).toISOString() })
    ).body.id as string
    const first = (await lan.upload(`/stays/${booked}/photos`, jpeg, 'image/jpeg')).body.id
    const second = (await lan.upload(`/stays/${booked}/photos`, jpeg, 'image/jpeg')).body.id

    await lan.delete(`/stays/${booked}/photos/${first}`)
    expect((await stayOf(booked)).photos).toMatchObject([{ id: second }])

    await lan.post(`/stays/${booked}/cancel`)
    expect((await lan.get(`/photos/${second}`)).status).toBe(404)
  })

  it('người không được phân công ở cơ sở thì không xem được ảnh', async () => {
    const id = await checkIn(lan)
    const photoId = (await lan.upload(`/stays/${id}/photos`, jpeg, 'image/jpeg')).body.id
    const hung = await env.login(PINS.hung, IDS.p2)
    await owner.patch(`/properties/${IDS.p1}`, { staffIds: [IDS.lan] })
    expect((await hung.get(`/photos/${photoId}`)).status).toBe(403)
  })
})

describe('kết thúc ca', () => {
  it('đóng ca với số lệch và ghi chú; ca đã đóng thì không đóng lại được; ca mới mở sau đó', async () => {
    const shiftId = (await state()).shift.id
    expect((await lan.post(`/shifts/${shiftId}/close`, { cashDiff: -50_000, note: 'Thối nhầm cho khách' })).status).toBe(200)
    expect((await state()).shift).toBeNull()
    expect((await lan.post(`/shifts/${shiftId}/close`, { cashDiff: 0 })).status).toBe(409)

    const next = (await lan.post('/shifts/start', { propertyId: IDS.p1 })).body
    expect(next).toMatchObject({ userId: IDS.lan, closedAt: null })
    expect(next.id).not.toBe(shiftId)
  })

  it('trạng thái vẫn có lượt đã trả phòng trong ca đang mở, để màn hình kết thúc ca tính đủ', async () => {
    const id = await checkIn(lan)
    await lan.post(`/stays/${id}/check-out`, { method: 'transfer' })

    const body = await state()
    expect(body.stays).toMatchObject([{ id, status: 'done', roomId: IDS.r101 }])
    expect(body.payments).toMatchObject([{ stayId: id, amount: 80_000, method: 'transfer', shiftId: body.shift.id }])

    // Sang ca sau thì lượt đó không còn trong trạng thái nữa.
    await lan.post(`/shifts/${body.shift.id}/close`, { cashDiff: 0 })
    await lan.post('/shifts/start', { propertyId: IDS.p1 })
    expect((await state()).stays).toEqual([])
  })

  it('người trực đến sau đóng được ca của người trước', async () => {
    const hung = await env.login(PINS.hung)
    const shiftId = (await state(hung)).shift.id
    expect((await state(hung)).shift.userId).toBe(IDS.lan)
    expect((await hung.post(`/shifts/${shiftId}/close`, { cashDiff: 0 })).status).toBe(200)
    expect((await hung.post('/shifts/start', { propertyId: IDS.p1 })).body.userId).toBe(IDS.hung)
  })
})

describe('tìm lượt thuê', () => {
  it('tìm theo tên, số điện thoại không cần đúng khoảng trắng, và số phòng', async () => {
    await checkIn(lan)
    await checkIn(lan, { roomId: IDS.r102, guestName: 'Chị Hoa', guestPhone: '0911 222 333' })
    const search = async (q: string) =>
      (await lan.get(`/stays?propertyId=${IDS.p1}&status=active&q=${encodeURIComponent(q)}`)).body.stays.map(
        (stay: { guestName: string }) => stay.guestName,
      )

    expect(await search('hoa')).toEqual(['Chị Hoa'])
    expect(await search('0911222')).toEqual(['Chị Hoa'])
    expect(await search('101')).toEqual(['Anh Minh'])
    expect(await search('không có ai')).toEqual([])
  })
})
