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
  TARGET_TIME
} = process.env;

let shuttingDown = false;
process.once('SIGINT', () => shuttingDown = true);
process.once('SIGTERM', () => shuttingDown = true);
process.on('unhandledRejection', e => { if(!shuttingDown) console.error(e); });
process.on('uncaughtException', e => { if(!shuttingDown) console.error(e); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
function parseCourseNames(str) { return str ? str.split(/[;,]/).map(s=>s.trim()).filter(Boolean) : []; }

/* ================= 오버레이 제거 ================= */
async function clearOverlays(page){
  for(let i=0;i<3;i++){
    const overlay = page.locator('.cdk-overlay-backdrop');
    if(await overlay.isVisible().catch(()=>false)){
      await page.evaluate(()=>{ const o=document.querySelector('.cdk-overlay-backdrop'); if(o)o.remove(); });
      await page.keyboard.press('Escape').catch(()=>{});
      await page.mouse.click(0,0).catch(()=>{});
      await page.waitForTimeout(120);
    } else break;
  }
}

/* ================= 티타임 렌더링 안정화 ================= */
async function waitForTeeResults(page, timeout=12000){
  await Promise.race([
    page.waitForFunction(()=>document.querySelectorAll('button.btnStepper').length>0,{timeout}),
    page.waitForResponse(r=>{
      try{
        const u = r.url();
        return r.ok() && /tee|sheet|time|availability|search/i.test(u);
      }catch{return false;}
    },{timeout}).catch(()=>{})
  ]).catch(()=>{});
}

/* ================= 날짜 선택 ================= */
async function clickDatePlus(page, offsetDays=14){
  const today=new Date();
  const target=new Date(today.getFullYear(), today.getMonth(), today.getDate()+offsetDays);
  const targetDay = target.getDate();
  const monthDiff = (target.getFullYear()-today.getFullYear())*12 + (target.getMonth()-today.getMonth());

  console.log(`📅 날짜 선택: ${target.toISOString().slice(0,10)} (오늘로부터 ${offsetDays}일 후)`);

  for(let i=0;i<monthDiff;i++){
    const forward = page.locator('#Forward').first();
    if(await forward.isVisible().catch(()=>false)){
      await forward.click().catch(()=>{});
      await page.waitForTimeout(400);
      await clearOverlays(page);
    }
  }
  const cell = page.locator('span.day-background-upper.is-visible',{hasText:String(targetDay)}).first();
  await cell.waitFor({timeout:8000});
  await cell.scrollIntoViewIfNeeded().catch(()=>{});
  await cell.click({timeout:2000}).catch(()=>{});
  await sleep(250);
  await clearOverlays(page);

  // 날짜 선택 후 UI 안정화
  await waitForTeeResults(page, 10000);
  console.log('🕐 날짜 선택 후 UI 안정화 완료');
}

/* ================= 코스 선택 ================= */
async function selectCourses(page, targets=[]){
  if(!targets.length) return;
  console.log('🎯 코스 선택 시작:', targets.join(', '));

  const combo = page.locator('#mat-select-2');
  await combo.waitFor({timeout:10000});
  if((await combo.getAttribute('aria-expanded'))!=='true') await combo.click();
  const panel = page.locator('.cdk-overlay-pane .mat-select-panel').last();
  await panel.waitFor({timeout:10000});

  const deselectAll = panel.locator('.mat-option-text',{hasText:/deselect|unselect|clear/i}).first();
  if(await deselectAll.isVisible().catch(()=>false)){ 
    await deselectAll.click().catch(()=>{}); 
    await page.waitForTimeout(150); 
    console.log('🔄 전체 해제 완료 ("Deselect All")');
  }

  for(const course of targets){
    const opt = panel.locator('.mat-option-text',{hasText:course}).first();
    if(await opt.isVisible().catch(()=>false)){
      await opt.click().catch(()=>{});
      await page.waitForTimeout(100);
      console.log(`✅ 선택: ${course}`);
    } else console.warn(`⚠️ 코스 "${course}" 찾지 못함`);
  }

  await page.keyboard.press('Escape').catch(()=>{});
}

/* ================= 티타임 버튼 찾기 ================= */
async function findTeeCandidate(page, hhmm){
  const hhmmNoPad = hhmm.replace(/^0/,'');
  const byDatetime = page.locator('button.btnStepper',{has:page.locator(`time[datetime*="T${hhmm}"]`)}).first();
  if(await byDatetime.elementHandle({timeout:0}).catch(()=>null)) return byDatetime;
  const byText = page.locator('button.btnStepper',{has:page.locator('time',{hasText:hhmmNoPad})}).first();
  if(await byText.elementHandle({timeout:0}).catch(()=>null)) return byText;
  return null;
}

/* ================= 티타임 클릭 ================= */
async function clickTeeTime(page, timeStr){
  if(!timeStr) return console.warn('⚠️ TARGET_TIME 미지정');
  console.log(`🕐 티타임 클릭 시도: ${timeStr}`);
  await clearOverlays(page);
  let target = await findTeeCandidate(page, timeStr);
  if(!target){ console.warn('⚠️ 버튼 못찾음, 수동 클릭 필요'); return; }
  try{
    await target.scrollIntoViewIfNeeded().catch(()=>{});
    await target.click({delay:10});
    await clearOverlays(page);
    console.log(`✅ 티타임 클릭 성공: ${timeStr}`);
  }catch{
    console.warn('⚠️ 클릭 실패, 수동 클릭 필요');
  }
}

/* ================= 로그인 타이밍 ================= */
async function preciseLoginClick(page){
  const btn = page.locator('button:has-text("Login"),button[type="submit"]').first();
  await btn.waitFor({timeout:10000});
  if(!LOGIN_TIME_CST) return;
  const target = DateTime.fromISO(LOGIN_TIME_CST,{zone:'America/Chicago'});
  const targetEpoch = target.toUTC().toMillis();
  let diff = targetEpoch-Date.now();
  while(diff>1000){ await sleep(Math.min(diff-900,800)); diff=targetEpoch-Date.now(); }
  while(Date.now()<targetEpoch-50) await sleep(10);
  await Promise.all([page.waitForNavigation({waitUntil:'networkidle'}), btn.click()]);
  console.log(`✅ 로그인 클릭 완료 (목표 ${target.toFormat('HH:mm:ss')})`);
}

/* ================= MAIN ================= */
async function run(){
  const startTime = Date.now();
  const browser = await chromium.launch({headless:HEADLESS!=='false'});
  const context = await browser.newContext({viewport:{width:1366,height:900}, timezoneId:'America/Chicago'});
  const page = await context.newPage();

  try{
    console.log('✅ 로그인 페이지 접속');
    await page.goto('https://rtjmembers.cps.golf/onlineresweb/auth/verify-email',{waitUntil:'networkidle'});
    await page.fill('input[name="username"]',RTJ_EMAIL);
    await Promise.all([page.waitForNavigation({waitUntil:'networkidle'}), page.click('button:has-text("Next"),button[type="submit"]')]);
    await page.fill('input[type="password"]',RTJ_PASSWORD);

    if(LOGIN_TIME_CST) await preciseLoginClick(page);
    else await Promise.all([page.waitForNavigation({waitUntil:'networkidle'}), page.click('button:has-text("Login"),button[type="submit"]')]);

    await clearOverlays(page);

    await page.goto('https://rtjmembers.cps.golf/onlineresweb/search-teetime',{waitUntil:'networkidle'});
    await clearOverlays(page);

    await clickDatePlus(page,14);

    const courses = parseCourseNames(COURSE_NAME);
    if(courses.length) await selectCourses(page,courses);

    await clickTeeTime(page,TARGET_TIME);

    console.log(`⏱ 전체 소요 시간: ${((Date.now()-startTime)/1000).toFixed(2)}초`);

    if(KEEP_OPEN==='true'){
      console.log('🟦 창 유지 중');
      await new Promise(r=>{
        const done = ()=>r();
        process.once('SIGINT',done);
        process.once('SIGTERM',done);
        page.once('close',done);
        context.once('close',done);
        browser.once('disconnected',done);
      });
    }

  }catch(e){ 
    if(!shuttingDown){ 
      console.error(e); 
      await page.screenshot({path:'error.png'}).catch(()=>{}); 
    } 
  }
  finally{ if(KEEP_OPEN!=='true') await browser.close().catch(()=>{}); }
}

run();
