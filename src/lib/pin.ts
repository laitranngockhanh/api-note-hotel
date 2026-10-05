import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'

// Mã PIN được lưu ở hai dạng:
// - pinCipher: mã hóa AES-256-GCM, giải mã lại được vì chủ cần xem PIN của nhân viên.
// - pinLookup: HMAC của PIN, dùng để tìm tài khoản lúc đăng nhập và chặn trùng PIN.
// Cả hai đều cần khóa bí mật PIN_SECRET; không có khóa thì bản lưu trong cơ sở dữ liệu vô dụng.

export const PIN_LENGTH = 4

export const isValidPin = (pin: string) => new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)

export interface PinCodec {
  encrypt: (pin: string) => string
  decrypt: (cipher: string) => string
  lookup: (pin: string) => string
}

export function createPinCodec(secret: string): PinCodec {
  const key = createHash('sha256').update(secret).digest()
  return {
    encrypt(pin) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(pin, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
    },
    decrypt(stored) {
      const raw = Buffer.from(stored, 'base64')
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
      decipher.setAuthTag(raw.subarray(12, 28))
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
    },
    lookup(pin) {
      return createHmac('sha256', key).update(pin).digest('hex')
    },
  }
}

// Mã phiên: gửi cho máy khách bản gốc, chỉ lưu bản băm.
export const newToken = () => randomBytes(32).toString('hex')
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
