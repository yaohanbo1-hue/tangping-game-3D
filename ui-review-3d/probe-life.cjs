// 探针 3：敌人为什么一出生就死？看每 tick 的敌人数量与血量
const PW = 'C:/Users/hambu/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium } = require(PW);

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto('http://localhost:5273/', { waitUntil: 'load' });
  await page.waitForFunction(() => !!globalThis.__TANGPING3D__, null, { timeout: 30000 });

  const out = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.reset();
    T.grant(99999999, 99999999, 999999);
    // 只造一座塔，看它能不能正常打死怪
    T.build('turret', 3, 2);
    T.startWave();
    const frames = [];
    const spawns = [];
    for (let i = 0; i < 60; i++) {
      T.tick(100);
      const s = T.snapshot();
      const es = T.gb.enemies.map((e) => ({
        id: e.id, lane: e.lane, p: +e.progress.toFixed(3), hp: Math.round(e.hp), st: e.state, dead: !!e.dead,
      }));
      frames.push({ i, n: s.alive, kills: s.kills, e: es.slice(0, 3) });
      if (s.state !== 'wave') break;
    }
    return {
      frames: frames.slice(0, 30),
      spawnSeen: T.gb.stats,
      maxSimultaneous: Math.max(...frames.map((f) => f.n)),
      totalKills: frames.length ? frames[frames.length - 1].kills : 0,
    };
  });
  console.log('maxSimultaneous =', out.maxSimultaneous, ' totalKills =', out.totalKills);
  console.log('stats =', JSON.stringify(out.spawnSeen));
  for (const f of out.frames) console.log(`t${String(f.i).padStart(2)} n=${f.n} kills=${f.kills} ${JSON.stringify(f.e)}`);
  await browser.close();
})();
