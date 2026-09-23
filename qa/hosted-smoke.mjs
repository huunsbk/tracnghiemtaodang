import { chromium } from 'playwright';

const APP = process.env.APP_URL || 'https://rawcdn.githack.com/huunsbk/tracnghiemtaodang/3f452f3cb5633a55826460513711ad1ef54da02b/index.html';
const SB = 'https://exfnarddchxzfewlztwb.supabase.co';
const session = {
  access_token: 'hosted-qa-access',
  refresh_token: 'hosted-qa-refresh',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now()/1000)+3600,
  user: {
    id: 'hosted-qa-user',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'hosted-qa@example.com',
    email_confirmed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: []
  }
};

const settings = {
  subject: 'Tin học',
  title: 'Online Preview QA',
  bankVisibility: 'private',
  bankGroupId: '',
  timeLimit: 20,
  checkInterval: 3,
  numAnswers: 4,
  poseAssets: { NONE:null, RAISE_LEFT:null, RAISE_RIGHT:null, BOTH_UP:null, CROSS_ARMS:null },
  questions: [{
    id: 1,
    text: 'Câu thử nghiệm online',
    image: null,
    audio: { data:null, name:'' },
    answers: [
      { text:'Đứng bình thường', pose:'NONE', isCorrect:true, image:null },
      { text:'Giơ trái', pose:'RAISE_LEFT', isCorrect:false, image:null },
      { text:'Giơ phải', pose:'RAISE_RIGHT', isCorrect:false, image:null },
      { text:'Hai tay', pose:'BOTH_UP', isCorrect:false, image:null }
    ]
  }],
  audio: {
    correct:{data:null,name:''},
    wrong:{data:null,name:''},
    bgm:{data:null,name:''}
  }
};

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']
});
const context = await browser.newContext({ permissions:['camera'] });
await context.addCookies([{
  name:'__Http-phish', value:'1', domain:'rawcdn.githack.com', path:'/',
  secure:true, httpOnly:true, sameSite:'Lax'
}]);
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', msg => {
  if (msg.type() === 'error') console.error('BROWSER_CONSOLE', msg.text());
});
page.on('dialog', async d => d.accept());

await page.route(SB + '/auth/v1/**', async route => {
  const u = route.request().url();
  if (u.includes('/logout')) return route.fulfill({status:204, body:''});
  if (u.includes('/token')) return route.fulfill({status:200, contentType:'application/json', body:JSON.stringify(session)});
  if (u.includes('/user')) return route.fulfill({status:200, contentType:'application/json', body:JSON.stringify(session.user)});
  return route.fulfill({status:200, contentType:'application/json', body:'{}'});
});

const ok = extra => ({status:200,contentType:'application/json',body:JSON.stringify({ok:true,...extra})});
await page.route(SB + '/functions/v1/pose-quiz-api**', async route => {
  const u = new URL(route.request().url());
  const action = u.searchParams.get('action');
  if (action === 'bootstrap') return route.fulfill(ok({version:'hosted-smoke'}));
  if (action === 'groups.list') return route.fulfill(ok({groups:[]}));
  if (action === 'bank.list') return route.fulfill(ok({items:[]}));
  if (action === 'lessons.list') return route.fulfill(ok({items:[]}));
  if (action === 'game.start') return route.fulfill(ok({game_token:'hosted-token',index:0,score:0,total:1}));
  if (action === 'game.check') return route.fulfill(ok({correct:true,feedback:'correct',score:1,total:1,finished:true,next_index:0,game_token:null}));
  return route.fulfill(ok({}));
});

const btn = text => page.getByRole('button',{name:text,exact:false}).first();
const txt = text => page.getByText(text,{exact:false}).first();

await page.goto(APP,{waitUntil:'networkidle',timeout:90000});
await btn('ĐĂNG NHẬP').waitFor({timeout:30000});
console.log('PASS hosted auth screen');

await page.locator('input[type=email]').fill('hosted-qa@example.com');
await page.locator('input[type=password]').fill('Qa123456!');
await page.getByRole('button',{name:'ĐĂNG NHẬP',exact:true}).last().click();
await btn('BẮT ĐẦU').waitFor({timeout:30000});
console.log('PASS hosted login/menu');

await btn('✏️ SOẠN BÀI').click();
await txt('THIẾT LẬP BÀI DẠY').waitFor();
console.log('PASS hosted editor');
await btn('XONG').click();

await btn('📚 KHO CÂU HỎI').click();
await txt('KHO CÂU HỎI').waitFor();
console.log('PASS hosted bank');
await btn('TRANG CHỦ').click();

await btn('👥 NHÓM CHIA SẺ').click();
await txt('NHÓM CHIA SẺ').waitFor();
console.log('PASS hosted groups');
await btn('TRANG CHỦ').click();

await btn('☁️ BÀI DẠY CLOUD').click();
await txt('BÀI DẠY CLOUD').waitFor();
console.log('PASS hosted cloud');
await btn('TRANG CHỦ').click();

await btn('BẮT ĐẦU').click();
await txt('CÂU 1').waitFor({timeout:30000});
console.log('PASS hosted game render');
await btn('KIỂM TRA').click();
await txt('XUẤT SẮC!').waitFor({timeout:10000});
console.log('PASS hosted backend-game wiring');

if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
await page.screenshot({path:'hosted-preview-pass.png',fullPage:true});
console.log('HOSTED_PREVIEW_SMOKE_OK');
await browser.close();
