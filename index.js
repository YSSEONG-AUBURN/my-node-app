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
  LOGIN_TIME_CST,
  TARGET_TIME, // 예: "08:00"
} = process.env;

/* ============ 전역 종료 플래그 (Ctrl+C 시 조용히 종료) ============ */
let shuttingDown = false;
process.once('SIGINT', () => { shuttingDown = true; });
process.once('SIGTERM', () => { shuttingDown = true; });
process.on('unhandledRejection', (err) => { if (!shuttingDown) console.error('UnhandledRejection:', err); });
process.on('uncaughtException', (err) => { if (!shuttingDown) console.error('UncaughtException:', err); });

/* ============ 유틸 ============ */
function parseCourseNames(str) {
  return str ? str.split(/[;,]/).map(s => s.trim()).filter(Boolean) : [];
}
const sleep = ms => new Promise(res => setTimeout(res, ms));

/* ============ 안정화 로그/필터 ============ */
async function stabilizePage(page) {
  const benignConsolePatterns = /(Failed to load resource|net::ERR_FAILED|oauth\/oidc|favicon|analytics|gtag|doubleclick|hotjar)/i;

  page.on('console', msg => {
    const text = msg.text();
    if (benignConsolePatterns.test(text)) return;
    console.log(`[BrowserLog] ${text}`);
  });

  page.on('pageerror', e => console.warn(`⚠️ PageError: ${e.message}`));

  await page.route('**/*', route => {
    const url = route.request().url();
    if (/\.(png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|map)$/i.test(url)) return route.abort().catch(()=>{});
    if (/google-analytics|doubleclick|gtag|hotjar/i.test(url)) return route.abort().catch(()=>{});
    route.continue().catch(()=>{});
  });
}

/* ============ 자동 모달 킬러 (MutationObserver · 방어 포함) ============ */
async function installAutoCloseDialogs(page) {
  await page.addInitScript(() => {
    const tryClose = (root = document) => {
      const host = root.querySelector?.('mat-dialog-container');
      if (!host) return false;
      const buttons = host.querySelectorAll('button, span');
      for (const el of buttons) {
        const txt = (el.textContent || '').trim().toLowerCase();
        if (txt.includes('close') || txt.includes('ok') || txt.includes('got it')) {
          ['mousedown','mouseup','click'].forEach(ev =>
            el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
          );
          return true;
        }
      }
      const backdrop = document.querySelector('.cdk-overlay-backdrop');
      if (backdrop) {
        ['mousedown','mouseup','click'].forEach(ev =>
          backdrop.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
        );
        return true;
      }
      return false;
    };

    const initObserver = () => {
      const rootNode = document?.documentElement;
      if (!rootNode) return false;
      tryClose();
      const obs = new MutationObserver(() => { tryClose(); });
      obs.observe(rootNode, { childList: true, subtree: true });
      window.__autoDialogObserver__ = obs;
      return true;
    };

    if (!initObserver()) {
      window.addEventListener('DOMContentLoaded', () => { initObserver(); }, { once: true });
    }
  });
}

/* ============ 강제 팝업 닫기 (수동 호출용) ============ */
async function forceCloseMatDialog(page, { attempts = 3 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const dialog = page.locator('mat-dialog-container');
    if (!(await dialog.isVisible().catch(() => false))) return false;

    const closed = await page.evaluate(() => {
      const root = document.querySelector('mat-dialog-container');
      if (!root) return false;
      const btns = Array.from(root.querySelectorAll('button, span'));
      for (const el of btns) {
        const txt = (el.textContent || '').trim().toLowerCase();
        if (txt.includes('close') || txt.includes('ok') || txt.includes('got it')) {
          ['mousedown','mouseup','click'].forEach(ev =>
            el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
          );
          return true;
        }
      }
      const backdrop = document.querySelector('.cdk-overlay-backdrop');
      if (backdrop) {
        ['mousedown','mouseup','click'].forEach(ev =>
          backdrop.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
        );
        return true;
      }
      return false;
    });

    if (closed) {
      await page.waitForTimeout(300);
      if (!(await page.locator('mat-dialog-container').isVisible().catch(()=>false))) return true;
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.mouse.click(0, 0).catch(() => {});
    await page.waitForTimeout(250);
  }
  return false;
}

/* ============ 결과 안정화 & 오버레이 제거 ============ */
async function waitForTeeResults(page, { timeout = 12000 } = {}) {
  await Promise.race([
    page.waitForFunction(() => document.querySelectorAll('button.btnStepper').length > 0, { timeout }),
    page.waitForResponse(
      r => {
        try {
          const u = r.url();
          return r.ok() && /tee|sheet|time|availability|search/i.test(u);
        } catch { return false; }
      },
      { timeout }
    ).catch(() => {})
  ]).catch(() => {});
}

async function clearOverlays(page) {
  for (let i = 0; i < 2; i++) {
    await forceCloseMatDialog(page);
    const backdrop = page.locator('.cdk-overlay-backdrop');
    if (await backdrop.isVisible().catch(() => false)) {
      try { await page.keyboard.press('Escape'); } catch {}
      try { await page.mouse.click(0, 0); } catch {}
      await page.waitForTimeout(120);
    } else break;
  }
}

/* ============ 날짜 선택 (+offsetDays, 안정화 포함) ============ */
async function clickDatePlus(page, offsetDays = 14) {
  const today = new Date();
  const target = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offsetDays);
  const targetDay = target.getDate();
  const monthDiff = (target.getFullYear() - today.getFullYear()) * 12 + (target.getMonth() - today.getMonth());

  console.log(`📅 날짜 선택 시작: ${target.toISOString().slice(0,10)} (오늘로부터 ${offsetDays}일 후)`);

  for (let i = 0; i < monthDiff; i++) {
    const forward = page.locator('#Forward').first();
    if (await forward.isVisible().catch(() => false)) {
      await forward.click().catch(() => {});
      await page.waitForTimeout(400);
      await forceCloseMatDialog(page);
    }
  }

  const cell = page.locator('span.day-background-upper.is-visible', { hasText: String(targetDay) }).first();
  await cell.waitFor({ timeout: 8000 });
  await cell.scrollIntoViewIfNeeded().catch(() => {});
  await cell.click({ timeout: 2000 }).catch(() => {});
  console.log(`✅ 날짜 클릭 완료: ${target.toISOString().slice(0,10)}`);

  await sleep(250);
  await forceCloseMatDialog(page);

  await waitForTeeResults(page, { timeout: 10000 });
  console.log('🕐 날짜 선택 후 UI 안정화 완료');
}

/* ============ 코스 선택 (Deselect All 활용: 기존 방식 유지) ============ */
async function selectCoursesUsingDeselectAll(page, targets = []) {
  if (!targets.length) return;
  console.log('🎯 코스 선택 시작:', targets.join(', '));

  const combo = page.locator('#mat-select-2');
  await combo.waitFor({ timeout: 10000 });
  if ((await combo.getAttribute('aria-expanded')) !== 'true') {
    await combo.click();
    await page.waitForTimeout(150);
  }

  const panel = page.locator('.cdk-overlay-pane .mat-select-panel').last();
  await panel.waitFor({ timeout: 10000 });

  const deselectAll = panel.locator('.mat-option-text', { hasText: /deselect|unselect|clear/i }).first();
  if (await deselectAll.isVisible().catch(() => false)) {
    await deselectAll.click().catch(()=>{});
    await page.waitForTimeout(150);
    console.log('🔄 전체 해제 완료 ("Deselect All")');
  }

  for (const course of targets) {
    const option = panel.locator('.mat-option-text', { hasText: course }).first();
    if (await option.isVisible().catch(() => false)) {
      await option.click().catch(()=>{});
      await page.waitForTimeout(100);
      console.log(`✅ 선택: ${course}`);
    } else {
      console.warn(`⚠️ 코스 "${course}" 찾지 못함`);
    }
  }

  await page.keyboard.press('Escape').catch(() => {});
  if ((await combo.getAttribute('aria-expanded').catch(() => 'false')) === 'true') {
    await page.mouse.click(0, 0).catch(() => {});
  }
  console.log('⛳ 코스 선택 완료');
}

/* ============ 수동 클릭 요청 & 하이라이트 ============ */
async function promptManualClick(page, hhmm, { waitMs = 60000 } = {}) {
  const msg = `🔴 자동 클릭실패 — 지금 브라우저에서 "${hhmm}" 티타임을 직접 클릭하세요. (최대 ${Math.round(waitMs/1000)}초 대기)`;
  console.log('\x07');
  console.log(msg);

  await page.evaluate((hhmm) => {
    const targets = [];
    const timeTexts = [hhmm.replace(/^0/, ''), hhmm];
    document.querySelectorAll('button.btnStepper').forEach(btn => {
      const tm = btn.querySelector('time');
      const text = (tm?.textContent || '').trim();
      const attr = tm?.getAttribute('datetime') || '';
      if (timeTexts.includes(text) || attr.includes(`T${hhmm}`)) targets.push(btn);
    });
    const styleId = '__tee_highlight_style__';
    if (!document.getElementById(styleId)) {
      const s = document.createElement('style');
      s.id = styleId;
      s.textContent = `
        @keyframes teeFlash { 0%{outline-color: red;} 50%{outline-color: transparent;} 100%{outline-color: red;} }
        .__tee_highlight__ { outline: 3px solid red !important; border-radius: 10px; animation: teeFlash 1s ease-in-out infinite; }
      `;
      document.head.appendChild(s);
    }
    targets.forEach(el => el.classList.add('__tee_highlight__'));
    return targets.length;
  }, hhmm).catch(()=>{});

  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
    page.waitForSelector('mat-dialog-container, .cdk-overlay-backdrop', { state: 'attached', timeout: waitMs }).catch(() => {}),
    page.waitForTimeout(waitMs)
  ]);

  await page.evaluate(() => {
    document.querySelectorAll('.__tee_highlight__').forEach(el => el.classList.remove('__tee_highlight__'));
  }).catch(()=>{});
}

/* ============ 빠른 후보 탐색 (콜로그/대기 없음) ============ */
async function findTeeCandidateFast(page, hhmm) {
  const hhmmNoPad = hhmm.replace(/^0/, '');
  const byDatetime = page.locator('button.btnStepper', {
    has: page.locator(`time[datetime*="T${hhmm}"]`),
  }).first();
  const el1 = await byDatetime.elementHandle({ timeout: 0 }).catch(() => null);
  if (el1) return byDatetime;

  const byText = page.locator('button.btnStepper', {
    has: page.locator('time', { hasText: hhmmNoPad }),
  }).first();
  const el2 = await byText.elementHandle({ timeout: 0 }).catch(() => null);
  if (el2) return byText;

  const candidates = await page.locator('button.btnStepper time').all().catch(() => []);
  for (const t of candidates) {
    const txt = (await t.textContent().catch(() => '') || '').trim();
    if (txt === hhmmNoPad || txt === hhmm) {
      return t.locator('xpath=ancestor::button[contains(@class,"btnStepper")]');
    }
  }
  return null;
}

/* ============ 티타임 클릭 (즉시 시도, 실패 즉시 수동 큐) ============ */
async function clickTeeTimeOnce(page, timeStr) {
  if (!timeStr) {
    console.warn('⚠️ TARGET_TIME 이 지정되지 않았습니다.');
    return;
  }

  const hhmm = timeStr.trim();
  console.log(`🕐 지정 시간 티타임 즉시 클릭 시도: ${hhmm}`);

  const deadline = Date.now() + 300;
  let target = await findTeeCandidateFast(page, hhmm);
  while (!target && Date.now() < deadline) {
    await page.waitForTimeout(50);
    target = await findTeeCandidateFast(page, hhmm);
  }

  if (!target) {
    await promptManualClick(page, hhmm, { waitMs: 60000 });
    return;
  }

  try {
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ trial: true }).catch(() => {});
    await clearOverlays(page);
    await target.click({ delay: 10 });
    console.log(`✅ 티타임 클릭 성공: ${hhmm}`);
    await clearOverlays(page);
  } catch {
    try {
      const box = await target.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 24));
        await page.mouse.down(); await page.mouse.up();
        console.log(`✅ 좌표 클릭 성공: ${hhmm}`);
        await clearOverlays(page);
        return;
      }
    } catch {}
    await promptManualClick(page, hhmm, { waitMs: 60000 });
  }
}

/* ============ 정밀 로그인 타이밍 ============ */
async function preciseLoginClick(page) {
  const loginBtn = page.locator('button:has-text("Login"), button[type="submit"]').first();
  await loginBtn.waitFor({ timeout: 10000 });

  const targetCST = DateTime.fromISO(LOGIN_TIME_CST, { zone: 'America/Chicago' });
  if (!targetCST.isValid) throw new Error(`LOGIN_TIME_CST이 유효하지 않습니다.`);

  const targetEpoch = targetCST.toUTC().toMillis();
  console.log(`⏳ 로그인 예약 중 → 목표시각(CST): ${targetCST.toFormat('yyyy-LL-dd HH:mm:ss.SSS')}`);

  let diff = targetEpoch - Date.now();
  while (diff > 1000) {
    process.stdout.write(`\r⌛ ${Math.ceil(diff / 1000)}초 남음...`);
    await sleep(Math.min(diff - 900, 800));
    diff = targetEpoch - Date.now();
  }
  while (Date.now() < targetEpoch - 50) await sleep(10);

  const before = Date.now();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    loginBtn.click(),
  ]);
  const after = Date.now();
  console.log(`✅ 로그인 클릭 완료 (지연 ${Math.round(after - targetEpoch)}ms)`);
}

/* ============ MAIN ============ */
async function run() {
  const browser = await chromium.launch({ headless: HEADLESS !== 'false' });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    timezoneId: 'America/Chicago',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });
  const page = await context.newPage();

  await installAutoCloseDialogs(page); // 모달 킬러 선 설치
  await stabilizePage(page);

  try {
    console.log('✅ 로그인 페이지 접속');
    await page.goto('https://rtjmembers.cps.golf/onlineresweb/auth/verify-email', { waitUntil: 'networkidle' });

    // 로그인
    await page.fill('input[name="username"]', RTJ_EMAIL);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click('button:has-text("Next"), button[type="submit"]'),
    ]);
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await page.fill('input[type="password"]', RTJ_PASSWORD);

    if (LOGIN_TIME_CST) await preciseLoginClick(page);
    else {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }),
        page.click('button:has-text("Login"), button[type="submit"]'),
      ]);
      console.log('🔓 로그인 완료');
    }

    await forceCloseMatDialog(page); // 로그인 직후 모달 닫기

    // 검색 페이지 이동
    await page.goto('https://rtjmembers.cps.golf/onlineresweb/search-teetime', { waitUntil: 'networkidle' });
    console.log('📍 티타임 검색 페이지 도착');
    await forceCloseMatDialog(page);

    // 날짜 → 코스 → 시간
    await clickDatePlus(page, 14);

    const courses = parseCourseNames(COURSE_NAME);
    if (courses.length) await selectCoursesUsingDeselectAll(page, courses);

    await clickTeeTimeOnce(page, TARGET_TIME);

    if (KEEP_OPEN === 'true') {
      console.log('🟦 KEEP_OPEN=true → 창 유지 중 (Ctrl+C로 종료)');
      await new Promise((resolve) => {
        const done = () => resolve();
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
        page.once('close', done);
        context.once('close', done);
        browser.once('disconnected', done);
      });
    }
  } catch (err) {
    if (!shuttingDown) {
      console.error('❌ 오류:', err.message);
      await page.screenshot({ path: 'error.png' }).catch(() => {});
    }
  } finally {
    if (KEEP_OPEN === 'true') {
      console.log('⏸ 브라우저 유지 종료');
    } else {
      await browser.close().catch(()=>{});
    }
  }
}

run();
