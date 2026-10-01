// ============================================================
//  main.js —— 3D 工程入口（第 4 步战斗规则 + 第 5 步叙事 + 第 6 步表现）
// ============================================================
//
// 本文件的职责边界：
//   ✅ 组装：rules（纯逻辑）+ board（胶水）+ 各表现层 + HUD + 叙事 + 音效
//   ✅ 定义一帧的顺序（逻辑帧 → 表现帧）
//   ✅ 暴露受控调试面 __TANGPING3D__
//   ❌ 不写任何数值规则（费用/伤害/波次全在 rules/）
//   ❌ 不碰 canvas 绘制细节（在 stage/fx/enemies/towers/mood 里）
//   ❌ 不写叙事内容（全在 @tangping/story，这里只接线）
//
// ── 第 5 步：叙事运行时 ───────────────────────────────────
//
//   story-ui.js        →  对话框 / 幕卡 / toast / 日记面板 / 结局画面
//   story-runtime.js   →  StoryHost 的 3D 实现 + 奖励文案解析
//   audio.js           →  WebAudio 合成音效 + 深层氛围音 + 秘密旋律
//   save.js            →  localStorage 存档（不依赖像素布局）
//   ending.js          →  6 个结局的判定与跨局解锁
//   @tangping/story    →  波次管线（章节→词条→支线→事件→插叙）+ 全部剧情数据
//
//   接线点只有一个：**开波时** narrative.onWaveStart(wave)。
//   这是有意的 —— 叙事只在波次边界推进，战斗中途不打断（塔防的节奏要求）。
//
// ── 一帧的顺序（这个顺序很重要）────────────────────────────
//
//   stage.onStep（固定 1/60）
//     board.stepBoard()          ← 逻辑：波次→经济→炮塔(发弹道请求)→敌人移动
//   stage.onBeforeRender（每帧一次）
//     shots.update()             ← 弹道飞行 + 命中结算（会产生新的 fx 请求）
//     fx.update()                ← 消费 fx 请求，推进粒子/飘字
//     enemies.sync()             ← 读最终状态画怪
//     towers.updateViews()       ← 读最终状态画塔
//     mood.update()              ← 氛围光/雾随幕次与战况变化（第 6 步）
//     storyUI.update()           ← 幕卡倒计时
//     hud 刷新
//
// 注意「弹道飞行」放在**表现帧**而不是逻辑帧：它只在有渲染时才存在，
// 纯逻辑测试走的是 rules 的瞬时结算通道。两条路都验证过。
//
// ── 暂停语义（对话时为什么要停）────────────────────────────
//
//   塔防里玩家在读对白时不该被 EPIC 打死。所以对话一开就 paused=true，
//   对白全读完才恢复。这里用**两个独立变量**：
//     paused      —— 玩家自己按的暂停（按钮状态要跟着变）
//     storyHold   —— 叙事占用（按钮状态不能变，否则玩家会以为是自己按的）
//   合成一个 eventual「是否推进逻辑」的判定，避免两者互相把对方关掉。
//
// ── 第 6 步：表现增强 ──────────────────────────────────────
//
//   mood.js（环境光/雾/暗角随幕次切换）
//   enemies.js 的受击闪白 + 死亡溶解
//   towers.js 的 BOSS 光环
//   shots.js 的弹道拖尾
//   全部代码生成，零外部资产（这个项目没有美术资产管线）。
// ============================================================

import * as THREE from 'three';
import { createStage } from './stage.js';
import { buildTerrain, setCellHighlight } from './terrain.js';
import { createEnemyLayer } from './enemies.js';
import { createHud } from './hud.js';
import { createTowerLayer } from './towers.js';
import { createShotLayer } from './shots.js';
import { createFxLayer } from './fx.js';
import { createMood } from './mood.js';
import { createStoryUI } from './story-ui.js';
import { createNarrative } from './story-runtime.js';
import { createAudio } from './audio.js';
import { createEndingSystem } from './ending.js';
import { makeBoard, makeCtx, stepBoard, beginWave, resetBoard, resyncCtx } from './board.js';
import { assertWorldContract, LANES, WORLD_W, WORLD_D, cellCenter, COLS } from './world.js';
import { loadStoryManifest, SOUND_MELODIES, STORY_VIDEO_SLOTS } from './story.js';
import { damageTarget } from './rules/combat.js';
import { FINAL_WAVE } from './rules/constants.js';
import { saveGame, loadGame, hasSave, clearSave, saveInfo, SAVE_VERSION } from './save.js';

// ══════════════════════════════════════════════════════════
//  舞台与地形
// ══════════════════════════════════════════════════════════

const canvas = document.getElementById('scene');
const hudRoot = document.getElementById('hud');

const stage = createStage({ canvas });
const terrain = buildTerrain();
stage.scene.add(terrain.group);

// 第 6 步：氛围层（光 / 雾 / 暗角）。挂在地形之后、表现层之前。
const mood = createMood(stage.scene, stage.camera);

// ══════════════════════════════════════════════════════════
//  规则层：gb + ctx
// ══════════════════════════════════════════════════════════

const gb = makeBoard();
let paused = false;
/** 叙事占用（对话/幕卡演出中）。与 paused 分开，见文件头「暂停语义」。 */
let storyHold = false;
let gameSpeed = 1;

/** 当前是否推进逻辑。两个暂停来源取「或」—— 任一为真就停。 */
const isFrozen = () => paused || storyHold;

// ══════════════════════════════════════════════════════════
//  音效（WebAudio 合成，零外部资产）
// ══════════════════════════════════════════════════════════

const audio = createAudio({ enabled: true, volume: 0.35 });
audio.setMelodies(SOUND_MELODIES);

// 浏览器要求音频在**用户手势**之后才能真正出声。
// 挂一次性的 pointerdown/keydown，任一手势到达就解锁。
{
  const unlock = () => {
    audio.unlock();
    audio.setAmbient(audio.ambientDepth || 0);
    globalThis.removeEventListener('pointerdown', unlock);
    globalThis.removeEventListener('keydown', unlock);
  };
  globalThis.addEventListener('pointerdown', unlock);
  globalThis.addEventListener('keydown', unlock);
}

// ══════════════════════════════════════════════════════════
//  表现层
// ══════════════════════════════════════════════════════════

const enemyLayer = createEnemyLayer(stage.scene);
const shotLayer = createShotLayer(stage.scene);
const fxLayer = createFxLayer(stage.scene, {
  onShake: (p) => { /* 震屏幅度由 fxLayer.shake 提供，渲染时施加到相机 */ },
  // 第 5 步接线：rules/combat.js 发出来的音效名直接交给合成器。
  // 合成器内部有 40ms 节流 —— 20 座塔同帧开火不会叠成噪音。
  onSfx: (name) => audio.sfx(name),
});

const hud = createHud(hudRoot, {
  onBuildType: (type) => towerLayer.setGhost(type),
  onUpgrade: () => {
    const r = towerLayer.upgradeSelected();
    if (!r.ok) hud.notify('⚠ ' + r.why);
    else hud.notify(`升级到 Lv${r.level}`);
    hud.setPanel(towerLayer.selectedInfo());
  },
  onBranch: (which) => {
    const r = towerLayer.branchSelected(which);
    if (!r.ok) hud.notify('⚠ ' + r.why);
    else hud.notify('转职成功：' + which.toUpperCase());
    hud.setPanel(towerLayer.selectedInfo());
  },
  onSell: () => {
    const r = towerLayer.sellSelected();
    if (!r.ok) hud.notify('⚠ ' + r.why);
    else hud.notify(`已出售，返还 ${r.refund}💰`);
    hud.setPanel(null);
  },
});

const towerLayer = createTowerLayer(stage.scene, {
  gb, ctx: null, terrain,   // ctx 稍后回填（它需要 fxLayer）
  onSelect: (b) => {
    hud.setPanel(towerLayer.selectedInfo());
  },
  onReject: (why) => hud.notify('⚠ ' + why),
  getBuildType: () => hud.buildType,
  // 第 5 步：每次成功建造报一次建筑 key —— 秘密旋律彩蛋（SOUND_MELODIES）
  // 就是靠「连续点击这几座建筑」触发的。
  onBuilt: (b) => {
    const hit = audio.tapBuild(b.type);
    if (hit) {
      storyUI.toast('🎵 ' + (hit.name || '隐藏旋律'), hit.reward || '旋律回响', 'gold', 8);
      if (hit.rewardSpec) narrative.host.applyEffect(hit.reward || '');
      narrative.host.diary('discover', '触发了隐藏旋律「' + (hit.name || '') + '」');
    }
  },
});

// ctx 需要 towerLayer 与 fxLayer 都存在，所以在这里回填
const ctx = makeCtx(gb, fxLayer.fx, {
  onKill: (e, reward) => {
    // 精英/BOSS 击杀给飘字强调（普通击杀已经在 combat.js 里飘了）
    if (e.boss) hud.notify(`💀 击破 ${e.def.name}！+${Math.round(reward.gold)}💰`, 2200);
  },
  onGameOver: () => {
    gb.gameOver = true;
    audio.sfx('gameOver');
    storyUI.toast('💀 梦碎了', '床铺被打穿 —— 按「重开」再战', 'red', 8);
    hud.notify('💀 床铺被打穿了… 按「重开」再战', 6000);
  },
  onFinalBossKilled: () => {
    gb.won = true;
    audio.sfx('victory');
    hud.notify(`🎉 第 ${FINAL_WAVE} 波最终 BOSS 已击破 —— 你守住了这条防线`, 8000);
    // 结局判定延迟一点，让胜利提示先出现
    setTimeout(() => settleEnding(), 900);
  },
});
towerLayer.bindInput(canvas, stage.camera);

// 撞门回调：门破了就打床
const boardDeps = {
  onKnock: (e, target) => {
    damageTarget(target, e.dmg, ctx);
    if (target.isDoor && target.broken) {
      hud.notify(`🚪 车道 ${e.lane + 1} 的铁门被撞碎了！`, 2400);
      fxLayer.fx.shake(8);
      const p = { x: target.x, y: target.y };
      fxLayer.fx.effect({ type: 'boom', x: p.x, y: p.y, r: 90, maxLife: 0.5, life: 0.5, color: '#ff9a3c' });
    }
  },
};

// ══════════════════════════════════════════════════════════
//  叙事：UI + 运行时 + 结局
// ══════════════════════════════════════════════════════════
//
// 依赖顺序有讲究：
//   storyUI 先于 narrative（narrative 的宿主要用 storyUI 做演出）
//   narrative 先于 towerLayer 的 onBuilt（那里会调 narrative.host）
// 但 towerLayer 的创建在上面 —— 所以 onBuilt 里用的是**闭包延迟求值**，
// 真正被调用时 narrative 一定已经存在（玩家第一次建造之前就装配完了）。

const storyUI = createStoryUI(hudRoot, {
  onDialogOpen: () => {
    storyHold = true;
    audio.sfx('dialog');
  },
  onDialogClose: () => {
    storyHold = false;
    // 对白读完顺手存一次档 —— 这是最自然的存档点（波次边界 + 无战斗压力）
    autoSave();
  },
  onChoice: (choice) => {
    if (choice && choice.effect) {
      applyChoiceEffect(choice.effect);
    }
  },
});

const narrative = createNarrative({
  ui: storyUI,
  gb,
  onWaveStory: (r) => {
    // 本波触发了什么 —— 写进 HUD 的叙事行，方便肉眼确认节奏
    const bits = [];
    if (r.main) bits.push('主线');
    if (r.boss) bits.push('BOSS');
    if (r.chapter) bits.push(`章节 ${r.chapter.title || r.chapter.id || ''}`);
    if ((r.side || []).length) bits.push(`支线 ${r.side.length}`);
    if ((r.event || []).length) bits.push(`事件 ${r.event.length}`);
    if ((r.perspective || []).length) bits.push('插叙');
    if (bits.length) hud.setStory(`📖 第 ${r.wave} 波：${bits.join(' · ')}（预算 ${r.budgetUsed}/${r.budget}）`, true);
  },
  onEnding: (stats) => settleEnding(stats),
});

/** 玩家选项的 effect 文案 → 实际加成（走宿主同一套解析器） */
function applyChoiceEffect(effect) {
  // 有些选项的 effect 是纯叙事标记（「困惑的记忆碎片被激活」），
  // 解析不出数值就是正常的 —— 不报警，也不影响流程。
  const r = narrative.host.applyEffect(effect);
  return r;
}

const endings = createEndingSystem();

/**
 * 结局结算。通关（第 60 波最终 BOSS 被击破）时调用一次。
 *
 * ⚠️ 这里要显式处理「3D 还没移植好感度/理解路线」这件事：
 *    ending.js 会把 maxAffinity / mercyDone 读成 0 并给出 degraded 列表。
 *    如果不把 degraded 暴露出来，表现就是「怎么每次都是同一个结局」——
 *    一个查不出原因的谜。所以这里既打日志，也在结局画面上标一行。
 */
let _settled = false;
function settleEnding() {
  if (_settled) return null;
  _settled = true;

  const prog = narrative.runtime.progress();
  const r = endings.evaluate({ gb, progress: prog });

  const stats = Object.assign({
    wave: gb.wave,
    kills: gb.stats.kills,
    souls: Math.round(gb.souls),
  }, narrative.stats());

  storyUI.showEnding(
    {
      id: r.def.id, kind: r.tone.label, title: r.def.icon + ' ' + r.def.title,
      text: r.def.text + '\n\n' + r.def.epilogue,
    },
    stats,
    () => { hardReset(); },
  );

  if (r.degraded.length) {
    console.warn('[main] 结局判定降级（3D 尚未实现的系统）：', r.degraded);
    storyUI.toast('⚠ 结局判定降级', r.degraded.join('；'), 'red', 10);
  }
  if (r.isNew) storyUI.toast('🏆 解锁新结局', r.def.title + ' —— ' + r.def.subtitle, 'gold', 9);

  // 通关后清掉本局存档（结局已结算，读档会回到通关前一刻，没有意义）
  clearSave();
  return r;
}

// ══════════════════════════════════════════════════════════
//  启动自检
// ══════════════════════════════════════════════════════════

const check = assertWorldContract();
hud.setContract(check.ok, check.problems);
if (!check.ok) console.error('[world-contract] 不一致：', check.problems);

loadStoryManifest().then((m) => {
  console.log('[story] @tangping/story 接入结果：', m);
  hud.setStory(
    m.ok
      ? `✅ 叙事包已接入：${m.arcs} 幕 / ${m.characters} 角色 / ${m.waveStories} 条波次剧情 / ${m.bossDialog} 组 BOSS 对话 / ${m.loreEntries} 词条`
      : `❌ 叙事包接入失败：${m.error}`,
    m.ok,
  );
}).catch((e) => {
  console.error('[story] 加载异常', e);
  hud.setStory('❌ 叙事包加载抛出异常：' + e.message, false);
});

// 宿主能力自检：少实现一个能力 = 那条通道的剧情静默丢失
if (!narrative.audit.ok) {
  console.warn('[main] 叙事宿主缺少能力：', narrative.audit.missing);
  hud.notify('⚠ 叙事宿主缺少能力：' + narrative.audit.missing.join(', '), 8000);
}

// ══════════════════════════════════════════════════════════
//  存档
// ══════════════════════════════════════════════════════════

/**
 * 自动存档。只在**备战期**存 —— 波次进行中存档要连 spawnQueue 一起存，
 * 会引入一堆边界情况，收益却只是「少点一次开始下一波」。不值得。
 */
function autoSave() {
  if (gb.state === 'wave') return null;
  if (gb.gameOver || gb.won) return null;
  const r = saveGame(gb, {
    story: narrative.snapshot(),
    melodies: audio.melodySnapshot(),
    fps: fpsShown,
  });
  if (r.ok) hud.setSave(`💾 第 ${r.wave} 波已存档`);
  return r;
}

/** 读档 */
function doLoad() {
  const r = loadGame(gb, { narrative, audio });
  if (!r.ok) { hud.notify('⚠ ' + r.why); return r; }

  // ⚠️⚠️ 必须 resyncCtx：ctx 缓存了 gb.stats / gb.enemies / gb.doors / gb.bed
  //     的**引用**。applyBoard 用的是原地写法（引用不变），但这里仍然
  //     显式再对一遍 —— 见 board.js::resyncCtx 的注释：
  //     「把它做成一个必须调用的收尾步骤，比依赖『记得别替换』可靠」。
  resyncCtx(ctx, gb);

  // 表现层要跟着清干净（否则画面上会留着上一局的塔/子弹/粒子）
  pendingShots = [];
  shotLayer.clear();
  fxLayer.fx.clear ? fxLayer.fx.clear() : null;
  rebuildTowerViews();
  towerLayer.select(null);
  hud.setPanel(null);

  // 叙事 UI 不重置（叙事进度是刚读回来的），但要把残留演出清掉
  storyUI.closePanel();
  storyUI.hideEnding();

  _settled = false;
  audio.setAmbient(mood.depthFor(gb.wave));
  hud.notify(`💾 已读档：第 ${gb.wave} 波`);
  return r;
}

/** 重开一局（严格：连叙事进度一起清） */
function hardReset() {
  resetBoard(gb);
  resyncCtx(ctx, gb);
  pendingShots = [];
  shotLayer.clear();
  rebuildTowerViews();
  towerLayer.select(null);
  hud.setPanel(null);

  // 叙事：UI + 运行时 + 结局（本局结局清空，跨局解锁保留）
  storyUI.reset();
  narrative.reset();
  endings.reset();
  _settled = false;

  // 音频：氛围回浅层，旋律彩蛋记录清掉
  audio.stopAmbient();
  audio.melodyRestore([]);
  mood.setDepth(0);

  clearSave();
  hud.setSave('');
  hud.notify('已重开');
}

/** 重建塔的视图（读档/重开后，场上建筑换了一批，视图必须跟着换） */
function rebuildTowerViews() {
  for (const v of towerLayer.views.values()) stage.scene.remove(v.group);
  towerLayer.views.clear();
  // 让 towers.js 在下一帧按新的 gb.buildings 重建视图
  if (typeof towerLayer.rebuildViews === 'function') towerLayer.rebuildViews();
}

// ══════════════════════════════════════════════════════════
//  逻辑帧（固定 1/60）
// ══════════════════════════════════════════════════════════

const FPS_WINDOW = 0.5;
let fpsAcc = 0, fpsCount = 0, fpsShown = 0;
/** 上一逻辑帧产生的弹道请求，交给表现帧去飞 */
let pendingShots = [];

stage.onStep((dt) => {
  if (isFrozen()) return;
  fpsAcc += dt; fpsCount++;

  // 命中停顿（BOSS 击杀）时放慢逻辑 —— 这是塔防的手感关键
  const hitStop = fxLayer.hitStop;
  const scaled = hitStop > 0 ? dt * 0.15 : dt * gameSpeed;

  const { shots } = stepBoard(gb, ctx, scaled, boardDeps);
  if (shots.length) pendingShots.push(...shots);
  // 上限保护：极端情况下别让数组无限增长
  if (pendingShots.length > 600) pendingShots = pendingShots.slice(-400);

  if (fpsAcc >= FPS_WINDOW) {
    fpsShown = fpsCount / fpsAcc;
    fpsAcc = 0; fpsCount = 0;
  }
});

// ══════════════════════════════════════════════════════════
//  表现帧（每帧一次）
// ══════════════════════════════════════════════════════════

const camTarget = new THREE.Vector3(WORLD_W * 0.52, 0, WORLD_D * 0.5);
const camBase = stage.camera.position.clone();

stage.onBeforeRender((dt) => {
  // 演出期间用真实的 dt 推进 UI（幕卡倒计时不能被暂停冻住，
  // 否则「暂停中触发的幕卡」永远不会消失）
  storyUI.update(dt);

  const d = Math.min(dt, 0.05) * (isFrozen() ? 0 : gameSpeed);

  // 1. 弹道飞行 + 命中结算（会产生新的 fx 请求）
  if (pendingShots.length) {
    shotLayer.spawn(pendingShots);
    pendingShots = [];
  }
  shotLayer.update(d, gb, fxLayer.fx, ctx);

  // 2. 消费 fx 请求（粒子/飘字/特效）
  fxLayer.update(d);

  // 3. 画怪 / 画塔
  enemyLayer.sync(gb.enemies, d);
  towerLayer.updateViews(d);

  // 4. 氛围（第 6 步）：幕次 + 战况 → 光/雾/暗角
  mood.update(d, {
    wave: gb.wave,
    state: gb.state,
    alive: gb.enemies.length,
    bedHp: gb.bed.hp,
    bedMax: gb.bed.maxHp,
    bossAlive: gb.enemies.some((e) => e.boss),
    gameOver: !!gb.gameOver,
    won: !!gb.won,
  });

  // 5. 震屏：把 fxLayer 的强度施加到相机上（正交相机平移即可）
  const sh = fxLayer.shake;
  if (sh > 0) {
    const k = sh * 0.0016;
    stage.camera.position.set(
      camBase.x + (Math.random() - 0.5) * k,
      camBase.y + (Math.random() - 0.5) * k,
      camBase.z + (Math.random() - 0.5) * k,
    );
  } else {
    stage.camera.position.copy(camBase);
  }

  // 6. HUD
  hud.setFps(fpsShown);
  hud.setWave(gb.wave, gb.state, gb.prepTimer);
  hud.setGold(gb.gold);
  hud.setPower(gb.power);
  hud.setSouls(gb.souls);
  hud.setBed(gb.bed.hp, gb.bed.maxHp);
  hud.setAffordable(gb);
});

// ══════════════════════════════════════════════════════════
//  交互
// ══════════════════════════════════════════════════════════

/** 开波：先跑叙事钩子（剧情在战斗开始前播完），再放怪 */
function startNextWave() {
  if (gb.state === 'wave' || gb.gameOver || gb.won) return false;
  const next = gb.wave + 1;

  // 叙事在**战斗开始前**推进：这样主线对白不会被战斗打断，
  // 而玩家读完点「继续」正好开打。顺序是刻意的。
  let storyResult = null;
  try {
    storyResult = narrative.onWaveStart(next);
  } catch (e) {
    console.warn('[main] 叙事钩子异常（不影响战斗）：', e);
  }

  // 幕次切换 → 氛围跟着变
  const depth = mood.depthFor(next);
  audio.setAmbient(depth);

  const okStarted = beginWave(gb, ctx);
  if (okStarted) {
    audio.sfx('waveStart');
    hud.notify(`⚔ 第 ${gb.wave} 波来了`);
  }
  return { started: okStarted, story: storyResult };
}

hud.btnWave.addEventListener('click', () => startNextWave());

hud.btnToggle.addEventListener('click', () => {
  paused = !paused;
  hud.setPaused(paused);
  hud.setSpeed(gameSpeed);
});

hud.btnReset.addEventListener('click', () => {
  // 「重开」按两次：第一次清空，第二次才真正重开（防误触）
  if (!hud.btnReset.dataset.armed) {
    hud.btnReset.dataset.armed = '1';
    hud.setResetArmed(true);
    setTimeout(() => {
      if (hud.btnReset.dataset.armed) {
        delete hud.btnReset.dataset.armed;
        hud.setResetArmed(false);
      }
    }, 2600);
    return;
  }
  delete hud.btnReset.dataset.armed;
  hud.setResetArmed(false);
  hardReset();
});

// 日记 / 设定集面板
hud.btnDiary.addEventListener('click', () => {
  storyUI.togglePanel(narrative.panelData());
  // 打开面板时暂停：玩家在读书时不该被偷袭
  if (storyUI.panelOpen) paused = true; else paused = false;
  hud.setPaused(paused);
});

// 音效开关
hud.btnSound.addEventListener('click', () => {
  const on = audio.setEnabled(!audio.enabled);
  hud.setSoundOn(on);
  if (on) { audio.unlock(); audio.setAmbient(mood.depthFor(gb.wave)); }
  hud.notify(on ? '🔊 音效已开启' : '🔇 音效已关闭');
});

// 键盘快捷键
globalThis.addEventListener('keydown', (e) => {
  // 输入框里不抢键
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

  switch (e.key) {
    case ' ':  // 空格：开下一波 / 推进对话
      e.preventDefault();
      if (storyUI.dialogOpen) storyUI.nodes.dlgWrap.click();
      else startNextWave();
      break;
    case 'p': case 'P':
      hud.btnToggle.click();
      break;
    case 'd': case 'D':
      hud.btnDiary.click();
      break;
    case 'm': case 'M':
      hud.btnSound.click();
      break;
    case '1': case '2': case '3':
      gameSpeed = [1, 2, 4][Number(e.key) - 1];
      hud.setSpeed(gameSpeed);
      hud.notify(`⏩ 速度 ×${gameSpeed}`);
      break;
    // 数字键 4-9 快速选建造类型（与建造栏顺序一致）
    case 'q': case 'Q': gameSpeed = 1; hud.setSpeed(1); break;
    default: break;
  }
});

// ══════════════════════════════════════════════════════════
//  视口适配（移动端健壮性）
// ══════════════════════════════════════════════════════════
//
// 只监听 window.resize 在手机上是不够的：
//   · 地址栏收起/展开、软键盘弹出 → 可视高度变化。iOS Safari 上
//     window.innerHeight 的更新时机不可靠（常常滞后甚至不更新），
//     而 visualViewport 是为此设计的、更准的信号。
//   · 横竖屏切换 → 部分浏览器主要靠 orientationchange（resize 可能
//     在尺寸稳定前就触发，拿到中间值）。
//
// 所以三种事件都汇聚到同一个 fit()，并在 fit() 里对**相同尺寸去重**：
// 重复调用 stage.resize 会白白重建 WebGL 缓冲区（移动端尤其贵）。

let lastFitW = -1, lastFitH = -1;

function fit() {
  // visualViewport 判空：部分浏览器（老 Safari / 部分 WebView）没有它。
  const vv = window.visualViewport;
  const w = Math.round(vv ? vv.width : window.innerWidth);
  const h = Math.round(vv ? vv.height : window.innerHeight);
  if (w === lastFitW && h === lastFitH) return;   // 去重：尺寸没变就不重建缓冲区
  lastFitW = w;
  lastFitH = h;
  stage.resize(w, h);
}

window.addEventListener('resize', fit);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fit);
}
window.addEventListener('orientationchange', () => {
  // 方向切换后可视尺寸要等一两拍才稳定（Safari 尤其明显），
  // 这里立刻量一次、下一帧再量一次、250ms 后再量一次兜底。
  fit();
  requestAnimationFrame(fit);
  setTimeout(fit, 250);
});
fit();

/** 每帧更新「开始下一波」按钮的状态 */
setInterval(() => {
  const canStart = gb.state !== 'wave' && !gb.gameOver && !gb.won && !storyUI.isBusy();
  hud.setWaveBtn(
    gb.gameOver ? '已失败'
      : (gb.won ? '已通关'
        : (gb.state === 'wave' ? `第 ${gb.wave} 波进行中`
          : (storyUI.isBusy() ? '…剧情中' : `开始第 ${gb.wave + 1} 波`))),
    canStart,
  );
  // 备战期自动存档（每 5 秒一次足够 —— 存档不是逐帧操作）
  if (!storyUI.isBusy() && gb.state !== 'wave' && gb.wave > 0 && !gb.gameOver && !gb.won) {
    if (!autoSave._t || Date.now() - autoSave._t > 5000) {
      autoSave._t = Date.now();
      autoSave();
    }
  }
}, 200);

// ══════════════════════════════════════════════════════════
//  受控调试面
// ══════════════════════════════════════════════════════════

function snapshot() {
  return {
    wave: gb.wave,
    state: gb.state,
    prepTimer: +gb.prepTimer.toFixed(2),
    gold: Math.round(gb.gold),
    power: Math.round(gb.power),
    souls: Math.round(gb.souls),
    alive: gb.enemies.length,
    buildings: gb.buildings.length,
    kills: gb.stats.kills,
    dmg: Math.round(gb.stats.dmg),
    bed: { hp: Math.round(gb.bed.hp), maxHp: Math.round(gb.bed.maxHp) },
    doors: gb.doors.map((d) => ({ lane: d.lane, hp: Math.round(d.hp), broken: d.broken })),
    flying: shotLayer.flying,
    gameOver: !!gb.gameOver,
    won: !!gb.won,
    // ── 第 5 步新增：叙事可观测性 ──
    story: {
      dialogOpen: storyUI.dialogOpen,
      pending: storyUI.pending,
      panelOpen: storyUI.panelOpen,
      busy: storyUI.isBusy(),
      chapters: narrative.runtime.progress().chapters,
      side: narrative.runtime.progress().side,
      lore: narrative.runtime.progress().lore,
      fragments: (gb.fragments || []).length,
      waveLog: narrative.waveLog.length,
      ignoredEffects: narrative.ignoredEffects.length,
    },
    audio: { enabled: audio.enabled, unlocked: audio.unlocked, ambient: audio.ambientDepth },
  };
}

globalThis.__TANGPING3D__ = {
  version: '0.3.0-step6',
  gb, ctx, stage, terrain, hud, towerLayer, shotLayer, fxLayer, enemyLayer, mood,
  audio, storyUI, narrative, endings,
  LANES, WORLD_W, WORLD_D, cellCenter,
  contract: () => assertWorldContract(),
  snapshot,

  /**
   * 剧情镜头位表（sceneId → { title, video, poster }）。
   * 暴露给验收脚本，让它能确认「六个镜头位真的填了素材、路径真能下载」，
   * 而不是只检查 UI 有没有渲染出一个空 div。
   */
  STORY_VIDEO_SLOTS,

  /**
   * 设计终点（第 60 波）。暴露给自动化脚本，让它们能**从规格派发**
   * 自己要跑多深，而不是把 10 / 30 / 60 这类数字抄进脚本里。
   * 抄进去的数字会在数值调整时悄悄失真，而失真的验收脚本比没有还糟。
   */
  FINAL_WAVE,

  /**
   * 确定性推演：绕开 rAF 直接跑 N 帧逻辑（自动化测试专用）。
   *
   * ⚠️ 最后要多飞一段：一帧里「塔发射弹道请求」和「子弹命中结算」
   *    之间隔了子弹的飞行时间，而上面的循环里 shotLayer.update() 是
   *    先于本帧新生成的 shots 的（同真实渲染帧的顺序）。
   *    所以跑完 N 帧后，最后一批塔还在飞 —— 快照会漏掉它们的伤害。
   *    收尾再空跑 40 帧（≈0.67s，覆盖最慢的导弹 330px/s 走满 323px），
   *    让所有在飞的子弹都落地，快照才是真的。
   */
  tick(frames = 60, dt = 1 / 60, settle = true) {
    for (let i = 0; i < frames; i++) {
      const { shots } = stepBoard(gb, ctx, dt, boardDeps);
      if (shots.length) shotLayer.spawn(shots);
      shotLayer.update(dt, gb, fxLayer.fx, ctx);
      fxLayer.update(dt);
    }
    if (settle) {
      for (let i = 0; i < 40; i++) {
        const { shots } = stepBoard(gb, ctx, dt, boardDeps);
        if (shots.length) shotLayer.spawn(shots);
        shotLayer.update(dt, gb, fxLayer.fx, ctx);
      }
    }
    return snapshot();
  },

  /** 开一波（含叙事钩子 —— 与玩家点按钮走同一条路） */
  startWave() { startNextWave(); return snapshot(); },

  /**
   * 只跑叙事钩子，不放怪（第 5 步验收用）。
   * 让测试可以单独检查「第 N 波的剧情是什么」，不受战斗影响。
   */
  storyAt(wave) {
    const r = narrative.onWaveStart(wave);
    return r;
  },

  /** 直接把叙事推到第 N 波（连播剧情，验收用）。返回最后的快照。 */
  storyRun(fromWave = 1, toWave = 1) {
    for (let w = fromWave; w <= toWave; w++) narrative.onWaveStart(w);
    return snapshot();
  },

  /**
   * 清空对话队列（测试/自动化驱动用）。
   *
   * ⚠️ 光点 dlgWrap 是不够的：带 choices 的对白**故意**不响应点击推进
   *    （见 story-ui.js：有选项时 `playNext` 不触发，逼玩家做选择）。
   *    所以这里在探测到有选项时点第一个选项按钮 —— 这正是玩家会做的事。
   *
   * 这个失败模式值得一提：第一版把「点了 200 次还没关掉」当成 bug 去查，
   * 实际上那是**设计正确**的表现。驱动脚本必须模拟「真实玩家怎么推进」，
   * 而不是「我以为怎么推进」。
   */
  flushDialogs(maxRounds = 400) {
    let n = 0;
    while ((storyUI.pending > 0 || storyUI.dialogOpen) && n < maxRounds) {
      const choice = storyUI.nodes.dlgWrap.querySelector('.su-choice');
      if (choice) choice.click();
      else storyUI.nodes.dlgWrap.click();
      n++;
    }
    return n;
  },

  /** 打开日记面板（验收截图用） */
  openDiary() { hud.btnDiary.click(); return snapshot(); },

  /** 成就与结局信息（验收用） */
  endingInfo() {
    return {
      list: endings.list().map((e) => ({ id: e.def.id, title: e.def.title, unlocked: e.unlocked })),
      progress: endings.progress(),
      current: endings.current() ? endings.current().id : null,
    };
  },

  /** 战斗中用：BOSS 阶段台词 */
  bossLine: (key, phase) => narrative.runtime.bossLine(key, phase),

  /** 在（col,row）造一座塔（自动化测试用，不打射线） */
  build(type, col, row) {
    const b = towerLayer.tryBuild(type, col, row);
    return b ? { ok: true, type: b.type, col, row } : { ok: false };
  },

  /** 一次性造一批塔（摆好阵型再推演） */
  buildRow(type, row, cols = [0, 1, 2, 3, 4, 5]) {
    const out = [];
    for (const c of cols) out.push(this.build(type, c, row));
    return out;
  },

  /** 直接给资源（测试/调试用） */
  grant(gold = 1000, power = 1000, souls = 100) {
    gb.gold += gold; gb.power += power; gb.souls += souls;
    return snapshot();
  },

  /** 场上敌人「progress → 世界坐标」的派生结果（不变量断言用） */
  positions() {
    return gb.enemies.map((e) => {
      const d = ctx.xyOf(e);
      return { lane: e.lane, progress: +e.progress.toFixed(6), state: e.state, x: +(d.x * 0.01).toFixed(4), z: +(d.y * 0.01).toFixed(4) };
    });
  },

  /** 放一只指定类型的敌人（调试用） */
  spawn(type = 'grunt', lane = 0) {
    // board.stepBoard 会在第一帧初始化 gb.__spawnFn，这里直接用它
    const fn = gb.__spawnFn;
    if (!fn) return { ok: false, why: '还没跑过一帧（spawnFn 未初始化）' };
    const e = fn(type, gb.wave || 1, lane);
    return e ? { ok: true, type: e.type, hp: Math.round(e.hp), lane } : { ok: false };
  },

  // ── 存档 / 读档（第 5 步）──
  save: () => saveGame(gb, { story: narrative.snapshot(), melodies: audio.melodySnapshot(), fps: fpsShown }),
  load: () => doLoad(),
  hasSave,
  saveInfo,
  clearSave,
  saveVersion: SAVE_VERSION,

  // ── 结局（第 5 步）──
  settleEnding: () => settleEnding(),

  setPaused(v) { paused = !!v; hud.setPaused(paused); },
  setSpeed(v) { gameSpeed = Math.max(0.1, Math.min(8, v)); hud.setSpeed(gameSpeed); return gameSpeed; },
  reset() { hardReset(); return snapshot(); },
};

stage.start();
console.log('[tangping-3d] 第 4 步：core.js 战斗规则已接入', {
  lanes: LANES.length, cols: COLS, worldW: WORLD_W, worldD: WORLD_D,
});
console.log('[tangping-3d] 第 5 步：叙事运行时已接线（剧情/日记/结局/音效/存档）');
console.log('[tangping-3d] 第 6 步：氛围光 / 雾 / 暗角 / 受击闪白 / BOSS 光环 / 弹道拖尾');
console.log('[tangping-3d] 调试面 window.__TANGPING3D__ —— 试试：');
console.log('  __TANGPING3D__.grant(5000)');
console.log('  __TANGPING3D__.startWave()');
console.log('  __TANGPING3D__.tick(3600)');
console.log('  __TANGPING3D__.snapshot()');
console.log('  __TANGPING3D__.storyRun(1, 60)        // 一口气播完 60 波剧情');
console.log('  __TANGPING3D__.openDiary()            // 打开梦境日记');
console.log('  __TANGPING3D__.save() / .load()       // 存档 / 读档');
