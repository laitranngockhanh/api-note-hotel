import type { Response } from 'express'
import type { Database } from './db/client'
import type { Role } from './domain/types'
import type { PinCodec } from './lib/pin'

// Những thứ mọi nhóm route đều cần.
export interface Context {
  db: Database
  pins: PinCodec
  // Cho phép kiểm thử điều khiển thời gian.
  now: () => Date
  // Mã phải nhập ở bước cài đặt lần đầu; không đặt thì không hỏi.
  setupCode?: string
}

export interface AuthUser {
  id: string
  name: string
  role: Role
}

// Người đang đăng nhập, do bước xác thực gắn vào.
export const userOf = (res: Response) => res.locals.user as AuthUser
