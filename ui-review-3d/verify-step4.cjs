// 第 4 步浏览器端端到端验证：在真浏览器里**打完一波**。
//
// 为什么必须有这个脚本：
//   前五个 verify 脚本证明了「规则层的数学对」和「架构边界没破」，
//   但它们都在纯 Node 里跑 —— 那里没有 three、没有 WebGL、没有真实
//   ctx.xyOf 的米/像素换算、没有 shots.js 的子弹飞行。
//
//   第 4 步的目标是「能玩一局」，所以必须**在浏览器里真的打一场**：
//     造塔 → 开波 → 塔开火 → 子弹飞 → 命中扣血 → 击杀 → 结算 → 进入备战
//
// 用法：node ui-review-3d/verify-step4.cjs
const path = require('path');
const PW = 'C:/Users/hambu/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core';

const URL = 'http://localhost:5273/';
const OUT = __dirname;

let fail = 0, pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`); }
};

(async () => {
  const { chromium } = require(PW);
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const errors = [];
  const consoleErrs = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);

  console.log('\n── A. 启动 ──');
  ok('调试面就绪', await page.evaluate(() => !!globalThis.__TANGPING3D__));
  const ver = await page.evaluate(() => globalThis.__TANGPING3D__.version);
  // ⚠️ 这里**不能**断言精确等于 'step4'。step4 是第 4 步的验收套件，
  //    但版本号会随着后续步骤前进（现在是 step6）。它真正关心的是
  //    「第 4 步的能力还在」—— 所以用「stepN 且 N ≥ 4」来判断。
  //    写成 === 'step4' 只会让每一步都误报一次回归。
  const stepNo = Number((/step(\d+)/.exec(ver) || [])[1] || 0);
  ok('版本不低于 step4（第 4 步能力仍在）', stepNo >= 4, ver);
  const contract = await page.evaluate(() => globalThis.__TANGPING3D__.contract());
  ok('世界坐标契约通过', contract.ok, contract.ok ? '' : JSON.stringify(contract.problems));
  ok('无未捕获异常', errors.length === 0, errors.join(' | '));

  console.log('\n── B. 建造（走真实的 makeBuilding + 扣费）──');
  const build = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.reset();
    T.grant(20000, 20000, 500);
    const before = T.snapshot();
    const r1 = T.build('turret', 0, 0);
    const r2 = T.build('turret', 0, 2);
    const r3 = T.build('frost', 1, 1);
    const after = T.snapshot();
    return { r1, r2, r3, goldBefore: before.gold, goldAfter: after.gold, buildings: after.buildings };
  });
  ok('造出 3 座塔', build.buildings === 3, `buildings=${build.buildings}`);
  ok('建造扣了金币', build.goldAfter < build.goldBefore, `${build.goldBefore} → ${build.goldAfter}`);
  ok('重复占格被拒', await page.evaluate(() => !globalThis.__TANGPING3D__.build('turret', 0, 0).ok));

  console.log('\n── C. 开波 + 出怪（rules/wave.js 真编排）──');
  const wave = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    const s0 = T.snapshot();
    T.startWave();
    const s1 = T.snapshot();
    T.tick(90);   // 1.5 秒，足够出几只
    const s2 = T.snapshot();
    return { wave0: s0.wave, state0: s0.state, wave1: s1.wave, state1: s1.state, alive2: s2.alive };
  });
  ok('开波后 wave=1', wave.wave1 === 1, `wave=${wave.wave1}`);
  ok('开波后 state=wave', wave.state1 === 'wave', wave.state1);
  ok('出怪了', wave.alive2 > 0, `alive=${wave.alive2}`);

  console.log('\n── D. 打完一波：塔开火 → 子弹飞 → 击杀 → 结算 ──');
  const fight = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    const mid = T.tick(600);          // 再跑 10 秒
    const late = T.tick(3600);        // 再跑 60 秒，足够清完第一波
    const shots = T.shotLayer.stats();
    return { mid, late, shots };
  });
  ok('塔造成了伤害', fight.late.dmg > 0, `dmg=${fight.late.dmg}`);
  ok('出现了击杀', fight.late.kills > 0, `kills=${fight.late.kills}`);
  ok('弹道飞行器真的发了子弹', fight.shots.spawned > 0, JSON.stringify(fight.shots));
  ok('弹道真的命中了', fight.shots.hits > 0, `hits=${fight.shots.hits}`);
  // ⚠️ 规则层的备战期状态名是 'build'（core.js:1795），不是 'prep'。
  //    这里两个都算通过 —— 别按自己想象的命名去断言。
  ok('第一波清空后进入备战期', fight.late.state === 'build' || fight.late.state === 'prep',
    `state=${fight.late.state}`);
  ok('备战期有倒计时', fight.late.prepTimer > 0, `prepTimer=${fight.late.prepTimer}`);
  ok('击杀给了金币', fight.late.gold > 0, `gold=${fight.late.gold}`);
  ok('击杀给了灵魂', fight.late.souls > 0, `souls=${fight.late.souls}`);

  console.log('\n── E. 经济与波次推进 ──');
  const econ = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    const a = T.snapshot();
    T.tick(600);                    // 备战期 10 秒 → 应自动开第 2 波
    const b = T.snapshot();
    T.tick(2400);                   // 第 2 波打一会
    const c = T.snapshot();
    return { a, b, c };
  });
  ok('备战期结束后自动开新波', econ.b.wave >= 2, `wave=${econ.b.wave} → ${econ.c.wave}`);
  ok('金币持续增长（床 + 矿机）', econ.c.gold >= econ.a.gold, `${econ.a.gold} → ${econ.c.gold}`);

  console.log('\n── F. 弹道在飞行中（视觉通道真的在工作）──');
  const flying = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    // 造一排机枪塔 + 大量敌人，跑一小步，抓「正在飞」的子弹
    T.reset();
    T.grant(90000, 90000, 900);
    for (let r = 0; r < 5; r++) for (let c = 0; c < 6; c++) T.build('turret', c, r);
    T.startWave();
    let maxFlying = 0;
    for (let i = 0; i < 40; i++) { T.tick(12); maxFlying = Math.max(maxFlying, T.snapshot().flying); }
    return { maxFlying, stats: T.shotLayer.stats() };
  });
  ok('一帧内出现多颗在飞的子弹', flying.maxFlying > 0, `maxFlying=${flying.maxFlying}`);
  ok('子弹有命中结算', flying.stats.hits > 0, `hits=${flying.stats.hits}`);

  console.log('\n── G. 敌人位置不变量（去像素化的硬约束）──');
  const posOk = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    const ps = T.positions();
    return {
      all: ps.every((p) => !Number.isNaN(p.x) && !Number.isNaN(p.z) && p.progress >= 0 && p.progress <= 1),
      n: ps.length,
      sample: ps.slice(0, 3),
    };
  });
  ok('所有敌人位置可派生且 progress∈[0,1]', posOk.all, `n=${posOk.n}`);
  ok('敌人对象上没有 x/y 字段', await page.evaluate(() => globalThis.__TANGPING3D__.gb.enemies.every((e) => !('x' in e) && !('y' in e))));

  console.log('\n── H. 投影方向（画面没镜像）──');
  const proj = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    const cam = T.stage.camera;
    const V = Object.getPrototypeOf(cam.position).constructor;
    const project = (x, y, z) => { const v = new V(x, y, z); v.project(cam); return v; };
    const cv = document.getElementById('scene');
    const w = cv.clientWidth, h = cv.clientHeight;
    const px = (v) => ({ sx: (v.x * 0.5 + 0.5) * w, sy: (-v.y * 0.5 + 0.5) * h });
    const l = px(project(0.4, 0, 3.4)), r = px(project(12.0, 0, 3.4));
    const n = px(project(6.0, 0, 1.0)), s = px(project(6.0, 0, 6.0));
    return { lx: l.sx, rx: r.sx, ny: n.sy, sy: s.sy };
  });
  ok('世界 +X 朝屏幕右', proj.lx < proj.rx, `${proj.lx.toFixed(0)} < ${proj.rx.toFixed(0)}`);
  ok('世界 +Z 朝屏幕下', proj.ny < proj.sy, `${proj.ny.toFixed(0)} < ${proj.sy.toFixed(0)}`);

  console.log('\n── I. HUD 显示真实状态 ──');
  const hud = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.reset();
    T.grant(3000, 3000, 60);
    T.build('turret', 2, 2);
    T.startWave();
    T.tick(120);
    return document.getElementById('hud').innerText.replace(/\n+/g, ' | ');
  });
  ok('HUD 显示波次', /第\s*\d+\s*波/.test(hud), hud.slice(0, 60));
  ok('HUD 显示金币', /💰/.test(hud));
  ok('HUD 显示床铺血量', /🛏/.test(hud));
  ok('HUD 有建造栏', await page.evaluate(() => document.querySelectorAll('.build-btn').length >= 10),
    `count=${await page.evaluate(() => document.querySelectorAll('.build-btn').length)}`);

  console.log('\n── J. 截图 ──');
  // 摆一个有看头的局面再截图
  await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.reset();
    T.grant(90000, 90000, 900);
    const layout = [
      ['turret', 0, 0], ['turret', 0, 2], ['turret', 0, 4],
      ['frost', 1, 1], ['laser', 1, 3], ['tesla', 2, 0],
      ['flame', 2, 2], ['missile', 2, 4], ['poison', 3, 1],
      ['prism', 3, 3], ['sonic', 4, 2], ['gravity', 4, 0],
    ];
    for (const [t, c, r] of layout) T.build(t, c, r);
    T.startWave();
    T.tick(600);
    T.setPaused(true);
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'shot-step4-battle.png') });
  console.log('  截图: shot-step4-battle.png');

  // 再截一张「选中一座塔、面板打开」的
  await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.towerLayer.select(T.gb.buildings[1]);
    T.setPaused(false);
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'shot-step4-panel.png') });
  console.log('  截图: shot-step4-panel.png');

  console.log('');
  if (errors.length) { console.log('❌ 页面异常:'); errors.forEach((e) => console.log('  ' + e)); }
  if (consoleErrs.length) {
    console.log('控制台错误:');
    consoleErrs.slice(0, 10).forEach((e) => console.log('  ' + e));
  }
  console.log(fail === 0 && errors.length === 0 ? `✅ 全部通过  ——  通过 ${pass} / 失败 ${fail}` : `❌ 有失败项  ——  通过 ${pass} / 失败 ${fail}`);

  await browser.close();
  process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
})().catch((e) => { console.error('验证脚本异常:', e); process.exit(2); });
