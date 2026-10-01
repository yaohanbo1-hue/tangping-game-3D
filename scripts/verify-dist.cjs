// 验证**生产产物**能否真正跑起来（部署前的最后一道关）。
// 不是验证源码 —— dist/ 是打包压缩后的东西，路径/分块/静态资源都可能出问题。
const { chromium } = require('C:/Users/hambu/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core');

const URL = process.env.URL || 'http://127.0.0.1:5180/';
let pass = 0, fail = 0; const bad = [];
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n + (x ? '  ' + x : '')); }
  else { fail++; bad.push(n); console.log('  ❌ ' + n + '  ' + (x || '')); } };

(async () => {
  const b = await chromium.launch({
    channel: 'chrome',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));

  const bad404 = [];
  const okRes = [];
  p.on('response', (r) => {
    const u = r.url();
    if (r.status() >= 400) bad404.push(r.status() + ' ' + u.split('/').pop());
    else if (/\.(mp4|js|css|html)$/.test(u)) okRes.push(u.split('/').pop());
  });

  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(2000);

  console.log('── 产物启动 ──');

  // 1) 游戏真的初始化了吗
  const booted = await p.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    if (!T) return { ok: false };
    return {
      ok: true,
      version: T.version,
      hasGb: !!T.gb,
      hasStage: !!T.stage,
      chapters: T.narrative && T.narrative.panelData
        ? T.narrative.panelData().chapterList.length : -1,
      videos: T.STORY_VIDEO_SLOTS ? Object.keys(T.STORY_VIDEO_SLOTS).length : -1,
    };
  });
  ok('游戏在产物里成功初始化', booted.ok, JSON.stringify(booted));
  ok('叙事数据已打包进去（章节 ≥ 15）', booted.chapters >= 15, `chapters=${booted.chapters}`);
  ok('六个镜头位已打包', booted.videos === 6, `videos=${booted.videos}`);

  // 2) 世界坐标契约（打包后仍然自洽）
  const contract = await p.evaluate(() => globalThis.__TANGPING3D__.contract());
  ok('世界坐标契约通过', contract.ok,
    contract.ok ? '' : JSON.stringify(contract.problems));

  // 3) 画布真的在渲染
  const canvas = await p.evaluate(() => {
    const c = document.querySelector('#scene');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), buf: c.width + 'x' + c.height };
  });
  ok('canvas 存在且铺满', !!canvas && canvas.w === 1440 && canvas.h === 900, JSON.stringify(canvas));

  // 4) 真开一局：建造 + 开波，确认战斗链路在产物里能跑
  const play = await p.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    T.grant(5000000, 5000000, 50000);
    const before = T.gb.buildings.length;
    T.build('turret', 2, 2);
    const after = T.gb.buildings.length;
    T.startWave();
    await new Promise((r) => { let n = 0;
      const s = () => (++n > 90 ? r() : requestAnimationFrame(s)); requestAnimationFrame(s); });
    return { before, after, wave: T.gb.wave, state: T.gb.state,
      enemies: (T.gb.enemies || []).length, kills: T.snapshot().kills };
  });
  ok('产物里能建造', play.after === play.before + 1, `${play.before} → ${play.after}`);
  ok('产物里能开波并出怪', play.wave >= 1 && play.state === 'wave', JSON.stringify(play));

  // 5) 剧情镜头视频真的能取到（这是最容易被 .gitignore 漏掉的东西）
  const vid = await p.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    const slot = T.STORY_VIDEO_SLOTS.wake_0307;
    if (!slot || !slot.video) return { err: 'no video path in slot' };
    const r = await fetch(slot.video, { method: 'HEAD' });
    return { path: slot.video, status: r.status, len: Number(r.headers.get('content-length') || 0) };
  });
  ok('剧情镜头视频可访问（没被 gitignore 漏掉）',
    vid.status === 200 && vid.len > 100000,
    `${vid.path} status=${vid.status} ${(vid.len / 1048576).toFixed(2)}MB`);

  // 6) 在产物里真的播一次镜头
  const played = await p.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    const ui = T.storyUI;
    ui.reset();
    await ui.showMedia('wake_0307');
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (ui.mediaReady) break;
    }
    const v = document.querySelector('.su-media video');
    return { ready: ui.mediaReady, scene: ui.mediaScene,
      rs: v ? v.readyState : -1, w: v ? v.videoWidth : 0 };
  });
  ok('产物里镜头能出画', played.ready && played.rs >= 2 && played.w > 0, JSON.stringify(played));

  ok('无未捕获 JS 异常（pageerror）', errors.length === 0, errors.slice(0, 3).join(' | '));
  ok('没有 4xx/5xx 资源', bad404.length === 0, bad404.slice(0, 5).join(' | '));

  await p.screenshot({ path: 'ui-review-3d/shot-dist-check.png' });   // 该目录的 png 已被 gitignore
  await b.close();

  console.log('\n' + (fail === 0 ? '✅ 生产产物验证通过' : '❌ 产物有问题') + `  ——  通过 ${pass} / 失败 ${fail}`);
  if (fail) bad.forEach((x) => console.log('  · ' + x));
  process.exit(fail === 0 ? 0 : 1);
})();
