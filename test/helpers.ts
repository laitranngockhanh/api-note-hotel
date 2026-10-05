import { sql } from 'drizzle-orm'
import request from 'supertest'
import { createApp } from '../src/app'
import { connect, connectInMemory, type Connection } from '../src/db/client'
import * as t from '../src/db/schema'
import { createPinCodec } from '../src/lib/pin'
import { DEFAULT_SETTINGS } from '../src/routes/admin'

// Môi trường kiểm thử: một PostgreSQL trong bộ nhớ, đồng hồ điều khiển được, và một bộ dữ
// liệu nhỏ cố định. Mã PIN ở đây chỉ dùng trong kiểm thử.

export const PINS = { owner: '9001', lan: '9002', hung: '9003' }
export const IDS = {
  owner: 'u-owner',
  lan: 'u-lan',
  hung: 'u-hung',
  p1: 'p1',
  p2: 'p2',
  single: 'type-single',
  double: 'type-double',
  r101: 'r101',
  r102: 'r102',
  r103: 'r103',
  r201: 'r201',
  otherRoom: 'p2-r101',
  otherType: 'p2-type',
}

const SINGLE = { firstHour: 80_000, nextHour: 30_000, overnight: 300_000, day: 500_000, week: 3_000_000, month: 9_000_000 }
const DOUBLE = { firstHour: 100_000, nextHour: 40_000, overnight: 380_000, day: 600_000, week: 3_600_000, month: 11_000_000 }

// Tháng 10/2026; tháng trong Date tính từ 0.
export const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute)

// Bình thường kiểm thử chạy trên PGlite trong bộ nhớ. Đặt TEST_DATABASE_URL (lệnh
// `npm run test:pg`) thì chạy trên một PostgreSQL thật, để chắc đường kết nối dùng khi triển
// khai cũng đúng. Kiểm thử XÓA SẠCH mọi bảng, nên chỉ nhận cơ sở dữ liệu có tên kết thúc
// bằng "_test"; nhờ vậy không thể lỡ tay trỏ vào dữ liệu thật.
function connectForTests(): Promise<Connection> {
  const url = process.env.TEST_DATABASE_URL
  if (!url) return connectInMemory()
  if (!new URL(url).pathname.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL phải trỏ tới cơ sở dữ liệu có tên kết thúc bằng "_test"')
  }
  return connect(url)
}

export async function createTestEnv(options: { setupCode?: string } = {}) {
  const connection: Connection = await connectForTests()
  const { db } = connection
  const pins = createPinCodec('khoa-bi-mat-chi-dung-trong-kiem-thu-0123456789')
  let clock = at(5, 14)
  const app = createApp({ db, pins, now: () => clock, setupCode: options.setupCode }, ['http://localhost'])

  // Hệ thống trống như lúc mới cài: chưa có tài khoản, chưa có cơ sở.
  async function clear() {
    clock = at(5, 14)
    await db.execute(sql`truncate table
      sessions, pin_guards, payments, stay_items, stay_notes, stay_photos, stays, expenses, shifts,
      services, rooms, room_types, properties, users cascade`)
  }

  async function reset() {
    await clear()
    const user = (id: string, name: string, role: 'owner' | 'staff', pin: string) => ({
      id,
      name,
      role,
      pinCipher: pins.encrypt(pin),
      pinLookup: pins.lookup(pin),
    })
    await db.insert(t.users).values([
      user(IDS.owner, 'Bác Tâm', 'owner', PINS.owner),
      user(IDS.lan, 'Lan', 'staff', PINS.lan),
      user(IDS.hung, 'Hùng', 'staff', PINS.hung),
    ])
    await db.insert(t.properties).values([
      { id: IDS.p1, name: 'Hoa Mai', settings: DEFAULT_SETTINGS },
      { id: IDS.p2, name: 'Bình Minh', settings: DEFAULT_SETTINGS },
    ])
    await db.insert(t.roomTypes).values([
      { id: IDS.single, propertyId: IDS.p1, name: 'Phòng đơn', standardGuests: 2, extraGuestFee: 100_000, prices: SINGLE },
      { id: IDS.double, propertyId: IDS.p1, name: 'Phòng đôi', standardGuests: 4, extraGuestFee: 100_000, prices: DOUBLE },
      { id: IDS.otherType, propertyId: IDS.p2, name: 'Phòng đơn', standardGuests: 2, extraGuestFee: 0, prices: SINGLE },
    ])
    const room = (id: string, propertyId: string, number: string, typeId: string, floor: number, col: number) => ({
      id,
      propertyId,
      number,
      typeId,
      floor,
      row: 1,
      col,
    })
    await db.insert(t.rooms).values([
      room(IDS.r101, IDS.p1, '101', IDS.single, 1, 1),
      room(IDS.r102, IDS.p1, '102', IDS.single, 1, 2),
      room(IDS.r103, IDS.p1, '103', IDS.single, 1, 3),
      room(IDS.r201, IDS.p1, '201', IDS.double, 2, 1),
      room(IDS.otherRoom, IDS.p2, '101', IDS.otherType, 1, 1),
    ])
    await db.insert(t.services).values({ id: 'sv-water', propertyId: IDS.p1, name: 'Nước suối', price: 10_000 })
  }

  // Đăng nhập và trả về một bộ gọi API đã gắn sẵn mã phiên.
  async function login(pin: string, propertyId = IDS.p1) {
    const response = await request(app).post('/api/login').send({ pin, propertyId })
    if (response.status !== 200) throw new Error(`Đăng nhập thất bại: ${response.status} ${response.text}`)
    return client(response.body.token as string)
  }

  function client(token: string) {
    const auth = { Authorization: `Bearer ${token}` }
    return {
      token,
      get: (path: string) => request(app).get(`/api${path}`).set(auth),
      post: (path: string, body: object = {}) => request(app).post(`/api${path}`).set(auth).send(body),
      patch: (path: string, body: object) => request(app).patch(`/api${path}`).set(auth).send(body),
      put: (path: string, body: object) => request(app).put(`/api${path}`).set(auth).send(body),
      delete: (path: string) => request(app).delete(`/api${path}`).set(auth),
      upload: (path: string, data: Buffer, contentType: string) =>
        request(app).post(`/api${path}`).set(auth).set('Content-Type', contentType).send(data),
    }
  }

  return {
    app,
    db,
    clear,
    reset,
    login,
    client,
    close: connection.close,
    setClock: (next: Date) => {
      clock = next
    },
  }
}

export type TestEnv = Awaited<ReturnType<typeof createTestEnv>>
export type Client = Awaited<ReturnType<TestEnv['login']>>

// Thân yêu cầu nhận phòng mặc định: phòng 101, thuê giờ, giá của phòng đơn.
export const checkInBody = (extra: object = {}) => ({
  roomId: IDS.r101,
  rentType: 'hour',
  periods: 1,
  prices: SINGLE,
  guestName: 'Anh Minh',
  guestPhone: '0900 111 222',
  guestCount: 2,
  ...extra,
})

export async function checkIn(api: Client, extra: object = {}): Promise<string> {
  const response = await api.post('/stays/check-in', checkInBody(extra))
  if (response.status !== 200) throw new Error(`Nhận phòng thất bại: ${response.status} ${response.text}`)
  return response.body.id as string
}
