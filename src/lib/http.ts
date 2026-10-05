import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { z } from 'zod'

// Lỗi có mã HTTP và câu báo tiếng Việt để giao diện hiện thẳng cho người dùng.
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export function fail(status: number, message: string): never {
  throw new HttpError(status, message)
}

// Tìm thấy thì trả về, không thì báo 404.
export function found<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) fail(404, `Không tìm thấy ${what}.`)
  return value as T
}

// Một tham số trên đường dẫn, ví dụ :id. Express khai báo kiểu có thể là mảng (cho đường
// dẫn dạng ký tự đại diện), ở đây luôn là một chuỗi.
export function param(req: Request, name: string): string {
  const value = req.params[name]
  return Array.isArray(value) ? value[0] : value
}

export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input)
  if (!result.success) {
    const issue = result.error.issues[0]
    fail(400, `Dữ liệu gửi lên không hợp lệ (${issue.path.join('.') || 'thân yêu cầu'}).`)
  }
  return result.data as z.infer<T>
}

// Bọc một hàm xử lý: giá trị trả về thành JSON, không trả gì thành { ok: true }.
export function handle(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return async (req, res) => {
    const body = await fn(req, res)
    if (!res.headersSent) res.json(body ?? { ok: true })
  }
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message })
    return
  }
  // Thân yêu cầu quá lớn hoặc không đọc được, do express báo.
  const status = (error as { status?: number }).status
  if (status === 413) {
    res.status(413).json({ error: 'Dữ liệu gửi lên quá lớn.' })
    return
  }
  if (status === 400) {
    res.status(400).json({ error: 'Không đọc được dữ liệu gửi lên.' })
    return
  }
  console.error(error)
  res.status(500).json({ error: 'Máy chủ gặp lỗi. Thử lại sau.' })
}

// Các kiểu dữ liệu vào dùng ở nhiều nơi.
export const money = z.number().int().min(0).max(1_000_000_000)
export const text = (max = 200) => z.string().trim().max(max)
export const requiredText = (max = 200) => z.string().trim().min(1).max(max)
