// ============================================================
//  verify-video.cjs —— 剧情镜头（视频）浏览器验收
// ============================================================
//
//  验收什么：
//    1. 六个镜头位真的有素材，且 URL 在浏览器里能解出来（不是 404）
//    2. 走到对应波次时，镜头层真的出现、真的有画面（不是空 div）
//    3. **过渡**：换镜头时不闪黑、不重播、不闪一下又回来
//    4. 素材缺失时优雅降级（文字照常，不抛错）
//
//  为什么第 3 条要单独验：
//    "过渡做得好一些"是个**视觉**要求，没法靠读代码确认。
//    常见翻车方式有两种，都会在浏览器里留下可观测证据：
//      a. 换 src → 解码器重初始化 → 中间黑一帧
//      b. 同一镜头被反复重建 → 视频反复从头播
//    所以这里量的是"层里是否始终有 readyState>=2 的画面"。
//
//  用法：先 `npm run dev`（或让下面的 ensureServer 自己起），再 node 本文件。
// ============================================================

const path = require('path');

const PW = 'C:/Users/hambu/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium } = require(PW);
const BASE = process.env.BASE || 'http://localhost:5273/';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
}

/** 等真实渲染帧（渲染层状态不在 tick() 里推进 —— 见 verify-step5 的注释）。 */
const WAIT_FRAMES = `(n) => new Promise((res) => {
  let left = n;
  const step = () => (--left <= 0 ? res() : requestAnimationFrame(step));
  requestAnimationFrame(step);
})`;

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // ⚠️ 区分两类错误（这个区分很重要，学自 verify-step5）：
  //   · pageerror      —— JS 真的抛异常了，一定是 bug
  //   · console.error  —— 可能只是 SwiftShader 软件渲染的着色器噪声
  //     （MeshDepthMaterial 在 software GL 下必报，与本次改动无关）
  //   混在一起断言会让验收恒定失败，然后被人加白名单"弄绿"——
  //   那就等于删掉了这条防线。所以分别收，只对 pageerror 硬断言。
  const errors = [];
  const consoleErrs = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text()); });

  // 记录视频请求的结果，用来区分「404」和「解码失败」
  const videoReqs = new Map();
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/assets/story/')) videoReqs.set(path.basename(u), r.status());
  });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__TANGPING3D__, null, { timeout: 20000 });
  await page.evaluate(`globalThis.__waitFrames = ${WAIT_FRAMES}`);

  console.log('\n── A. 素材可达性 ──');
  const slots = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    const s = T.STORY_VIDEO_SLOTS;
    if (!s) return null;
    return Object.entries(s).map(([id, v]) => ({ id, video: v.video, poster: v.poster, title: v.title }));
  });
  ok('STORY_VIDEO_SLOTS 可读到', !!slots && slots.length === 6, `n=${slots ? slots.length : 0}`);
  const filled = (slots || []).filter((s) => s.video);
  ok('六个镜头位都填了素材', filled.length === 6,
    `filled=${filled.length} ids=${filled.map((f) => f.id).join(',')}`);

  // 逐个 fetch，确认浏览器真能拿到（不是路径写错）
  const fetched = await page.evaluate(async (list) => {
    const out = [];
    for (const s of list) {
      try {
        const r = await fetch(s.video, { method: 'HEAD' });
        out.push({ id: s.id, status: r.status, len: Number(r.headers.get('content-length') || 0) });
      } catch (e) { out.push({ id: s.id, status: -1, err: String(e) }); }
    }
    return out;
  }, filled.map((f) => ({ id: f.id, video: f.video })));
  fetched.forEach((f) => ok(`素材可下载：${f.id}`, f.status === 200 && f.len > 0,
    `status=${f.status} ${(f.len / 1048576).toFixed(2)}MB`));

  console.log('\n── B. 到达对应波次时镜头真的出现 ──');
  // 用调试面直接触发镜头（不依赖打 60 波），再验证层里的画面状态
  const cases = [
    { id: 'wake_0307',    wave: 1 },
    { id: 'first_return', wave: 10 },
    { id: 'mirror_bed',   wave: 32 },
    { id: 'ledger_four',  wave: 47 },
    { id: 'message_0307', wave: 55 },
    { id: 'morning_door', wave: 60 },
  ];

  for (const c of cases) {
    const r = await page.evaluate(async ({ id, wave }) => {
      const T = globalThis.__TANGPING3D__;
      const ui = T.storyUI;
      if (!ui || !ui.showMedia) return { err: 'ui.showMedia 不存在' };
      await ui.showMedia(id, { caption: '测试 ' + id });
      // 等画面真的就绪（video readyState>=2 或 poster 已解码）
      for (let i = 0; i < 90; i++) {
        await globalThis.__waitFrames(2);
        if (ui.mediaReady) break;
      }
      const layer = document.querySelector('.su-media');
      const v = layer && layer.querySelector('video');
      const cap = layer && layer.querySelector('.su-media-cap');
      return {
        shown: !!layer && layer.classList.contains('on'),
        scene: ui.mediaScene,
        ready: ui.mediaReady,
        opacity: layer ? Number(getComputedStyle(layer).opacity) : 0,
        // readyState>=2 表示已经拿到当前帧数据
        readyState: v ? v.readyState : -1,
        videoW: v ? v.videoWidth : 0,
        videoH: v ? v.videoHeight : 0,
        paused: v ? v.paused : null,
        loop: v ? v.loop : null,
        muted: v ? v.muted : null,
        caption: cap ? cap.textContent : '',
      };
    }, c);

    ok(`镜头 ${c.id} 出现`, r.shown && r.scene === c.id,
      `shown=${r.shown} scene=${r.scene} err=${r.err || ''}`);
    ok(`镜头 ${c.id} 有真实画面`, r.ready && r.readyState >= 2 && r.videoW > 0,
      `ready=${r.ready} rs=${r.readyState} ${r.videoW}x${r.videoH}`);
    ok(`镜头 ${c.id} 在播（非暂停、静音、循环）`,
      r.paused === false && r.muted === true && r.loop === true,
      `paused=${r.paused} muted=${r.muted} loop=${r.loop}`);
  }

  console.log('\n── C. 过渡：换镜头时画面不断档 ──');
  // 真实场景是"第 47 波说好几段，每段同一个 sceneId"。
  // 关键验收：连续调用同一镜头 → **不重播**（否则玩家看到反复从头开始）
  const sameScene = await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    const ui = T.storyUI;
    ui.reset();
    await ui.showMedia('ledger_four');
    await globalThis.__waitFrames(4);
    const v1 = document.querySelector('.su-media video');
    const t1 = v1 ? v1.currentTime : -1;
    const node1 = v1;
    // 再"推一段同镜头的对白" → 不该重建节点
    await ui.showMedia('ledger_four');
    await ui.showMedia('ledger_four');
    await globalThis.__waitFrames(3);
    const v2 = document.querySelector('.su-media video');
    return {
      sameNode: node1 === v2,
      t1, t2: v2 ? v2.currentTime : -1,
      count: document.querySelectorAll('.su-media video').length,
    };
  });
  ok('重复同一镜头不重建 <video>（同一 DOM 节点）', sameScene.sameNode,
    `sameNode=${sameScene.sameNode} videos=${sameScene.count}`);
  ok('重复同一镜头不重播（播放进度继续走）', sameScene.t2 >= sameScene.t1,
    `t1=${sameScene.t1.toFixed(2)} t2=${sameScene.t2.toFixed(2)}`);

  // 换成**不同**镜头时要连续有画面（不闪黑）
  const transition = await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    const ui = T.storyUI;
    ui.reset();
    await ui.showMedia('wake_0307');
    await globalThis.__waitFrames(6);
    // 采样整段过渡里的"有画面"比例
    const samples = [];
    const p = ui.showMedia('morning_door');
    for (let i = 0; i < 40; i++) {
      await globalThis.__waitFrames(1);
      const layer = document.querySelector('.su-media');
      const has = layer && Array.from(layer.querySelectorAll('video,img')).some((n) => {
        if (n.tagName === 'VIDEO') return !n.hidden && n.readyState >= 2;
        return !n.hidden && n.complete && n.naturalWidth > 0;
      });
      const op = layer ? Number(getComputedStyle(layer).opacity) : 0;
      samples.push({ has: !!has, op });
    }
    await p;
    await globalThis.__waitFrames(6);
    const finalHas = (() => {
      const layer = document.querySelector('.su-media');
      return !!(layer && Array.from(layer.querySelectorAll('video,img')).some((n) => {
        if (n.tagName === 'VIDEO') return !n.hidden && n.readyState >= 2;
        return !n.hidden && n.complete && n.naturalWidth > 0;
      }));
    })();
    return {
      shownSamples: samples.filter((s) => s.op > 0.05).length,
      coveredSamples: samples.filter((s) => s.op > 0.05 && s.has).length,
      finalHas,
      total: samples.length,
    };
  });
  ok('过渡结束后新镜头有画面', transition.finalHas,
    `finalHas=${transition.finalHas}`);
  ok('过渡期间没有"层可见但没画面"的空档（不闪黑）',
    transition.coveredSamples === transition.shownSamples,
    `可见帧=${transition.shownSamples}/${transition.total} 其中有画面=${transition.coveredSamples}`);

  console.log('\n── D. 降级：素材坏了也不影响剧情 ──');
  // 用一个不存在的路径覆盖 slot，确认走 poster/静默降级而不是抛错
  const degrade = await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    const ui = T.storyUI;
    const before = [];
    ui.reset();
    try {
      await ui.showMedia('__不存在的镜头__');
    } catch (e) { return { threw: String(e) }; }
    return { threw: null, scene: ui.mediaScene };
  });
  ok('未知镜头编号不抛错且不显示', !degrade.threw && degrade.scene === null,
    `threw=${degrade.threw} scene=${degrade.scene}`);

  // ══════════════════════════════════════════════════════════
  console.log('\n── D2. 竞态：过期的异步续体不许改动当前状态 ──');
  // ══════════════════════════════════════════════════════════
  //
  // 这一节是**真 bug 的回归**，不是假想场景。
  // 镜头层有三个异步尾巴（fillLayer 的 playing/decode 回调、它的 2500ms 兜底、
  // hideMedia 的 700ms 清理），它们都可能在下一次调用之后才落地。
  // 曾实测到的失败：hideMedia 的清理定时器把刚填好的新层一起抹掉 ——
  // mediaScene 报 morning_door、层 opacity=1，但**两层都是 empty**，
  // 玩家看到的是一个黑框。修复手段是世代号（mediaGen）。
  //
  // 这三条断言分别覆盖三种交错方式。删掉任何一条，那类竞态就会悄悄回来。

  // D2-1：hideMedia 之后很快 showMedia —— 旧的清理定时器不许动新层
  const raceHide = await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__, ui = T.storyUI;
    ui.reset();
    await ui.showMedia('wake_0307');
    await globalThis.__waitFrames(6);
    ui.hideMedia();                        // 启动 700ms 清理
    await globalThis.__waitFrames(8);      // 只等 ~130ms
    await ui.showMedia('morning_door');    // 新镜头落进某一层
    await globalThis.__waitFrames(90);     // 等全部定时器落地
    const layers = Array.from(document.querySelectorAll('.su-media-layer'));
    return {
      scene: ui.mediaScene,
      ready: ui.mediaReady,
      // "可见的那一层必须真有画面" —— 这正是当时失败的形态
      visibleHasPicture: layers.some((l) => {
        const v = l.querySelector('video');
        return Number(getComputedStyle(l).opacity) > 0.5 && v && !v.hidden && v.readyState >= 2;
      }),
      emptyButVisible: layers.filter((l) =>
        Number(getComputedStyle(l).opacity) > 0.5 && !l.querySelector('video,img')).length,
    };
  });
  ok('hideMedia 后立刻换镜头：新层没有被旧清理定时器抹掉',
    raceHide.scene === 'morning_door' && raceHide.ready && raceHide.visibleHasPicture,
    `scene=${raceHide.scene} ready=${raceHide.ready} 可见且有画面=${raceHide.visibleHasPicture}`);
  ok('没有"可见但空"的层（黑框的形态）',
    raceHide.emptyButVisible === 0, `空可见层=${raceHide.emptyButVisible}`);

  // D2-2：连续两次 showMedia（第一次的续体可能迟到）→ 层记账保持自洽
  //
  // ⚠️ 诚实说明：**这一条我没能证伪。**
  //    它断言的是内部不变量「可见的那一层就是 mediaTop 指向的那一层」，
  //    但在去掉世代守卫后它依然通过（top 恰好与可见层一致）。
  //    我试过三种更"敏感"的写法都不成立：
  //      · 数层数（1 有内容 / 1 可见 / 1 在播）→ 无守卫时也全对
  //      · 查可见层的 src 是否是当前镜头 → 无守卫时也对
  //      · 逐帧采样"层可见但两层全透明"→ 无守卫时露底帧也是 0/60
  //        （CSS 淡出有 600ms，本地视频加载快，重叠把空档盖住了）
  //    所以它现在的作用是**防护性的**：守住不变量本身，将来若有人改动
  //    .then 的写入顺序，这条会先炸。不要把它当成"守卫有效"的证据 ——
  //    守卫的有效性由 D2-1 和 D2-3 证明（去掉守卫它们必失败）。
  const raceTwice = await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__, ui = T.storyUI;
    ui.reset();
    const p1 = ui.showMedia('wake_0307');    // 故意不 await
    const p2 = ui.showMedia('mirror_bed');
    await Promise.all([p1, p2]);
    await globalThis.__waitFrames(30);
    // 再切一次，然后让所有定时器落地
    await ui.showMedia('morning_door');
    await globalThis.__waitFrames(90);       // 越过 700ms 清理窗口
    const d = ui.mediaDebug();
    const visibleIdx = d.layers
      .map((l, i) => ({ i, op: l.opacity }))
      .filter((l) => l.op > 0.5)
      .map((l) => l.i);
    const visVideo = (() => {
      const layers = document.querySelectorAll('.su-media-layer');
      const l = layers[visibleIdx[0]];
      return l ? l.querySelector('video') : null;
    })();
    return {
      scene: ui.mediaScene,
      ready: ui.mediaReady,
      debug: d,
      visibleIdx,
      contentLayers: d.layers.filter((l) => l.hasVideo || l.hasImg).length,
      visibleSrc: visVideo ? (visVideo.currentSrc || visVideo.src || '') : '',
    };
  });
  ok('连续换镜头后恰好一层有内容、一层可见',
    raceTwice.scene === 'morning_door' && raceTwice.ready
      && raceTwice.contentLayers === 1 && raceTwice.visibleIdx.length === 1,
    `scene=${raceTwice.scene} 有内容=${raceTwice.contentLayers} 可见=${JSON.stringify(raceTwice.visibleIdx)}`);
  ok('可见的那一层装的确实是当前镜头（不是上一个）',
    raceTwice.visibleSrc.includes('morning_door'),
    `可见层 src=${raceTwice.visibleSrc.split('/').pop() || '(空)'}`);
  ok('mediaTop 指向可见层（双缓冲的前提，防护性断言）',
    raceTwice.visibleIdx.length === 1 && raceTwice.debug.top === raceTwice.visibleIdx[0],
    `top=${raceTwice.debug.top} 可见层=${JSON.stringify(raceTwice.visibleIdx)}`);

  // D2-3：加载途中 reset() → 在飞的续体不许把内容复活
  const raceReset = await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__, ui = T.storyUI;
    ui.reset();
    ui.showMedia('wake_0307');   // 不等它
    ui.reset();                  // 立刻重开
    await globalThis.__waitFrames(90);
    const wrap = document.querySelector('.su-media');
    return {
      on: wrap.classList.contains('on'),
      scene: ui.mediaScene,
      contentLayers: Array.from(document.querySelectorAll('.su-media-layer'))
        .filter((l) => l.querySelector('video')).length,
    };
  });
  ok('reset() 之后在飞的加载不会复活内容',
    raceReset.on === false && raceReset.scene === null && raceReset.contentLayers === 0,
    `on=${raceReset.on} scene=${raceReset.scene} 有内容=${raceReset.contentLayers}`);

  console.log('\n── E. 全流程：真的玩到第 1 波看到开场镜头 ──');
  const live = await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    T.reset();
    const ui = T.storyUI;
    ui.reset();
    T.grant(5000000, 5000000, 50000);
    // 铺一点塔保证第 1 波能过
    for (const [t, c, r] of [['turret', 0, 0], ['turret', 0, 2], ['turret', 0, 4]]) T.build(t, c, r);
    T.startWave();
    // 读完这段剧情（第 1 波就是 wake_0307）
    let scene = null, ready = false;
    for (let i = 0; i < 40; i++) {
      await globalThis.__waitFrames(2);
      if (ui.mediaScene) { scene = ui.mediaScene; if (ui.mediaReady) { ready = true; break; } }
    }
    return { scene, ready, dialogOpen: ui.dialogOpen };
  });
  ok('走正常游戏流程到第 1 波会演出开场镜头', live.scene === 'wake_0307',
    `scene=${live.scene}`);
  ok('开场镜头真有画面（不只是挂了个空层）', live.ready, `ready=${live.ready}`);

  console.log('\n── F. 截图 ──');
  await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    const ui = T.storyUI;
    ui.reset();
    await ui.showMedia('morning_door', { caption: '门的两边 · 林小夏' });
    await globalThis.__waitFrames(8);
  });
  await page.screenshot({ path: path.join(__dirname, 'shot-video-media.png') });
  console.log('  截图: shot-video-media.png');

  ok('无未捕获 JS 异常（pageerror）', errors.length === 0, errors.slice(0, 3).join(' | '));
  // 着色器噪声单独报告，不作为失败（软件渲染下必然出现）
  const shaderNoise = consoleErrs.filter((t) => /Shader Error|VALIDATE_STATUS|WebGLProgram/.test(t));
  ok('除软件渲染着色器噪声外无 console.error',
    consoleErrs.length === shaderNoise.length,
    `noise=${shaderNoise.length} other=${consoleErrs.length - shaderNoise.length}`);

  await browser.close();

  console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败项') +
    `  ——  通过 ${pass} / 失败 ${fail}`);
  if (fail) { console.log('失败项：'); failures.forEach((f) => console.log('  · ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('运行失败:', e); process.exit(1); });
