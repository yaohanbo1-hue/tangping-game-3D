// 探针 2：波次 9-13 的悬崖在哪？看床血/门血/敌人构成
const PW = 'C:/Users/hambu/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium } = require(PW);

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto('http://localhost:5273/', { waitUntil: 'load' });
  await page.waitForFunction(() => !!globalThis.__TANGPING3D__, null, { timeout: 30000 });

  const out = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.reset();
    T.grant(99999999, 99999999, 999999);
    const TYPES = ['turret', 'frost', 'laser', 'missile', 'prism', 'tesla'];
    const cols = 6, rows = 5;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) T.build(TYPES[(r * cols + c) % TYPES.length], c, r);
    for (const b of T.gb.buildings) {
      T.towerLayer.select(b);
      for (let i = 0; i < 40; i++) { const bf = b.level; T.towerLayer.upgradeSelected(); if (b.level === bf) break; }
    }
    const rowsLog = [];
    for (let w = 1; w <= 20; w++) {
      T.startWave();
      T.flushDialogs();
      let peak = 0;
      for (let i = 0; i < 60; i++) {
        T.tick(300);
        const s = T.snapshot();
        peak = Math.max(peak, s.alive);
        if (s.state !== 'wave' || s.gameOver || s.won) break;
      }
      T.flushDialogs();
      const s = T.snapshot();
      rowsLog.push({
        w: s.wave, bed: `${s.bed.hp}/${s.bed.maxHp}`,
        doors: s.doors.map((d) => d.hp).join(','),
        broken: s.doors.filter((d) => d.broken).length,
        peakAlive: peak, kills: s.kills, dmg: s.dmg,
        over: s.gameOver, won: s.won,
      });
      if (s.gameOver || s.won) break;
    }
    return { rowsLog, buildLevels: T.gb.buildings.map((b) => b.level) };
  });

  console.log('buildLevels:', JSON.stringify(out.buildLevels));
  console.log('w   bed        doors            broken peak kills  dmg      over');
  for (const r of out.rowsLog) {
    console.log(`${String(r.w).padStart(2)}  ${r.bed.padEnd(10)} ${r.doors.padEnd(16)} ${String(r.broken).padEnd(6)} ${String(r.peakAlive).padEnd(4)} ${String(r.kills).padEnd(6)} ${String(r.dmg).padEnd(8)} ${r.over ? 'DEAD' : ''}${r.won ? 'WON' : ''}`);
  }
  await browser.close();
})();
