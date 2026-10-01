// ============================================================
//  rules/wave.js —— 波次编排 / 出怪 / 结算（core.js 的规则部分）
// ============================================================
//
// 搬运自 core.js：
//   buildWaveQueue()   1697-1708
//   startWave()        1709-1759（去掉剧情/DOM/音效，保留编排）
//   updateWave()       1761-1777
//   spawnEnemy()       874-957
//   updateEnemies()    973+  （走路/敲门部分，不含撞门伤害细节）
//   endWave()          1778+  （结算部分）
//
// ── 与 2D 版最重要的差异：敌人的「位置」是派生量 ──────────────
//
// 2D `spawnEnemy` 里有一堆像素操作：
//     e.progress = clamp(rnd(0,1) * (CORRIDOR_SPAWN_JIT / corridorSpan()), 0, 1);
//     e.laneOffset = rnd(-CORRIDOR_LANE_PAD, CORRIDOR_LANE_PAD);
//     { const wp = enemyWorldPos(e); e.x = wp.x; e.y = wp.y + e.laneOffset; }
//
// 去像素化后这些**全部保留** —— 因为它们本来就是「lane + progress」派生的。
// 唯一的不同：3D 侧不把派生结果写回 e.x/e.y，而是渲染时现算。
// `laneOffset`（车道内固定偏移）要保留，它是「同批敌人不叠在一起」的关键。
//
// 所以本文件里的敌人对象仍然**没有 x/y 字段**（除了兼容 2D 测试的
// `legacyXY` 开关）。位置一律走 `enemyWorldPos3D(e, e.progress)`。
// ============================================================

import {
  ENEMY_DEFS, BOSS_DEFS, AFFIX, AFFIX_KEYS,
  BOSS_ORDER, FINAL_WAVE, bossKeyForWave,
  waveUnlocks, waveCount, waveBossCount, waveSpawnInterval, eliteChance,
  enemyHpScale, enemyDmgScale, DIFFS,
} from './constants.js';
import { clamp, rnd, pick } from './math.js';
// endWave 要读银行/设施的面板属性（interest / souls），那必须走 bstat
// 才能把等级、分支、符文、科技都算进去 —— 直接读 def.stat 会漏掉转职加成。
import { bstat } from './buildings.js';

let nextEnemyId = 1;

/** 重置 id 计数器（测试用，保证快照可复现） */
export function _resetEnemyIds() { nextEnemyId = 1; }

// ══════════════════════════════════════════════════════════
//  波次编排
// ══════════════════════════════════════════════════════════

/**
 * 生成本波队列（core.js:1697）。
 * @returns {{rest:string[], bossList:string[]}}
 */
export function buildWaveQueue(n, eff) {
  const pool = waveUnlocks(n);
  const cnt = Math.round(waveCount(n) * ((eff && eff.countMul) || 1));
  const q = [];
  for (let i = 0; i < cnt; i++) q.push(pick(pool));

  const bossType = n >= FINAL_WAVE ? 'final' : 'boss';
  const bossList = [];
  for (let i = 0; i < waveBossCount(n); i++) bossList.push(bossType);

  q.sort(() => Math.random() - 0.5);
  return { rest: q, bossList };
}

/**
 * 开一波（core.js:1709 的编排部分）。
 * 剧情触发、音效、飘字都拆出去给外部，这里只产出一个「波次状态」。
 *
 * @param {object} gb   game board（要有 wave / diff / event）
 * @param {object} [eff] 事件效果（缺省取 gb.event.eff）
 * @returns {{wave:number, spawnQueue:string[], bossQueue:string[], spawnTimer:number}}
 */
export function startWave(gb, eff) {
  gb.wave = (gb.wave || 0) + 1;
  const E = eff || (gb.event && gb.event.eff) || {};
  const { rest, bossList } = buildWaveQueue(gb.wave, E);

  // 难度 spawnMul：把队列按比例复制一份（core.js:1716）
  const sm = (gb.diff && gb.diff.spawnMul) || 1;
  if (sm > 1 && rest.length) {
    const extra = Math.round(rest.length * (sm - 1));
    for (let i = 0; i < extra; i++) rest.push(rest[i % rest.length]);
  }

  gb.spawnQueue = rest;
  gb.bossQueue = bossList;
  gb.spawnTimer = 0;
  gb.state = 'wave';
  gb.waveTime = 0;
  return { wave: gb.wave, spawnQueue: rest, bossQueue: bossList, spawnTimer: 0 };
}

/**
 * 推进波次：出怪节奏 + 结束判定（core.js:1761）。
 *
 * @param {number} dt
 * @param {object} gb
 * @param {(type:string, wave:number, lane?:number) => object} spawnFn 出怪回调
 * @returns {'prep'|'wave'|'ended'}
 */
export function updateWave(dt, gb, spawnFn, fx) {
  if (gb.state === 'build' || gb.state === 'prep') {
    gb.prepTimer -= dt;
    if (gb.prepTimer <= 0) {
      startWave(gb);
      if (fx && fx.waveStart) fx.waveStart(gb.wave);
    }
    return 'prep';
  }

  gb.waveTime = (gb.waveTime || 0) + dt;
  if (gb.comboT > 0) { gb.comboT -= dt; if (gb.comboT <= 0) gb.combo = 0; }

  gb.spawnTimer -= dt;
  if (gb.spawnTimer <= 0 && (gb.spawnQueue.length || gb.bossQueue.length)) {
    const interval = waveSpawnInterval(gb.wave) * (((gb.diff && gb.diff.prepMul) || 1) ? 1 : 1);
    const type = gb.spawnQueue.length ? gb.spawnQueue.shift() : gb.bossQueue.shift();
    spawnFn(type, gb.wave);
    gb.spawnTimer = Math.max(0.20, interval);
  }

  if (!gb.spawnQueue.length && !gb.bossQueue.length && !gb.enemies.length) {
    endWave(gb, fx);
    return 'ended';
  }
  return 'wave';
}

/**
 * 波次结算（core.js:1778 的数值部分）：清理本波限时增益 → 银行利息 → 进入备战期。
 *
 * ⚠️ 这里修过两处搬运错误（都是「凭印象写」造成的）：
 *   ① 备战时长：原写成固定 34 秒。实际是 core.js:1806 的
 *      `Math.max(12, 24 - wave*0.16) * prepMul * prize.prep`
 *      —— 是个**随波次递减**的值（第 1 波 23.84s，第 30 波 19.2s，第 50 波起封顶 12s）。
 *      固定值会让前中期节奏明显偏慢。
 *   ② 银行利息：原写成「按 def.stat 累加 interest 率」再乘本金。
 *      实际是 core.js:1810-1814：先对每个银行取 `s.interest` 乘以**当前金币**
 *      得到利息额，累加后再 `+=`（不是乘），且**封顶 70% 本金**。
 *      原写法漏了封顶，也把「乘本金」和「乘倍率」搞混了。
 *      这才是真正的搬运 bug，不是风格差异 —— 所以下面把公式逐字抄下来。
 *
 * `prize.prep` / `gb.buff` 的清理也一并照搬（goldBoost / dmgBoost / fateWave
 * 都是「本波限定」，跨波不清会让增益永久叠加）。
 */
export function endWave(gb, fx) {
  // ── 本波限时增益到期（core.js:1794-1805）──
  if (gb.buff) {
    gb.buff.goldBoost = 0;
    gb.buff.dmgBoost = 0;
  }
  gb.fateWave = { dmg: 0, rate: 0, def: 0, crit: 0, critDmg: 0 };

  // ── 备战时长（core.js:1806）──
  gb.state = 'build';
  gb.prepTimer = Math.max(12, 24 - gb.wave * 0.16)
    * ((gb.diff && gb.diff.prepMul) || 1)
    * ((gb.prize && gb.prize.prep) || 1);
  gb.prepTotal = gb.prepTimer;

  // ── 梦境银行利息（core.js:1808-1815）──
  let interest = 0;
  let soulsFromBank = 0;
  (gb.buildings || []).forEach((b) => {
    const s = bstat(b, gb);
    if (s.interest) interest += gb.gold * s.interest;   // ★ 乘的是「当前金币」，不是倍率
    if (s.souls) soulsFromBank += s.souls;
  });
  interest = Math.min(interest, gb.gold * 0.7);         // ★ 封顶 70% 本金
  if (interest > 0) gb.gold += interest;
  if (soulsFromBank > 0) gb.souls += soulsFromBank;

  if (fx && fx.waveEnd) fx.waveEnd(gb.wave);
}

// ══════════════════════════════════════════════════════════
//  出怪（core.js:874 spawnEnemy）
// ══════════════════════════════════════════════════════════

/**
 * 造一只敌人。**不写 e.x/e.y** —— 位置是 lane + progress 的派生量。
 *
 * @param {string} type     敌人类型（'boss' = 从 BOSS_ORDER 取）
 * @param {number} wave
 * @param {object} opts     { lane, corridorSpan, spawnJit, lanePad, diff, event, hpMul, rnd }
 * @returns {object}
 */
export function spawnEnemy(type, wave, opts = {}) {
  let d = ENEMY_DEFS[type];
  let bossKey = null;
  let isBoss = false;
  if (type === 'boss' || !d) {
    bossKey = BOSS_DEFS[type] ? type : bossKeyForWave(wave);
    d = BOSS_DEFS[bossKey];
    type = 'boss';
    isBoss = true;
  }

  const lanes = opts.laneCount || 3;
  const lane = opts.lane !== undefined ? (opts.lane % lanes) : ((Math.random() * lanes) | 0);
  const span = Math.max(1, opts.corridorSpan || 323);
  const spawnJit = opts.spawnJit !== undefined ? opts.spawnJit : 23;
  const lanePad = opts.lanePad !== undefined ? opts.lanePad : 22;

  const hpScale = enemyHpScale(wave, opts.event && opts.event.eff)
    * ((opts.diff && opts.diff.hpMul) || 1);
  const dmgScale = enemyDmgScale(wave, opts.diff || { dmgMul: 1 });

  const e = {
    id: nextEnemyId++,
    type, def: d, lane,
    // ★ 位置真值：车道 + 走廊进度（0 = 出生点，1 = 铁门前）
    progress: 0,
    laneOffset: rnd(-lanePad, lanePad),   // 车道内固定偏移，防同批叠一起

    hp: d.hp * hpScale, maxHp: d.hp * hpScale,
    dmg: d.dmg * dmgScale,
    speed: d.speed * rnd(0.92, 1.08) * ((opts.event && opts.event.eff && opts.event.eff.spdMul) || 1),
    r: d.r,
    state: 'walk', target: null, atkCd: 0, door: null,

    slow: 0, slowT: 0, burn: 0, burnT: 0, burnDmg: 0, burnStack: 0,
    poison: 0, poisonT: 0, poisonDps: 0,
    elem: null, vuln: 0, vulnT: 0,
    stealthT: 0, alpha: 1, untargetable: false, stun: 0,
    res: Object.assign({}, d.res), weak: Object.assign({}, d.weak),
    affixes: [], affixRes: 0, phase: 0, summonT: 0,
    wob: rnd(0, 6.28), anim: 0, dead: false,
    boss: !!d.phases, bossKey,
    hitFlash: 0, hasteT: 0, hasteMul: 1, inCombatT: 0,
    maxPhase: d.phases ? d.phases.length - 1 : 0,
    empT: 0, reviveT: 0, mimicRevealed: false, parasiteTarget: null,
    color: d.color,
    bobPhase: Math.random() * Math.PI * 2,
  };

  // 出生点进度：随机一点点，避免整条车道的敌人完全重叠
  e.progress = clamp(rnd(0, 1) * (spawnJit / span), 0, 1);

  if (d.shieldself) { e.shield = e.maxHp * d.shieldself; e.shieldMax = e.shield; }
  if (d.phaseShield) { e.phaseShield = d.phaseShield; e.segMax = e.maxHp / (d.phaseShield + 1); e.segIdx = 0; }
  // BOSS / 飞行 / 遁地：出生位置更靠外且车道居中
  if (d.boss || d.flying || d.burrow) { e.progress = 0; }

  // 精英词缀
  const ec = eliteChance(wave);
  if (wave >= 5 && Math.random() < ec && !d.boss) {
    const n = wave >= 20 && Math.random() < 0.3 ? 2 : 1;
    const pool = AFFIX_KEYS.slice();
    for (let i = 0; i < n && pool.length; i++) {
      const k = pool.splice((Math.random() * pool.length) | 0, 1)[0];
      e.affixes.push(k);
      const a = AFFIX[k];
      if (a.hp) { e.maxHp *= a.hp; e.hp = e.maxHp; }
      if (a.spd) e.speed *= a.spd;
      if (a.shield) { e.shield = e.maxHp * a.shield; e.shieldMax = e.shield; }
      if (a.allres) e.affixRes = a.allres;
      if (a.flat) e.flat = a.flat;
      if (a.regen) e.regenR = a.regen;
      if (a.vamp) e.vamp = a.vamp;
      if (a.frenzy) e.frenzyOn = true;
      if (a.split) e.splitN = a.split;
      if (a.explode) e.explodeN = a.explode;
    }
    e.elite = true;
  }

  return e;
}

// ══════════════════════════════════════════════════════════
//  敌人推进（core.js:958 enemySpeed / 973 updateEnemies 的移动部分）
// ══════════════════════════════════════════════════════════

/** 当前有效速度（core.js:958）。0 = 完全停住（冻结/眩晕）。 */
export function enemySpeed(e, gb) {
  let s = e.speed;
  if (e.slowT > 0) s *= (1 - e.slow);

  const frenzyAt = (e.def.frenzy && e.def.frenzy.at) || 0.35;
  const frenzySpd = (e.def.frenzy && e.def.frenzy.spd) || 1.9;
  if ((e.frenzyOn || e.def.frenzy) && e.hp < e.maxHp * frenzyAt) s *= frenzySpd;

  if (e.phase > 0 && e.boss && e.def.phases && e.def.phases[e.phase]) {
    s *= e.def.phases[e.phase].speed;
  }
  if (e.hasteT > 0 && e.hasteMul) s *= e.hasteMul;

  const frozen = gb && gb.buff && gb.buff.freeze > 0;
  if (frozen || e.stun > 0) s = 0;
  return s;
}

/**
 * 推进一只敌人的移动/状态（core.js:973 的移动子集）。
 *
 * @param {object} e
 * @param {number} dt
 * @param {object} gb
 * @param {object} hooks { progressSpeed, knockDamage, onDoorBreak }
 */
export function stepEnemyMovement(e, dt, gb, hooks = {}) {
  e.anim += dt;
  if (e.hitFlash > 0) e.hitFlash -= dt;
  if (e.slowT > 0) e.slowT -= dt;
  if (e.stun > 0) e.stun -= dt;
  if (e.vulnT > 0) e.vulnT -= dt;
  if (e.spawnGrace > 0) e.spawnGrace -= dt;

  if (e.dead) return;

  if (e.state === 'walk') {
    const sp = enemySpeed(e, gb);
    const ps = hooks.progressSpeed ? hooks.progressSpeed(sp) : (sp / 323);
    e.progress = Math.min(1, e.progress + ps * dt);
    if (e.progress >= 1) {
      e.state = 'door';
      e.atkCd = 0;
      if (hooks.onArriveDoor) hooks.onArriveDoor(e);
    }
  } else if (e.state === 'door') {
    // 已到门前：按 atkCd 周期性撞门（实际扣血由 combat.damageTarget 处理）
    e.atkCd -= dt;
    if (e.atkCd <= 0) {
      e.atkCd = 1.0;
      if (hooks.onKnock) hooks.onKnock(e);
    }
  }
}

export { FINAL_WAVE, DIFFS, BOSS_ORDER };
