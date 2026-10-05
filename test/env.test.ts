import { describe, expect, it } from 'vitest'
import { LOCAL_ORIGIN, readEnv } from '../src/env'

describe('địa chỉ giao diện được phép gọi API', () => {
  it('chạy trên máy: nhận chính máy này và các máy trong mạng nội bộ, cổng nào cũng được', () => {
    expect(readEnv({}).corsOrigins).toEqual([LOCAL_ORIGIN])
    for (const origin of [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5173',
      'http://192.168.1.20:5173',
      'http://10.0.0.7:5173',
      'http://172.16.4.2:5173',
      'http://172.31.255.1',
    ]) {
      expect(LOCAL_ORIGIN.test(origin), origin).toBe(true)
    }
  })

  it('không nhận địa chỉ ngoài mạng nội bộ hay địa chỉ giả dạng', () => {
    for (const origin of [
      'https://vi-du.com',
      'http://8.8.8.8:5173',
      'http://172.32.0.1:5173',
      'http://192.168.1.20.vi-du.com',
      'http://localhost.vi-du.com',
      'http://vi-du.com/http://localhost:5173',
    ]) {
      expect(LOCAL_ORIGIN.test(origin), origin).toBe(false)
    }
  })

  it('khi triển khai chỉ nhận đúng các địa chỉ đã khai trong CORS_ORIGIN', () => {
    const env = readEnv({
      DATABASE_URL: 'postgres://vi-du',
      PIN_SECRET: 'x'.repeat(32),
      CORS_ORIGIN: 'https://a.pages.dev, https://b.pages.dev',
    })
    expect(env.corsOrigins).toEqual(['https://a.pages.dev', 'https://b.pages.dev'])
  })

  it('có cơ sở dữ liệu thật mà quên CORS_ORIGIN thì không mở cho mạng nội bộ', () => {
    const env = readEnv({ DATABASE_URL: 'postgres://vi-du', PIN_SECRET: 'x'.repeat(32) })
    expect(env.corsOrigins).toEqual(['http://localhost:5173'])
  })
})
