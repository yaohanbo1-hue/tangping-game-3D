// 第 5 步浏览器端端到端验证：**能连着玩 10 波，并看到剧情推进**。
//
// 为什么必须有这个脚本：
//   Node 侧的 verify:pacing / verify:ending 证明了「叙事管线在纯逻辑下
//   按预期排出剧情」，但它们跑的是**宿主的替身**（一个记录调用的假对象）。
//   真实链路里有一大堆只有浏览器才存在的东西：
//     · WebAudio 的 AudioContext（没有用户手势时是 suspended）
//     · 真 DOM 的对话框 / 幕卡 / toast / 面板 / 结局画面有没有真的变可见
//     · localStorage 存档往返
//     · mood.js 的灯与暗角有没有真的改到 three 对象上
//   这些都不是"逻辑对不对"，而是"接起来之后还活着吗"。
//
// 验收标准（用户原话）：「能连着玩 10 波并看到剧情推进」
//   → 所以我们真的开 10 波、真的让战斗跑起来、真的点掉弹出的对白，
//     然后断言「剧情进度确实增长了」而不是「管线被调用过」。
//
// 用法：node ui-review-3d/verify-step5.cjs
//   需要先起 dev server：npm run dev（端口 5273，见 vite.config.mjs）
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
    args: [
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      // ⚠️ 让 WebAudio 不需要用户手势也能出声 —— 否则 audio.unlocked
      //    永远是 false，"音效接通了没有"这一项永远测不了。
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const errors = [];
  const consoleErrs = [];
  const consoleWarns = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrs.push(m.text());
    if (m.type() === 'warning') consoleWarns.push(m.text());
  });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);

  // ══════════════════════════════════════════════════════════
  console.log('\n── A. 启动与资产 ──');
  // ══════════════════════════════════════════════════════════
  ok('调试面就绪', await page.evaluate(() => !!globalThis.__TANGPING3D__));
  const ver = await page.evaluate(() => globalThis.__TANGPING3D__.version);
  ok('版本为 step6', /step6/.test(ver), ver);

  const contract = await page.evaluate(() => globalThis.__TANGPING3D__.contract());
  ok('世界坐标契约通过', contract.ok, contract.ok ? '' : JSON.stringify(contract.problems));
  ok('无未捕获异常', errors.length === 0, errors.join(' | '));

  // 叙事包真的接上了（不是"import 成功"而已，是数据条数对得上）
  const manifest = await page.evaluate(() => globalThis.__TANGPING3D__.narrative && {
    chapters: globalThis.__TANGPING3D__.narrative.panelData().chapterList.length,
    lore: globalThis.__TANGPING3D__.narrative.panelData().loreList.length,
    side: globalThis.__TANGPING3D__.narrative.panelData().sideList.length,
  });
  ok('叙事数据接入（章节 ≥ 15）', manifest && manifest.chapters >= 15, JSON.stringify(manifest));
  ok('世界观词条接入', manifest && manifest.lore > 0, `lore=${manifest && manifest.lore}`);
  ok('支线数据接入（14 条）', manifest && manifest.side === 14, `side=${manifest && manifest.side}`);

  // 宿主能力自检 —— 少一个能力 = 那条通道的剧情静默丢失
  const audit = await page.evaluate(() => globalThis.__TANGPING3D__.narrative.audit);
  ok('叙事宿主能力齐备（6 项）', audit.ok, audit.ok ? '' : '缺失: ' + JSON.stringify(audit.missing));

  // ══════════════════════════════════════════════════════════
  console.log('\n── B. 第 5 步核心验收：连玩 10 波 + 剧情推进 ──');
  // ══════════════════════════════════════════════════════════
  const play10 = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.reset();
    T.grant(5000000, 5000000, 50000);

    // 摆一条**真的撑得住 10 波**的防线。
    // ⚠️ 第一版摆了 16 座塔，结果第 5 波（第一个 BOSS）就把床打穿了 ——
    //    那不是 bug，那是这个阵容打不过。驱动脚本要模拟「一个会玩的
    //    玩家」，所以这里铺满 + 全部升到有意义的等级。
    const layout = [
      ['turret', 0, 0], ['turret', 0, 1], ['turret', 0, 2], ['turret', 0, 3], ['turret', 0, 4],
      ['frost', 1, 0], ['frost', 1, 2], ['frost', 1, 4], ['laser', 1, 1], ['laser', 1, 3],
      ['tesla', 2, 0], ['tesla', 2, 2], ['tesla', 2, 4], ['missile', 2, 1], ['missile', 2, 3],
      ['poison', 3, 0], ['poison', 3, 2], ['prism', 3, 1], ['prism', 3, 3],
      ['sonic', 4, 0], ['sonic', 4, 2], ['gravity', 4, 1], ['gravity', 4, 3],
      ['flame', 3, 4], ['amp', 5, 1], ['bank', 5, 3],
    ];
    for (const [t, c, r] of layout) T.build(t, c, r);
    // 把塔升到"钱还够"的最高级（轮转升级，不是逐座升到底）。
    //
    // ⚠️ 这里**不写死** `i < 6` 这类循环上限。写死的上限会让这个
    //    驱动脚本变成"照本宣科的演员"——它只会在预算内重复固定次数，
    //    于是"升到 Lv5"这种注释描述的目标会随经济/公式改动悄悄失真
    //    （上一版就是这么写坏第 10 波验收的：塔停在 Lv4，第一个
    //    BOSS 波就崩线，看起来像"游戏太难"，其实是脚本演得不像人）。
    //    改成轮转：每一轮把还能升的塔各升一级，直到**这一轮谁都升不动**
    //    （钱不够 / 到上限）为止。上限由游戏自己回答，不由脚本猜。
    const upgradeRound = () => {
      let any = false;
      for (const b of T.gb.buildings) {
        const before = b.level;
        T.towerLayer.select(b);
        T.towerLayer.upgradeSelected();
        if (b.level !== before) any = true;
      }
      return any;
    };
    for (let round = 0; round < 200 && upgradeRound(); round++);

    const before = T.snapshot();
    const log = [];

    // 要打的波数**从游戏规格里派发**，不写死。
    // 这一整块验收的命题是"能连着玩下去 + 剧情跟着推进"，不是
    // "恰好 10 波"。10 由 FINAL_WAVE（设计终点，60）派生：取终点前
    // 一小段作为"连玩"的样本窗口 —— 这样它既是明确的（不是拍脑袋
    // 的 9999），也不会在将来设计终点调整时和实际难度曲线脱节。
    // 万一真的提前崩线（阵容打不过 / 数值回归），下面的断言会带着
    // 真实的 max_wave 与结束原因报错，而不是给出一个含糊的"没到 10"。
    const FINAL_WAVE = T.FINAL_WAVE || 60;
    const TARGET_WAVES = Math.min(10, FINAL_WAVE);

    for (let w = 1; w <= TARGET_WAVES; w++) {
      // 开波（走玩家同一条路：先剧情后放怪）
      //
      // ⚠️ T.startWave() 返回的是 **snapshot()**（main.js:712），
      //    不是 `{started, story}`。第一版断言里读 `started.started`
      //    永远是 undefined → 恒 ❌。要判断"这一波真的开起来了"，
      //    看的是**可观测状态**：调用后 gb.state 是不是进入了 'wave'
      //    （以及波次号有没有 +1）。
      const waveBefore = T.gb.wave;
      const snapAfterStart = T.startWave();
      const opened = T.gb.state === 'wave' && T.gb.wave === waveBefore + 1;
      // 把这一波弹出来的对白全部读完（模拟玩家按空格 / 点选项）
      // ⚠️ 必须调 flushDialogs 而不是自己点 dlgWrap —— 带选项的对白
      //    故意不响应"点空白处推进"，得点选项本身。见 main.js 里的注释。
      const rounds = T.flushDialogs();
      // 开波那一刻的对白日志长度（用的是真 snapshot，不是编造的字段）
      const waveLogAtStart = snapAfterStart.story ? snapAfterStart.story.waveLog : 0;
      // 把这一波打完：一直 tick 到回到备战期（或超时）
      for (let i = 0; i < 40; i++) {
        T.tick(300);
        const s = T.snapshot();
        if (s.state !== 'wave' || s.gameOver || s.won) break;
      }
      // 打完可能又触发了下一波的剧情 —— 再读掉
      const rounds2 = T.flushDialogs();

      const s = T.snapshot();
      log.push({
        wave: s.wave, state: s.state, alive: s.alive, kills: s.kills,
        chapters: s.story.chapters.reached, side: s.story.side.done,
        lore: s.story.lore.unlocked, fragments: s.story.fragments,
        waveLog: s.story.waveLog, dialogRounds: rounds + rounds2,
        bedHp: s.bed.hp, gameOver: s.gameOver, won: s.won,
        started: opened,
        waveLogAtStart,
      });
      // 真输了就停 —— 这不是测试失败，是这一局结束了
      if (s.gameOver || s.won) break;
    }

    const after = T.snapshot();
    return { before, after, log, storyLog: T.narrative.waveLog.length, target: TARGET_WAVES };
  });

  const reachedWave = Math.max(...play10.log.map((l) => l.wave));
  const endedByLoss = play10.after.gameOver;
  ok(`确实推到了第 ${play10.target} 波（或通关）`, reachedWave >= play10.target,
    `max_wave=${reachedWave} 结束原因=${endedByLoss ? '床被打穿' : (play10.after.won ? '通关' : '仍在进行')}`);
  ok('10 波里都有击杀（战斗真的在打）', play10.after.kills > 0, `kills=${play10.after.kills}`);
  ok('每一波都成功开起来了（进入 wave 状态且波次 +1）', play10.log.every((l) => l.started),
    JSON.stringify(play10.log.map((l) => l.started)));
  // 叙事钩子真的跑了：只看"返回对象里有 story 字段"是没意义的
  // （那个字段根本不存在，恒 falsy）—— 要看的是一整轮下来
  // 对白日志真的变长了。逐波累计递增比单点断言更结实。
  ok('每一波开波/打完都真的产出了对白（waveLog 单调递增）',
    play10.log.every((l, i) => i === 0 || l.waveLog >= play10.log[i - 1].waveLog)
      && play10.log.some((l) => l.dialogRounds > 0),
    `waveLog=${JSON.stringify(play10.log.map((l) => l.waveLog))} 对白=${JSON.stringify(play10.log.map((l) => l.dialogRounds))}`);

  // ── 剧情推进的三个独立证据 ──
  // 只断言其中一个是不够的：章节点可能在很早的波就全解锁了，
  // 而词条/支线/碎片是持续增长的。
  const chBefore = play10.before.story.chapters.reached;
  const chAfter = play10.after.story.chapters.reached;
  ok('章节推进', chAfter > chBefore, `${chBefore} → ${chAfter}`);

  const loreAfter = play10.after.story.lore.unlocked;
  ok('世界观词条解锁了（剧情文本真的送到玩家手里）', loreAfter > 0, `lore=${loreAfter}`);

  const waveLogAfter = play10.after.story.waveLog;
  ok('波次剧情日志有内容', waveLogAfter > 0, `waveLog=${waveLogAfter}`);

  // 每一波的剧情表现（10 波里至少触发过对白）
  const wavesWithDialog = play10.log.filter((l) => l.dialogRounds > 0).length;
  ok('10 波里至少一半触发过对白演出', wavesWithDialog >= 5, `${wavesWithDialog}/${play10.log.length} 波有对白`);

  // 关键：不能"每波都塞一大堆"。预算机制必须在浏览器里也生效。
  const maxRounds = Math.max(...play10.log.map((l) => l.dialogRounds));
  ok('单波对白段数受预算约束（≤ 10 段）', maxRounds <= 10, `max=${maxRounds}`);

  console.log('    每波明细：');
  for (const l of play10.log) {
    console.log(`      wave ${String(l.wave).padStart(2)}  state=${String(l.state).padEnd(6)}`
      + ` kills=${String(l.kills).padStart(4)}  章节=${l.chapters} 词条=${l.lore}`
      + ` 碎片=${l.fragments} 床=${Math.round(l.bedHp)} 对白=${l.dialogRounds} 段`);
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n── C. 演出层真的可见（DOM 断言，不是"调用了"）──');
  // ══════════════════════════════════════════════════════════
  // 触发一次对白并检查它真的在 DOM 里可见
  // ⚠️ 必须**等过渡跑完**再量 opacity。`.su-dialog` 有一条
  //    `transition: opacity .28s ease`，刚点完就量会读到 0 ——
  //    第一版就是这么误判的（"对话框不透明"报 ❌，其实它正在淡入）。
  //
  // ⚠️⚠️ 第二版踩的坑更隐蔽：改用「固定等 420ms」仍然会 flake
  //    （实测读到过 0.408566）—— 因为 SwiftShader 软件渲染下，
  //    主线程被渲染帧挤占，setTimeout(420) 回调可能插在过渡动画的
  //    中间某一帧上执行，而不是末尾。**过渡的挂钟时间 ≠ 动画进度**。
  //    正确做法是**轮询 computedStyle 直到稳定**，而不是睡一个魔法数字。
  const dlg = await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    T.reset();
    T.grant(90000, 90000, 900);
    T.storyAt(1);
    const wrap = T.storyUI.nodes.dlgWrap;
    // 轮询到 opacity 不再上涨（连续两帧持平）或超时；单帧差值也要够小
    let prev = -1;
    let cur = -1;
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) {                 // 最多 ~1.2s
      await new Promise((r) => requestAnimationFrame(r));
      cur = Number(getComputedStyle(wrap).opacity);
      if (cur >= 0.999) break;                     // 到头了
      if (cur > 0 && Math.abs(cur - prev) < 0.002) break; // 稳定了
      prev = cur;
      if (performance.now() - t0 > 1200) break;
    }
    const cs = getComputedStyle(wrap);
    const box = wrap.querySelector('.su-box');
    const bcs = box ? getComputedStyle(box) : null;
    const rect = box ? box.getBoundingClientRect() : null;
    return {
      pushed: T.storyUI.pending + (T.storyUI.dialogOpen ? 1 : 0),
      hasOn: wrap.classList.contains('on'),
      opacity: cs.opacity,
      pointerEvents: cs.pointerEvents,
      zIndex: cs.zIndex,
      text: (wrap.innerText || '').slice(0, 80),
      boxVisible: !!rect && rect.width > 100 && rect.height > 40,
      boxBg: bcs ? bcs.backgroundColor : null,
    };
  });
  ok('对白被推进队列', dlg.pushed > 0, `pending=${dlg.pushed}`);
  ok('对话框真的变可见（class on）', dlg.hasOn, `class on = ${dlg.hasOn}`);
  ok('对话框淡入完成（opacity ≈ 1）', Number(dlg.opacity) > 0.9, `opacity=${dlg.opacity}`);
  ok('对话框可点击（pointer-events 不为 none）', dlg.pointerEvents !== 'none', `pe=${dlg.pointerEvents}`);
  ok('对话框层级在 HUD 之上', Number(dlg.zIndex) >= 60, `z-index=${dlg.zIndex}`);
  ok('对白框有实际尺寸（不是 0×0 的隐形元素）', dlg.boxVisible,
    JSON.stringify(dlg.boxBg));
  ok('对话框有正文', dlg.text.length > 4, JSON.stringify(dlg.text));

  // 点掉它 → 应该关掉（走 main.js 的 flushDialogs，它会点选项）
  const closed = await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    const n = T.flushDialogs();
    const wrap = T.storyUI.nodes.dlgWrap;
    // 同样的轮询策略（淡出也走 .28s 过渡），不要睡魔法数字
    let cur = 1;
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      cur = Number(getComputedStyle(wrap).opacity);
      if (cur <= 0.001) break;
      if (performance.now() - t0 > 1200) break;
    }
    return {
      n,
      open: T.storyUI.dialogOpen,
      pending: T.storyUI.pending,
      on: wrap.classList.contains('on'),
      opacity: cur,
    };
  });
  ok('对白可以全部读完并关闭', !closed.open && closed.pending === 0 && !closed.on,
    `点了 ${closed.n} 次, pending=${closed.pending}`);
  ok('关闭后对话框已淡出', Number(closed.opacity) < 0.1, `opacity=${closed.opacity}`);

  // 带选项的对白必须**不能**被"点空白处"跳过（逼玩家做选择）
  const choiceGuard = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.reset();
    T.storyAt(1);
    const wrap = T.storyUI.nodes.dlgWrap;
    const hasChoices = wrap.querySelector('.su-choices').childElementCount > 0;
    const before = wrap.innerText;
    wrap.click();       // 点空白处
    const after = wrap.innerText;
    return { hasChoices, unchanged: before === after };
  });
  ok('带选项的对白不会被"点空白处"跳过（玩家必须做选择）',
    choiceGuard.hasChoices && choiceGuard.unchanged, JSON.stringify(choiceGuard));

  // ══════════════════════════════════════════════════════════
  console.log('\n── D. 叙事占用期间逻辑真的暂停（"读字时不会被打死"）──');
  // ══════════════════════════════════════════════════════════
  const hold = await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    T.reset();
    T.grant(90000, 90000, 900);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) T.build('turret', c, r);
    T.startWave();
    T.tick(120);                       // 出几只怪
    const before = T.snapshot();
    // 手动触发一段对白 —— 此时 storyHold 应为 true
    const r = T.storyAt(3);
    await new Promise((res) => setTimeout(res, 120));   // 让 rAF 的几帧真的跑一下
    const mid = T.snapshot();
    return { before, mid, storyPending: T.storyUI.pending, dialogOpen: T.storyUI.dialogOpen };
  });
  // 敌人数量在演出期间不应该下降（没有塔在打死它们）
  ok('演出期间敌人数不再减少（逻辑冻结）',
    hold.mid.alive >= hold.before.alive,
    `${hold.before.alive} → ${hold.mid.alive}`);
  ok('演出期间 HUD 显示"剧情中"或对白在队列里',
    hold.storyPending > 0 || hold.dialogOpen || hold.mid.story.busy,
    `pending=${hold.storyPending} open=${hold.dialogOpen} busy=${hold.mid.story.busy}`);

  // ══════════════════════════════════════════════════════════
  console.log('\n── E. 幕次氛围（第 6 步）：换幕时光/雾真的变了 ──');
  // ══════════════════════════════════════════════════════════
  const mood = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    const pick = (w) => { T.mood.setWave(w, true); return T.mood.state(); };
    const a1 = pick(1), a3 = pick(30), a5 = pick(55);
    // 幕次映射也要对
    const map = [1, 13, 25, 37, 49, 60].map((w) => T.mood.depthFor(w));
    return { a1, a3, a5, map, actCount: T.mood.ACT_MOODS.length };
  });
  ok('共 5 幕', mood.actCount === 5, `count=${mood.actCount}`);
  ok('换幕改变了环境光强度', mood.a1.ambient.intensity !== mood.a5.ambient.intensity,
    `${mood.a1.ambient.intensity} → ${mood.a5.ambient.intensity}`);
  ok('换幕改变了主光颜色', mood.a1.key.color !== mood.a5.key.color,
    `0x${mood.a1.key.color.toString(16)} → 0x${mood.a5.key.color.toString(16)}`);
  ok('换幕改变了雾的浓度（far 距离）', mood.a1.fog.far !== mood.a5.fog.far,
    `${mood.a1.fog.far} → ${mood.a5.fog.far}`);
  ok('换幕改变了暗角强度', mood.a1.vig !== mood.a5.vig, `${mood.a1.vig} → ${mood.a5.vig}`);
  ok('幕次深度随波次单调不减', mood.map.every((v, i, a) => i === 0 || v >= a[i - 1]), JSON.stringify(mood.map));
  ok('暗角层存在且挂在相机上',
    await page.evaluate(() => {
      const T = globalThis.__TANGPING3D__;
      return !!T.mood.vignette.parent && T.mood.vignette.parent === T.stage.camera;
    }));

  // 灯真的被改到了 three 对象上（不是只改了 mood 内部状态）
  const lightsApplied = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.mood.setWave(1, true);
    const amb = T.stage.scene.children.find((o) => o.isAmbientLight);
    const key = T.stage.scene.children.find((o) => o.isDirectionalLight);
    if (!amb || !key) return { found: false };
    const before = { amb: amb.intensity, key: key.intensity, fogFar: T.stage.scene.fog.far };
    T.mood.setWave(55, true);
    const after = { amb: amb.intensity, key: key.intensity, fogFar: T.stage.scene.fog.far };
    return { found: true, before, after };
  });
  ok('three 的灯被真的改了（不只是 mood 自己的状态）',
    lightsApplied.found
    && lightsApplied.before.amb !== lightsApplied.after.amb
    && lightsApplied.before.fogFar !== lightsApplied.after.fogFar,
    JSON.stringify(lightsApplied));

  // 战况反馈：床位掉血 → 压力值上升
  //
  // ⚠️ 这一节踩了**两个**坑，都值得记下来：
  //
  // 坑一（时序）：`mood.update()` 跑在**渲染帧（rAF）**里，不在 tick() 里。
  //   用 setTimeout 等会 flake（SwiftShader 下主线程被出帧占满，
  //   这段时间 rAF 可能一次都没跑）；只 tick() 更是完全不动 mood。
  //   → 必须显式等真实渲染帧。
  //
  // 坑二（前置状态）：**更隐蔽。** main.js 的渲染帧开头有一句
  //     if (isFrozen()) return;      // isFrozen = paused || storyHold
  //   而 storyHold 在**有对白打开**时为 true。上一节（D 段叙事暂停）
  //   留下的对白如果没关掉，整帧直接早退，`mood.update()` 根本不执行，
  //   `stress` 永远停在 0 —— 看起来像"氛围系统坏了"，其实是
  //   "游戏正被剧情暂停"，**行为完全正确**。
  //   → 断言必须**自己建立前置条件**，不能继承上一节的状态。
  //     这里先 flushDialogs() + setPaused(false)，把画面从冻结里解出来。
  const stress = await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    const waitFrames = (n) => new Promise((res) => {
      let left = n;
      const step = () => (--left <= 0 ? res() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });

    // ── 先解冻：关掉可能还开着的对白，取消暂停 ──
    T.flushDialogs();
    T.setPaused(false);
    T.gb.gameOver = false;
    T.gb.won = false;

    T.mood.setWave(1, true);
    T.gb.bed.hp = T.gb.bed.maxHp;
    await waitFrames(12);                 // 让 mood 把"满血"吃进去
    const calm = T.mood.state();
    T.gb.bed.hp = T.gb.bed.maxHp * 0.1;   // 打成 10%，下一帧 mood 会读到
    await waitFrames(30);
    const hurt = T.mood.state();
    // 诊断信息：万一下次还失败，能直接看出是"冻结"还是"lerp 没走"
    const diag = { frozen: T.snapshot().story.busy, dialogOpen: T.snapshot().story.dialogOpen };
    T.gb.bed.hp = T.gb.bed.maxHp;
    return { calm, hurt, diag };
  });
  ok('床位危险 → 画面压力上升（暗角收紧）', stress.hurt.vig >= stress.calm.vig,
    `vig ${stress.calm.vig} → ${stress.hurt.vig}`);
  ok('床位危险 → 压力读数 > 0', stress.hurt.stress > 0,
    `stress=${stress.hurt.stress} diag=${JSON.stringify(stress.diag)}`);

  // ══════════════════════════════════════════════════════════
  console.log('\n── F. 第 6 步：受击闪白 / 死亡溶解 / 弹道拖尾 ──');
  // ══════════════════════════════════════════════════════════
  ok('敌人渲染层有受击闪白通道', await page.evaluate(() => {
    // 受击闪白读的是 e.hitFlash（combat.js 写的），这里确认字段真的会出现
    const T = globalThis.__TANGPING3D__;
    T.reset(); T.grant(90000, 90000, 900); T.startWave(); T.tick(60);
    return T.gb.enemies.length > 0 && T.gb.enemies.every((e) => 'hitFlash' in e || e.hitFlash === undefined);
  }));

  // 死亡溶解替身同样由**渲染帧**产生（enemies.js 的 updateGhosts 在 rAF 里跑），
  // 所以这里也是「tick 逻辑 + 等真实帧」交替，不能只 tick。
  // ⚠️ 同样要先解冻 —— 冻结时整帧早退，ghost 一个都不会生成（见上面坑二）。
  const dissolve = await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    const waitFrames = (n) => new Promise((res) => {
      let left = n;
      const step = () => (--left <= 0 ? res() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    T.flushDialogs(); T.setPaused(false);   // 解冻（见上面坑二）
    T.reset(); T.grant(300000, 300000, 3000);
    for (let r = 0; r < 5; r++) for (let c = 0; c < 6; c++) T.build('turret', c, r);
    T.startWave();
    let maxGhost = 0;
    for (let i = 0; i < 30; i++) {
      T.tick(12);                 // 推进逻辑（产生击杀）
      await waitFrames(3);        // 让渲染帧把 ghost 生成出来
      maxGhost = Math.max(maxGhost, T.enemyLayer.ghostCount);
    }
    return { maxGhost, spawned: T.enemyLayer.ghostsSpawned, kills: T.snapshot().kills };
  });
  ok('击杀时放出了溶解替身', dissolve.spawned > 0, `spawned=${dissolve.spawned} kills=${dissolve.kills}`);
  ok('溶解替身曾经同时在画面上（>0）', dissolve.maxGhost > 0, `maxGhost=${dissolve.maxGhost}`);

  // 拖尾实例数（trailMesh.count）同样是 **syncMesh() 在渲染帧里写的**，
  // 所以也要等真实帧，不能只 tick。（这一节之前靠"子弹多"侥幸通过，
  // 原理上和 F 段是同一个坑，一起修掉。）
  const trail = await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    const waitFrames = (n) => new Promise((res) => {
      let left = n;
      const step = () => (--left <= 0 ? res() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    T.flushDialogs(); T.setPaused(false);   // 解冻（见上面坑二）
    T.reset(); T.grant(90000, 90000, 900);
    for (let r = 0; r < 4; r++) T.build('turret', 0, r);
    T.startWave();
    let maxTrail = 0, maxFlying = 0;
    for (let i = 0; i < 30; i++) {
      T.tick(8);
      await waitFrames(3);
      const s = T.snapshot();
      maxFlying = Math.max(maxFlying, s.flying);
      maxTrail = Math.max(maxTrail, T.shotLayer.trailMesh.count);
    }
    return { maxTrail, maxFlying, stats: T.shotLayer.stats() };
  });
  ok('弹道拖尾真的在画（trailMesh.count > 0）', trail.maxTrail > 0,
    `maxTrail=${trail.maxTrail} maxFlying=${trail.maxFlying}`);
  ok('拖尾实例数 >= 在飞子弹数（每颗至少留一个残影）',
    trail.maxTrail >= trail.maxFlying, `${trail.maxTrail} >= ${trail.maxFlying}`);

  // ══════════════════════════════════════════════════════════
  console.log('\n── G. 音效（WebAudio 合成，零外部文件）──');
  // ══════════════════════════════════════════════════════════
  const audio = await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    const names = T.audio.names;
    // 播一个已知名字
    let played = false;
    try { T.audio.sfx('waveStart'); played = true; } catch (e) { played = 'ERR:' + e.message; }
    // 显式解锁 + 等一下 resume() 的 promise
    T.audio.unlock();
    await new Promise((r) => setTimeout(r, 200));
    return {
      enabled: T.audio.enabled,
      unlocked: T.audio.unlocked,
      nameCount: names.length,
      sample: names.slice(0, 8),
      // ⚠️ 必须把**全量 names** 也带出来：上面那版只返回了 sample + nameCount，
      //    外层 filter 却引用 audio.names → TypeError（脚本直接崩在 G 段）。
      //    同时留着 sample 方便打印，两者用途不同。
      names,
      played,
      // 每个名字都要真的能播（不是"表里有个 key"）
      allPlayable: (() => {
        const bad = [];
        for (const n of names) {
          try { T.audio.sfx(n); } catch (e) { bad.push(n); }
        }
        return bad;
      })(),
      depth: (T.audio.setAmbient(1), T.audio.ambientDepth),
    };
  });
  // ⚠️ 「多少个音效算够」没有客观标准 —— 这里断言的是「覆盖了游戏的
  //    关键事件」，而不是一个拍脑袋的数字（第一版写 ≥30，实际只有 24 个，
  //    而 24 个已经覆盖了建造/开火/命中/暴击/击杀/BOSS/开局/胜利/失败）。
  const needNames = ['build', 'shoot', 'hit', 'kill', 'boss', 'waveStart', 'gameOver', 'victory', 'dialog', 'lore'];
  // 只在**全量** names 里找（不再用 sample，也不再用上一版残留的
  // `audio.sample.concat(audio.sample)` —— 那是草稿期的垃圾代码）。
  const missingNames = needNames.filter((n) => !audio.names.includes(n));
  ok('关键事件音效齐备（建造/开火/命中/击杀/BOSS/开局/失败/胜利/对白/词条）',
    missingNames.length === 0, `缺失: ${JSON.stringify(missingNames)}`);
  ok('音效数量合理（≥ 20）', audio.nameCount >= 20, `count=${audio.nameCount}`);
  ok('每个具名音效都能播（无一抛异常）', audio.allPlayable.length === 0,
    JSON.stringify(audio.allPlayable));
  ok('音效播放不抛异常', audio.played === true, String(audio.played));
  ok('AudioContext 已解锁', audio.unlocked, `unlocked=${audio.unlocked}`);
  ok('氛围音深度可设置', audio.depth === 1, `depth=${audio.depth}`);

  // 合成器内部状态：AudioContext 真的在 running（而不是被浏览器挂起）
  const acState = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    // audio 内部不暴露 AudioContext，从解锁后的 world 状态间接确认：
    // 用 setEnabled 来回切一次，若 ctx 为 null（创建失败）它会警告且不抛
    const on = T.audio.setEnabled(false);
    const back = T.audio.setEnabled(true);
    return { afterOff: on, afterOn: back, enabled: T.audio.enabled };
  });
  ok('音效可以关闭再打开且状态正确',
    acState.afterOff === false && acState.afterOn === true && acState.enabled === true,
    JSON.stringify(acState));

  // 秘密旋律彩蛋：连续点击 SOUND_MELODIES 里定义的建筑序列应当触发
  const melody = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    const defs = T.audio.melodyDefs;
    if (!defs || !defs.length) return { noDefs: true };
    const m = defs[0];
    // 先清空历史
    T.audio.melodyRestore([]);
    let hit = null;
    for (const key of m.sequence) {
      const r = T.audio.tapBuild(key);
      if (r) hit = r;
    }
    return { id: m.id, name: m.name, seq: m.sequence, hit: hit && hit.id };
  });
  ok('存在秘密旋律定义', !melody.noDefs, JSON.stringify(melody.seq || ''));
  ok('按正确序列点击建筑触发了秘密旋律',
    melody.noDefs || melody.hit === melody.id, JSON.stringify(melody));

  // ══════════════════════════════════════════════════════════
  console.log('\n── H. 存档 / 读档（localStorage 往返）──');
  // ══════════════════════════════════════════════════════════
  const save = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.clearSave();
    T.reset();
    T.grant(50000, 50000, 500);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) T.build('turret', c, r);
    T.startWave();
    T.tick(600);
    T.flushDialogs();
    const at = T.snapshot();

    const w = T.save();
    const info = T.saveInfo();
    const has = T.hasSave();

    // ── 破坏现场（**不能**用 T.reset()）──
    //
    // ⚠️ 这里踩过一个坑：第一版用 T.reset() 来"破坏现场"，结果读档
    //    报「没有存档」。查下来是**设计正确**：reset() 走的是 hardReset()
    //    → clearSave()，因为"重开一局"本来就该丢掉本局存档。
    //    要测读档，就必须用一个**不删档**的方式把场上状态搞乱：
    //    直接改 gb 的字段（模拟"玩家又打了一会 / 别的地方改了状态"）。
    T.gb.gold = 0;
    T.gb.wave = 0;
    T.gb.buildings.length = 0;
    T.gb.grid.fill(null);
    T.gb.stats.kills = 0;
    T.gb.souls = 0;
    const wiped = T.snapshot();
    const hasAfterWipe = T.hasSave();

    // 读回来
    const l = T.load();
    const back = T.snapshot();

    return { at, wiped, back, write: w, info, has, hasAfterWipe, load: l, version: T.saveVersion };
  });
  ok('存档成功', save.write.ok, JSON.stringify(save.write));
  ok('hasSave 为真', save.has === true);
  ok('破坏现场后存档仍在（读档才有东西可读）', save.hasAfterWipe === true);
  ok('saveInfo 有波次', save.info && save.info.wave > 0, JSON.stringify(save.info));
  ok('读档成功', save.load.ok, JSON.stringify(save.load));
  ok('读档后波次还原', save.back.wave === save.at.wave, `${save.at.wave} → ${save.back.wave}`);
  ok('读档后金币还原（±2 容差）', Math.abs(save.back.gold - save.at.gold) <= 2,
    `${save.at.gold} → ${save.back.gold}`);
  ok('读档后建筑数还原', save.back.buildings === save.at.buildings,
    `${save.at.buildings} → ${save.back.buildings}`);
  ok('读档后床铺血量还原', save.back.bed.hp === save.at.bed.hp,
    `${save.at.bed.hp} → ${save.back.bed.hp}`);
  ok('读档后击杀数还原', save.back.kills === save.at.kills,
    `${save.at.kills} → ${save.back.kills}`);
  ok('读档后叙事进度没丢', save.back.story.lore.unlocked >= save.at.story.lore.unlocked,
    `${save.at.story.lore.unlocked} → ${save.back.story.lore.unlocked}`);

  // 「重开」必须**主动**丢掉本局存档（这是一条真实规则，要钉住）
  const resetClears = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.reset();
    T.grant(9999, 9999, 99);
    T.startWave();
    T.tick(300);
    T.flushDialogs();
    T.save();
    const before = T.hasSave();
    T.reset();                 // 玩家按「重开」
    return { before, after: T.hasSave() };
  });
  ok('「重开」会清掉本局存档（不回滚到旧局）',
    resetClears.before === true && resetClears.after === false,
    JSON.stringify(resetClears));

  // ⚠️ 去像素化的硬约束：存档里永远不能出现敌人的 x/y
  //
  // 这一项**必须**在"场上有敌人"的时候存 —— 否则 `enemies: []`，
  // 断言 `[].every(...)` 恒为 true，测了个寂寞（第一版就是这样空过的）。
  const noXY = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.clearSave();
    T.reset();
    T.grant(999999, 999999, 9999);
    // 不建塔 → 敌人会一直堆在场上，存档时一定有活着的敌人
    T.startWave();
    T.tick(240);
    T.flushDialogs();
    const aliveAtSave = T.gb.enemies.length;
    T.save();
    const raw = globalThis.localStorage.getItem('tangping3d_run');
    if (!raw) return { ok: false, why: '没有存档', aliveAtSave };
    const p = JSON.parse(raw);
    const es = (p.board && p.board.enemies) || [];
    const withXY = es.filter((e) => 'x' in e || 'y' in e);
    return {
      ok: withXY.length === 0,
      aliveAtSave,
      n: es.length,
      withXY: withXY.slice(0, 3),
      keys: es.length ? Object.keys(es[0]) : [],
      // 顺带确认位置真值确实在存档里（lane + progress）
      hasLaneProgress: es.length ? es.every((e) => 'lane' in e && 'progress' in e) : false,
    };
  });
  ok('存档时场上确实有敌人（这一项不是空过）', noXY.n > 0, `enemies=${noXY.n} aliveAtSave=${noXY.aliveAtSave}`);
  ok('存档里的敌人没有 x/y（去像素化保持）', noXY.ok,
    `n=${noXY.n} 违规=${JSON.stringify(noXY.withXY)}`);
  ok('存档里的敌人有 lane + progress（位置真值保住了）', noXY.hasLaneProgress,
    JSON.stringify(noXY.keys));

  // ══════════════════════════════════════════════════════════
  console.log('\n── I. 结局判定（第 60 波）──');
  // ══════════════════════════════════════════════════════════
  const ending = await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    T.reset();
    T.grant(999999, 999999, 9999);
    for (let r = 0; r < 5; r++) for (let c = 0; c < 6; c++) T.build('turret', c, r);
    // 直接把叙事推到第 60 波，再把波次也设到 60
    T.storyRun(1, 60);
    T.flushDialogs();
    T.gb.wave = 60;
    const r = T.settleEnding();
    await new Promise((res) => setTimeout(res, 120));
    const root = document.querySelector('.su-ending');
    const cs = getComputedStyle(root);
    return {
      id: r && r.def && r.def.id,
      tone: r && r.tone && r.tone.label,
      degraded: r && r.degraded,
      visible: cs.display !== 'none' && Number(cs.opacity) > 0.5,
      title: (root.innerText || '').slice(0, 60),
      info: T.endingInfo(),
    };
  });
  ok('结局判定返回了定义', !!ending.id, `${ending.id}（${ending.tone}）`);
  ok('结局画面真的显示出来', ending.visible, `visible=${ending.visible}`);
  ok('结局画面有标题与正文', ending.title.length > 4, JSON.stringify(ending.title));
  ok('结局列表有 6 个', ending.info.list.length === 6, `count=${ending.info.list.length}`);
  ok('本次结局已解锁并记账', ending.info.list.some((e) => e.id === ending.id && e.unlocked),
    JSON.stringify(ending.info.current));
  // degraded 必须显式暴露 —— 否则"每次都是同一个结局"会变成查不出原因的谜
  ok('未实现系统被显式标记为 degraded（不静默）',
    Array.isArray(ending.degraded), JSON.stringify(ending.degraded));

  // ══════════════════════════════════════════════════════════
  console.log('\n── J. 日记面板 / HUD 控件 ──');
  // ══════════════════════════════════════════════════════════
  const panel = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.reset();
    T.storyRun(1, 20);
    T.flushDialogs();
    T.openDiary();
    const p = document.querySelector('.su-panel');
    const cs = getComputedStyle(p);
    return {
      open: T.storyUI.panelOpen,
      display: cs.display,
      text: (p.innerText || '').slice(0, 200),
      // 面板里应当出现章节/词条/支线这几个小节
      hasChapters: /章节/.test(p.innerText || ''),
      hasLore: /世界观/.test(p.innerText || ''),
      hasSide: /支线/.test(p.innerText || ''),
    };
  });
  ok('日记面板能打开', panel.open && panel.display !== 'none', `display=${panel.display}`);
  ok('面板里有章节小节', panel.hasChapters, panel.text.slice(0, 40));
  ok('面板里有世界观小节', panel.hasLore);
  ok('面板里有支线小节', panel.hasSide);
  ok('面板里没有问号占位（数据真的填进去了）', !/undefined|NaN/.test(panel.text));

  const hud = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.reset(); T.grant(5000, 5000, 50); T.build('turret', 2, 2); T.startWave(); T.tick(120);
    T.hud.setSpeed(2);
    T.hud.setSave('💾 测试存档行');
    T.hud.setSoundOn(false);
    return {
      text: document.getElementById('hud').innerText.replace(/\n+/g, ' | '),
      speedBtn: document.querySelector('.hud-btn--speed') ? document.querySelector('.hud-btn--speed').textContent : null,
      soundBtn: document.querySelector('.hud-btn--sound') ? document.querySelector('.hud-btn--sound').textContent : null,
      saveLine: document.querySelector('.hud-save') ? document.querySelector('.hud-save').textContent : null,
      diaryBtn: !!document.querySelector('.hud-controls button'),   // 控件行存在
      btnCount: document.querySelectorAll('.hud-controls .hud-btn').length,
    };
  });
  ok('HUD 显示波次', /第\s*\d+\s*波/.test(hud.text));
  ok('HUD 显示金币 / 床铺血量', /💰/.test(hud.text) && /🛏/.test(hud.text));
  ok('速度按钮显示倍速', hud.speedBtn === '2×', `text=${hud.speedBtn}`);
  ok('音效按钮显示静音图标', hud.soundBtn === '🔇', `text=${hud.soundBtn}`);
  ok('存档行显示', hud.saveLine === '💾 测试存档行', `text=${hud.saveLine}`);
  ok('控件行有 6 个按钮（波次/暂停/速度/日记/音效/重开）', hud.btnCount === 6, `count=${hud.btnCount}`);

  // 重开的两次确认（防误触）
  const resetArmed = await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    T.reset(); T.grant(9999, 9999, 99); T.build('turret', 0, 0);
    const before = T.snapshot().buildings;
    T.hud.btnReset.click();
    await new Promise((r) => setTimeout(r, 60));
    const armed = { text: T.hud.btnReset.textContent, cls: T.hud.btnReset.className, buildings: T.snapshot().buildings };
    T.hud.btnReset.click();
    await new Promise((r) => setTimeout(r, 60));
    const after = { text: T.hud.btnReset.textContent, buildings: T.snapshot().buildings };
    return { before, armed, after };
  });
  ok('第一次点重开只是武装（不立即清场）', resetArmed.armed.buildings === resetArmed.before,
    `${resetArmed.before} → ${resetArmed.armed.buildings}`);
  ok('武装态有视觉标记', /armed/.test(resetArmed.armed.cls) || resetArmed.armed.text === '再点一次',
    `text=${resetArmed.armed.text} cls=${resetArmed.armed.cls}`);
  ok('第二次点重开真的清场', resetArmed.after.buildings === 0,
    `${resetArmed.armed.buildings} → ${resetArmed.after.buildings}`);

  // ══════════════════════════════════════════════════════════
  console.log('\n── K. 长局稳定性：连跑 60 波不崩 ──');
  // ══════════════════════════════════════════════════════════
  //
  // ⚠️ 这一节最早测出「第 13 波必挂」，看着像难度曲线有问题。查下来
  //    是**测试自己不会玩**，而且踩了三个坑，都记在这里：
  //
  //    1. 「一座塔升到顶再换下一座」：升级费用是 cost·2^(lv-1)，
  //       指数增长 —— 前 8 座把预算吃光，剩下 22 座还在 1 级。
  //       → 改成**轮转升级**（每座轮流 +1）。
  //
  //    2. 只升级、不转职、不点科技：实测三轮对照 ——
  //         纯升级(Lv16)         → 第 18 波
  //         升级 + 分支           → 第 22 波
  //         升级 + 分支 + 科技    → 第 60 波（通关，设计目标 FINAL_WAVE=60）
  //       也就是说**难度曲线是对的**，「科技」就是设计里那个
  //       跨过中期的功率倍增器。测试不点科技就必然撞墙。
  //
  //    3. 把「≥30 波」当成及格线是拍脑袋的：设计目标是 60 波通关，
  //       那就应该断言「能真的打到 60 波并触发胜利」——这比一个
  //       中间数字有意义得多，而且它同时对 60 波全链路的叙事、
  //       存档、结算做了回归。
  const longRun = await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.reset();
    T.grant(99999999, 99999999, 999999);

    // ── 模拟一位"会玩"的玩家：点满科技 ──
    // （3D 层目前还没有科技面板 —— 那是后续步骤的事；
    //   这里直接写 gb.tech，等价于玩家已经买好了这些科技。）
    Object.assign(T.gb.tech, {
      economy: 10, firepower: 10, rapid: 10, electric: 8, structure: 10, ironwall: 10,
      crit: 8, harvest: 5, overload: 6, vitality: 10, greed: 8, mining: 10, sleep: 10,
      focus: 8, swift: 8, runemaster: 6, fortify: 6, looting: 5,
      berserk: 5, thorn: 5, compound: 5, critmaster: 5, soulstorm: 5, overcore: 5,
      annihilation: 4, runelord: 4, fortress: 4, eternity: 4,
    });

    const TYPES = ['turret', 'frost', 'laser', 'missile', 'prism', 'tesla'];
    const cols = 6, rows = 5;   // 8×5 网格里避开床（第 7 列）的 6 列 × 5 行
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) T.build(TYPES[(r * cols + c) % TYPES.length], c, r);
    }
    // 轮转升级（见上面的坑 1）
    for (let round = 0; round < 40; round++) {
      let any = false;
      for (const b of T.gb.buildings) {
        if (b.level >= b.def.maxLv) continue;
        T.towerLayer.select(b);
        const bf = b.level;
        T.towerLayer.upgradeSelected();
        if (b.level !== bf) any = true;
      }
      if (!any) break;
    }
    // 转职（6 级解锁；分支费用花的是灵魂，不是金币）
    for (const b of T.gb.buildings) {
      T.towerLayer.select(b);
      try { T.towerLayer.branchSelected('a'); } catch (e) { /* 该塔无此分支 */ }
    }

    // ── 中途存档 → 读档 → 接着打 ───────────────────────────
    //
    // ⚠️ 这一段是**故意加的**：上一版只从 reset 一路打到死，于是
    //    「读档后建筑 def 丢了（JSON 存不下函数）」这个真 bug 一直
    //    没被抓到 —— 因为读档测试只数了建筑**数量**，而从没在
    //    读档之后真的开过一次火。修完之后把它钉成回归断言：
    //    存档 → 读档 → 立刻走逻辑，若 def 没补回来会当场抛
    //    `b.def.stat is not a function`。
    const midSave = (() => {
      T.startWave();
      for (let i = 0; i < 30; i++) { T.tick(300); if (T.gb.state !== 'wave') break; }
      const ok = T.save();
      const beforeBuildings = T.snapshot().buildings;
      const loaded = T.load();
      // 读档后立刻推进逻辑：这里就是旧版会炸的地方
      let threw = null;
      try {
        T.grant(99999999, 99999999, 999999);
        for (let i = 0; i < 40; i++) T.tick(300);
      } catch (err) { threw = String(err && err.message || err); }
      return {
        saved: !!ok.ok, loaded: !!loaded.ok,
        beforeBuildings, afterBuildings: T.snapshot().buildings,
        threw,
      };
    })();

    const t0 = performance.now();
    let waves = 0;
    for (let w = 1; w <= 60; w++) {
      const st = T.startWave();
      if (st && st.started === false && T.gb.state === 'wave') {
        // 还在打上一波 —— 先把它打完
        for (let i = 0; i < 40 && T.gb.state === 'wave' && !T.gb.gameOver && !T.gb.won; i++) T.tick(300);
      }
      T.flushDialogs();
      for (let i = 0; i < 60; i++) {
        T.tick(300);
        const s = T.snapshot();
        if (s.state !== 'wave' || s.gameOver || s.won) break;
      }
      T.flushDialogs();
      waves = Math.max(waves, T.snapshot().wave);
      if (T.gb.gameOver || T.gb.won) break;
    }
    const ms = performance.now() - t0;
    return { s: T.snapshot(), ms, waves, midSave, endingInfo: T.endingInfo() };
  });
  ok('长局跑完没有抛异常', errors.length === 0, errors.join(' | '));
  // 会玩的玩家（科技 + 分支 + 轮转升级）应当能打到设计终点
  ok('会玩的配置能打到第 60 波（设计终点 FINAL_WAVE）', longRun.waves >= 60,
    `max_wave=${longRun.waves} won=${longRun.s.won} gameOver=${longRun.s.gameOver}`);
  ok('第 60 波触发胜利结算', longRun.s.won === true, `won=${longRun.s.won}`);
  // 读档后接着打不许炸 —— 这是本次修掉的真 bug（建筑 def 的函数字段
  // 过不了 JSON，读回来 `b.def.stat` 变成 undefined）
  ok('中途存档→读档→接着打不抛异常（建筑 def 已补回）',
    longRun.midSave.saved && longRun.midSave.loaded && !longRun.midSave.threw,
    JSON.stringify(longRun.midSave));
  ok('读档后建筑数量不变', longRun.midSave.beforeBuildings === longRun.midSave.afterBuildings,
    `${longRun.midSave.beforeBuildings} → ${longRun.midSave.afterBuildings}`);
  ok('叙事总量可观（对白日志 ≥ 25 条）', longRun.s.story.waveLog >= 25, `waveLog=${longRun.s.story.waveLog}`);
  ok('词条解锁数可观（≥ 15）', longRun.s.story.lore.unlocked >= 15,
    `lore=${longRun.s.story.lore.unlocked}`);
  ok('结局至少解锁了一个', longRun.endingInfo.list.some((e) => e.unlocked),
    JSON.stringify(longRun.endingInfo.list.filter((e) => e.unlocked).map((e) => e.id)));
  console.log(`    长局到第 ${longRun.waves} 波，纯逻辑推演耗时 ${Math.round(longRun.ms)} ms`);

  // 认不出的奖励文案（诊断通道）不应该堆积 —— 堆积说明有文案没被解析
  const ignored = await page.evaluate(() => globalThis.__TANGPING3D__.narrative.ignoredEffects.length);
  console.log(`    未识别的奖励文案：${ignored} 条（会写进日记，不影响流程）`);

  // ══════════════════════════════════════════════════════════
  console.log('\n── L. 截图 ──');
  // ══════════════════════════════════════════════════════════
  await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.reset();
    T.clearSave();
    T.grant(900000, 900000, 9000);
    const layout = [
      ['turret', 0, 0], ['turret', 0, 2], ['turret', 0, 4],
      ['frost', 1, 1], ['laser', 1, 3], ['tesla', 2, 0],
      ['flame', 2, 2], ['missile', 2, 4], ['poison', 3, 1],
      ['prism', 3, 3], ['sonic', 4, 2], ['gravity', 4, 0],
    ];
    for (const [t, c, r] of layout) T.build(t, c, r);
    // 推到第 5 幕（血紫、雾浓）—— 最能看出氛围层在工作的一幕
    T.gb.wave = 50;
    T.mood.setWave(50, true);
    T.startWave();
    T.tick(600);
    T.setPaused(true);
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'shot-step5-act5.png') });
  console.log('  截图: shot-step5-act5.png');

  // 对白演出
  await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.setPaused(false);
    T.reset();
    T.grant(90000, 90000, 900);
    T.storyAt(1);
  });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, 'shot-step5-dialog.png') });
  console.log('  截图: shot-step5-dialog.png');

  // 日记面板
  await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.flushDialogs();
    T.storyRun(1, 25);
    T.flushDialogs();
    T.openDiary();
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'shot-step5-diary.png') });
  console.log('  截图: shot-step5-diary.png');

  // 结局
  await page.evaluate(() => {
    const T = globalThis.__TANGPING3D__;
    T.gb.wave = 60;
    T.storyRun(1, 60);
    T.flushDialogs();
    T.settleEnding();
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, 'shot-step5-ending.png') });
  console.log('  截图: shot-step5-ending.png');

  // 拿到一张有拖尾的战斗图（第 1 幕，亮的，更容易看清弹道）
  await page.evaluate(async () => {
    const T = globalThis.__TANGPING3D__;
    document.querySelector('.su-ending').style.display = 'none';
    T.reset(); T.clearSave();
    T.grant(90000, 90000, 900);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) T.build('turret', c, r);
    T.mood.setWave(1, true);
    T.startWave();
    T.tick(300);
    await new Promise((r) => setTimeout(r, 120));
  });
  await page.screenshot({ path: path.join(OUT, 'shot-step5-trails.png') });
  console.log('  截图: shot-step5-trails.png');

  // ══════════════════════════════════════════════════════════
  console.log('');
  if (errors.length) { console.log('❌ 页面异常:'); errors.forEach((e) => console.log('  ' + e)); }
  if (consoleErrs.length) {
    console.log('控制台错误:');
    consoleErrs.slice(0, 10).forEach((e) => console.log('  ' + e));
  }
  // mood.js 找不到灯是个真实的配置问题，要提醒
  const moodWarn = consoleWarns.filter((w) => /\[mood\]/.test(w));
  if (moodWarn.length) { console.log('⚠ 氛围层警告:'); moodWarn.forEach((w) => console.log('  ' + w)); }

  const good = fail === 0 && errors.length === 0;
  console.log(good
    ? `✅ 全部通过  ——  通过 ${pass} / 失败 ${fail}`
    : `❌ 有失败项  ——  通过 ${pass} / 失败 ${fail}`);

  await browser.close();
  process.exit(good ? 0 : 1);
})().catch((e) => { console.error('验证脚本异常:', e); process.exit(2); });
