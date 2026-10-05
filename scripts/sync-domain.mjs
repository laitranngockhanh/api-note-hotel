// Chép phần tính toán dùng chung từ ../Fe sang src/domain. Nguồn duy nhất là FE: muốn đổi
// quy tắc thì sửa ở FE, chạy kiểm thử ở FE, rồi chạy lệnh này.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fe = join(root, '..', 'Fe', 'src')
const target = join(root, 'src', 'domain')

const files = [
  ['types.ts', 'types.ts'],
  ['lib/format.ts', 'format.ts'],
  ['lib/labels.ts', 'labels.ts'],
  ['lib/pricing.ts', 'pricing.ts'],
  ['lib/bill.ts', 'bill.ts'],
  ['lib/booking.ts', 'booking.ts'],
  ['lib/report.ts', 'report.ts'],
  ['lib/pricing.test.ts', 'pricing.test.ts'],
  ['lib/bill.test.ts', 'bill.test.ts'],
  ['lib/booking.test.ts', 'booking.test.ts'],
]

const banner = '// Chép từ ../Fe bằng `npm run sync:domain`. Không sửa ở đây; sửa ở FE rồi chép lại.\n'

await mkdir(target, { recursive: true })
for (const [from, to] of files) {
  const source = await readFile(join(fe, from), 'utf8')
  // Ở FE, types.ts nằm trên thư mục lib một cấp; ở đây mọi file nằm chung một thư mục.
  await writeFile(join(target, to), banner + source.replaceAll("'../types'", "'./types'"))
  console.log(`${from} -> src/domain/${to}`)
}
