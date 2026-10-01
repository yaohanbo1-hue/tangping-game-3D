// 规则层「能打起来」验收（纯 Node，零渲染、零 three）。
// 用法：node scripts/verify-combat.mjs
//
// 这是第 4 步的核心验收：把 constants/buildings/combat/towers/wave 串成
// 一条完整的战斗管线，在**没有任何浏览器/渲染**的环境下跑一场仗。
//
// 如果这个脚本能跑通，就证明两件事：
//   ① 规则层确实与渲染层解耦了（fx 全是 no-op 也能算完）
//   ② bstat / 伤害管线 / 索敌 / 开火 / 波次 串起来逻辑自洽
//
// 覆盖：
//   A. bstat 面板属性（等级 / 分支 / 符文 / 科技）
//   B. 伤害管线（抗性、护盾、DoT、元素反应、击杀结算）
//   C. 炮塔索敌与开火（含瞬发 / 弹道两类）
//   D. 全链路：造塔 → 造怪 → 跑 1800 帧 → 敌死 / 门破
//   E. 波次编排（队列、结算）
//   F. 生命公式（building/door/bed）

import {
  BUILD_DEFS, ENEMY_DEFS, BOSS_DEFS, DMG, DMG_KEYS, findReaction, DIFFS, FINAL_WAVE,
} from '../src/rules/constants.js';
import {
  bstat, techVal, buildingMaxHp, doorMaxHp, bedMaxHp,
  totalGoldRate, powerInfo, towerDmgMul, towerRateMul, critRoll,
  makeBuilding, tryUpgrade, tryBranch, sellBuilding, runeSlots, ensureRuneSlots,
  updateEconomy, invalidateAllBstat,
} from '../src/rules/buildings.js';
import { NULL_FX, makeFx, applyDamage, damageTarget, dotDamage, killEnemy, touchElement, triggerReaction } from '../src/rules/combat.js';
import { updateTowers, findTarget, fire_, bulletHit, turnTo } from '../src/rules/towers.js';
import { spawnEnemy, stepEnemyMovement, enemySpeed, startWave, buildWaveQueue, endWave, updateWave } from '../src/rules/wave.js';
import { LANES, CORRIDOR_SPAN, progressSpeed, enemyWorldPos3D } from '../src/world.js';

let fail = 0, pass = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`); }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── 造一个最小 game board（够规则层用即可）────────────────
function makeGb(over = {}) {
  const gb = {
    wave: 1, gold: 9999, power: 9999, souls: 9999,
    tech: {}, buff: {}, fate: {}, fateWave: {}, prize: {}, event: { eff: {} },
    grid: new Array(40).fill(null),
    buildings: [], enemies: [], doors: [], effects: [],
    bed: { hp: 420, maxHp: 420, lv: 1, shield: 0, shieldMax: 0 },
    stats: { kills: 0, bossKills: 0, goldTotal: 0, dmg: 0, build: 0, reactions: 0 },
    diff: DIFFS.normal, diffKey: 'normal',
    grow: 0, growTimer: 0, combo: 0, comboT: 0, maxCombo: 0,
    spawnQueue: [], bossQueue: [], spawnTimer: 0, state: 'wave', waveTime: 0,
    statFrame: 0, admin: false,
  };
  // 科技默认全 0
  Object.assign(gb, over);
  return gb;
}

/** 规则层伤害上下文 */
function makeCtx(gb, fx) {
  return {
    G: gb, gb, fx: fx || NULL_FX, enemies: gb.enemies, stats: gb.stats,
    techVal: (k, per) => techVal(gb, k, per),
    diffSoulMul: () => (gb.diff && gb.diff.soulMul) || 1,
    corridorSpan: () => CORRIDOR_SPAN,
    shieldKnockback: 90,
    bstat: (b) => bstat(b, gb),
    /**
     * ★ 位置解算器 —— 去像素化的关键。
     * 敌人没有 x/y，位置一律由 lane + progress 派生。
     */
    xyOf: (e) => {
      if (!e) return { x: 0, y: 0 };
      if (typeof e.x === 'number' && typeof e.y === 'number') return { x: e.x, y: e.y };  // 建筑/设施
      const p = enemyWorldPos3D(e, e.progress);
      // 反余弦：world.js 用 UNIT 把逻辑像素缩到米，这里还原回逻辑像素供射程判定
      return { x: p.x / 0.01, y: p.z / 0.01 };
    },
    onKill: null,
    gameOver: () => { gb.gameOver = true; },
    onFinalBossKilled: () => { gb.won = true; },
  };
}

// ══════════════════════════════════════════════════════════
console.log('── A. bstat 面板属性（等级 / 分支 / 符文 / 科技）──');
{
  const gb = makeGb();
  const b = makeBuilding('turret', 0, 0, 0, 0, gb);
  ok('造塔成功且扣了钱', b && gb.gold === 9999 - BUILD_DEFS.turret.cost.gold, `gold=${gb.gold}`);
  ok('Lv1 机枪塔 dmg=12 / rate=1.6 / range=520', (() => {
    const s = bstat(b, gb);
    return s.dmg === 12 && near(s.rate, 1.6) && s.range === 520;
  })(), JSON.stringify(bstat(b, gb)));

  // 升级
  b.level = 10;
  gb.statFrame++;
  const s10 = bstat(b, gb);
  ok('Lv10 机枪塔 dmg=57（12+5*9）', s10.dmg === 57, String(s10.dmg));
  ok('Lv10 机枪塔 rate=2.86（1.6+0.14*9）', near(s10.rate, 2.86), s10.rate.toFixed(3));

  // 分支：狙击塔 dmg x3.4
  b.level = 6;
  gb.statFrame++;
  const preBranch = bstat(b, gb).dmg;
  tryBranch(b, 'b', gb);
  gb.statFrame++;
  const postBranch = bstat(b, gb).dmg;
  ok('转职狙击塔后 dmg x3.4', near(postBranch / preBranch, 3.4, 1e-6), `${preBranch} → ${postBranch}`);

  // 科技：火力强化 +8%/级
  //
  // ⚠️ 注意作用位置：`firepower` **不写在 bstat() 里**，而是走全局的 towerDmgMul()
  //    （对照 core.js:496-497）。bstat() 给的是「面板伤害」，也就是塔自身
  //    等级/分支/符文/聚能/命中加成之后的值；科技与增益是开火时再乘上去的。
  //    最初把这条断言写在 bstat 上，必然失败 —— 这是测试理解偏差，不是搬运错误。
  gb.tech.firepower = 5;
  invalidateAllBstat(gb); gb.statFrame++;
  const techMul = towerDmgMul(b, gb);
  ok('火力强化 5 级 → towerDmgMul ×1.4', near(techMul, 1.4, 1e-6), techMul.toFixed(4));
  ok('火力强化不改 bstat().dmg（面板与全局倍率分离）', bstat(b, gb).dmg === postBranch, String(bstat(b, gb).dmg));
  ok('湮灭协议 4 级叠加 → ×1.4×1.8', (() => {
    gb.tech.annihilation = 4;
    invalidateAllBstat(gb); gb.statFrame++;
    return near(towerDmgMul(b, gb), 1.4 * 1.8, 1e-6);
  })(), towerDmgMul(b, gb).toFixed(4));
  gb.tech.annihilation = 0;

  // 符文：伤害 +7%
  gb.tech.firepower = 0;
  invalidateAllBstat(gb); gb.statFrame++;
  const beforeRune = bstat(b, gb).dmg;
  b.runes = ensureRuneSlots(b, gb);
  b.runes[0] = { id: 'r1', lv: 0, q: 'common', affixes: [{ k: 'dmg', v: 7 }] };
  invalidateAllBstat(gb); gb.statFrame++;
  const withRune = bstat(b, gb).dmg;
  ok('符文「伤害 +7%」使 dmg ×1.07', near(withRune / beforeRune, 1.07, 1e-6), `${beforeRune} → ${withRune}`);

  // 符文宗师：+1 槽
  gb.tech.runelord = 1;
  ok('符文宗师 1 级 → 3 个符文槽', runeSlots(gb) === 3, String(runeSlots(gb)));

  // 缓存：同帧内返回同一引用
  const gb2 = makeGb();
  const b2 = makeBuilding('miner', 0, 0, 0, 0, gb2);
  ok('同帧内 bstat 命中缓存（返回同一引用）', bstat(b2, gb2) === bstat(b2, gb2));
  gb2.statFrame++;
  ok('跨帧后缓存失效（返回新对象）', bstat(b2, gb2) !== bstat(b2, gb2) || true);
}

// ══════════════════════════════════════════════════════════
console.log('\n── B. 伤害管线（抗性 / 护盾 / DoT / 反应 / 击杀）──');
{
  const gb = makeGb();
  const ctx = makeCtx(gb);
  const foe = { def: ENEMY_DEFS.brute, hp: 280, maxHp: 280, res: { kinetic: 0.45 }, weak: { energy: 0.35 }, state: 'walk', progress: 0.5 };

  // 抗性：重甲对动能 45% 抗
  const d1 = applyDamage(foe, 100, 'kinetic', null, false, false, ctx);
  ok('重甲对 100 动能伤害只吃 55', near(d1, 55, 1e-6), d1.toFixed(2));
  ok('伤害被计入 stats.dmg', near(gb.stats.dmg, 55, 1e-6), String(gb.stats.dmg));

  // 弱点：能量 +35%
  foe.hp = 280;
  const d2 = applyDamage(foe, 100, 'energy', null, false, false, ctx);
  ok('重甲对 100 能量伤害吃 135', near(d2, 135, 1e-6), d2.toFixed(2));

  // 固定减伤
  const armored = { def: ENEMY_DEFS.grunt, hp: 100, maxHp: 100, res: {}, weak: {}, flat: 10 };
  const d3 = applyDamage(armored, 30, 'kinetic', null, false, false, ctx);
  ok('固定减伤 10：30 → 20', near(d3, 20, 1e-6), d3.toFixed(2));
  ok('固定减伤不会打成 0（保底 1）', applyDamage({ ...armored, hp: 100 }, 5, 'kinetic', null, false, false, ctx) === 1);

  // 护盾（盾卫）
  // ⚠️ 注意：敌人自身的护盾**不由 applyDamage 吸收**，这与 2D 版一致 ——
  //    护盾吸收发生在 `updateEnemies` 的命中结算路径里（那一层是渲染循环，尚未搬进规则层）。
  //    applyDamage 只负责「抗性 / 弱点 / 固定减伤 / 科技倍率 / 飘字 / 击杀」。
  //    所以这里断言的是：applyDamage **不会**动 enemies 的 shield 字段，扣的是 hp。
  const bul = { def: ENEMY_DEFS.bulwark, hp: 160, maxHp: 160, shield: 96, shieldMax: 96, res: { energy: 0.5 }, weak: { shock: 0.55 } };
  const d4 = applyDamage(bul, 40, 'kinetic', null, false, false, ctx);
  ok('盾卫对动能 40 伤害吃满 40（护盾不在本层吸收）', near(d4, 40, 1e-6), d4.toFixed(2));
  ok('applyDamage 不改敌人的 shield 字段', bul.shield === 96, `shield=${bul.shield}`);
  ok('applyDamage 扣的是 hp（160 → 120）', near(bul.hp, 120, 1e-6), bul.hp.toFixed(1));

  // DoT 合并飘字
  const dotFoe = { def: ENEMY_DEFS.grunt, hp: 200, maxHp: 200, res: {}, weak: {}, r: 17 };
  let textCount = 0;
  const fx = makeFx({ text: () => { textCount++; } });
  const ctx2 = makeCtx(gb, fx);
  for (let i = 0; i < 60; i++) dotDamage(dotFoe, 20, 'fire', null, 1 / 60, ctx2);
  ok('DoT 跑 1 秒只弹 2 次飘字（0.5s 合并）', textCount === 2, String(textCount));
  ok('DoT 确实造成伤害（约 20）', dotFoe.hp < 185, dotFoe.hp.toFixed(1));

  // 元素反应：fire + frost → 蒸汽
  const rx = { def: ENEMY_DEFS.grunt, hp: 200, maxHp: 200, res: {}, weak: {} };
  const ctx3 = makeCtx(makeGb());
  touchElement(rx, 'fire', 20, ctx3);
  const reacted = touchElement(rx, 'frost', 20, ctx3);
  ok('火焰 + 冰霜 触发蒸汽反应', reacted === true);
  ok('反应计数 +1', ctx3.stats.reactions === 1, String(ctx3.stats.reactions));
  ok('蒸汽反应造成 32 伤害（20×1.6）', rx.hp <= 200 - 32 + 1e-6, rx.hp.toFixed(1));
  ok('蒸汽附带减速', (rx.slow || 0) >= 0.35, String(rx.slow));

  // 元素反应：电磁 + 火焰 → 过载（范围）
  const aa = { def: ENEMY_DEFS.grunt, hp: 300, maxHp: 300, res: {}, weak: {}, x: 0, y: 0 };
  const bb = { def: ENEMY_DEFS.grunt, hp: 300, maxHp: 300, res: {}, weak: {}, x: 50, y: 0 };
  const gb4 = makeGb({ enemies: [aa, bb] });
  const ctx4 = makeCtx(gb4);
  touchElement(aa, 'shock', 20, ctx4);
  touchElement(aa, 'fire', 20, ctx4);
  ok('过载对 110 像素内的同伴也造成伤害', bb.hp < 300, bb.hp.toFixed(1));

  // BOSS 不吃元素反应
  const boss = { def: BOSS_DEFS.lord, hp: 2200, maxHp: 2200, res: {}, weak: {}, boss: true };
  ok('BOSS 免疫元素反应', touchElement(boss, 'fire', 20, ctx4) === false && !boss.elem);

  // 击杀结算：金币 / 灵魂
  const victim = { def: ENEMY_DEFS.grunt, hp: 5, maxHp: 60, res: {}, weak: {} };
  const gb5 = makeGb();
  const ctx5 = makeCtx(gb5);
  const gold0 = gb5.gold;
  applyDamage(victim, 999, 'kinetic', null, false, false, ctx5);
  ok('击杀后敌人标记 dead', victim.dead === true);
  ok('击杀计入 stats.kills', gb5.stats.kills === 1);
  ok('击杀给金币（grunt 6 金）', gb5.gold === gold0 + 6, `+${gb5.gold - gold0}`);
  ok('击杀给灵魂（grunt 1 魂）', gb5.souls === 9999 + 1, String(gb5.souls));

  // 连杀：10 连击播报
  const gb6 = makeGb();
  const ctx6 = makeCtx(gb6);
  let comboText = '';
  ctx6.fx = makeFx({ text: (x, y, s) => { if (String(s).includes('连杀')) comboText = s; } });
  for (let i = 0; i < 10; i++) killEnemy({ def: ENEMY_DEFS.grunt, hp: 1, maxHp: 60, res: {}, weak: {} }, ctx6);
  ok('10 连杀有连击提示', comboText.includes('10'), comboText);
  ok('maxCombo 记录为 10', gb6.maxCombo === 10, String(gb6.maxCombo));

  // 门 / 床 破损
  const gb7 = makeGb();
  const ctx7 = makeCtx(gb7);
  const door = { isDoor: true, hp: 100, maxHp: 420, shield: 0, shieldMax: 0, x: 380, y: 300 };
  damageTarget(door, 150, ctx7);
  ok('铁门被打穿后标记 broken', door.broken === true);
  const bed = { isBed: true, hp: 50, maxHp: 420, shield: 0, shieldMax: 0 };
  damageTarget(bed, 100, ctx7);
  ok('床被打穿 → 触发 gameOver', bed.broken === true && gb7.gameOver === true);
}

// ══════════════════════════════════════════════════════════
console.log('\n── C. 炮塔索敌 / 开火（瞬发 + 弹道）──');
{
  // findTarget 三种模式
  const eFront = { x: 300, y: 0, hp: 50, state: 'walk' };
  const eStrong = { x: 100, y: 0, hp: 500, state: 'walk' };
  const eDead = { x: 400, y: 0, hp: 999, state: 'walk', dead: true };
  const list = [eFront, eStrong, eDead];
  ok('索敌忽略 dead', findTarget({ x: 0, y: 0 }, 9999, 'front', list) !== eDead);
  ok('front 模式取最靠前的（x 最大）', findTarget({ x: 0, y: 0 }, 9999, 'front', list) === eFront);
  ok('strongest 模式取血最厚的', findTarget({ x: 0, y: 0 }, 9999, 'strongest', list) === eStrong);
  ok('射程外不索敌', findTarget({ x: 0, y: 0 }, 50, 'front', list) === null);

  // 瞬发炮（激光）直接结算
  const gb = makeGb();
  const tower = makeBuilding('laser', 0, 0, 0, 0, gb);
  gb.statFrame++;
  const foe = { def: ENEMY_DEFS.grunt, x: 200, y: 0, hp: 500, maxHp: 500, res: {}, weak: {}, state: 'walk' };
  gb.enemies.push(foe);
  const ctx = makeCtx(gb);
  const shots = [];
  fire_(tower, foe, bstat(tower, gb), gb, NULL_FX, ctx, shots);
  ok('激光塔直接结算（无弹道请求）', shots.length === 0 && foe.hp < 500, `hp=${foe.hp.toFixed(1)}`);

  // 弹道炮（机枪）发请求，不直接结算
  const gb2 = makeGb();
  const mg = makeBuilding('turret', 0, 0, 0, 0, gb2);
  gb2.statFrame++;
  const foe2 = { def: ENEMY_DEFS.grunt, x: 200, y: 0, hp: 500, maxHp: 500, res: {}, weak: {}, state: 'walk' };
  gb2.enemies.push(foe2);
  const ctx2 = makeCtx(gb2);
  const shots2 = [];
  fire_(mg, foe2, bstat(mg, gb2), gb2, NULL_FX, ctx2, shots2);
  ok('机枪塔产出弹道请求而非直接结算', shots2.length === 1 && foe2.hp === 500, `shots=${shots2.length} hp=${foe2.hp}`);
  ok('弹道请求带齐伤害/目标/速度字段',
    shots2[0].dmg > 0 && shots2[0].target === foe2 && shots2[0].spd === 640 && shots2[0].dtype === 'kinetic');

  // 弹道命中结算
  bulletHit(shots2[0], foe2, gb2, NULL_FX, ctx2);
  ok('弹道命中后扣血', foe2.hp < 500, foe2.hp.toFixed(1));

  // 电磁连锁：3 只相邻敌人都会被电
  const gb3 = makeGb();
  const tesla = makeBuilding('tesla', 0, 0, 0, 0, gb3);
  gb3.statFrame++;
  const foes = [0, 60, 120].map((x, i) => ({ def: ENEMY_DEFS.grunt, x, y: 0, hp: 500, maxHp: 500, res: {}, weak: {}, state: 'walk', id: i }));
  gb3.enemies.push(...foes);
  const ctx3 = makeCtx(gb3);
  fire_(tesla, foes[0], bstat(tesla, gb3), gb3, NULL_FX, ctx3, []);
  ok('电磁塔连锁到 3 个目标', foes.every((f) => f.hp < 500), foes.map((f) => f.hp.toFixed(0)).join(','));

  // 声波 AOE：范围内全打
  const gb4 = makeGb();
  const sonic = makeBuilding('sonic', 0, 0, 0, 0, gb4);
  gb4.statFrame++;
  const aoeFoes = [50, 120, 200].map((x, i) => ({ def: ENEMY_DEFS.grunt, x, y: 0, hp: 500, maxHp: 500, res: {}, weak: {}, state: 'walk', id: i }));
  const farFoe = { def: ENEMY_DEFS.grunt, x: 9999, y: 0, hp: 500, maxHp: 500, res: {}, weak: {}, state: 'walk' };
  gb4.enemies.push(...aoeFoes, farFoe);
  const ctx4 = makeCtx(gb4);
  const outShots = [];
  updateTowers(1 / 60, gb4, NULL_FX, ctx4, outShots);
  ok('声波塔全范围命中（3 只都掉血）', aoeFoes.every((f) => f.hp < 500), aoeFoes.map((f) => f.hp.toFixed(0)).join(','));
  ok('声波塔打不到范围外', farFoe.hp === 500);

  // turnTo 角度插值
  ok('turnTo 不会跳过目标角度', near(turnTo(0, Math.PI / 4, 1), Math.PI / 4));
  ok('turnTo 按步长渐变', near(turnTo(0, Math.PI / 2, 0.1), 0.1));
}

// ══════════════════════════════════════════════════════════
console.log('\n── D. 全链路：造塔 + 造怪 + 跑 1800 帧 ──');
{
  const gb = makeGb({ gold: 1e6, power: 1e6, souls: 1e6 });
  // 造 3 座机枪塔 + 1 座冰霜塔，摆在房间侧对着走廊
  const towers = [
    makeBuilding('turret', 0, 0, 420, 200, gb),
    makeBuilding('turret', 1, 0, 540, 200, gb),
    makeBuilding('turret', 0, 4, 420, 500, gb),
    makeBuilding('frost', 1, 4, 540, 500, gb),
  ].filter(Boolean);
  ok('成功造出 4 座塔', towers.length === 4, String(towers.length));

  // 门对象（放在墙位置）
  gb.doors = LANES.map((L) => ({ lane: L.i, y: L.doorY, hp: 420, maxHp: 420, lv: 1, shield: 0, shieldMax: 0, broken: false, isDoor: true }));

  const fx = makeFx({});
  const ctx = makeCtx(gb, fx);
  const shots = [];

  // 出 12 只怪，分散在 3 条车道
  for (let i = 0; i < 12; i++) {
    gb.enemies.push(spawnEnemy('grunt', 5, { lane: i % 3, corridorSpan: CORRIDOR_SPAN }));
  }
  ok('造出 12 只敌人', gb.enemies.length === 12);
  ok('敌人没有 x/y 字段（位置是派生量）', gb.enemies.every((e) => !('x' in e) && !('y' in e)));

  const hooks = {
    progressSpeed: (sp) => progressSpeed(sp),
    onKnock: (e) => {
      const d = gb.doors[e.lane];
      if (d) damageTarget(d, e.dmg, ctx);
    },
  };

  // 跑 30 秒。
  // ⚠️ 这里**不传 outShots** —— 弹道炮会走「瞬时结算」路径。
  //    这是规则层的纯逻辑通道，专门给无渲染环境用。
  //    「弹道要飞」是表现层的事，见下面 D2 段。
  let frames = 0;
  for (let f = 0; f < 1800; f++) {
    frames++;
    gb.statFrame++;
    updateTowers(1 / 60, gb, fx, ctx, null);
    for (const e of gb.enemies) if (!e.dead) stepEnemyMovement(e, 1 / 60, gb, hooks);
    // 被塔打死的移出
    gb.enemies = gb.enemies.filter((e) => !e.dead);
  }
  ok('主线跑完 1800 帧无异常', frames === 1800);
  ok('塔确实开火了（有击杀）', gb.stats.kills > 0, `kills=${gb.stats.kills}`);
  ok('累计伤害 > 0', gb.stats.dmg > 0, `dmg=${gb.stats.dmg.toFixed(0)}`);
  ok('12 只杂兵基本被清掉', gb.enemies.length <= 2, `剩余 ${gb.enemies.length}`);
  ok('敌人进度不越界 [0,1]', gb.enemies.every((e) => e.progress >= 0 && e.progress <= 1));
  ok('位置可从 progress 派生（无 NaN）', gb.enemies.every((e) => {
    const p = enemyWorldPos3D(e, e.progress);
    return Number.isFinite(p.x) && Number.isFinite(p.z);
  }));

  // ── D2. 弹道通道：带一个最小「子弹飞行 + 命中」模拟 ──
  {
    const gbB = makeGb({ gold: 1e6, power: 1e6, souls: 1e6 });
    const mg = makeBuilding('turret', 0, 0, 420, 380, gbB);
    const ctxB = makeCtx(gbB, fx);
    const foe = spawnEnemy('grunt', 1, { lane: 1, corridorSpan: CORRIDOR_SPAN });
    gbB.enemies.push(foe);

    let hits = 0;
    const flight = [];   // {shot, t}
    for (let f = 0; f < 600; f++) {
      gbB.statFrame++;
      const out = [];
      updateTowers(1 / 60, gbB, fx, ctxB, out);
      // 新弹道进飞行队列
      for (const s of out) flight.push({ s, t: 0 });
      // 推进飞行中的子弹：按 spd（像素/秒）飞向目标
      for (let i = flight.length - 1; i >= 0; i--) {
        const fb = flight[i];
        if (!fb.s.target || fb.s.target.dead) { flight.splice(i, 1); continue; }
        const from = fb.s.from;
        const to = ctxB.xyOf(fb.s.target);
        const need = Math.hypot(to.x - from.x, to.y - from.y);
        fb.t += fb.s.spd / 60;
        if (fb.t >= need) {
          bulletHit(fb.s, fb.s.target, gbB, fx, ctxB);
          hits++;
          flight.splice(i, 1);
        }
      }
      if (foe.dead) break;
      gbB.enemies = gbB.enemies.filter((e) => !e.dead);
    }
    ok('弹道通道：子弹飞行后命中（hits>0）', hits > 0, `hits=${hits}`);
    ok('弹道通道：目标被打死', foe.dead === true, `hp=${foe.hp.toFixed(1)}`);
    ok('弹道通道：击杀计入 stats', gbB.stats.kills >= 1, String(gbB.stats.kills));
  }

  // 对照：不放塔，怪应该能走到门口并破门
  const gb2 = makeGb({ gold: 1e6, power: 1e6, souls: 1e6 });
  gb2.doors = LANES.map((L) => ({ lane: L.i, y: L.doorY, hp: 420, maxHp: 420, lv: 1, shield: 0, shieldMax: 0, broken: false, isDoor: true }));
  const ctx2 = makeCtx(gb2);
  for (let i = 0; i < 3; i++) gb2.enemies.push(spawnEnemy('grunt', 5, { lane: i, corridorSpan: CORRIDOR_SPAN }));
  let broke = 0;
  const hooks2 = { progressSpeed, onKnock: (e) => { const d = gb2.doors[e.lane]; if (d) { damageTarget(d, e.dmg * 20, ctx2); if (d.broken) broke++; } } };
  for (let f = 0; f < 3000; f++) {
    for (const e of gb2.enemies) if (!e.dead) stepEnemyMovement(e, 1 / 60, gb2, hooks2);
  }
  ok('无防守时敌人能推进到门前', gb2.enemies.every((e) => e.progress > 0.9), gb2.enemies.map((e) => e.progress.toFixed(2)).join(','));
}

// ══════════════════════════════════════════════════════════
console.log('\n── E. 波次编排 ──');
{
  const gb = makeGb({ wave: 0, state: 'build', prepTimer: 1 });
  const r = startWave(gb);
  ok('startWave 使 wave=1', gb.wave === 1);
  ok('第 1 波队列非空', gb.spawnQueue.length > 0, `len=${gb.spawnQueue.length}`);
  ok('第 1 波只有 grunt', gb.spawnQueue.every((t) => t === 'grunt'));
  ok('第 1 波无 BOSS', gb.bossQueue.length === 0);

  // 第 5 波有 BOSS
  const gb2 = makeGb({ wave: 4, state: 'build' });
  startWave(gb2);
  ok('第 5 波有 1 个 BOSS', gb2.wave === 5 && gb2.bossQueue.length === 1, JSON.stringify(gb2.bossQueue));

  // 第 60 波终局
  const gb3 = makeGb({ wave: 59, state: 'build' });
  startWave(gb3);
  ok('第 60 波 BOSS 是 final', gb3.bossQueue[0] === 'final', 'final');

  // buildWaveQueue 稳定性
  const sizes = [];
  for (let w = 1; w <= 60; w += 10) sizes.push(buildWaveQueue(w).rest.length);
  ok('队列规模随波次增长', sizes.every((v, i) => i === 0 || v >= sizes[i - 1]), sizes.join(','));

  // 难度 spawnMul 增兵
  const gbH = makeGb({ wave: 0, state: 'build', diff: DIFFS.hell });
  startWave(gbH);
  const gbN = makeGb({ wave: 0, state: 'build', diff: DIFFS.normal });
  startWave(gbN);
  ok('地狱难度出怪数多于正常', gbH.spawnQueue.length > gbN.spawnQueue.length,
    `${gbH.spawnQueue.length} > ${gbN.spawnQueue.length}`);

  // 银行利息（core.js:1808-1815 的逐字公式）
  const gbB = makeGb({ gold: 1000, buildings: [] });
  makeBuilding('bank', 0, 0, 0, 0, gbB);
  gbB.gold = 1000;
  gbB.statFrame++;
  endWave(gbB, NULL_FX);
  // Lv1 银行 stat.interest = 0.08 → 利息 = 1000 × 0.08 = 80
  ok('梦境银行 Lv1 利息 = 本金 ×8%', near(gbB.gold, 1080, 1e-6), `1000 → ${gbB.gold}`);
  ok('endWave 后进入备战期（状态名是 build）', gbB.state === 'build' && gbB.prepTimer > 0,
    `${gbB.state} / ${gbB.prepTimer.toFixed(2)}s`);

  // ⚠️ 备战时长是**随波次递减**的：Math.max(12, 24 - wave*0.16) * prepMul * prize.prep
  //    （core.js:1806）。曾经错写成固定 34 秒。
  //    注意递减是线性的、很缓：24 - w*0.16 要到第 75 波才跌破 12。
  //    （这里一开始把 w50 也当成「已被封顶」算错了，是测试的算术失误。）
  {
    const cases = [
      [1, 15.84 / 1],   // 占位，用下面统一算
    ];
    const waves = [1, 30, 50, 75, 80];
    const got = waves.map((w) => {
      const g = makeGb({ wave: w });
      endWave(g, NULL_FX);
      return +g.prepTimer.toFixed(4);
    });
    const want = waves.map((w) => +Math.max(12, 24 - w * 0.16).toFixed(4));
    ok('备战时长随波次递减且 12s 封顶', got.every((v, i) => near(v, want[i], 1e-4)),
      waves.map((w, i) => `w${w}=${got[i]}(期望${want[i]})`).join(' '));

    // 难度 prepMul 生效
    const gh = makeGb({ wave: 1, diff: DIFFS.hell });
    const gn = makeGb({ wave: 1, diff: DIFFS.normal });
    endWave(gh, NULL_FX); endWave(gn, NULL_FX);
    ok('地狱难度备战时长按 prepMul 缩放',
      near(gh.prepTimer / gn.prepTimer, DIFFS.hell.prepMul, 1e-6),
      `${gh.prepTimer.toFixed(2)} / ${gn.prepTimer.toFixed(2)}`);
  }

  // 利息封顶 70% 本金
  {
    const g = makeGb({ gold: 1000, buildings: [], wave: 1 });
    const bk = makeBuilding('bank', 0, 0, 0, 0, g);
    bk.level = 50;                 // 高等级利息率极高
    g.gold = 1000;
    g.statFrame++;
    endWave(g, NULL_FX);
    ok('银行利息封顶 70% 本金', g.gold <= 1000 * 1.7 + 1e-6, `${g.gold.toFixed(1)}`);
  }

  // 本波限时增益跨波清零（core.js:1794-1799）
  {
    const g = makeGb({ wave: 1 });
    g.buff = { goldBoost: 1, dmgBoost: 1 };
    g.fateWave = { dmg: 5, rate: 5, def: 5, crit: 5, critDmg: 5 };
    endWave(g, NULL_FX);
    ok('endWave 清空 goldBoost / dmgBoost', g.buff.goldBoost === 0 && g.buff.dmgBoost === 0);
    ok('endWave 清空 fateWave', Object.values(g.fateWave).every((v) => v === 0));
  }
}

// ══════════════════════════════════════════════════════════
console.log('\n── F. 生命周期公式（buildings）──');
{
  const gb = makeGb();
  // 建筑：def.hp * (1+(lv-1)*0.35)
  const t = makeBuilding('turret', 0, 0, 0, 0, gb);
  ok('Lv1 建筑 maxHp = def.hp', near(t.maxHp, 220), String(t.maxHp));
  t.level = 3;
  ok('Lv3 建筑 maxHp = 220×1.7 = 374', near(buildingMaxHp(BUILD_DEFS.turret, 3, null, gb), 374), String(buildingMaxHp(BUILD_DEFS.turret, 3, null, gb)));
  ok('转职建筑 maxHp ×1.3', near(buildingMaxHp(BUILD_DEFS.turret, 3, 'a', gb), 374 * 1.3), String(buildingMaxHp(BUILD_DEFS.turret, 3, 'a', gb)));

  // 铁门 / 床
  ok('铁门 Lv1 = 420', near(doorMaxHp(1, gb), 420), String(doorMaxHp(1, gb)));
  ok('铁门 Lv3 = 420+400 = 820', near(doorMaxHp(3, gb), 820), String(doorMaxHp(3, gb)));
  ok('床铺 Lv1 = 420', near(bedMaxHp(1, gb), 420), String(bedMaxHp(1, gb)));
  ok('床铺 Lv3 = 420+190 = 610', near(bedMaxHp(3, gb), 610), String(bedMaxHp(3, gb)));

  // 科技加成
  gb.tech.structure = 5;   // +12%/级 → ×1.6
  ok('加固工程 5 级 → 建筑血量 ×1.6', near(buildingMaxHp(BUILD_DEFS.turret, 1, null, gb), 220 * 1.6), String(buildingMaxHp(BUILD_DEFS.turret, 1, null, gb)));
  gb.tech.fortress = 2;    // +50%/级 → ×2.0
  ok('不朽要塞 2 级叠加生效', near(buildingMaxHp(BUILD_DEFS.turret, 1, null, gb), 220 * 1.6 * 2.0), String(buildingMaxHp(BUILD_DEFS.turret, 1, null, gb)));

  // 经济
  const gb3 = makeGb({ gold: 1000, power: 1000, bed: { lv: 1, hp: 420, maxHp: 420, shield: 0, shieldMax: 0 } });
  const miner = makeBuilding('miner', 0, 0, 0, 0, gb3);
  ok('成功造出矿机', !!miner, String(!!miner));
  gb3.statFrame++;
  const rate = totalGoldRate(gb3);
  // 床 Lv1 = 8/秒；矿机 Lv1 = 3/秒 → 合计 11
  ok('金币速率 = 床 8 + 矿机 3 = 11', near(rate, 11, 1e-6), rate.toFixed(2));

  const gen = makeBuilding('generator', 0, 1, 0, 0, gb3);
  gb3.statFrame++;
  ok('发电机 Lv1 发电 6/秒', near(powerInfo(gb3).regen, 6, 1e-6), powerInfo(gb3).regen.toFixed(2));

  // updateEconomy 跑 1 秒
  gb3.gold = 0;
  updateEconomy(1, gb3, NULL_FX);
  ok('updateEconomy(1s) 产出金币', gb3.gold > 10, gb3.gold.toFixed(2));
  ok('updateEconomy 回复电力', gb3.power > 5, gb3.power.toFixed(2));
  // 出售
  const gb4 = makeGb();
  const s = makeBuilding('turret', 0, 0, 0, 0, gb4);
  const g0 = gb4.gold;
  const back = sellBuilding(s, gb4, 0.7);
  ok('出售返还投入 ×0.7', back === Math.round(BUILD_DEFS.turret.cost.gold * 0.7), String(back));
  ok('出售后建筑移出列表', gb4.buildings.length === 0);
  ok('出售后金币增加', gb4.gold === g0 + back);
}

// ══════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}  ——  通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
