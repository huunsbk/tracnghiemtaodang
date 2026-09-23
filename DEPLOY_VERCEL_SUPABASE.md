# Triển khai AI Pose Quiz với Vercel + Supabase

## 1. Supabase

Project đã cấu hình trong `supabase-config.js` là **MotionClass**.

1. Mở Supabase Dashboard -> SQL Editor.
2. Chạy toàn bộ file `supabase-setup.sql`.
3. Vào Authentication -> URL Configuration:
   - Site URL: đặt thành URL Vercel chính thức sau khi triển khai.
   - Redirect URLs: thêm URL Vercel và (nếu vẫn dùng) `https://huunsbk.github.io/tracnghiemtaodang/`.
4. Email/Password Auth được dùng cho đăng ký và đăng nhập.

Các bảng `public.pose_quiz_sets`, `public.pose_quiz_question_bank`, `public.pose_quiz_groups` và `public.pose_quiz_group_members` đều được bảo vệ bằng RLS. Mỗi người dùng chỉ được SELECT/INSERT/UPDATE/DELETE dữ liệu có `user_id = auth.uid()`.

> `supabase-config.js` chỉ chứa **publishable key**, không chứa service role/secret key.

## 2. Vercel

Sau khi merge PR vào `main`:

1. Vercel -> Add New -> Project.
2. Import GitHub repo `huunsbk/tracnghiemtaodang`.
3. Framework Preset: Other.
4. Root Directory: mặc định.
5. Build Command: để trống.
6. Output Directory: để trống.
7. Deploy.

Đây là trang HTML tĩnh nên không cần Node backend riêng.

## 3. Chức năng cloud đã thêm

- Đăng ký bằng email/mật khẩu.
- Đăng nhập/đăng xuất.
- Tên bài dạy.
- Lưu bài dạy lên Supabase.
- Cập nhật bản đã lưu.
- Thư viện đám mây.
- Mở lại và xóa bài dạy.
- Kho câu hỏi theo cấu trúc **Môn học → Bài học → Câu hỏi**.
- Lưu một câu hoặc toàn bộ câu của bài hiện tại vào kho.
- Chọn quyền chia sẻ khi lưu: **Riêng tư / Công khai / Theo nhóm**.
- Câu **Công khai** được các tài khoản đã đăng nhập khác xem và lấy về bài của họ, nhưng không được sửa/xóa bản gốc.
- Tạo **nhóm chia sẻ riêng**, hệ thống sinh mã nhóm 8 ký tự.
- Thành viên nhập mã nhóm để tham gia.
- Câu chia sẻ **Theo nhóm** chỉ hiển thị cho chủ nhóm và thành viên nhóm.
- Lọc kho theo môn, bài, nguồn chia sẻ; tìm nội dung; chọn nhiều câu và thêm hàng loạt vào bài đang soạn.
- Chỉ chủ sở hữu câu hỏi mới được xóa/sửa câu gốc.
- Khi xóa một nhóm, các câu đã chia sẻ vào nhóm không bị xóa mà tự chuyển về **Riêng tư**.
- Vẫn giữ localStorage và xuất/nhập JSON để dùng dự phòng.

## 4. Kiểm thử sau triển khai

1. Tạo tài khoản và xác nhận email.
2. Đăng nhập.
3. Vào **Thiết lập bài dạy**.
4. Đặt tên, thêm/sửa câu hỏi.
5. Bấm **Lưu cloud**.
6. Vào **Thư viện đám mây**, mở lại bài.
7. Đăng xuất, đăng nhập lại trên thiết bị khác để kiểm tra đồng bộ.


## 5. Mô hình chia sẻ câu hỏi

| Chế độ | Ai xem được | Ai sửa/xóa câu gốc |
|---|---|---|
| Riêng tư | Chỉ người tạo | Người tạo |
| Công khai | Mọi tài khoản đã đăng nhập | Người tạo |
| Theo nhóm | Người tạo + thành viên nhóm | Người tạo |

### Quy trình nhóm riêng

1. Vào **Nhóm chia sẻ**.
2. Chọn **Tạo nhóm mới**.
3. Hệ thống sinh mã 8 ký tự, ví dụ `A1B2C3D4`.
4. Gửi mã này cho giáo viên cần tham gia.
5. Người nhận vào **Nhóm chia sẻ → Tham gia bằng mã**.
6. Khi soạn bài, chọn **Theo nhóm riêng** và chọn đúng tên nhóm trước khi lưu câu vào kho.
