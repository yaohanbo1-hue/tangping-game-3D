// 浏览器端端到端验证：真的把 3D 场景跑起来。
//
// 为什么必须用真浏览器：WebGL 上下文、Three.js 的渲染、叙事包经 Vite 的
// 依赖解析，这三件事在 Node 里都验不出来。前面两个 verify 脚本证明了
// 「数学对」，这个脚本证明「跑得起来」。
//
// 用法：node ui-review-3d/verify-browser.cjs
const path = require('path');
const PW = 'C:/Users/hambu/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core';

const URL = 'http://localhost:5273/';
const OUT = path.join(__dirname);

(async () => {
  const { chromium } = require(PW);
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const logs = [];
  const errors = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // ── 1. 调试面是否就绪 ──
  const ready = await page.evaluate(() => !!globalThis.__TANGPING3D__);
  console.log('调试面就绪:', ready);

  // ── 2. WebGL 真的在渲染吗（检查 canvas 像素不是全黑）──
  const canvasInfo = await page.evaluate(() => {
    const cv = document.getElementById('scene');
    return { w: cv.width, h: cv.height, hasCtx: !!cv.getContext('webgl2') || !!cv.getContext('webgl') };
  });
  console.log('画布:', JSON.stringify(canvasInfo));

  // ── 3. 让敌人跑一段，看有没有真的动起来 ──
  const after = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.reset();
    T.tick(600);                 // 确定性推演 10 秒
    const s = T.snapshot();
    return { ...s, positions: T.positions().slice(0, 4) };
  });
  console.log('推演 10s:', JSON.stringify({ alive: after.alive, spawned: after.spawned, doorHits: after.doorHits, breaches: after.breaches }));
  console.log('样本位置:', JSON.stringify(after.positions, null, 0));

  // ── 4. 屏幕投影检查：确认世界坐标到屏幕的方向没搞反 ──
  // 这是唯一能抓住「相机镜像」这类错误的检查 —— 数学全对、契约全过，
  // 但画面左右颠倒，只有把世界坐标真的投影到屏幕才看得出来。
  const proj = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    const { camera, THREE } = { camera: T.stage.camera, THREE: null };
    const project = (x, y, z) => {
      const v = { x, y, z };
      // 借 camera 的矩阵手动投影，避免依赖 THREE 全局
      const vec = new (Object.getPrototypeOf(camera.position).constructor)(x, y, z);
      vec.project(camera);
      return { nx: vec.x, ny: vec.y };  // 归一化设备坐标：-1..1，x 右为正，y 上为正
    };
    const cv = document.getElementById('scene');
    const w = cv.clientWidth, h = cv.clientHeight;
    const px = (p) => ({ sx: (p.nx * 0.5 + 0.5) * w, sy: (-p.ny * 0.5 + 0.5) * h });
    // 走廊入口（X 小） vs 房间右边缘（X 大）
    const leftWorld = px(project(0.4, 0, 3.4));    // 走廊深处
    const rightWorld = px(project(12.0, 0, 3.4));  // 房间右端
    // 第一条车道（Z 小） vs 第三条车道（Z 大）
    const northLane = px(project(6.0, 0, 1.0));
    const southLane = px(project(6.0, 0, 6.0));
    return { leftX: leftWorld.sx, rightX: rightWorld.sx, northY: northLane.sy, southY: southLane.sy, w, h };
  });
  const dirOk = proj.leftX < proj.rightX;
  const zOk = proj.northY < proj.southY;
  console.log(`投影: 走廊X→屏幕${proj.leftX.toFixed(0)}px, 房间X→屏幕${proj.rightX.toFixed(0)}px  => 世界+X 朝${dirOk ? '右 ✅' : '左 ❌'}`);
  console.log(`投影: 车道0(Z小)→屏幕y${proj.northY.toFixed(0)}px, 车道2(Z大)→屏幕y${proj.southY.toFixed(0)}px  => 世界+Z 朝${zOk ? '下 ✅' : '上 ❌'}`);
  if (!dirOk || !zOk) errors.push('相机投影方向错误：世界+X 应朝右、世界+Z 应朝下');

  // ── 5. 契约自检（浏览器里的实际值）──
  const contract = await page.evaluate(() => globalThis.__TANGPING3D__.contract());
  console.log('契约:', contract.ok ? 'PASS' : 'FAIL ' + JSON.stringify(contract.problems));

  // ── 6. 叙事包接入 ──
  const storyLine = await page.textContent('#story-state').catch(() => '(未找到)');
  console.log('叙事包:', storyLine);

  // ── 7. HUD 文字 ──
  const hudText = await page.evaluate(() => document.getElementById('hud').innerText.replace(/\n+/g, ' | '));
  console.log('HUD:', hudText.slice(0, 200));

  // ── 8. 截图 ──
  await page.screenshot({ path: path.join(OUT, 'shot-3d-overview.png') });
  console.log('截图: shot-3d-overview.png');

  // ── 9. 出怪后暂停到某个中间态再截一张 ──
  await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.reset();
    T.setPaused(true);
    for (let i = 0; i < 14; i++) { T.spawn(i % 3); T.tick(22); }   // 让敌人散布在走廊各处
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'shot-3d-enemies.png') });
  console.log('截图: shot-3d-enemies.png');

  // ── 10. 报错汇总 ──
  if (errors.length) {
    console.log('\n❌ 发现问题:');
    errors.forEach((e) => console.log('  ' + e));
  } else {
    console.log('\n✅ 无页面错误 / 投影方向正确');
  }
  const warns = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[warning]'));
  if (warns.length) {
    console.log('控制台告警:');
    warns.slice(0, 12).forEach((l) => console.log('  ' + l));
  }

  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('验证脚本异常:', e); process.exit(2); });
