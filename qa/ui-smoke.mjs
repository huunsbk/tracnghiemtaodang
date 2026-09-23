import { chromium } from 'playwright';

const APP = process.env.APP_URL || 'http://127.0.0.1:4173/index.html';
const SUPABASE_HOST = 'https://exfnarddchxzfewlztwb.supabase.co';
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9WlZkAAAAASUVORK5CYII=', 'base64');
const tinyWav = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=', 'base64');

const importedSettings = {
  subject: 'Tin học',
  title: 'Bài QA nhập file',
  bankVisibility: 'private',
  bankGroupId: '',
  timeLimit: 30,
  checkInterval: 3,
  numAnswers: 4,
  poseAssets: { NONE: null, RAISE_LEFT: null, RAISE_RIGHT: null, BOTH_UP: null, CROSS_ARMS: null },
  questions: [{
    id: 101,
    text: 'Câu QA một câu',
    image: null,
    audio: { data: null, name: '' },
    answers: [
      { text: 'Đứng bình thường', pose: 'NONE', isCorrect: true, image: null },
      { text: 'Giơ trái', pose: 'RAISE_LEFT', isCorrect: false, image: null },
      { text: 'Giơ phải', pose: 'RAISE_RIGHT', isCorrect: false, image: null },
      { text: 'Hai tay', pose: 'BOTH_UP', isCorrect: false, image: null }
    ]
  }],
  audio: {
    correct: { data: null, name: '' },
    wrong: { data: null, name: '' },
    bgm: { data: null, name: '' }
  }
};

const state = {
  profile: {
    user_id: 'qa-user',
    email: 'qa@example.com',
    email_confirmed: true,
    phone: '',
    phone_confirmed: false,
    display_name: '',
    school_name: '',
    avatar_path: null,
    avatar_url: null,
    updated_at: new Date().toISOString()
  },
  groups: [],
  lessons: [],
  bank: [{
    id: 'bank-seed',
    user_id: 'other-user',
    subject_name: 'Tin học',
    lesson_name: 'Bài chia sẻ mẫu',
    visibility: 'public',
    group_id: null,
    question: {
      id: 88,
      text: 'Câu hỏi công khai mẫu',
      image: null,
      audio: { data: null, name: '' },
      answers: [
        { text: 'Đúng', pose: 'NONE', isCorrect: true, image: null },
        { text: 'Sai 1', pose: 'RAISE_LEFT', isCorrect: false, image: null },
        { text: 'Sai 2', pose: 'RAISE_RIGHT', isCorrect: false, image: null },
        { text: 'Sai 3', pose: 'BOTH_UP', isCorrect: false, image: null }
      ]
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }]
};

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required'
  ]
});
const context = await browser.newContext({ permissions: ['camera'] });
if (APP.includes('githack.com')) {
  const host = new URL(APP).hostname;
  await context.addCookies([{
    name: '__Http-phish',
    value: '1',
    domain: host,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax'
  }]);
}
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('dialog', async d => { await d.accept(); });

const session = {
  access_token: 'qa-access-token',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now()/1000)+3600,
  refresh_token: 'qa-refresh-token',
  user: {
    id: 'qa-user',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'qa@example.com',
    email_confirmed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: []
  }
};

await page.route(SUPABASE_HOST + '/auth/v1/**', async route => {
  const url = route.request().url();
  if (url.includes('/logout')) return route.fulfill({ status: 204, body: '' });
  if (url.includes('/token')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
  }
  if (url.includes('/user')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session.user) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

const ok = body => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ...body }) });
await page.route(SUPABASE_HOST + '/functions/v1/pose-quiz-recovery**', async route => {
  const req = route.request();
  let body = {};
  try { body = req.postDataJSON(); } catch {}
  const action = body.action || '';
  if (action === 'capabilities') return route.fulfill(ok({ email: true, sms: true }));
  if (action === 'email.begin') return route.fulfill(ok({ message: 'Đã gửi email' }));
  if (action === 'email.complete') return route.fulfill(ok({ message: 'Đã đặt mật khẩu' }));
  if (action === 'phone.begin') return route.fulfill(ok({ phone: '+84912345678', message: 'Đã gửi OTP' }));
  if (action === 'phone.verify') return route.fulfill(ok({ recovery_token: 'qa-phone-recovery-token' }));
  if (action === 'phone.complete') return route.fulfill(ok({ message: 'Đã đặt mật khẩu' }));
  return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok:false, error:{ message:'Unknown recovery action '+action } }) });
});

await page.route(SUPABASE_HOST + '/functions/v1/pose-quiz-api**', async route => {
  const req = route.request();
  const u = new URL(req.url());
  const action = u.searchParams.get('action') || '';
  let body = {};
  if ((req.headers()['content-type'] || '').includes('application/json')) {
    try { body = req.postDataJSON(); } catch {}
  }

  if (action === 'bootstrap' || action === 'health') return route.fulfill(ok({ version: 'qa' }));
  if (action === 'account.profile.get') return route.fulfill(ok({ profile: state.profile }));
  if (action === 'account.profile.update') {
    state.profile = { ...state.profile, display_name: body.display_name || '', school_name: body.school_name || '', updated_at: new Date().toISOString() };
    return route.fulfill(ok({ profile: state.profile }));
  }
  if (action === 'account.avatar.upload') {
    state.profile = {
      ...state.profile,
      avatar_path: 'users/qa/avatar.png',
      avatar_url: 'data:image/png;base64,' + tinyPng.toString('base64')
    };
    return route.fulfill(ok({ profile: state.profile }));
  }
  if (action === 'account.avatar.delete') {
    state.profile = { ...state.profile, avatar_path: null, avatar_url: null };
    return route.fulfill(ok({ profile: state.profile }));
  }
  if (action === 'account.phone.begin') return route.fulfill(ok({ phone: '+84912345678' }));
  if (action === 'account.phone.verify') {
    state.profile = { ...state.profile, phone: '+84912345678', phone_confirmed: true };
    return route.fulfill(ok({ profile: state.profile }));
  }
  if (action === 'account.password.change') return route.fulfill(ok({ message: 'Đã đổi mật khẩu' }));
  if (action === 'game.start') {
    const questions = body.data?.questions || [];
    state.game = {
      index: 0,
      score: 0,
      total: questions.length,
      correct: questions.map(q => (q.answers || []).find(a => a.isCorrect)?.pose || 'NONE')
    };
    return route.fulfill(ok({ game_token: 'mock-game-token-0', index: 0, score: 0, total: state.game.total }));
  }
  if (action === 'game.check') {
    const game = state.game || { index: 0, score: 0, total: 1, correct: ['NONE'] };
    const correct = String(body.detected_pose || 'NONE') === String(game.correct[game.index] || 'NONE');
    if (correct) game.score += 1;
    const nextIndex = game.index + 1;
    const finished = nextIndex >= game.total;
    if (!finished) game.index = nextIndex;
    state.game = game;
    return route.fulfill(ok({
      correct,
      feedback: correct ? 'correct' : 'wrong',
      score: game.score,
      total: game.total,
      finished,
      next_index: finished ? game.index : nextIndex,
      game_token: finished ? null : 'mock-game-token-' + nextIndex
    }));
  }
  if (action === 'groups.list') return route.fulfill(ok({ groups: state.groups }));
  if (action === 'groups.create') {
    const group = { id: 'g-owner', name: body.name || 'Nhóm QA', join_code: 'OWNR1234', owner_id: 'qa-user', is_owner: true, member_count: 1 };
    state.groups = [group, ...state.groups.filter(g => g.id !== group.id)];
    return route.fulfill(ok({ group }));
  }
  if (action === 'groups.join') {
    const group = { id: 'g-member', name: 'Nhóm đã tham gia', join_code: String(body.code || 'TEAM1234'), owner_id: 'owner-2', is_owner: false, member_count: 2 };
    state.groups = [...state.groups.filter(g => g.id !== group.id), group];
    return route.fulfill(ok({ group }));
  }
  if (action === 'groups.delete' || action === 'groups.leave') {
    state.groups = state.groups.filter(g => g.id !== body.group_id);
    return route.fulfill(ok({}));
  }
  if (action === 'bank.list') return route.fulfill(ok({ items: state.bank }));
  if (action === 'bank.resolve') {
    const ids = new Set(body.ids || []);
    const questions = state.bank
      .filter(item => ids.has(item.id))
      .map((item, idx) => ({ ...JSON.parse(JSON.stringify(item.question)), id: Date.now() + idx }));
    return route.fulfill(ok({ questions }));
  }
  if (action === 'bank.save') {
    for (const q of body.questions || []) {
      state.bank.unshift({
        id: 'bank-' + (state.bank.length + 1),
        user_id: 'qa-user',
        subject_name: body.subject_name,
        lesson_name: body.lesson_name,
        visibility: body.visibility,
        group_id: body.group_id || null,
        question: q,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }
    return route.fulfill(ok({ count: (body.questions || []).length }));
  }
  if (action === 'bank.delete') {
    const ids = new Set(body.ids || []);
    const before = state.bank.length;
    state.bank = state.bank.filter(x => !(ids.has(x.id) && x.user_id === 'qa-user'));
    return route.fulfill(ok({ count: before - state.bank.length }));
  }
  if (action === 'lessons.list') {
    return route.fulfill(ok({ items: state.lessons.map(x => ({
      id: x.id, subject_name: x.subject_name, title: x.title,
      created_at: x.created_at, updated_at: x.updated_at,
      question_count: x.data.questions?.length || 0
    })) }));
  }
  if (action === 'lessons.save') {
    const id = body.id || 'lesson-' + (state.lessons.length + 1);
    const item = {
      id,
      subject_name: body.subject_name,
      title: body.title,
      data: body.data,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    state.lessons = [item, ...state.lessons.filter(x => x.id !== id)];
    return route.fulfill(ok({ item }));
  }
  if (action === 'lessons.get') {
    const item = state.lessons.find(x => x.id === body.id);
    return route.fulfill(item ? ok({ item }) : { status: 404, contentType: 'application/json', body: JSON.stringify({ok:false,error:{message:'Not found'}}) });
  }
  if (action === 'lessons.delete') {
    state.lessons = state.lessons.filter(x => x.id !== body.id);
    return route.fulfill(ok({ id: body.id }));
  }
  if (action === 'media.upload') {
    return route.fulfill(ok({ asset: {
      storage: 'pose-quiz-media',
      path: 'users/qa/media-' + Date.now(),
      name: 'qa-media',
      mime: 'image/png',
      size: 68,
      url: 'data:image/png;base64,' + tinyPng.toString('base64')
    }}));
  }
  if (action === 'document.export') return route.fulfill(ok({ data: body.data || importedSettings }));
  if (action === 'document.import') return route.fulfill(ok({ data: importedSettings }));
  return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ok:false,error:{message:'Unknown mock action '+action}}) });
});

const pass = [];
async function check(name, fn) {
  try {
    await fn();
    pass.push('PASS ' + name);
    console.log('PASS', name);
  } catch (e) {
    console.error('FAIL', name, e);
    throw e;
  }
}
const byButton = name => page.getByRole('button', { name, exact: false }).first();
const hasText = text => page.getByText(text, { exact: false }).first();

await page.goto(APP, { waitUntil: 'networkidle', timeout: 90000 });

await check('Auth screen renders', async () => {
  await byButton('ĐĂNG NHẬP').waitFor();
  await byButton('ĐĂNG KÝ').click();
  await hasText('TẠO TÀI KHOẢN').waitFor();
  await byButton('ĐĂNG NHẬP').click();
});

await check('Email recovery link reset screen works', async () => {
  const recoveryUrl = new URL(APP);
  recoveryUrl.searchParams.set('recovery_state', 'qa-email-recovery-state');
  await page.goto(recoveryUrl.toString(), { waitUntil: 'networkidle', timeout: 90000 });
  await hasText('TẠO LẠI MẬT KHẨU').waitFor();
  const pw = page.locator('input[type=password]');
  await pw.nth(0).fill('QaReset123!');
  await pw.nth(1).fill('QaReset123!');
  await byButton('LƯU MẬT KHẨU MỚI').click();
  await byButton('ĐĂNG NHẬP').waitFor();
});

await check('Forgot password email and SMS flows work', async () => {
  await byButton('QUÊN MẬT KHẨU?').click();
  await hasText('Khôi phục tài khoản an toàn').waitFor();

  const emailInput = page.locator('input[type=email]');
  await emailInput.fill('qa@example.com');
  await byButton('GỬI LIÊN KẾT KHÔI PHỤC').click();
  await hasText('liên kết tạo lại mật khẩu').waitFor();

  await byButton('📱 SMS').click();
  await page.getByPlaceholder('0912345678 hoặc +84912345678').fill('0912345678');
  await byButton('GỬI MÃ OTP').click();
  await page.getByPlaceholder('000000').fill('123456');
  await byButton('XÁC MINH OTP').click();
  const resetPw = page.locator('input[type=password]');
  await resetPw.nth(0).fill('QaPhone123!');
  await resetPw.nth(1).fill('QaPhone123!');
  await byButton('TẠO MẬT KHẨU MỚI').click();
  await byButton('ĐĂNG NHẬP').waitFor();
});

await check('Login reaches main menu and backend bootstrap', async () => {
  await page.locator('input[type=email]').fill('qa@example.com');
  await page.locator('input[type=password]').fill('Qa123456!');
  await page.getByRole('button', { name: 'ĐĂNG NHẬP', exact: true }).last().click();
  await byButton('BẮT ĐẦU').waitFor({ timeout: 30000 });
});

await check('Account profile avatar school and phone controls work', async () => {
  await byButton('👤 TÀI KHOẢN CỦA TÔI').click();
  await hasText('TÀI KHOẢN CỦA TÔI').waitFor();

  await page.getByPlaceholder('Nguyễn Văn A').fill('Giáo viên QA');
  await page.getByPlaceholder('Tên trường...').fill('Trường QA');
  await byButton('LƯU HỒ SƠ').click();
  await hasText('Đã cập nhật hồ sơ').waitFor();

  const avatarInput = page.locator('input[type=file][accept="image/*"]').first();
  await avatarInput.setInputFiles({ name:'avatar.png', mimeType:'image/png', buffer:tinyPng });
  await byButton('XÓA ẢNH').waitFor();
  await byButton('XÓA ẢNH').click();

  await page.getByPlaceholder('0912345678 hoặc +84912345678').fill('0912345678');
  await byButton('GỬI OTP XÁC MINH SỐ MỚI').click();
  await page.getByPlaceholder('OTP').fill('123456');
  await byButton('XÁC MINH').click();
  await hasText('Đã xác minh và cập nhật số điện thoại').waitFor();

  await byButton('← TRANG CHỦ').click();
  await byButton('BẮT ĐẦU').waitFor();
});

await check('Editor opens and basic fields work', async () => {
  await byButton('✏️ SOẠN BÀI').click();
  await hasText('THIẾT LẬP BÀI DẠY').waitFor();
  await page.getByPlaceholder('Môn học (VD: Tin học)').fill('Tin học QA');
  await page.getByPlaceholder('Tên bài dạy').fill('Bài kiểm thử UI');
  await byButton('+ THÊM CÂU').click();
  await hasText('CÂU HỎI 2').waitFor();
});

await check('General settings and question navigation controls work', async () => {
  const numberInputs = page.locator('input[type=number]');
  await numberInputs.nth(0).fill('25');
  await numberInputs.nth(1).fill('4');

  await byButton('CÂU HỎI 2').click();
  await hasText('Em hãy tạo dáng mới nào!').waitFor();
  await byButton('CÂU HỎI 1').click();

  const poseSelect = page.locator('select').filter({ hasText: 'Bình thường' }).first();
  await poseSelect.selectOption('RAISE_LEFT');
  await poseSelect.selectOption('NONE');
});

await check('Image and audio uploads call backend', async () => {
  const imageInputs = page.locator('input[type=file][accept="image/*"]');
  await imageInputs.nth(0).setInputFiles({ name: 'pose.png', mimeType: 'image/png', buffer: tinyPng });
  await page.getByText(/Xóa/i).first().waitFor();

  const audioInputs = page.locator('input[type=file][accept="audio/*"]');
  await audioInputs.nth(0).setInputFiles({ name: 'bgm.wav', mimeType: 'audio/wav', buffer: tinyWav });
  await page.getByText('NGHE THỬ', { exact: false }).first().waitFor();

  await imageInputs.nth(5).setInputFiles({ name: 'question.png', mimeType: 'image/png', buffer: tinyPng });
  await audioInputs.nth(3).setInputFiles({ name: 'question.wav', mimeType: 'audio/wav', buffer: tinyWav });
  await hasText('question.wav').waitFor();
});

await check('Media preview, delete and answer-image buttons work', async () => {
  const imageInputs = page.locator('input[type=file][accept="image/*"]');
  const audioInputs = page.locator('input[type=file][accept="audio/*"]');

  const bgmCard = page.getByText('Nhạc nền', { exact: true }).locator('..');
  await bgmCard.getByRole('button', { name: /Nghe thử/i }).click();
  await bgmCard.getByRole('button', { name: /^Xóa$/i }).click();
  await audioInputs.nth(0).setInputFiles({ name: 'bgm2.wav', mimeType: 'audio/wav', buffer: tinyWav });

  await page.getByRole('button', { name: '▶ NGHE', exact: true }).click();
  await page.getByRole('button', { name: 'XÓA', exact: true }).click();
  await audioInputs.nth(3).setInputFiles({ name: 'question2.wav', mimeType: 'audio/wav', buffer: tinyWav });

  await page.getByRole('button', { name: '✕', exact: true }).click();
  await imageInputs.nth(5).setInputFiles({ name: 'question2.png', mimeType: 'image/png', buffer: tinyPng });

  await imageInputs.nth(6).setInputFiles({ name: 'answer.png', mimeType: 'image/png', buffer: tinyPng });
  await byButton('XÓA ẢNH ĐÁP ÁN').click();

  const exactDeleteButtons = page.getByRole('button', { name: /^Xóa$/i });
  if (await exactDeleteButtons.count()) {
    await exactDeleteButtons.first().click();
    await imageInputs.nth(0).setInputFiles({ name: 'pose2.png', mimeType: 'image/png', buffer: tinyPng });
  }
});

await check('Question delete button works', async () => {
  await byButton('CÂU HỎI 2').click();
  await byButton('XÓA CÂU HỎI NÀY').click();
  if (await page.getByRole('button', { name: /CÂU HỎI 2/i }).count()) {
    throw new Error('Question 2 still exists after delete');
  }
});

await check('Correct answer selector and bank save work', async () => {
  const correctButtons = page.getByRole('button', { name: /CHỌN LÀM ĐÚNG/ });
  if (await correctButtons.count()) await correctButtons.first().click();

  const shareSelect = page.locator('select').filter({ hasText: 'Riêng tư — chỉ tôi' }).first();
  await shareSelect.selectOption('public');
  await byButton('LƯU CÂU NÀY VÀO KHO').click();
  await byButton('LƯU TẤT CẢ VÀO KHO').click();
  await byButton('MỞ KHO ĐỂ LẤY NHIỀU CÂU').click();
  await hasText('KHO CÂU HỎI').waitFor();
  await byButton('← SOẠN BÀI').click();
});

await check('Cloud save switches to update mode', async () => {
  await byButton('LƯU CLOUD').click();
  await byButton('CẬP NHẬT CLOUD').waitFor();
  await byButton('CẬP NHẬT CLOUD').click();
  await byButton('CẬP NHẬT CLOUD').waitFor();
});

await check('JSON export and import buttons are wired', async () => {
  const downloadPromise = page.waitForEvent('download');
  await byButton('LƯU FILE (.JSON)').click();
  await downloadPromise;

  const jsonInput = page.locator('input[type=file][accept=".json"]');
  await jsonInput.setInputFiles({ name: 'lesson.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(importedSettings)) });
  await byButton('LƯU CLOUD').waitFor();
});

await check('Question bank filters, owner delete, select and multi-import work', async () => {
  await byButton('📚 KHO CÂU HỎI').click();
  await hasText('KHO CÂU HỎI').waitFor();

  const sourceSelect = page.locator('select').filter({ hasText: 'Tất cả nguồn' }).first();
  await sourceSelect.selectOption('MINE');
  await page.waitForTimeout(350);
  await byButton('CHỌN TẤT CẢ').click();
  const deleteOwn = page.getByRole('button', { name: /Xóa câu của tôi \([1-9][0-9]*\)/i });
  await deleteOwn.waitFor();
  await deleteOwn.click();

  await sourceSelect.selectOption('PUBLIC');
  await hasText('Câu hỏi công khai mẫu').waitFor();
  let addSelected = page.getByRole('button', { name: /thêm.*câu vào bài đang soạn/i });
  if (!await addSelected.isEnabled()) {
    await hasText('Câu hỏi công khai mẫu').click();
    addSelected = page.getByRole('button', { name: /thêm.*câu vào bài đang soạn/i });
  }
  await addSelected.click();
  await hasText('THIẾT LẬP BÀI DẠY').waitFor();
});

await check('Group create, copy, join, delete and leave work', async () => {
  await byButton('👥 NHÓM').click();
  await hasText('NHÓM CHIA SẺ').waitFor();
  await page.getByPlaceholder('Tên nhóm...').fill('Nhóm QA');
  await byButton('TẠO').click();
  await hasText('OWNR1234').waitFor();
  await byButton('SAO CHÉP').click();

  await page.getByPlaceholder('VD: A1B2C3D4').fill('TEAM1234');
  await byButton('THAM GIA').click();
  await hasText('Nhóm đã tham gia').waitFor();

  await byButton('← TRANG CHỦ').click();
  await byButton('✏️ SOẠN BÀI').click();
  const visibilitySelect = page.locator('select').filter({ hasText: 'Riêng tư — chỉ tôi' }).first();
  await visibilitySelect.selectOption('group');
  const groupSelect = page.locator('select').filter({ hasText: '-- Chọn nhóm chia sẻ --' }).first();
  await groupSelect.selectOption('g-owner');
  await byButton('LƯU CÂU NÀY VÀO KHO').click();
  await byButton('👥 NHÓM').click();

  await byButton('XÓA NHÓM').click();
  await byButton('RỜI NHÓM').click();
});

await check('Cloud library new/open/delete work', async () => {
  await byButton('← TRANG CHỦ').click();
  await byButton('✏️ SOẠN BÀI').click();
  await byButton('LƯU CLOUD').click();
  await byButton('☁️ THƯ VIỆN').click();
  await hasText('Bài QA nhập file').waitFor();
  await byButton('MỞ').click();
  await hasText('THIẾT LẬP BÀI DẠY').waitFor();
  await byButton('☁️ THƯ VIỆN').click();
  await byButton('XÓA').click();
  await byButton('+ BÀI MỚI').click();
  await page.getByPlaceholder('Tên bài dạy').waitFor();
});

await check('Editor top navigation buttons work', async () => {
  await byButton('📚 KHO CÂU HỎI').click();
  await byButton('← SOẠN BÀI').click();
  await byButton('👥 NHÓM').click();
  await byButton('← TRANG CHỦ').click();
  await byButton('✏️ SOẠN BÀI').click();
  await byButton('XONG').click();
  await byButton('BẮT ĐẦU').waitFor();
});

await check('Game mute/check/result/replay buttons work', async () => {
  await byButton('✏️ SOẠN BÀI').click();
  const jsonInput = page.locator('input[type=file][accept=".json"]');
  await jsonInput.setInputFiles({ name: 'single.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(importedSettings)) });
  await byButton('XONG').click();
  await byButton('BẮT ĐẦU').click();
  await hasText('CÂU 1').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '🔊', exact: true }).click();
  await byButton('KIỂM TRA').click();
  await hasText('XUẤT SẮC!').waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: /CHƠI LẠI THÔI/i }).click();
  await byButton('BẮT ĐẦU').waitFor();
});

await check('Account password change signs out and new login path remains usable', async () => {
  await byButton('👤 TÀI KHOẢN CỦA TÔI').click();
  const pw = page.locator('input[type=password]');
  await pw.nth(0).fill('Qa123456!');
  await pw.nth(1).fill('QaChanged123!');
  await pw.nth(2).fill('QaChanged123!');
  await byButton('ĐỔI MẬT KHẨU').click();
  await page.getByRole('button', { name: 'ĐĂNG NHẬP', exact: true }).first().waitFor();

  await page.locator('input[type=email]').fill('qa@example.com');
  await page.locator('input[type=password]').fill('QaChanged123!');
  await page.getByRole('button', { name: 'ĐĂNG NHẬP', exact: true }).last().click();
  await byButton('BẮT ĐẦU').waitFor();
});

await check('Logout returns to auth screen', async () => {
  await byButton('ĐĂNG XUẤT').click();
  await page.getByRole('button', { name: 'ĐĂNG NHẬP', exact: true }).first().waitFor();
});

if (pageErrors.length) {
  console.error('PAGE_ERRORS', pageErrors);
  throw new Error('Browser page errors detected: ' + pageErrors.join(' | '));
}

console.log('\nUI_SMOKE_OK');
console.log(pass.join('\n'));
await page.screenshot({ path: 'qa-ui-final.png', fullPage: true }).catch(() => {});
await browser.close();
