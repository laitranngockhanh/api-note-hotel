// Múi giờ phải được đặt trước mọi phép tính ngày giờ: ngày của ca, mốc trả phòng 12:00,
// khung giờ qua đêm đều tính theo giờ Việt Nam, kể cả khi máy chủ đặt ở nước khác.
process.env.TZ ??= 'Asia/Ho_Chi_Minh'

const DEV_PIN_SECRET = 'khoa-chi-dung-khi-chay-tren-may-khong-dung-that'

// Khi chạy trên máy (không có DATABASE_URL) và không đặt CORS_ORIGIN: nhận giao diện mở từ
// chính máy này hoặc từ máy khác trong mạng nội bộ (ví dụ điện thoại cùng wifi), ở cổng nào cũng được.
export const LOCAL_ORIGIN =
  /^http:\/\/(localhost|127\.0\.0\.1|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2})(:\d+)?$/

export interface Env {
  port: number
  databaseUrl: string | undefined
  dataDir: string
  pinSecret: string
  corsOrigins: (string | RegExp)[]
  setupCode: string | undefined
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const databaseUrl = source.DATABASE_URL || undefined
  // Có cơ sở dữ liệu thật mà thiếu khóa thì dừng ngay, không âm thầm dùng khóa mặc định.
  if (databaseUrl && (!source.PIN_SECRET || source.PIN_SECRET.length < 32)) {
    throw new Error('Cần đặt PIN_SECRET dài ít nhất 32 ký tự khi dùng DATABASE_URL')
  }
  return {
    port: Number(source.PORT) || 3000,
    databaseUrl,
    dataDir: source.DATA_DIR || 'data/pglite',
    pinSecret: source.PIN_SECRET || DEV_PIN_SECRET,
    corsOrigins: source.CORS_ORIGIN
      ? source.CORS_ORIGIN.split(',').map((origin) => origin.trim())
      : databaseUrl
        ? ['http://localhost:5173']
        : [LOCAL_ORIGIN],
    setupCode: source.SETUP_CODE || undefined,
  }
}
