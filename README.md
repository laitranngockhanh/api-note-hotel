# BE quản lý nhà nghỉ

API cho ứng dụng quản lý nhà nghỉ nhỏ, nơi chủ thường kiêm lễ tân. Giao diện nằm ở thư mục `../Fe`; tài liệu này mô tả phần máy chủ: nó làm gì, dữ liệu lưu thế nào, quy tắc nghiệp vụ nào đã chốt, và cách chạy.

## Mục lục

1. [Tổng quan](#tổng-quan)
2. [Công nghệ](#công-nghệ)
3. [Chạy trên máy](#chạy-trên-máy)
4. [Cấu trúc thư mục](#cấu-trúc-thư-mục)
5. [Mô hình dữ liệu](#mô-hình-dữ-liệu)
6. [Quy tắc nghiệp vụ](#quy-tắc-nghiệp-vụ)
7. [Đăng nhập và phân quyền](#đăng-nhập-và-phân-quyền)
8. [API](#api)
9. [Triển khai](#triển-khai)
10. [Sao lưu](#sao-lưu)
11. [Tình trạng](#tình-trạng)

## Tổng quan

Một chủ có thể có nhiều cơ sở (nhà nghỉ). Mỗi cơ sở có sơ đồ phòng, bảng giá, dịch vụ, quy tắc tính tiền, ca trực và báo cáo riêng. Tài khoản và mã PIN thì dùng chung cho mọi cơ sở.

Luồng chính mà API phục vụ:

```text
Chọn cơ sở (một lần cho mỗi máy) → nhập PIN (mỗi ca)
  → nhận phòng / đặt trước → thêm dịch vụ, phụ thu, giảm giá, thu trước
  → thanh toán và trả phòng → kết thúc ca (đối soát tiền mặt) → báo cáo
```

Tiền được ghi nhận theo kiểu tin tưởng: người trực bấm "đã thu" là hệ thống ghi nhận, không có bước xác nhận từ ngân hàng. Khi có nhầm lẫn thì ghi chú lại chứ không sửa số liệu cũ.

## Công nghệ

| Phần | Chọn | Lý do |
|---|---|---|
| Máy chủ | Node.js + Express + TypeScript | Chạy được trên gói miễn phí của Render |
| Cơ sở dữ liệu | PostgreSQL | Supabase khi triển khai; PGlite (PostgreSQL nhúng) khi chạy trên máy và khi kiểm thử, không phải cài gì |
| Truy vấn | Drizzle ORM | Khai báo bảng bằng TypeScript, tự sinh migration |
| Kiểm tra dữ liệu vào | Zod | |
| Kiểm thử | Vitest + Supertest | Gọi API thật trên một cơ sở dữ liệu trong bộ nhớ |

## Chạy trên máy

Cần Node.js 22 trở lên. Không cần cài PostgreSQL hay Docker.

```bash
npm install
```

```bash
npm run dev
```

Máy chủ chạy ở `http://localhost:3000`. Khi không có `DATABASE_URL`, dữ liệu nằm trong thư mục `data/` (PGlite).

Hệ thống bắt đầu trống, không có dữ liệu mẫu. Lần đầu mở giao diện sẽ hiện màn hình **Cài đặt lần đầu** để chủ sở hữu tự đặt tên, mã PIN và nhà nghỉ đầu tiên (xem [Cài đặt lần đầu](#cài-đặt-lần-đầu)). Muốn làm lại từ đầu trên máy thì tắt máy chủ rồi xóa thư mục `data/`.

Các lệnh khác:

| Lệnh | Việc |
|---|---|
| `npm run dev:try` | Chạy **bản thử**: cổng 3100, dữ liệu riêng trong `data/try`, không đụng dữ liệu thật |
| `npm test` | Chạy toàn bộ kiểm thử (PGlite trong bộ nhớ) |
| `npm run test:pg` | Chạy kiểm thử trên một PostgreSQL thật (xem bên dưới) |
| `npm run typecheck` | Kiểm tra kiểu |
| `npm run build` | Đóng gói ra `dist/` |
| `npm start` | Chạy bản đã đóng gói |
| `npm run db:generate` | Sinh migration sau khi sửa `src/db/schema.ts` |
| `npm run sync:domain` | Chép lại phần tính tiền dùng chung từ `../Fe` |

Biến môi trường (xem `.env.example`):

| Biến | Bắt buộc | Ý nghĩa |
|---|---|---|
| `DATABASE_URL` | Khi triển khai | Chuỗi kết nối PostgreSQL. Bỏ trống thì dùng PGlite |
| `PIN_SECRET` | Khi triển khai | Khóa bí mật để mã hóa mã PIN, ít nhất 32 ký tự |
| `CORS_ORIGIN` | Khi triển khai | Địa chỉ của giao diện, ví dụ `https://ten-app.pages.dev` |
| `SETUP_CODE` | Nên đặt khi triển khai | Mã phải nhập ở bước cài đặt lần đầu. Bỏ trống thì không hỏi mã |
| `DATA_DIR` | Không | Thư mục dữ liệu PGlite khi không có `DATABASE_URL`. Mặc định `data/pglite` |
| `PORT` | Không | Mặc định 3000 |
| `TZ` | Không | Mặc định `Asia/Ho_Chi_Minh`. Mọi phép tính ngày giờ dựa vào múi giờ này |

### Bản thử

Dữ liệu trong `data/pglite` là sổ sách thật. Muốn bấm thử một tính năng mà không làm bẩn sổ thì chạy bản thử: `npm run dev:try` ở đây và `npm run dev:try` ở `../Fe`, rồi mở `http://localhost:5174`. Bản thử có chủ, PIN, phòng riêng (tạo ở màn Cài đặt lần đầu của nó) và chạy song song với bản thật được. Xóa thư mục `data/try` là bản thử trống lại.

### Mở từ điện thoại trong cùng mạng wifi

Khi chạy trên máy (không có `DATABASE_URL`, không đặt `CORS_ORIGIN`), máy chủ nhận giao diện mở từ chính máy này và từ các máy trong mạng nội bộ. Để thử trên điện thoại thật: ở `../Fe` chạy `npm run dev:lan` thay cho `npm run dev`, rồi trên điện thoại mở `http://<địa chỉ IP của máy tính>:5173` (lệnh `dev:lan` in ra địa chỉ này ở dòng Network). Lần đầu Windows có thể hỏi cho phép Node.js nhận kết nối trong mạng riêng; phải đồng ý thì điện thoại mới vào được. Khi triển khai (có `DATABASE_URL`) thì chỉ các địa chỉ khai trong `CORS_ORIGIN` mới gọi được API.

### Kiểm thử trên PostgreSQL thật

`npm test` dùng PGlite. Khi triển khai, máy chủ nói chuyện với PostgreSQL qua một thư viện khác, nên trước khi triển khai nên chạy cùng bộ kiểm thử đó trên một PostgreSQL thật, dựng tạm bằng Docker:

```bash
docker run --rm -d --name hotel-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=hotel_test -p 55432:5432 postgres:17
```

```bash
npm run test:pg
```

```bash
docker stop hotel-pg
```

Kiểm thử xóa sạch mọi bảng, nên nó chỉ chịu chạy trên cơ sở dữ liệu có tên kết thúc bằng `_test`. Đừng sửa `.env.pgtest` thành chuỗi kết nối của Supabase.

## Cấu trúc thư mục

```text
src/
  index.ts          Khởi động máy chủ
  app.ts            Lắp ráp Express: CORS, đăng nhập, các nhóm route, xử lý lỗi
  env.ts            Đọc biến môi trường
  db/
    schema.ts       Khai báo bảng
    client.ts       Kết nối PostgreSQL hoặc PGlite, chạy migration
  domain/           Phần tính tiền, chép nguyên từ ../Fe/src/lib (không sửa tay ở đây)
  lib/              Mã hóa PIN, tiện ích HTTP
  auth.ts           Cài đặt lần đầu, đăng nhập bằng PIN, phiên, chặn đoán PIN, kiểm tra quyền
  repo.ts           Đọc dữ liệu từ bảng thành đối tượng nghiệp vụ
  routes/           Mỗi file một nhóm API
migrations/         SQL do Drizzle sinh ra
scripts/            sync-domain: chép phần tính tiền từ FE
test/               Kiểm thử API
```

### Phần tính tiền dùng chung

Hàm tính tiền phòng, hóa đơn, kiểm tra trùng lịch và báo cáo được viết một lần ở `../Fe/src/lib` và chép sang `src/domain` bằng `npm run sync:domain`. Giao diện dùng chúng để hiện số tạm tính; máy chủ dùng chính các hàm đó để chốt tiền lúc trả phòng và làm báo cáo, nên hai bên không thể lệch nhau. Muốn đổi quy tắc tính tiền thì sửa ở FE, chạy kiểm thử ở FE, rồi chạy `sync:domain`.

## Mô hình dữ liệu

| Bảng | Nội dung | Ghi chú |
|---|---|---|
| `users` | Tài khoản | Dùng chung mọi cơ sở. Vai trò `owner` hoặc `staff`. Người nghỉ việc thì `active = false`, không xóa |
| `sessions` | Phiên đăng nhập | Chỉ lưu bản băm của mã phiên |
| `pin_guards` | Bộ đếm nhập sai PIN | Theo địa chỉ IP |
| `properties` | Cơ sở | Kèm quy tắc tính tiền, tài khoản ngân hàng, quyền của người trực |
| `room_types` | Loại phòng và bảng giá | Thuộc một cơ sở |
| `rooms` | Phòng | Vị trí trên sơ đồ: tầng, hàng, cột. Tình trạng: sẵn sàng, chờ dọn, bảo trì |
| `services` | Danh mục dịch vụ | Thuộc một cơ sở |
| `shifts` | Ca trực | Mỗi cơ sở tối đa một ca mở |
| `stays` | Lượt thuê, gồm cả đặt trước | Trạng thái: đặt trước, đang ở, đã trả, đã hủy |
| `stay_items` | Dịch vụ, phụ thu, giảm giá của lượt thuê | |
| `stay_notes` | Ghi chú của lượt thuê | Chỉ thêm, không sửa, không xóa |
| `stay_photos` | Ảnh giấy tờ của khách | Lưu ngay trong cơ sở dữ liệu; xóa khi trả phòng hoặc hủy đặt |
| `payments` | Khoản thu | Số âm là hoàn tiền |
| `expenses` | Khoản chi | Thuộc một cơ sở |

Quan hệ: một cơ sở có nhiều loại phòng, phòng, dịch vụ, ca và khoản chi. Một phòng có nhiều lượt thuê. Một lượt thuê có nhiều dòng hóa đơn, ghi chú, ảnh và khoản thu. Mỗi khoản thu và mỗi dòng hóa đơn gắn với ca đã ghi nó.

Các quy ước:

- **Tiền là số nguyên đồng.**
- **"Đang thuê" không lưu ở phòng.** Phòng đang thuê là phòng có lượt thuê ở trạng thái đang ở.
- **Giá được chép vào lượt thuê lúc nhận phòng.** Đổi bảng giá sau đó không làm sai hóa đơn cũ. Số người tiêu chuẩn và mức phụ thu thêm người cũng được chép theo cách này.
- **Số còn phải thu không lưu thành cột.** Luôn tính: tổng hóa đơn trừ tổng khoản thu.
- **Không lưu số giấy tờ của khách.** Việc đăng ký lưu trú làm ở ứng dụng của công an; ở đây chỉ giữ ảnh tạm trong lúc khách ở.

## Quy tắc nghiệp vụ

### Hóa đơn

```text
Tổng = tiền phòng (gồm phụ thu trả muộn) + phụ thu thêm người + dịch vụ và phụ thu − giảm giá
Còn phải thu = Tổng − các khoản đã thu
```

### Năm kiểu thuê

| Kiểu | Cách tính |
|---|---|
| Theo giờ | Giờ đầu + số giờ tiếp theo × giá mỗi giờ tiếp. Không vượt quá số tiền nếu thuê theo ngày từ cùng giờ vào |
| Qua đêm | Một giá. Chỉ nhận trong khung giờ qua đêm của cơ sở |
| Theo ngày | Số ngày × giá ngày. Một ngày kết thúc ở mốc trả phòng, không phải sau 24 tiếng |
| Theo tuần | Số tuần × giá tuần; ở lố thì ngày lẻ tính giá ngày |
| Theo tháng | Số tháng × giá tháng; ở lố thì ngày lẻ tính giá ngày |

### Trả muộn (thuê ngày và qua đêm)

Sau mốc trả phòng, phụ thu tính theo phần trăm giá ngày. Mặc định:

| Trả phòng | Phụ thu |
|---|---|
| Trước 12:00 | Không |
| Đến 15:00 | 30% giá ngày |
| Đến 18:00 | 50% giá ngày |
| Sau 18:00 | Thêm trọn một ngày; mốc trả phòng dời sang 12:00 hôm sau và xét lại từ đầu |

Có ân hạn (mặc định 10 phút) cho cả việc làm tròn giờ lẫn trả muộn.

### Các quy tắc khác

- **Thêm người:** mỗi người vượt số tiêu chuẩn của loại phòng phụ thu một lần cho cả lượt.
- **Giảm giá:** một dòng trừ trong hóa đơn, kèm lý do.
- **Đổi kiểu thuê:** tiền tính lại từ giờ vào theo kiểu mới.
- **Đổi phòng:** giữ nguyên giờ vào, giá và hóa đơn; phòng cũ chuyển sang chờ dọn; tự thêm ghi chú.
- **Đặt trước:** là một lượt thuê ở trạng thái đặt trước; tiền cọc là một khoản thu. Khách đến thì giờ vào tính từ lúc đó. Hủy thì chọn giữ cọc hoặc hoàn cọc (ghi một khoản âm).
- **Trùng lịch:** máy chủ không chặn; giao diện cảnh báo và người trực quyết định.
- **Ảnh giấy tờ:** tối đa 6 ảnh mỗi lượt, mỗi ảnh tối đa 1 MB, xóa khi trả phòng hoặc hủy đặt.

Mọi con số (giá, phần trăm, mốc giờ, ân hạn) là cài đặt của từng cơ sở, không viết cứng trong code.

### Ca và ngày

- Mỗi cơ sở có tối đa một ca mở. Mọi khoản thu và dòng hóa đơn ghi vào ca đang mở.
- Người trực nhập PIN là ca tự mở. Chủ vào xem thì không mở ca; ca của chủ tự mở ở thao tác đầu tiên có ghi sổ.
- Mỗi ca thuộc về ngày mà nó bắt đầu. Khoản thu lúc 2 giờ sáng của ca tối vẫn tính cho ngày hôm trước. Báo cáo ngày, tháng, năm đều gom theo ngày của ca.
- Kết thúc ca: người trực xác nhận tiền mặt khớp hoặc nhập số lệch, kèm ghi chú.
- Khoản thu chỉ bỏ được khi ca ghi nó còn mở. Sau đó thì ghi chú.

## Một đồng hồ cho việc tính tiền

Thời gian thuê quyết định tiền phòng, nên chỉ có **một** đồng hồ: của máy chủ, theo giờ Việt Nam.

- Giờ nhận phòng, giờ trả phòng, giờ thu tiền và tiền phòng chốt lúc trả đều do máy chủ ghi theo giờ của nó.
- Mỗi lần trả dữ liệu cho màn hình chính, máy chủ gửi kèm giờ hiện tại. Giao diện tính độ lệch so với đồng hồ của máy đang mở và dùng giờ đã chỉnh cho thời gian đã ở, tiền tạm tính, quá hạn, trễ hẹn. Máy ở quầy chạy nhanh hay chậm vài phút thì số trên màn hình vẫn đúng.
- Lúc trả phòng, giao diện gửi số tiền người trực đang thấy. Máy chủ tự tính lại; hai số khác nhau (vừa sang mốc giờ mới, hoặc máy khác vừa thêm dịch vụ hay thu trước) thì từ chối và báo số mới. Tiền thu của khách vì thế luôn bằng tiền ghi sổ.
- Múi giờ của máy đang mở khác giờ Việt Nam thì giao diện hiện cảnh báo, vì giờ hiển thị và các mốc trong ngày (12:00 trả phòng, khung qua đêm) khi đó bị lệch.

## Đăng nhập và phân quyền

Mã PIN 4 chữ số là thứ duy nhất dùng để đăng nhập và để biết ai đang trực. Vì vậy:

- **PIN không trùng nhau** giữa các tài khoản.
- **Chặn đoán PIN ở máy chủ:** sai 5 lần liên tiếp từ một địa chỉ IP thì khóa 60 giây.
- **PIN lưu ở dạng mã hóa đọc lại được** (AES-256-GCM với `PIN_SECRET`), vì chủ cần xem PIN của nhân viên khi họ quên. Việc tìm tài khoản theo PIN dùng một cột HMAC riêng. Ai có cả cơ sở dữ liệu lẫn `PIN_SECRET` thì đọc được mọi PIN.
- **Phiên đăng nhập** là một mã ngẫu nhiên gửi qua header `Authorization: Bearer …`; máy chủ chỉ lưu bản băm. Phiên hết hạn sau 30 ngày kể từ lúc nhập PIN.

| Việc | Người trực | Chủ |
|---|---|---|
| Nhận phòng, đặt trước, dịch vụ, phụ thu, thu tiền, trả phòng, ghi chú, ảnh | Có, ở cơ sở được phân công | Có |
| Sửa giá lúc nhận phòng, giảm giá | Nếu cơ sở cho phép | Có |
| Đổi tình trạng phòng, đổi phòng, kết thúc ca | Có | Có |
| Báo cáo, khoản chi | Không | Có |
| Sơ đồ phòng, loại phòng, giá, dịch vụ, quy tắc, ngân hàng | Không | Có |
| Nhân viên, mã PIN, cơ sở | Không | Có |

Mỗi cơ sở tự chọn "mọi người trực" hay "chỉ những người được chọn". Luôn phải còn ít nhất một chủ đang hoạt động.

### Cài đặt lần đầu

Hệ thống mới không có tài khoản nào, nên chưa ai đăng nhập được. Khi đó `POST /setup` cho phép tạo **chủ sở hữu đầu tiên** với mã PIN tự chọn, cùng nhà nghỉ đầu tiên (chưa có phòng, loại phòng hay dịch vụ), và trả về luôn một phiên đăng nhập.

- Chỉ chạy được khi bảng tài khoản còn trống. Đã có một tài khoản thì trả 409, vĩnh viễn; hai máy bấm cùng lúc thì chỉ một máy thành chủ.
- Địa chỉ trang là công khai, nên **ai mở trang trước thì người đó thành chủ**. Khi triển khai lên mạng nên đặt `SETUP_CODE`: bước cài đặt sẽ hỏi mã này, sai thì trả 403. Trên máy cá nhân không cần đặt.
- Các chủ và người trực khác được thêm sau trong Quản lý, mục Nhân viên.

## API

Mọi đường dẫn bắt đầu bằng `/api`. Trừ bốn dòng đầu, tất cả cần header `Authorization`. Lỗi trả về dạng `{ "error": "câu báo lỗi tiếng Việt" }`.

### Đăng nhập

| Phương thức | Đường dẫn | Việc |
|---|---|---|
| GET | `/setup` | Hệ thống đã có chủ chưa (`needsSetup`), và có phải nhập mã cài đặt không (`codeRequired`) |
| POST | `/setup` | Cài đặt lần đầu: tạo chủ sở hữu, mã PIN và nhà nghỉ đầu tiên |
| GET | `/properties/public` | Tên các cơ sở đang hoạt động, để chọn cơ sở trước khi nhập PIN |
| POST | `/login` | Đăng nhập bằng PIN vào một cơ sở |
| POST | `/logout` | Kết thúc phiên |
| GET | `/me` | Tài khoản của phiên hiện tại |

### Trạng thái

| Phương thức | Đường dẫn | Việc |
|---|---|---|
| GET | `/state?propertyId=` | Mọi thứ màn hình chính cần: cơ sở, phòng, loại phòng, dịch vụ, lượt đang ở và đặt trước, ca đang mở, cùng mọi khoản thu và lượt thuê của ca đang mở. Kèm giờ của máy chủ (`now`, `utcOffsetMinutes`) để giao diện chỉnh đồng hồ theo |
| GET | `/stays?propertyId=&status=&q=` | Danh sách lượt thuê theo trạng thái, tìm theo tên, số điện thoại, số phòng; kèm khoản thu và tên người thu |
| GET | `/reports?propertyId=&mode=&date=` | Báo cáo ngày, tháng, năm. Bỏ `propertyId` để gộp mọi cơ sở |

### Lượt thuê

| Phương thức | Đường dẫn | Việc |
|---|---|---|
| POST | `/stays/check-in` | Nhận phòng |
| POST | `/stays/book` | Đặt trước, kèm tiền cọc nếu có |
| POST | `/stays/:id/arrive` | Khách đặt trước đến |
| POST | `/stays/:id/cancel` | Hủy đặt, giữ hoặc hoàn cọc |
| POST | `/stays/:id/check-out` | Chốt tiền, thu phần còn lại, trả phòng. Gửi kèm `expectedDue` (số tiền đang hiện trên màn hình): khác số máy chủ tự tính thì trả 409 kèm số mới, chưa ghi gì |
| PATCH | `/stays/:id` | Sửa khách, số người, kiểu thuê, giờ hẹn |
| POST | `/stays/:id/extend` | Gia hạn thêm một kỳ |
| POST | `/stays/:id/move` | Đổi phòng |
| POST | `/stays/:id/items` | Thêm dịch vụ, phụ thu, giảm giá |
| DELETE | `/stays/:id/items/:itemId` | Bỏ một dòng |
| POST | `/stays/:id/payments` | Thu trước |
| DELETE | `/payments/:id` | Bỏ khoản thu, chỉ khi ca ghi nó còn mở |
| POST | `/stays/:id/notes` | Thêm ghi chú |
| POST | `/stays/:id/photos` | Tải ảnh giấy tờ (thân yêu cầu là ảnh) |
| GET | `/photos/:id` | Xem ảnh |
| DELETE | `/stays/:id/photos/:photoId` | Bỏ ảnh |

### Ca và phòng

| Phương thức | Đường dẫn | Việc |
|---|---|---|
| POST | `/shifts/start` | Mở ca |
| POST | `/shifts/:id/close` | Kết thúc ca, khớp hoặc lệch |
| POST | `/shifts/:id/notes` | Thêm ghi chú cho ca (chủ) |
| POST | `/rooms/:id/condition` | Đổi tình trạng phòng |

### Quản lý (chỉ chủ)

| Phương thức | Đường dẫn | Việc |
|---|---|---|
| POST, PATCH, DELETE | `/rooms`, `/rooms/:id` | Sơ đồ phòng |
| POST, PUT, DELETE | `/room-types`, `/room-types/:id` | Loại phòng và giá |
| POST, PUT, DELETE | `/services`, `/services/:id` | Dịch vụ |
| GET, POST, PATCH, DELETE | `/properties`, `/properties/:id` | Cơ sở, quy tắc, ngân hàng, quyền người trực |
| GET, POST, PATCH, DELETE | `/users`, `/users/:id` | Nhân viên |
| GET | `/users/:id/pin` | Xem mã PIN của một người |
| POST, DELETE | `/expenses`, `/expenses/:id` | Khoản chi |

## Triển khai

Phương án đã chọn, miễn phí và không cần thẻ:

| Phần | Nơi chạy |
|---|---|
| Giao diện | Cloudflare Pages |
| API | Render (Web Service, gói miễn phí) |
| Cơ sở dữ liệu | Supabase (PostgreSQL) |

Các bước:

1. Đưa mã nguồn lên GitHub, repo để **riêng tư** (thư mục `Be` và `Fe` chung một repo hoặc hai repo đều được).
2. Tạo dự án Supabase ở khu vực Singapore. Lấy chuỗi kết nối loại **pooler**; kết nối trực tiếp chỉ có IPv6 nên Render không dùng được.
3. Trên Render chọn New > Blueprint và trỏ tới repo: file `render.yaml` đã khai sẵn lệnh build, lệnh chạy, khu vực Singapore và các biến môi trường. (Tạo Web Service bằng tay cũng được: lệnh build `npm install --include=dev && npm run build`, lệnh chạy `npm start`.)
4. Render tự sinh `PIN_SECRET` và `SETUP_CODE`. Nhập tay `DATABASE_URL` (chuỗi pooler ở bước 2) và `CORS_ORIGIN` (địa chỉ giao diện ở bước 5).
5. Trên Cloudflare Pages tạo dự án từ repo, thư mục gốc `Fe`, lệnh build `npm run build`, thư mục kết quả `dist`, và biến `VITE_API_URL` là địa chỉ API trên Render kèm `/api`, ví dụ `https://hotel-api.onrender.com/api`.
6. Lần khởi động đầu tiên máy chủ tự tạo bảng. Mở giao diện, ở màn hình Cài đặt lần đầu nhập tên, mã PIN muốn dùng, tên nhà nghỉ và giá trị `SETUP_CODE` xem trên trang Render. Xong bước này có thể xóa biến `SETUP_CODE`.

Điều cần biết:

- Gói miễn phí của Render tự ngủ sau 15 phút không có truy cập; lượt mở đầu tiên chờ 30–60 giây. Có thể dùng một dịch vụ theo dõi uptime miễn phí gọi `GET /api/health` 5 phút một lần: không cần đăng nhập, trả `{"ok":true}` với mã 200 khi cả máy chủ lẫn cơ sở dữ liệu đều dùng được, mã khác 200 khi có sự cố. Vì mỗi lần gọi có hỏi cơ sở dữ liệu, việc ping này cũng giữ cho Supabase không bị tạm dừng.
- Supabase gói miễn phí tạm dừng dự án nếu một tuần không có truy cập.

## Sao lưu

Supabase gói miễn phí không tự sao lưu. File `.github/workflows/backup.yml` chạy `pg_dump` mỗi đêm lúc 02:00 giờ Việt Nam và lưu file thành artifact của GitHub Actions, giữ 90 ngày. Repo phải để riêng tư.

- Đặt secret `BACKUP_DATABASE_URL` trong repo, là chuỗi kết nối loại **session pooler** (cổng 5432); `pg_dump` không chạy được qua transaction pooler.
- Nội dung bảng `stay_photos` không được xuất, để ảnh giấy tờ của khách không nằm trong bản sao lưu.
- Mỗi tháng nên tải một bản về máy để giữ lâu hơn 90 ngày.
- Thử khôi phục một lần sau khi cài, vì sao lưu chưa thử khôi phục thì chưa chắc dùng được.

## Tình trạng

Đã có và đã kiểm thử:

- Toàn bộ API trong tài liệu này, chạy được trên máy với PGlite.
- 128 kiểm thử: 75 kiểm thử gọi API thật (cài đặt lần đầu, đăng nhập, hết hạn phiên và chặn đoán PIN, luồng nhận và trả phòng, đặt trước, đổi phòng, ảnh, ghi chú, ca, phân quyền, quản lý, báo cáo) 4 kiểm thử về địa chỉ giao diện được phép gọi API, và 49 kiểm thử của phần tính tiền chép từ FE.
- Bản đóng gói (`npm run build` rồi `npm start`) khởi động và trả lời được.
- Giao diện ở `../Fe` đã nối với API này; cả hai bên không còn dữ liệu mẫu. Đã thử qua giao diện, trên bản thử: cài đặt lần đầu, đăng nhập, sai PIN, sửa giá và dịch vụ, sửa sơ đồ (thêm, trùng số, chuyển chỗ), thêm nhân viên (trùng PIN), thêm và đổi tên cơ sở, phân công người trực, cấm người trực sửa giá, đặt trước có cọc và ảnh, cảnh báo trùng lịch, nhận phòng có ảnh, dịch vụ, phụ thu, giảm giá, thu trước, ghi chú, sửa khách, đổi phòng, trả phòng, dọn phòng, đổi giờ đặt, chuyển phòng của lượt đặt, khách đến, hủy đặt và hoàn cọc, danh sách lượt thuê, kết thúc ca có lệch, khoản chi, báo cáo ngày, tháng, năm, xuất Excel, sửa khách và thêm ảnh cho lượt đặt trước. Đã rà mọi màn hình ở bề ngang điện thoại (375px): không màn nào tràn ngang.

Chưa làm hoặc chưa kiểm chứng:

- **Chưa chạy trên PostgreSQL thật.** Lệnh `npm run test:pg` đã sẵn nhưng chưa chạy lần nào (cần Docker đang bật). Đường kết nối tới Supabase vì thế vẫn chưa được kiểm chứng.
- **Chưa triển khai** lên Render, Supabase, Cloudflare Pages. File `render.yaml` chưa được Render đọc thử.
- **Workflow sao lưu chưa chạy thử.**
- Phiên đăng nhập hết hạn sau 30 ngày kể từ lúc nhập PIN, không gia hạn theo lần dùng cuối.
- Bộ đếm sai PIN theo địa chỉ IP: nhiều máy dùng chung một mạng wifi sẽ chung một bộ đếm.
