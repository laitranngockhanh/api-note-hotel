import cors from 'cors'
import { sql } from 'drizzle-orm'
import express, { type Express } from 'express'
import { authenticate, authRouter, requireOwner, sessionRouter } from './auth'
import type { Context } from './context'
import { errorHandler, fail, handle } from './lib/http'
import { adminRouter } from './routes/admin'
import { shiftsRouter } from './routes/shifts'
import { stateRouter } from './routes/state'
import { staysRouter } from './routes/stays'

export function createApp(context: Context, corsOrigins: (string | RegExp)[]): Express {
  const app = express()
  // Render đứng trước máy chủ như một proxy; cần dòng này để lấy đúng địa chỉ IP của máy
  // khách cho bộ đếm nhập sai PIN.
  app.set('trust proxy', 1)
  app.use(cors({ origin: corsOrigins }))
  app.use(express.json({ limit: '100kb' }))

  const api = express.Router()
  // Dùng cho dịch vụ theo dõi uptime. Hỏi cả cơ sở dữ liệu, để "còn sống" nghĩa là dùng được
  // thật, và để mỗi lần ping cũng tính là một lần truy cập giữ Supabase khỏi tạm dừng.
  api.get(
    '/health',
    handle(async () => {
      await context.db.execute(sql`select 1`)
      return { ok: true }
    }),
  )
  // Hai việc làm được khi chưa đăng nhập: xem tên cơ sở để chọn, và đăng nhập.
  api.use(authRouter(context))

  api.use(authenticate(context))
  api.use(sessionRouter(context))
  api.use(stateRouter(context))
  api.use(staysRouter(context))
  api.use(shiftsRouter(context))
  // Từ đây trở xuống chỉ chủ mới vào được.
  api.use(requireOwner, adminRouter(context))

  app.use('/api', api)
  app.use(() => fail(404, 'Không có đường dẫn này.'))
  app.use(errorHandler)
  return app
}
