// 探针 6：升级为什么在第 2 级就停？逐个条件打点
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
    // ⚠️ T.build() 返回的是 {ok,type,col,row} 结果对象，**不是**建筑本体。
    //    要拿建筑必须从 T.gb.buildings 里取（这一点踩过一次坑：
    //    把结果对象当建筑传给 select() → selectedInfo() 读 stub.def.stat → 崩）。
    T.build('turret', 2, 2);
    const b = T.gb.buildings[0];
    const trace = [];
    for (let i = 0; i < 30; i++) {
      T.towerLayer.select(b);
      const before = b.level;
      T.towerLayer.upgradeSelected();
      trace.push({ i, lv: b.level, maxLv: b.def.maxLv, hasStat: typeof b.def.stat === 'function', gold: Math.round(T.gb.gold), power: Math.round(T.gb.power), changed: b.level !== before });
      if (b.level === before) break;
    }
    return {
      trace,
      numBuildings: T.gb.buildings.length,
      selectedIsB: T.towerLayer.selected === b,
      // 造 30 个，看是不是"造到后面没钱了"
      all: (() => {
        const TYPES = ['turret', 'frost', 'laser', 'missile', 'prism', 'tesla'];
        for (let r = 0; r < 5; r++) for (let c = 0; c < 6; c++) { if (r === 2 && c === 2) continue; T.build(TYPES[(r * 6 + c) % 6], c, r); }
        return { built: T.gb.buildings.length, gold: Math.round(T.gb.gold), power: Math.round(T.gb.power) };
      })(),
    };
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})();
