// 玩法回归：相机 38° + 墙体抬高后，建造/开波/投影是否仍然正常。
//
// 这个探针专门防「画面好看了、点击坏了」——相机角度改变会让
// 屏幕↔世界的投影跟着变，而屏幕坐标 → 格子的映射一旦偏了，
// 玩家就会「点了 3,1 建到 4,1」。这类错误不会抛异常，
// 塔照样建起来，只是建错位置。塔防里这等于游戏坏了但毫无提示。
//
// ⚠️ 血泪教训（这个文件第一版就踩了）：
//   第一版把建筑类型写死成 'gun'，结果 tryBuild 返回 null，
//   5 条断言全红，看起来像「相机改动搞坏了建造」。
//   实际上 3D 版的类型名是 **kinetic**（见 rules/constants.js 的 BUILD_DEFS），
//   根本没有 'gun' —— 是**探针在照本宣科**，游戏完全正常。
//   这正是项目记忆里那条铁律：验收脚本里任何写死的数字/名字，
//   都是会在数值调整时静默失真的定时炸弹。
//   → 本版改成**问游戏要类型名**，不写死。
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
  await p.waitForTimeout(1000);

  let pass = 0, fail = 0;
  const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✅ ' + msg); } else { fail++; console.log('  ❌ ' + msg); } };

  // 从建造栏 DOM 里读真实类型名 —— 不写死
  const typeInfo = await p.evaluate(() => {
    const items = [...document.querySelectorAll('.hud-buildbar [data-type]')];
    return items.map((el) => el.getAttribute('data-type')).filter(Boolean);
  });
  console.log(`── 从游戏里读到 ${typeInfo.length} 种可建类型: ${typeInfo.slice(0, 6).join(', ')}${typeInfo.length > 6 ? ' …' : ''} ──`);
  const TYPE = typeInfo[0];
  ok(!!TYPE, `至少有一种可建类型（用 "${TYPE}" 做测试）`);

  // 1) 建造落格准确性
  console.log('\n── 1. 建造落格准确性 ──');
  const r1 = await p.evaluate((type) => {
    const T = window.__TANGPING3D__;
    T.grant(999999, 999999, 999);
    const targets = [[0, 0], [3, 2], [6, 4], [5, 1], [2, 3]];
    return targets.map(([col, row]) => {
      const r = T.build(type, col, row);
      return { want: [col, row], got: [r.col, r.row], ok: !!r.ok && r.col === col && r.row === row };
    });
  }, TYPE);
  r1.forEach((x) => ok(x.ok, `建在 [${x.want}] 实得 [${x.got}]`));

  // 2) 投影往返：格心 → 屏幕 → 反投影回世界（正交相机）
  //
  // ⚠️ 两个正交相机专属陷阱，各踩过一次：
  //   ① unproject 必须用 z=-1（近）与 z=+1（远）两点连线当射线方向。
  //      用 z=0→1 时两点在正交下几乎重合，方向完全失真（实测偏 1600+ 米）。
  //   ② unproject 的入参必须是 **NDC(-1..1)**，不是像素坐标。
  //      而且 NDC 要用 **drawingBuffer 的实际尺寸**换算 —— 渲染器带
  //      devicePixelRatio 时 buffer 比 CSS 尺寸大，用 CSS 尺寸算会整体偏移。
  console.log('\n── 2. 投影往返一致性（屏幕↔世界）──');
  const r2 = await p.evaluate(() => {
    const T = window.__TANGPING3D__;
    const cam = T.stage.camera;
    const Vec3 = cam.position.constructor;
    const cv = T.stage.canvas || document.querySelector('canvas');
    const BW = cv.width, BH = cv.height;   // drawingBuffer 尺寸
    const bad = [];

    const toNDC = (px, py) => ({ x: (px / BW) * 2 - 1, y: -(py / BH) * 2 + 1 });

    for (let row = 0; row < 5; row++) for (let col = 0; col < 8; col++) {
      const c = T.cellCenter(col, row);
      // 正投影：世界 → NDC → 像素
      const v = new Vec3(c.x, 0.10, c.z); v.project(cam);
      const px = (v.x * 0.5 + 0.5) * BW, py = (-v.y * 0.5 + 0.5) * BH;
      // 反投影
      const n = toNDC(px, py);
      const o = new Vec3(n.x, n.y, -1).unproject(cam);
      const f = new Vec3(n.x, n.y, 1).unproject(cam);
      const dir = f.clone().sub(o).normalize();
      const t = (0.10 - o.y) / dir.y;
      const hit = o.clone().add(dir.multiplyScalar(t));
      const dx = Math.abs(hit.x - c.x), dz = Math.abs(hit.z - c.z);
      if (dx > 0.05 || dz > 0.05) bad.push({ col, row, dx: +dx.toFixed(3), dz: +dz.toFixed(3) });
    }
    return { bad, BW, BH };
  });
  ok(r2.bad.length === 0, `40 格投影往返自洽（buffer ${r2.BW}x${r2.BH}，偏差 >5cm 的 ${r2.bad.length} 个）`);
  if (r2.bad.length) console.log('     ' + JSON.stringify(r2.bad.slice(0, 4)));

  // 3) 开波 + 敌人推进
  //
  // ⚠️ 不要断言 state === 'walk'：敌人从 spawn 到进门是一个状态机，
  //    跑一段时间后它们可能已进入 'attack' / 'door' 等状态。
  //    第一版只数 walk，结果 8 只敌人全是 progress=1 的非 walk 状态，
  //    断言失败 —— 而「它们全走到了终点」恰恰说明走廊是通的。
  //    正确判据是**位置在随时间变化**，不是处在某个特定状态。
  console.log('\n── 3. 开波与敌人推进 ──');
  const r3 = await p.evaluate(() => {
    const T = window.__TANGPING3D__;
    const before = T.gb.wave;
    T.startWave();
    const started = T.gb.state === 'wave' && T.gb.wave === before + 1;
    T.tick(20);
    const a = T.positions().map((e) => e.progress);
    T.tick(20);
    const bb = T.positions().map((e) => e.progress);
    const moved = a.filter((v, i) => bb[i] !== undefined && Math.abs(bb[i] - v) > 1e-6).length;
    const states = [...new Set(T.positions().map((e) => e.state))];
    return { started, wave: T.gb.wave, count: bb.length, moved, states, sample: T.positions()[0] || null };
  });
  ok(r3.started, `开波成功（第 ${r3.wave} 波）`);
  ok(r3.count > 0, `场上出现 ${r3.count} 只敌人`);
  ok(r3.moved > 0, `其中 ${r3.moved} 只在推进（progress 在变）`);
  console.log(`     状态分布: ${r3.states.join(', ')}`);
  if (r3.sample) console.log(`     样本 lane=${r3.sample.lane} progress=${r3.sample.progress} pos=(${r3.sample.x},${r3.sample.z})`);

  // 4) 敌人位置在场地范围内
  console.log('\n── 4. 敌人位置在场地范围内 ──');
  const r4 = await p.evaluate(() => {
    const T = window.__TANGPING3D__;
    const ps = T.positions();
    const out = ps.filter((e) => e.x < -0.5 || e.x > T.WORLD_W + 0.5 || e.z < -0.5 || e.z > T.WORLD_D + 0.5);
    return { total: ps.length, outside: out.length, worldW: T.WORLD_W, worldD: T.WORLD_D };
  });
  ok(r4.outside === 0, `全部 ${r4.total} 个敌人在 0..${r4.worldW} × 0..${r4.worldD} 内`);

  // 5) 门洞未被抬高后的墙体堵死
  console.log('\n── 5. 门洞未被堵死（敌人能走到墙边）──');
  const r5 = await p.evaluate(() => {
    const T = window.__TANGPING3D__;
    for (let i = 0; i < 260; i++) T.tick(6);
    const ps = T.positions();
    const maxP = ps.length ? Math.max(...ps.map((e) => e.progress)) : 0;
    return { total: ps.length, maxProgress: +maxP.toFixed(3) };
  });
  ok(r5.maxProgress > 0.35, `最深的敌人推进到 progress=${r5.maxProgress}（>0.35 = 走廊通畅）`);

  ok(errs.length === 0, `无 JS 异常${errs.length ? ': ' + errs.join(' | ') : ''}`);

  console.log(`\n${fail === 0 ? '✅ 玩法回归通过' : '❌ 有失败'}  ——  通过 ${pass} / 失败 ${fail}`);
  await b.close();
  process.exit(fail === 0 ? 0 : 1);
})();
