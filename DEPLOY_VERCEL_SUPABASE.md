# Triển khai AI Pose Quiz với Vercel + Supabase

## 1. Supabase

Project đã cấu hình trong `supabase-config.js` là **MotionClass**.

1. Mở Supabase Dashboard -> SQL Editor.
2. Chạy toàn bộ file `supabase-setup.sql`.
3. Vào Authentication -> URL Configuration:
   - Site URL: đặt thành URL Vercel chính thức sau khi triển khai.
   - Redirect URLs: thêm URL Vercel và (nếu vẫn dùng) `https://huunsbk.github.io/tracnghiemtaodang/`.
4. Email/Password Auth được dùng cho đăng ký và đăng nhập.

Hai bảng `public.pose_quiz_sets` và `public.pose_quiz_question_bank` đều bật RLS. Mỗi người dùng chỉ được SELECT/INSERT/UPDATE/DELETE dữ liệu có `user_id = auth.uid()`.

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
- Kho câu hỏi riêng theo từng bài.
- Lưu một câu hoặc toàn bộ câu của bài hiện tại vào kho.
- Lọc kho theo bài, tìm nội dung, chọn nhiều câu và thêm hàng loạt vào bài đang soạn.
- Xóa nhiều câu khỏi kho.
- Vẫn giữ localStorage và xuất/nhập JSON để dùng dự phòng.

## 4. Kiểm thử sau triển khai

1. Tạo tài khoản và xác nhận email.
2. Đăng nhập.
3. Vào **Thiết lập bài dạy**.
4. Đặt tên, thêm/sửa câu hỏi.
5. Bấm **Lưu cloud**.
6. Vào **Thư viện đám mây**, mở lại bài.
7. Đăng xuất, đăng nhập lại trên thiết bị khác để kiểm tra đồng bộ.
