import { PGlite } from '@electric-sql/pglite'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import * as schema from './schema'

// Kiểu chung cho cả hai cách kết nối, để phần còn lại không cần biết đang chạy trên gì.
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>
// Trong một giao dịch thì dùng được mọi lệnh như trên Database.
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

export interface Connection {
  db: Database
  close: () => Promise<void>
}

const migrationsFolder = resolve('migrations')

// PostgreSQL thật khi có chuỗi kết nối (Supabase). prepare: false vì cổng pooler của
// Supabase không hỗ trợ câu lệnh chuẩn bị sẵn.
async function connectPostgres(url: string): Promise<Connection> {
  const client = postgres(url, { prepare: false })
  const db = drizzlePostgres(client, { schema })
  await migratePostgres(db, { migrationsFolder })
  return { db: db as unknown as Database, close: () => client.end() }
}

// PGlite là PostgreSQL nhúng: dùng khi chạy trên máy (lưu vào thư mục) và khi kiểm thử
// (không truyền thư mục thì nằm trong bộ nhớ).
async function connectPglite(dataDir?: string): Promise<Connection> {
  const client = new PGlite(dataDir)
  const db = drizzlePglite(client, { schema })
  await migratePglite(db, { migrationsFolder })
  return { db: db as unknown as Database, close: () => client.close() }
}

export function connect(databaseUrl: string | undefined, dataDir = 'data/pglite'): Promise<Connection> {
  if (databaseUrl) return connectPostgres(databaseUrl)
  // PGlite không tự tạo thư mục cha, nên tạo sẵn cho lần chạy đầu tiên.
  const dir = resolve(dataDir)
  mkdirSync(dir, { recursive: true })
  return connectPglite(dir)
}

export function connectInMemory(): Promise<Connection> {
  return connectPglite()
}
