// index.js
require('dotenv').config();
const { chromium } = require('playwright');
const { DateTime } = require('luxon');

const {
  RTJ_EMAIL,
  RTJ_PASSWORD,
  COURSE_NAME,
  HEADLESS,
  KEEP_OPEN,
  LOGIN_TIME_CST
} = process.env;

/* ============================================
 * 공통 유틸
 * ============================================ */
function norm(s = '') { return s.replace(/\s+/g, ' ').trim().toLowerCase(); }
function parseCourseNames(str) {
  return str ? str.split(/[;,]/).map(s => s.trim()).filter(Boolean) : [];
}
async function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

/* ============================================
 *  안정화: 페이지 이벤트 및 라우팅
 * ============================================ */
async function stabilizePage(page) {
  // console 노이즈 최소화
  page.on('console', msg => {
    const text = msg.text();
    if (/favicon|tracking|analytics/i.test(text)) return;
    console.log(`[BrowserLog] ${text}`);
  });

  // 에러 감지
  page.on('pageerror', e => console.warn(`⚠️ PageError: ${e.message}`));

  // 불필요 요청 차단 (속도 향상)
  await page.route('**/*', route => {
    const url = route.request().url();
    if (
      /\.(png|jpg|jpeg|gif|woff|woff2|ttf|map)$/i.test(url) ||
      /google-analytics|doubleclick|hotjar|gtag/i.test(url)
    ) return route.abort();
    route.continue();
  });
}

/* ============================================
 * 팝업 닫기
 * ============================================ */
async function closeOverlayIfAny(page) {
  const candidates = [
    'button:has-text("Close")',
    'div.cdk-overlay-container button:has-text("Close")',
    '.mat-dialog-actions button:has-text("Close")',
  ];
  for (const sel of candidates) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      console.log(`ℹ️ 팝업 감지 → ${sel} 클릭`);
      await btn.click().catch(() => {});
      await page.waitForTimeout(250);
    }
  }
}

/* ============================================
 * 코스 선택 (<mat-select multiple>)
 * ============================================ */
async function selectCourseFast(page, targets = [], { selector = '#mat-select-2' } = {}) {
  if (!targets.length) return;
  const combo = page.locator(selector);
  await combo.waitFor({ timeout: 10000 });
  if ((await combo.getAttribute('aria-expanded')) !== 'true') await combo.click();

  const panel = page.locator('.cdk-overlay-pane .mat-select-panel').last();
  await panel.waitFor({ timeout: 10000 });

  const tnorms = targets.map(norm);
  const changed = await panel.evaluate((panelEl, tnormsArg) => {
    const N = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const keep = label => tnormsArg.length && tnormsArg.some(t => N(label).includes(t));
    const opts = Array.from(panelEl.querySelectorAll('mat-option'));
    const toClick = [];
    for (const opt of opts) {
      const txt = (opt.querySelector('.mat-option-text')?.textContent || opt.textContent || '').trim();
      const selected = opt.classList.contains('mat-selected');
      if ((selected && !keep(txt)) || (!selected && keep(txt))) toClick.push(opt);
    }
    const fire = el => ['mousedown','mouseup','click'].forEach(ev =>
      el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
    );
    toClick.forEach(fire);
    return toClick.length;
  }, tnorms).catch(() => -1);

  await page.keyboard.press('Escape').catch(() => {});
  if ((await combo.getAttribute('aria-expanded')) === 'true') await page.mouse.click(0, 0).catch(() => {});
  console.log(`⛳ 코스 선택 완료(${changed >= 0 ? '빠른 모드' : '폴백 사용'})`);
}

/* ============================================
 * 날짜 선택 (+offsetDays)
 * ============================================ */
async function clickDatePlus(page, offsetDays = 14) {
  const today = new Date();
  const target = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offsetDays);
  const targetDay = target.getDate();
  const monthDiff = (target.getFullYear() - today.getFullYear()) * 12 + (target.getMonth() - today.getMonth());

  // 월 이동
  for (let i = 0; i < monthDiff; i++) {
    const forward = page.locator('#Forward').first();
    if (await forward.isVisible().catch(() => false)) {
      await forward.click().catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  const cell = page.locator('span.day-background-upper.is-visible', { hasText: String(targetDay) }).first();
  await cell.waitFor({ timeout: 8000 });
  await cell.click();
  console.log(`📅 날짜 선택 완료 → ${target.toISOString().slice(0,10)}`);
  await closeOverlayIfAny(page);
}

/* ============================================
 * 정밀 타이밍 로그인 (America/Chicago)
 * ============================================ */
async function preciseLoginClick(page) {
  const loginBtn = page.locator('button:has-text("Login"), button[type="submit"]').first();
  await loginBtn.waitFor({ timeout: 10000 });

  const targetCST = DateTime.fromISO(LOGIN_TIME_CST, { zone: 'America/Chicago' });
  if (!targetCST.isValid) throw new Error(`LOGIN_TIME_CST이 유효하지 않습니다.`);
  const targetEpoch = targetCST.toUTC().toMillis();

  console.log('⏳ 로그인 예약 대기 중...');
  const fmt = 'yyyy-LL-dd HH:mm:ss.SSS';
  console.log(`🕐 목표시각(CST): ${targetCST.toFormat(fmt)}`);

  let diff = targetEpoch - Date.now();
  while (diff > 1200) {
    process.stdout.write(`\r⌛ ${Math.ceil(diff / 1000)}초 남음...`);
    await sleep(Math.min(diff - 1000, 800));
    diff = targetEpoch - Date.now();
  }

  const spinMs = 100;
  while (Date.now() < targetEpoch - spinMs) await sleep(10);
  const targetNs = process.hrtime.bigint() + BigInt((targetEpoch - Date.now()) * 1e6);
  while (process.hrtime.bigint() < targetNs) {}

  const before = Date.now();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    loginBtn.click()
  ]);
  const after = Date.now();

  const skew = Math.round(after - targetEpoch);
  console.log(`✅ 로그인 클릭 완료 (지연: ${skew} ms)`);
}

/* ============================================
 * MAIN
 * ============================================ */
async function run() {
  const browser = await chromium.launch({ headless: HEADLESS !== 'false' });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });
  const page = await context.newPage();
  await stabilizePage(page);

  try {
    console.log('✅ 브라우저 실행 및 로그인 페이지 접속');
    await page.goto('https://rtjmembers.cps.golf/onlineresweb/auth/verify-email', { waitUntil: 'networkidle' });

    // 1️⃣ 이메일 입력
    await page.fill('input[name="username"]', RTJ_EMAIL);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click('button:has-text("Next"), button[type="submit"]'),
    ]);

    // 2️⃣ 비밀번호 입력
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await page.fill('input[type="password"]', RTJ_PASSWORD);

    // 3️⃣ 로그인 시각 맞춰 클릭
    if (LOGIN_TIME_CST) await preciseLoginClick(page);
    else {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }),
        page.click('button:has-text("Login"), button[type="submit"]'),
      ]);
      console.log('🔓 로그인 성공');
    }

    // 4️⃣ 검색 페이지 이동
    await page.goto('https://rtjmembers.cps.golf/onlineresweb/search-teetime', { waitUntil: 'networkidle' });
    console.log('📍 티타임 검색 페이지 진입');
    await closeOverlayIfAny(page);

    // 5️⃣ 코스 필터
    const courses = parseCourseNames(COURSE_NAME);
    if (courses.length) await selectCourseFast(page, courses);

    // 6️⃣ 날짜 선택 (+14일)
    await clickDatePlus(page, 14);

    if (KEEP_OPEN === 'true') {
      console.log('🟦 KEEP_OPEN=true → 종료하지 않고 대기 (Ctrl+C)');
      await page.waitForEvent('close');
    }
  } catch (err) {
    console.error('❌ 오류 발생:', err.message);
    await page.screenshot({ path: 'error.png' }).catch(() => {});
  } finally {
    if (KEEP_OPEN === 'true') console.log('⏸ 브라우저 유지');
    else await browser.close();
  }
}

run();
