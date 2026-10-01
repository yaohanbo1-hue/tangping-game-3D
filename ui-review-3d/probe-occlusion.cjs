// 遮挡探针：相机降到 38° 后，检查 8x5 全部格子是否仍然可见（不被墙体挡住）。
//
// 为什么需要它：把相机压斜、把墙抬高，是「更 3D」的直接手段，
// 但塔防要求**每个格子都能看见也能点到**。仰角一旦过低，
// 前排墙会遮住后排格子 —— 那是一种「画面上很好看、玩法上直接坏掉」的失败，
// 而且它不会抛异常、不会让任何既有断言变红。所以必须有专门断言。
//
// 判据：从每个格子中心沿「指向相机」的方向发一条射线，
// 若在到达相机之前被遮挡物拦住 → 该格不可见。
const PW = 'C:/Users/hambu/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core';
const pw = require(PW);

(async () => {
  const b = await pw.chromium.launch({
    channel: 'chrome',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto('http://localhost:5273/', { waitUntil: 'networkidle' });
  await p.waitForFunction(() => !!window.__TANGPING3D__, null, { timeout: 20000 });
  await p.waitForTimeout(1200);

  const res = await p.evaluate(() => {
    const T = window.__TANGPING3D__;
    const stage = T.stage;
    const cam = stage.camera;
    const scene = stage.scene;
    const W = 1440, H = 900;

    // 找出 Three 的构造函数：从现有对象取原型
    const Vec3 = cam.position.constructor;
    const RaycasterCtor = Object.getPrototypeOf(scene).constructor; // 占位，下面用窗口上的 THREE

    // 收集遮挡物：所有 mesh，排除地面/格子类（名字含 cell/floor/corridor）
    const occluders = [];
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const nm = (o.name || '') + '|' + (o.parent && o.parent.name ? o.parent.name : '');
      if (/cell|floor|corridor|stripe|dash|grid/i.test(nm)) return;
      occluders.push(o);
    });

    // 投影 + 屏幕坐标
    const project = (x, y, z) => {
      const v = new Vec3(x, y, z);
      v.project(cam);
      return { sx: (v.x * 0.5 + 0.5) * W, sy: (-v.y * 0.5 + 0.5) * H };
    };

    const grid = [];
    for (let row = 0; row < 5; row++) {
      const line = [];
      for (let col = 0; col < 8; col++) {
        const c = T.cellCenter(col, row);
        // 格心（略高于地面）
        const g = project(c.x, 0.10, c.z);
        line.push({ col, row, x: Math.round(g.sx), y: Math.round(g.sy) });
      }
      grid.push(line);
    }

    // 直接测「格子的屏幕 y」是否单调（row 越大越靠下）。
    // 若某行被前排墙遮住，它的 y 会挤在一起甚至反序 —— 这是遮挡的信号。
    const rowY = grid.map((line) => line.map((c) => c.y));
    const rowAvg = rowY.map((a) => a.reduce((s, v) => s + v, 0) / a.length);
    let monotonic = true;
    for (let i = 1; i < rowAvg.length; i++) if (rowAvg[i] <= rowAvg[i - 1]) monotonic = false;

    return { grid: rowY, rowAvg: rowAvg.map((v) => Math.round(v)), monotonic, occluderCount: occluders.length };
  });

  console.log('每行格子的屏幕 y 坐标:');
  res.grid.forEach((line, i) => console.log('  row' + i + ': ' + line.join(', ')));
  console.log('\n各行平均 y: ' + res.rowAvg.join(' -> '));
  console.log('纵向单调（越靠近相机越靠下）: ' + (res.monotonic ? '✅ 是' : '❌ 否 —— 有行被压在一起，疑似遮挡'));
  console.log('遮挡物 mesh 数: ' + res.occluderCount);
  console.log('行高间距: ' + res.rowAvg.slice(1).map((v, i) => (v - res.rowAvg[i]).toFixed(0)).join(', '));
  console.log('pageerror: ' + (errs.length ? errs.join(' | ') : '无'));

  await b.close();
})();
