// ============================================================
//  verify-mobile.cjs —— 3D 版「手机端适配」浏览器验收
// ============================================================
//
//  验收什么（本轮唯一能证明「手机适配真的生效」的东西）：
//    1. viewport meta：viewport-fit=cover（刘海机铺满）、user-scalable=no（不可缩放）
//    2. 竖屏(390×844) / 横屏(844×390)：canvas 的 CSS 显示尺寸 == 视口尺寸
//    3. HUD（顶栏 / 底栏 / 建造栏）连**子孙元素**都不越出视口
//    4. 触摸点按空格子 → 真的造出一座塔（走 pointerType==='touch' 的真实路径）
//    5. 触摸**按下**时目标格高亮（建造预览）—— 本轮正在修的缺口，如实报红
//    6. 触摸拖动不滚动页面，且拖动不算点击（不误造塔）
//    7. 旋转到横屏后 canvas 尺寸跟随变化
//    8. 无 pageerror（软件渲染的 shader 噪声单独统计，不算失败）
//
//  设计原则（重要）：
//    · 这个脚本**必须能真的失败**。不满足的项如实报红 —— 那正是它的价值。
//    · 每条失败都打印「实测值 vs 期望值」，不要只打印 false。
//    · 渲染层状态等**真实渲染帧**（rAF），不用 setTimeout / 逻辑 tick。
//
//  用法：先跑 dev 服务器（默认 http://localhost:5273/），再 node 本文件。
//        URL 可用环境变量 BASE 覆盖。
// ============================================================

const path = require('path');

const PW = 'C:/Users/hambu/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium, devices } = require(PW);
const BASE = process.env.BASE || 'http://localhost:5273/';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
}

/** 等真实渲染帧（渲染层状态不在逻辑 tick 里推进）。 */
const WAIT_FRAMES = `(n) => new Promise((res) => {
  let left = n;
  const step = () => (--left <= 0 ? res() : requestAnimationFrame(step));
  requestAnimationFrame(step);
})`;

// ── 页面内测量工具（注入到浏览器执行） ──
//
//  measureCanvas：canvas 的 CSS 显示矩形 vs 视口
//  hudBox：把某个 HUD 区域**连同全部子孙**的矩形并起来
//          —— 只看容器自身会漏掉「子按钮溢出到屏幕外」这种真实缺陷
const MEASURE_CANVAS = `() => {
  const c = document.getElementById('scene') || document.querySelector('canvas');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  const hint = document.getElementById('rotate-hint');
  return {
    vw: window.innerWidth, vh: window.innerHeight,
    cw: +r.width.toFixed(1), ch: +r.height.toFixed(1),
    cl: +r.left.toFixed(1), ct: +r.top.toFixed(1),
    dpr: window.devicePixelRatio,
    coarse: matchMedia('(pointer: coarse)').matches,
    touch: (navigator.maxTouchPoints || 0) > 0,
    hintDisplay: hint ? getComputedStyle(hint).display : '(无)',
  };
}`;

//  HUD 越界检查：拆成两件事，失败信息能直接区分「盒子大了」还是「内容漏出来了」
//
//   ① selfFits —— 元素**自身**的 getBoundingClientRect 是否落在视口内
//   ② worst/leakCount —— **可见子孙**是否漏到视口外
//
//  ⚠️ 子孙判定必须考虑祖先裁剪：祖先链上只要出现 overflow ∈ {auto,hidden,scroll,clip}，
//     子孙超出盒子部分就被裁掉、根本不会显示 → 不算溢出。
//     早期版本直接把「元素 + 全部子孙的 rect 并集」当可视矩形，于是把
//     `.hud-buildbar` 的 scrollWidth（17 个按钮排成单行、overflow-x:auto 可横向滚动，
//     这是**设计意图**）误判成溢出 → 假失败。测量错了比没测更糟。
const HUD_CHECK = `(sel) => {
  const root = document.querySelector(sel);
  if (!root) return null;
  const vw = window.innerWidth, vh = window.innerHeight;
  const r = root.getBoundingClientRect();
  const self = { l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1) };
  const selfFits = r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1;

  const CLIP = { auto: 1, hidden: 1, scroll: 1, clip: 1 };
  /**
   * 祖先链上是否存在**真正会裁到它**的盒子。有 → 该元素不可能漏到视口外。
   *
   * ⚠️ 两个必须同时成立的细节，少一个就会量错：
   *   · 祖先 overflow ∈ {auto,hidden,scroll,clip} 才裁（visible 不裁）
   *   · 一旦遇到 position:fixed 的祖先就**停**：它相对视口定位，
   *     它上面的祖先（例如 body{overflow:hidden}）裁不到它，也裁不到它的子孙。
   *     忽略这条会把「fixed HUD 的子元素漏到屏幕外」误判成「被 body 裁掉了」→ 假绿。
   */
  const isClipped = (el) => {
    let n = el.parentElement;
    while (n) {
      const cs = getComputedStyle(n);
      if (CLIP[cs.overflowX] || CLIP[cs.overflowY]) return true;
      if (cs.position === 'fixed') return false;
      n = n.parentElement;
    }
    return false;
  };

  let worst = null, leakCount = 0;
  const walk = (el) => {
    for (const c of el.children) {
      const q = c.getBoundingClientRect();
      if (q.width > 0 && q.height > 0 && !isClipped(c)) {
        const over = Math.max(-q.left, -q.top, q.right - vw, q.bottom - vh);
        if (over > 1) {
          leakCount++;
          if (!worst || over > worst.over) worst = {
            over: +over.toFixed(1),
            tag: c.tagName.toLowerCase() + (c.id ? '#' + c.id : '') +
                 (typeof c.className === 'string' && c.className ? '.' + c.className.trim().split(/\\s+/)[0] : ''),
            rect: { l: +q.left.toFixed(1), t: +q.top.toFixed(1), r: +q.right.toFixed(1), b: +q.bottom.toFixed(1) },
          };
        }
      }
      walk(c);
    }
  };
  walk(root);
  return { self, selfFits, vw, vh, leakCount, worst };
}`;

/** 读真实的 env(safe-area-inset-*)。用一个临时元素量，最接近浏览器实际用于布局的值。 */
const SAFE_READ = `() => {
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;' +
    'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);' +
    'padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)';
  document.body.appendChild(el);
  const cs = getComputedStyle(el);
  const env = { top: num(cs.paddingTop), bottom: num(cs.paddingBottom), left: num(cs.paddingLeft), right: num(cs.paddingRight) };
  el.remove();
  return { env, vw: window.innerWidth, vh: window.innerHeight };
}`;

const HUD_REGIONS = [['顶栏', '.hud-bar'], ['底栏', '.hud-footer'], ['建造栏', '.hud-buildbar']];

// 安全区数值：竖屏是「顶部刘海 + 底部 Home 条」，横屏是「左右刘海 + 底部 Home 条」。
const SAFE_PORTRAIT = { top: 47, bottom: 34, left: 0, right: 0 };
const SAFE_LANDSCAPE = { top: 0, bottom: 21, left: 47, right: 47 };

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });

  // 用 iPhone 13 的设备特征（hasTouch / isMobile / DPR），但把视口固定成任务要求的
  // 390×844 —— Playwright 自带的 iPhone 13 视口是 390×664（扣掉了 Safari 地址栏），
  // 与「刘海机铺满」这个验收目标不一致。
  const ctx = await browser.newContext({
    ...devices['iPhone 13'],
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();

  // ⚠️ 区分两类错误：
  //   · pageerror      —— JS 真的抛异常了，一定是 bug → 硬断言
  //   · console.error  —— SwiftShader 软件渲染下 three.js 的 MeshDepthMaterial 必报
  //                       shader error，那是渲染噪声不是本次改动的 bug → 单独统计
  //   混在一起断言会让验收恒定失败，然后被人加白名单「弄绿」= 删掉了防线。
  const errors = [];
  const consoleErrs = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text()); });

  const cdp = await ctx.newCDPSession(page);

  // ── 真实注入安全区（刘海 / Home 条）──
  // CDP 的 Emulation.setSafeAreaInsetsOverride 会让页面的 env(safe-area-inset-*) 真的返回注入值。
  // 必须在 goto 之前设置（导航后仍生效）；改视口后重新下发一次即可更新，无需重新导航。
  // ⚠️ 这是本套件里唯一能证明「HUD 真的避开了刘海」的手段。
  //    若注入失败（env 仍为 0），所有「不侵入安全区」的断言都会因 0 而恒真 → 假绿，
  //    所以下面把「注入生效」单独作为**前提断言**，且依赖它的断言在前提不成立时按失败计。
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: SAFE_PORTRAIT });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__TANGPING3D__, null, { timeout: 20000 });
  await page.evaluate(`globalThis.__waitFrames = ${WAIT_FRAMES}`);
  await page.evaluate(`globalThis.__measureCanvas = ${MEASURE_CANVAS}`);
  await page.evaluate(`globalThis.__hudCheck = ${HUD_CHECK}`);
  await page.evaluate(`globalThis.__safeRead = ${SAFE_READ}`);
  await page.evaluate('globalThis.__waitFrames(4)');

  /**
   * 安全区验收：先证明注入生效（前提），再逐区检查 HUD 是否落在安全区可用区内。
   * 前提不成立时，依赖它的断言一律按失败计 —— 宁可报红，也不要因 env=0 而假绿。
   */
  async function checkSafeArea(label, want) {
    const s = await page.evaluate('globalThis.__safeRead()');
    const envOk = s.env.top === want.top && s.env.bottom === want.bottom
      && s.env.left === want.left && s.env.right === want.right;
    ok(`[${label}] 安全区注入生效（前提）`, envOk,
      `期望 top=${want.top} bottom=${want.bottom} left=${want.left} right=${want.right}，实测 env=${JSON.stringify(s.env)}`);
    const box = `[${s.env.left},${s.env.top}]–[${s.vw - s.env.right},${s.vh - s.env.bottom}]`;
    for (const [name, sel] of HUD_REGIONS) {
      const r = await page.evaluate(`globalThis.__hudCheck(${JSON.stringify(sel)})`);
      if (!r) { ok(`[${label}] ${name} 不侵入安全区`, false, `选择器 ${sel} 未命中`); continue; }
      const inside = r.self.l >= s.env.left - 1 && r.self.t >= s.env.top - 1
        && r.self.r <= s.vw - s.env.right + 1 && r.self.b <= s.vh - s.env.bottom + 1;
      ok(`[${label}] ${name} 不侵入安全区`, envOk && inside,
        `rect=(${r.self.l},${r.self.t})-(${r.self.r},${r.self.b}) 安全区可用区=${box}` +
        (envOk ? '' : '　⚠️ 前提不成立（env 未注入），本项无法判定，按失败计'));
    }
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n── A. viewport meta（不可缩放 / 刘海铺满）──');
  // ══════════════════════════════════════════════════════════
  const meta = await page.evaluate(() => {
    const m = document.querySelector('meta[name="viewport"]');
    return m ? m.getAttribute('content') : null;
  });
  ok('viewport meta 存在', !!meta, `content=${meta}`);
  ok('viewport meta 含 viewport-fit=cover（刘海机不铺满会露白边）',
    !!meta && /viewport-fit\s*=\s*cover/.test(meta), `content=${meta}`);
  ok('viewport meta 含 user-scalable=no（禁止双指缩放）',
    !!meta && /user-scalable\s*=\s*no/.test(meta), `content=${meta}`);

  // 安全区已在 goto 前通过 CDP 注入（见上），这里逐区做真测量。

  // ══════════════════════════════════════════════════════════
  console.log('\n── B. 竖屏 390×844：canvas 铺满 + HUD 不越界 + 避开安全区 ──');
  // ══════════════════════════════════════════════════════════
  const p = await page.evaluate('globalThis.__measureCanvas()');
  console.log(`  环境：${p.vw}×${p.vh} dpr=${p.dpr} coarse=${p.coarse} touch=${p.touch} rotate-hint=${p.hintDisplay}`);
  ok('[竖屏] canvas 宽度 == 视口宽度', Math.abs(p.cw - p.vw) <= 1,
    `canvas=${p.cw} 视口=${p.vw}`);
  ok('[竖屏] canvas 高度 == 视口高度', Math.abs(p.ch - p.vh) <= 1,
    `canvas=${p.ch} 视口=${p.vh}`);
  ok('[竖屏] canvas 原点贴 (0,0)（不留边）',
    Math.abs(p.cl) <= 1 && Math.abs(p.ct) <= 1, `left=${p.cl} top=${p.ct}`);

  for (const [name, sel] of HUD_REGIONS) {
    const r = await page.evaluate(`globalThis.__hudCheck(${JSON.stringify(sel)})`);
    if (!r) { ok(`[竖屏] ${name} 存在`, false, `选择器 ${sel} 未命中`); continue; }
    ok(`[竖屏] ${name} 自身不超出视口`, r.selfFits,
      `rect=(${r.self.l},${r.self.t})-(${r.self.r},${r.self.b}) 视口=${r.vw}×${r.vh}`);
    ok(`[竖屏] ${name} 的可见子孙不超出视口`, !r.worst,
      r.worst
        ? `越界 ${r.worst.over}px：${r.worst.tag} rect=(${r.worst.rect.l},${r.worst.rect.t})-(${r.worst.rect.r},${r.worst.rect.b})，共 ${r.leakCount} 个`
        : `无可见子孙越界（被 overflow 裁剪的不计）`);
  }
  await checkSafeArea('竖屏安全区', SAFE_PORTRAIT);

  // 截图留证：竖屏有 #rotate-hint 全屏遮罩，额外截一张「藏掉遮罩」的看真实 HUD 布局
  //
  // ⚠️ 截图前必须等**真实渲染帧**。否则 3D 场景可能还没出第一帧，
  //    截出来是一片空白 —— 那不是 bug，但会被后来的人当成"手机上不渲染"。
  //    （这条踩过：`shot-mobile-landscape.png` 曾是一片白。）
  await page.evaluate('globalThis.__waitFrames(20)');
  await page.screenshot({ path: path.join(__dirname, 'shot-mobile-portrait.png') });
  await page.evaluate(() => { const h = document.getElementById('rotate-hint'); if (h) h.dataset.savedDisplay = h.style.display, h.style.display = 'none'; });
  await page.screenshot({ path: path.join(__dirname, 'shot-mobile-portrait-nohint.png') });
  await page.evaluate(() => { const h = document.getElementById('rotate-hint'); if (h) h.style.display = h.dataset.savedDisplay || ''; });

  // ══════════════════════════════════════════════════════════
  console.log('\n── C. 横屏 844×390：canvas 跟随 + HUD 不越界 + 避开安全区 ──');
  // ══════════════════════════════════════════════════════════
  await page.setViewportSize({ width: 844, height: 390 });
  // 横屏的安全区是「左右刘海 + 底部 Home 条」，与竖屏不同 → 重新下发（无需重新导航）
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: SAFE_LANDSCAPE });
  await page.evaluate('globalThis.__waitFrames(8)');
  const l = await page.evaluate('globalThis.__measureCanvas()');
  console.log(`  环境：${l.vw}×${l.vh} dpr=${l.dpr} rotate-hint=${l.hintDisplay}`);
  ok('[横屏] canvas 宽度 == 视口宽度', Math.abs(l.cw - l.vw) <= 1, `canvas=${l.cw} 视口=${l.vw}`);
  ok('[横屏] canvas 高度 == 视口高度', Math.abs(l.ch - l.vh) <= 1, `canvas=${l.ch} 视口=${l.vh}`);
  ok('[横屏] 旋转后 canvas 尺寸与竖屏不同（说明真的跟随视口变化）',
    Math.abs(l.cw - p.cw) > 1 && Math.abs(l.ch - p.ch) > 1,
    `竖屏=${p.cw}×${p.ch} → 横屏=${l.cw}×${l.ch}`);

  for (const [name, sel] of HUD_REGIONS) {
    const r = await page.evaluate(`globalThis.__hudCheck(${JSON.stringify(sel)})`);
    if (!r) { ok(`[横屏] ${name} 存在`, false, `选择器 ${sel} 未命中`); continue; }
    ok(`[横屏] ${name} 自身不超出视口`, r.selfFits,
      `rect=(${r.self.l},${r.self.t})-(${r.self.r},${r.self.b}) 视口=${r.vw}×${r.vh}`);
    ok(`[横屏] ${name} 的可见子孙不超出视口`, !r.worst,
      r.worst
        ? `越界 ${r.worst.over}px：${r.worst.tag} rect=(${r.worst.rect.l},${r.worst.rect.t})-(${r.worst.rect.r},${r.worst.rect.b})，共 ${r.leakCount} 个`
        : `无可见子孙越界（被 overflow 裁剪的不计）`);
  }
  await checkSafeArea('横屏安全区', SAFE_LANDSCAPE);
  await page.evaluate('globalThis.__waitFrames(20)');   // 同上：别截到空白帧
  await page.screenshot({ path: path.join(__dirname, 'shot-mobile-landscape.png') });

  // ══════════════════════════════════════════════════════════
  console.log('\n── D. 触摸点按建造（真实 pointerType===\'touch\' 路径）──');
  // ══════════════════════════════════════════════════════════
  //
  // 为什么必须在横屏做：竖屏下 3D 版有 #rotate-hint 全屏遮罩（z-index:200），
  // 触摸会打在遮罩上、到不了 canvas。这是**设计如此**（主场景是横屏），
  // 不是缺陷；但也意味着「竖屏能不能建造」这个问题在本脚本里无法验证。
  const target = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    const cam = T.stage.camera;
    const V3 = cam.position.constructor;
    const canvas = document.getElementById('scene');
    const rect = canvas.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const free = [];
    const occluded = [];
    const byOccluder = {};
    const rows = {};   // row -> { ok, total }（可建造格子的可点情况）
    const shortName = (el) => {
      if (!el) return '(null)';
      if (el === canvas) return 'canvas';
      const cls = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\s+/).join('.') : '';
      return (el.tagName.toLowerCase()) + (el.id ? '#' + el.id : '') + cls;
    };
    for (const mesh of T.terrain.cells) {
      const ud = mesh.userData;
      if (ud.isBed) continue;
      if (!T.towerLayer.cellFree(ud.col, ud.row)) continue;
      const v = new V3(); mesh.getWorldPosition(v); v.project(cam);
      const x = rect.left + (v.x * 0.5 + 0.5) * rect.width;
      const y = rect.top + (-v.y * 0.5 + 0.5) * rect.height;
      if (x < 4 || x > rect.width - 4 || y < 4 || y > rect.height - 4) continue;
      rows[ud.row] = rows[ud.row] || { ok: 0, total: 0 };
      rows[ud.row].total++;
      // ⚠️ 关键：点必须真的落在 canvas 上。HUD 的固定层（建造栏等）会盖住战场，
      //    如果只是「在视口内」就当成可点，测出来的失败会是遮挡而非输入问题。
      //    elementFromPoint 会忽略 pointer-events:none 的元素，正好等价于「手指能不能点到」。
      const hit = document.elementFromPoint(x, y);
      if (hit !== canvas) {
        occluded.push({ col: ud.col, row: ud.row, by: shortName(hit) });
        const k = shortName(hit);
        byOccluder[k] = (byOccluder[k] || 0) + 1;
        continue;
      }
      rows[ud.row].ok++;
      free.push({ col: ud.col, row: ud.row, x, y, d: Math.hypot(x - cx, y - cy) });
    }
    free.sort((a, b) => a.d - b.d);
    return {
      best: free.length ? free[0] : null,
      freeCount: free.length,
      occludedCount: occluded.length,
      byOccluder,
      rows,
      total: free.length + occluded.length,
      sample: occluded.slice(0, 4),
    };
  });
  const tapRatio = target.total ? target.freeCount / target.total : 0;
  console.log(`  可建造格子 ${target.total} 个：可点 ${target.freeCount} / 被遮挡 ${target.occludedCount}`);
  console.log(`  遮挡来源：${JSON.stringify(target.byOccluder)}`);
  // 这条断言是本节真正的价值所在：HUD 只要盖住战场，触摸建造就无从谈起。
  // 阈值取「至少一半可建造格子可点」——低于此，玩家在横屏下基本点不到战场。
  ok('横屏下战场不被固定 HUD 大面积遮挡（≥50% 可建造格子可点）',
    tapRatio >= 0.5,
    `可点 ${target.freeCount}/${target.total} = ${(tapRatio * 100).toFixed(0)}%；` +
    `遮挡来源=${JSON.stringify(target.byOccluder)} 例=${JSON.stringify(target.sample)}`);

  // 真不变量（比上面那条 50% 的阈值更硬）：row 0 紧贴顶栏、被部分遮挡是**设计上的正常重叠**，
  // 但第 1–3 行位于战场中部，那里任何遮挡都是缺陷 —— 玩家正是在这几行布防。
  console.log(`  逐行可点情况：${JSON.stringify(target.rows)}`);
  const badRows = [1, 2, 3].filter((r) => {
    const s = target.rows[r];
    return s && s.total > 0 && s.ok < s.total;
  });
  ok('横屏下第 1–3 行的可建造格子全部可点（row 0 被顶栏部分遮挡属正常）',
    badRows.length === 0,
    badRows.length
      ? `以下行的格子被遮挡：${badRows.map((r) => `row${r} ${target.rows[r].ok}/${target.rows[r].total}`).join('、')}`
      : `rows=${JSON.stringify(target.rows)}`);

  const best = target.best;

  if (!best) {
    ok('横屏下存在「在视口内、未被 HUD 遮挡、可建造」的格子', false,
      `可点=0 被遮挡=${target.occludedCount}/${target.total} —— ` +
      '战场被固定 HUD（建造栏）盖住，玩家点不到任何格子');
  } else {
    console.log(`  目标格 col=${best.col} row=${best.row} 屏幕坐标=(${best.x.toFixed(0)},${best.y.toFixed(0)})`);
    const before = await page.evaluate(() => {
      const T = globalThis.__TANGPING3D__;
      T.grant(999999, 999999, 9999);
      T.hud.setBuildType('turret');   // 进入建造模式（等价于点建造栏里的炮塔卡片）
      return T.snapshot().buildings;
    });
    // 真实触摸点按（Chromium 会据此派发 pointerdown/up，pointerType === 'touch'）
    await page.touchscreen.tap(best.x, best.y);
    await page.evaluate('globalThis.__waitFrames(4)');
    const after = await page.evaluate(() => globalThis.__TANGPING3D__.snapshot().buildings);
    ok('触摸点按空格子 → 场上建筑数 +1', after === before + 1,
      `before=${before} after=${after}（期望 ${before + 1}）tap=(${best.x.toFixed(0)},${best.y.toFixed(0)})`);
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n── E. 建造预览：真实触摸**按下**时目标格高亮 ──');
  // ══════════════════════════════════════════════════════════
  //
  // ⚠️ 这一条正是本轮修过的缺口（原实现把高亮挂在 pointermove 上，触摸点按不产生
  //    pointermove，所以按下去没有任何预览）。
  //
  //  这里用 **CDP Input.dispatchTouchEvent** 走真实触摸序列（按住 → 读数 → 抬起），
  //  而不是合成 PointerEvent —— 后者会绕过浏览器的触摸→指针合成，可能掩盖真实差异。
  //  真实触摸下 Chromium 会自己派发 pointerdown/pointerup，pointerType 就是 'touch'。
  const pick = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    const cam = T.stage.camera;
    const V3 = cam.position.constructor;
    const canvas = document.getElementById('scene');
    const rect = canvas.getBoundingClientRect();
    const screenOf = (mesh) => {
      const v = new V3(); mesh.getWorldPosition(v); v.project(cam);
      return { x: rect.left + (v.x * 0.5 + 0.5) * rect.width, y: rect.top + (-v.y * 0.5 + 0.5) * rect.height };
    };
    // 选一个：非床、可建造、点真落在 canvas 上、且**当前未被高亮**的格子。
    // 要求「未被高亮」是为了让基线干净 —— 免得上一节触摸留下的高亮污染读数。
    const cands = T.terrain.cells.filter((m) => {
      if (m.userData.isBed) return false;
      if (!T.towerLayer.cellFree(m.userData.col, m.userData.row)) return false;
      const s = screenOf(m);
      if (s.x < 24 || s.x > rect.width - 24 || s.y < 70 || s.y > rect.height - 70) return false;
      if (document.elementFromPoint(s.x, s.y) !== canvas) return false;
      return m.material.emissiveIntensity <= 0.25;
    });
    if (!cands.length) return { err: '找不到「未被高亮且可点」的格子（无法建立干净基线）' };
    const mesh = cands[0];
    const other = T.terrain.cells.find((m) => !m.userData.isBed && m !== mesh);
    return {
      col: mesh.userData.col, row: mesh.userData.row, x: screenOf(mesh).x, y: screenOf(mesh).y,
      otherCol: other.userData.col, otherRow: other.userData.row,
    };
  });

  if (pick.err) {
    ok('触摸按下时目标格高亮（建造预览）', false, pick.err);
  } else {
    const readEmissive = () => page.evaluate(({ c, r, oc, or }) => {
      const T = globalThis.__TANGPING3D__;
      const find = (cc, rr) => T.terrain.cells.find((m) => m.userData.col === cc && m.userData.row === rr);
      return {
        target: find(c, r).material.emissiveIntensity,
        other: find(oc, or).material.emissiveIntensity,
      };
    }, { c: pick.col, r: pick.row, oc: pick.otherCol, or: pick.otherRow });

    const base = await readEmissive();
    // 真实触摸：按下 → 保持不动 → 读数 → 抬起
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pick.x, y: pick.y }] });
    await page.evaluate('globalThis.__waitFrames(2)');
    const down = await readEmissive();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.evaluate('globalThis.__waitFrames(2)');

    ok('触摸按下时目标格高亮（真实触摸序列：按住 → 读数）',
      down.target > base.target + 0.2 && down.target > down.other + 0.2,
      `目标格(${pick.col},${pick.row}) 按住=${down.target.toFixed(2)} 基线=${base.target.toFixed(2)}；` +
      `对照格(${pick.otherCol},${pick.otherRow}) 按住=${down.other.toFixed(2)} 基线=${base.other.toFixed(2)}`);
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n── F. 触摸拖动：不滚页 + 不误造塔 ──');
  // ══════════════════════════════════════════════════════════
  //
  // ⚠️ 诚实说明：body 是 overflow:hidden，「scrollY===0」在当前代码下近乎恒真。
  //    它只能防住「有人把 overflow:hidden 拿掉」这类回归，不能证明手势处理正确。
  //    真正有鉴别力的是下面那条「拖动不算点击」——它会在误触防护被破坏时失败。
  const dragBefore = await page.evaluate(() => globalThis.__TANGPING3D__.snapshot().buildings);
  const startX = 120, startY = 200;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y: startY }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: startX + i * 30, y: startY + i * 10 }],
    });
    await page.evaluate('globalThis.__waitFrames(1)');
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.evaluate('globalThis.__waitFrames(4)');

  const afterDrag = await page.evaluate(() => ({
    scrollY: window.scrollY,
    scrollX: window.scrollX,
    buildings: globalThis.__TANGPING3D__.snapshot().buildings,
  }));
  ok('触摸拖动后页面没有被滚动', afterDrag.scrollY === 0 && afterDrag.scrollX === 0,
    `scroll=(${afterDrag.scrollX},${afterDrag.scrollY})`);
  ok('触摸拖动不算点击（不误造塔）', afterDrag.buildings === dragBefore,
    `拖动前=${dragBefore} 拖动后=${afterDrag.buildings}（期望不变）`);

  // ══════════════════════════════════════════════════════════
  console.log('\n── G. 错误：只对 pageerror 硬断言 ──');
  // ══════════════════════════════════════════════════════════
  ok('无未捕获 JS 异常（pageerror）', errors.length === 0, errors.slice(0, 3).join(' | '));
  const shaderNoise = consoleErrs.filter((t) => /Shader Error|VALIDATE_STATUS|WebGLProgram|GL_|program/i.test(t));
  ok('除软件渲染着色器噪声外无 console.error',
    consoleErrs.length === shaderNoise.length,
    `噪声=${shaderNoise.length} 其他=${consoleErrs.length - shaderNoise.length}` +
    (consoleErrs.length - shaderNoise.length ? ` 例：${consoleErrs.filter((t) => !shaderNoise.includes(t))[0]}` : ''));

  await browser.close();

  console.log('\n' + (fail === 0 ? '✅ 3D 手机端验收全部通过' : '❌ 3D 手机端验收有失败项') +
    `  ——  通过 ${pass} / 失败 ${fail}`);
  if (fail) { console.log('失败项：'); failures.forEach((f) => console.log('  · ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('运行失败:', e); process.exit(1); });
