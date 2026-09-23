# AI Pose Quiz — kiến trúc backend + triển khai

## 1. Kiến trúc đã chốt

Frontend `index.html` chỉ đảm nhiệm:
- Giao diện và thao tác người dùng.
- Supabase Auth để đăng ký/đăng nhập.
- Camera + MediaPipe Pose realtime trên chính thiết bị người dùng.
- Gọi API backend `pose-quiz-api`.

Mọi xử lý nghiệp vụ/dữ liệu được thực hiện ở **Supabase Edge Function**:
- Bài dạy cloud: danh sách, mở, lưu, cập nhật, xóa.
- Kho câu hỏi: lưu, lấy nhiều câu, xóa câu của chủ sở hữu.
- Phân loại Môn học → Bài học → Câu hỏi.
- Quyền Riêng tư / Công khai / Theo nhóm.
- Tạo nhóm, mã nhóm 8 ký tự, tham gia/rời/xóa nhóm.
- Phân quyền chủ sở hữu/thành viên.
- Import/export dữ liệu.
- Upload media, chuyển dữ liệu Base64 cũ sang Storage.
- Tạo signed URL sau khi backend kiểm tra quyền.

Frontend **không còn** gọi `supabaseClient.from(...)`, `rpc(...)` hoặc Storage trực tiếp.

## 2. Supabase

Project: **MotionClass**

Edge Functions:
- `pose-quiz-api`: API sản phẩm, yêu cầu JWT hợp lệ.
- `pose-quiz-qa`: kiểm thử tích hợp backend; không dùng Supabase JWT nhưng tự xác thực GitHub Actions OIDC, chỉ chấp nhận đúng repo/nhánh QA.

Schema được quản lý bằng `supabase-setup.sql` và đã áp dụng vào database. `pose-quiz-api` không chạy DDL trong runtime; khi khởi động nó chỉ kiểm tra/tạo-cập nhật bucket riêng tư `pose-quiz-media`.

Bảng nghiệp vụ:
- `pose_quiz_sets`
- `pose_quiz_question_bank`
- `pose_quiz_groups`
- `pose_quiz_group_members`
- `pose_quiz_media`

Các role trình duyệt `anon` và `authenticated` bị **REVOKE** quyền trực tiếp trên những bảng này. Backend dùng khóa bí mật chỉ ở Edge Function và tự kiểm tra quyền trước mỗi thao tác.

File `supabase-setup.sql` là nguồn chuẩn để tái tạo/đồng bộ schema. Schema hiện tại đã được áp dụng vào project MotionClass; Edge Function runtime không tự sửa cấu trúc database.

## 3. Media được lưu

Tất cả media sau được lưu trong private Supabase Storage:
- Ảnh các tư thế AI.
- Ảnh câu hỏi.
- Ảnh riêng của đáp án.
- Âm thanh riêng của câu hỏi.
- Nhạc nền.
- Âm thanh đúng.
- Âm thanh sai.

Database chỉ lưu metadata/path. Backend cấp **signed URL có thời hạn** khi người dùng có quyền truy cập.

Giới hạn backend hiện tại: tối đa 20 MB cho một tệp ảnh/âm thanh.

## 4. Chia sẻ

| Chế độ | Ai xem/lấy được | Ai sửa/xóa bản gốc |
|---|---|---|
| Riêng tư | Người tạo | Người tạo |
| Công khai | Tài khoản đã đăng nhập | Người tạo |
| Theo nhóm | Chủ + thành viên nhóm | Người tạo |

Khi thành viên lấy câu được chia sẻ, ứng dụng sao chép câu vào bài đang soạn; không sửa bản gốc.

Khi chủ nhóm xóa nhóm, câu đã chia sẻ cho nhóm không bị mất mà chuyển về Riêng tư của người tạo.

## 5. Vercel

Tạo project Vercel riêng từ repo:
- GitHub repo: `huunsbk/tracnghiemtaodang`
- Framework Preset: **Other**
- Root Directory: mặc định
- Build Command: để trống
- Output Directory: để trống

Không dùng project Vercel `motionclass` hiện có vì đó là ứng dụng khác.

Sau khi có URL Vercel:
1. Supabase → Authentication → URL Configuration.
2. Site URL: URL Vercel chính thức.
3. Redirect URLs: thêm URL Vercel.
4. Nếu vẫn giữ GitHub Pages, thêm `https://huunsbk.github.io/tracnghiemtaodang/`.

## 6. Kiểm thử tự động

Workflow: `.github/workflows/pose-quiz-qa.yml`

### UI smoke test
Chromium/Playwright kiểm tra:
- Đăng nhập và chuyển tab đăng ký.
- Mở màn soạn bài.
- Nhập môn/tên bài.
- Thêm câu.
- Upload ảnh/âm thanh.
- Chọn đáp án đúng.
- Lưu câu vào kho.
- Lưu/cập nhật cloud.
- Import/export JSON.
- Lọc/chọn nhiều câu từ kho.
- Tạo/tham gia/rời/xóa nhóm.
- Mở/xóa/tạo bài cloud.
- Các nút điều hướng.
- Vào game, tắt tiếng, Kiểm tra, màn kết quả, Chơi lại.
- Đăng xuất.

UI test mock API để kiểm tra wiring/nút mà không làm bẩn dữ liệu thật.

### Backend integration test
GitHub Actions lấy OIDC token ngắn hạn. `pose-quiz-qa` xác minh:
- đúng issuer GitHub,
- đúng repo `huunsbk/tracnghiemtaodang`,
- đúng nhánh `supabase-auth-cloud`.

Sau đó test trên backend thật:
- tạo 2 tài khoản QA tạm thời,
- đăng nhập,
- bootstrap schema/bucket,
- lưu/mở/xóa bài,
- chuyển media Base64 cũ vào Storage,
- upload media,
- tạo nhóm và tham gia bằng mã,
- kiểm tra private/public/group,
- xác nhận thành viên không xóa được câu người khác,
- import/export,
- xóa nhóm và chuyển câu nhóm về Riêng tư,
- dọn toàn bộ dữ liệu/tài khoản QA sau test.

## 7. Nguyên tắc bảo mật

- Không đưa secret/service-role key vào frontend hoặc GitHub.
- Frontend chỉ chứa publishable key.
- Bucket media luôn private.
- Business tables không cấp quyền trực tiếp cho browser roles.
- Backend xác thực JWT và kiểm tra quyền sở hữu/nhóm.
- QA backend được bảo vệ bằng GitHub OIDC thay vì secret tĩnh.
