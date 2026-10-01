// ============================================================
//  board.js —— 3D 侧的 game board（把 rules/ 接到 3D 世界的那一层胶水）
// ============================================================
//
// 这是第 4 步的收口文件。它只做一件事：**把 2D 里的全局 `G` 变成一个
// 显式对象 `gb`，再配一个 `ctx`，让 rules/ 里的纯逻辑跑起来。**
//
// ── 为什么要单独一个文件 ──────────────────────────────────
//
// rules/ 那五个文件是「纯逻辑」：不 import three、不碰 DOM、不读全局。
// 但纯逻辑总得有人喂它「现在场上有什么、钱多少、波次到哪」——
// 在 2D 里这些全挂在 `G` 上（519 个全局符号之一）。
//
// 3D 这边刻意**不复制 G 的形状**，而是：
//   · `gb`：只放规则层真正会读写的字段（见下面 makeBoard 的注释）
//   · `ctx`：只放「规则需要但不属于 gb」的东西（fx、解算器、回调）
//
// 这样接口面是**可枚举的**：`grep ctx\\.` 就能列出全部依赖（17 个），
// 不会像 2D 那样「不知道哪个函数偷偷改了 G 的哪个字段」。
//
// ── 位置解算器（xyOf）—— 本步最关键的一处适配 ─────────────
//
// 第 1 步去像素化之后，敌人**没有 x/y 字段**，只有 lane + progress。
// 但 rules/ 里的索敌、溅射、反应 AoE 都要算「两点距离」。
//
// 解法：规则层不直接读 e.x，而是调 `ctx.xyOf(e)`。本文件提供的实现是：
//
//   敌人   → enemyWorldPos3D(e, e.progress) 得到米，再 ÷ UNIT 还原成逻辑像素
//   建筑/门/床 → 它们自带静态 x/y，直接返回
//
// ⚠️ 这里 ÷ UNIT 是**必须**的：规则层的射程、溅射半径、反应 AoE 全部是
//    「逻辑像素」量纲（520px 射程、110px 过载范围…）。如果直接把米喂进去，
//    射程会缩小 100 倍，所有塔都会「够不到敌人」。
//    这类量纲错误不会报错，只会表现为「塔不开火」——最难查的一种。
//
// ── fx 适配 ──────────────────────────────────────────────
//
// rules/combat.js 通过 fx 回调请求表现（飘字/粒子/震屏/特效/音效/停顿）。
// 本文件把它们翻译成 Three.js 世界的做法（见 fx.js），
// 并且**锚点统一转成世界坐标**：规则层发出来的是逻辑像素，
// 表现层需要米。转换只在这一处做，别处不许再转。
// ============================================================

import {
  DIFFS, FINAL_WAVE, BOSS_ORDER,
} from './rules/constants.js';
import { techVal, bstat, invalidateAllBstat, buildingMaxHp, doorMaxHp, bedMaxHp } from './rules/buildings.js';
import { makeFx } from './rules/combat.js';
import { startWave, updateWave, endWave, stepEnemyMovement, spawnEnemy, _resetEnemyIds } from './rules/wave.js';
import { updateTowers } from './rules/towers.js';
import { updateEconomy } from './rules/buildings.js';
import {
  LANES, UNIT, CORRIDOR_SPAN, progressSpeed, enemyWorldPos3D, WALL_X,
} from './world.js';

// ══════════════════════════════════════════════════════════
//  gb 的构造
// ══════════════════════════════════════════════════════════

/**
 * 造一个全新的 game board。
 *
 * 字段是按「rules/ 里真正出现过的 `gb.xxx`」逐个列出来的，
 * 不是照抄 2D 的 G —— 所以这份清单就是规则层的**依赖契约**。
 *
 * @param {object} [over] 覆盖初始值（测试/难度选择用）
 */
export function makeBoard(over = {}) {
  const gb = {
    // ── 波次与推进 ──
    wave: 0,
    waveTime: 0,
    state: 'prep',          // prep（备战）| wave（出怪中）
    prepTimer: 8,           // 备战倒计时
    spawnQueue: [],
    bossQueue: [],
    spawnTimer: 0,

    // ── 资源 ──
    gold: 120,
    power: 60,
    souls: 0,
    grow: 0,                // 成长层数（每层 +2% 灵魂）
    growTimer: 0,

    // ── 科技 / 增益 / 命运 ──
    tech: {},
    buff: {},
    fate: {},
    fateWave: {},
    prize: {},
    event: { eff: {} },

    // ── 场景物件 ──
    grid: new Array(40).fill(null),   // 8×5 建造格，存建筑或 null
    buildings: [],
    enemies: [],
    doors: [],
    bed: null,
    effects: [],

    // ── 统计与连击 ──
    stats: { kills: 0, bossKills: 0, goldTotal: 0, dmg: 0, build: 0, reactions: 0 },
    combo: 0, comboT: 0, maxCombo: 0,

    // ── 难度 ──
    diff: DIFFS.normal,
    diffKey: 'normal',

    // ── 缓存与调试 ──
    statFrame: 0,
    admin: false,
  };
  Object.assign(gb, over);

  // 铁门：三条车道各一扇。位置是**静态**的（不随波次变），
  // 所以在这里一次性生成，之后只改 hp/lv。
  if (!gb.doors.length) {
    gb.doors = LANES.map((L) => ({
      lane: L.i,
      x: WALL_X - 26,          // 门板中心（贴走廊侧），逻辑像素
      y: L.doorY,
      hp: doorMaxHp(1, gb),
      maxHp: doorMaxHp(1, gb),
      lv: 1, shield: 0, shieldMax: 0, broken: false, isDoor: true,
    }));
  }

  // 床铺：全房间唯一，破了就 gameOver。位置取房间中心偏右。
  if (!gb.bed) {
    const hp = bedMaxHp(1, gb);
    gb.bed = { x: 980, y: 311, hp, maxHp: hp, lv: 1, shield: 0, shieldMax: 0, isBed: true, radius: 60 };
  }

  return gb;
}

// ══════════════════════════════════════════════════════════
//  位置解算器
// ══════════════════════════════════════════════════════════

/**
 * 敌人 / 静态物 → 逻辑像素坐标。
 *
 * ⚠️ 这是**规则层唯一允许获得位置的方式**。任何地方直接读 `e.x` 都会
 *    拿到 undefined（敌人根本没这个字段）。
 */
export function makeXYOf() {
  return function xyOf(o) {
    if (!o) return { x: 0, y: 0 };
    // 建筑 / 门 / 床：自带静态 x/y，短路返回
    if (typeof o.x === 'number' && typeof o.y === 'number') return { x: o.x, y: o.y };
    // 敌人：由 lane + progress 派生，再从米还原成逻辑像素
    const p = enemyWorldPos3D(o, o.progress);
    return { x: p.x / UNIT, y: p.z / UNIT };
  };
}

/**
 * 把「逻辑像素」翻成「世界米」。
 * 表现层（fx / 弹道 / 特效）需要世界坐标，规则层给的是逻辑像素，
 * 这个函数就是两者之间**唯一**的换算口。
 */
export const px2world = (x, y) => ({ x: x * UNIT, z: y * UNIT });

// ══════════════════════════════════════════════════════════
//  ctx（伤害/索敌上下文）
// ══════════════════════════════════════════════════════════

/**
 * 造 ctx。规则层用到的字段见文件头的清单，一共 17 个。
 *
 * @param {object} gb
 * @param {object} [fx]      表现回调（缺省 no-op）
 * @param {object} [hooks]   { onKill, onGameOver, onFinalBossKilled }
 */
export function makeCtx(gb, fx, hooks = {}) {
  const xyOf = makeXYOf();

  return {
    // 兼容两种取法：新代码用 ctx.gb，老代码（2D 沿用的）读 ctx.G
    gb,
    G: gb,
    fx: makeFx(fx),
    enemies: gb.enemies,
    stats: gb.stats,
    xyOf,

    // ── 规则需要的「外部读数」──
    techVal: (k, per) => techVal(gb, k, per),
    bstat: (b) => bstat(b, gb),
    corridorSpan: () => CORRIDOR_SPAN,
    diffSoulMul: () => (gb.diff && gb.diff.soulMul) || 1,
    shieldKnockback: 90,

    // ── 击退 / 牵引：去像素化后不能直接改 e.x，要改 progress ──
    //
    // 2D 里 `e.x += dx/d * knock`，3D 里必须翻译成「progress 往回退多少」。
    // 因为 progress=1 在门前（x 最小），往回退 = 远离门 = x 变大，
    // 所以是 **progress 减去** 位移对应的进度量，不是加。
    knockProgress(e, pxDist) {
      if (!e || e.state !== 'walk') return;
      e.progress = Math.max(0, e.progress - pxDist / CORRIDOR_SPAN);
    },
    pullProgress(e, pxDist) {
      if (!e || e.state !== 'walk') return;
      if (e.boss) return;   // BOSS 免疫牵引（与 2D 的 0.28 系数等效的保守处理）
      e.progress = Math.max(0, e.progress - pxDist / CORRIDOR_SPAN);
    },

    // ── 结算回调 ──
    onKill: hooks.onKill || null,
    gameOver: hooks.onGameOver || (() => { gb.gameOver = true; }),
    onFinalBossKilled: hooks.onFinalBossKilled || (() => { gb.won = true; }),
  };
}

// ══════════════════════════════════════════════════════════
//  一帧的推进
// ══════════════════════════════════════════════════════════

/**
 * 造一个缺省出怪函数：把 rules/wave.js 的 spawnEnemy 接上本场景的参数
 * （车道轮转、走廊长度、难度、事件效果）。
 *
 * 之所以要有这个包装：`spawnEnemy(type, wave, opts)` 的 opts 里有一堆
 * 场景相关参数（corridorSpan / diff / event），规则层故意不自己去找它们
 * ——那是全局状态的活。3D 侧在这一处集中喂进去。
 */
export function makeSpawnFn(gb) {
  let cursor = 0;
  return function spawnFn(type, wave, lane) {
    const L = lane !== undefined ? lane : (cursor++ % LANES.length);
    const e = spawnEnemy(type, wave, {
      lane: L,
      laneCount: LANES.length,
      corridorSpan: CORRIDOR_SPAN,
      diff: gb.diff,
      event: gb.event,
    });
    gb.enemies.push(e);
    return e;
  };
}

/**
 * 推进整个世界一帧。顺序**必须**与 2D 的 core.js:2041-2045 一致：
 *
 *   updateWave → updateEconomy → updateTowers → updateBullets → updateEnemies
 *
 * 顺序错了会静默出现数值偏差（比如塔在敌人移动前开火 vs 移动后开火，
 * 命中数不一样）。「弹道飞行」那一步在 3D 里由表现层的 shots.js 负责，
 * 所以这一步拿到 outShots 后交给调用方，本函数不消费它。
 *
 * @param {object} gb
 * @param {object} ctx
 * @param {number} dt
 * @param {object} deps  { spawnFn, onKnock }
 * @returns {{shots:Array}}
 */
export function stepBoard(gb, ctx, dt, deps = {}) {
  if (gb.gameOver || gb.won) return { shots: [] };

  gb.statFrame++;

  // spawnFn 每帧都要有：备战期结束那一帧会立刻出怪。
  // 缺省用 gb 自己的持久 cursor（不能每次新建，否则车道轮转会退化）。
  if (!deps.spawnFn) deps.spawnFn = gb.__spawnFn || (gb.__spawnFn = makeSpawnFn(gb));

  updateWave(dt, gb, deps.spawnFn, ctx.fx);
  updateEconomy(dt, gb, ctx.fx);

  const shots = updateTowers(dt, gb, ctx.fx, ctx, []);

  // 敌人移动（含撞门）
  const hooks = {
    progressSpeed: (sp) => progressSpeed(sp),
    onArriveDoor: (e) => {
      // 抵达门后不再推进 progress，只按 atkCd 撞门
      e.state = 'door';
      gb.stats.doorArrivals = (gb.stats.doorArrivals || 0) + 1;
    },
    onKnock: (e) => {
      const door = gb.doors[e.lane];
      if (door && !door.broken) {
        // 撞门伤害走 damageTarget（由 combat.js 提供，这里通过 ctx 里的门对象直接算）
        deps.onKnock ? deps.onKnock(e, door) : null;
      } else {
        // 门破了 → 打床
        deps.onKnock ? deps.onKnock(e, gb.bed) : null;
      }
    },
  };
  for (const e of gb.enemies) if (!e.dead) stepEnemyMovement(e, dt, gb, hooks);

  // 清理死亡敌人（对应 2D updateEnemies 里的 splice）
  //
  // ⚠️ 必须**原地** splice，不能 `gb.enemies = gb.enemies.filter(...)`。
  //    filter 会造出一个新数组，而 ctx.enemies 还指着老数组 ——
  //    索敌从此扫一个永远不更新的空数组，塔就再也不开火了。
  //    （这正是「僵尸对象」bug 的另一种形态：不是替换对象，是替换数组。）
  for (let i = gb.enemies.length - 1; i >= 0; i--) {
    if (gb.enemies[i].dead) gb.enemies.splice(i, 1);
  }

  return { shots };
}

// ══════════════════════════════════════════════════════════
//  波次控制（给 UI 用）
// ══════════════════════════════════════════════════════════

/**
 * 开新一波。返回是否真的开了。
 *
 * ⚠️ `startWave()` 内部**自己会 `gb.wave += 1`**，所以这里千万不要
 *    再自增一次 —— 否则第 1 波会变成第 2 波，而且波次越跑越超前。
 */
export function beginWave(gb, ctx) {
  if (gb.state === 'wave') return false;
  startWave(gb, gb.diff && gb.diff.eff);
  invalidateAllBstat(gb);
  return true;
}

/**
 * 全部重置（重开一局）。
 *
 * ⚠️⚠️ 这里必须**原地清空**，不能 `Object.assign(gb, fresh)`。
 *
 *   后者会把 gb.stats / gb.enemies / gb.doors / gb.bed 换成**新对象**，
 *   而 `ctx` 在创建时就把这些引用缓存下来了（ctx.stats、ctx.enemies…）。
 *   于是重开之后：
 *     · 规则层往 gb.stats.dmg 累加 → 写的是新对象
 *     · 快照 / HUD 读的是新对象 → 看起来「有伤害」
 *     · 但任何还握着旧引用的地方（ctx.stats）永远读到 0
 *   更隐蔽的是 ctx.enemies：出怪推进的是 gb.enemies，而索敌读 ctx.enemies，
 *   两边不是同一个数组 —— 表现为「塔不开火」。
 *
 *   这和第 1 步踩过的「僵尸对象」是同一类 bug，所以干脆全用原地操作：
 *   数组 length = 0，对象逐 key 删/写。
 */
export function resetBoard(gb) {
  _resetEnemyIds();
  const fresh = makeBoard({ diffKey: gb.diffKey, diff: gb.diff });

  // 逐键原地写：数组与对象都保留原引用
  for (const k of Object.keys(gb)) {
    if (!(k in fresh)) continue;
    const nv = fresh[k];
    const ov = gb[k];
    if (Array.isArray(ov) && Array.isArray(nv)) {
      ov.length = 0;
      for (const item of nv) ov.push(item);
    } else if (ov && typeof ov === 'object' && nv && typeof nv === 'object'
               && !Array.isArray(nv) && !(ov instanceof Map) && !(ov instanceof Set)) {
      // 普通对象：原地合并（保留引用），并清掉 fresh 里没有的旧键
      for (const kk of Object.keys(ov)) if (!(kk in nv)) delete ov[kk];
      Object.assign(ov, nv);
    } else {
      gb[k] = nv;
    }
  }
  delete gb.gameOver;
  delete gb.won;
  delete gb.__spawnFn;
  return gb;
}

/**
 * 重开之后让 ctx 重新对齐 gb 的各个子对象。
 *
 * 即使 resetBoard 已经保证了引用不变，这里也**显式再对一遍** ——
 * 因为 ctx 是个「缓存了一堆 gb 子对象引用」的快照，任何对 gb 的
 * 整体替换都会让它失效。把它做成一个必须调用的收尾步骤，
 * 比依赖「记得别替换」可靠。
 */
export function resyncCtx(ctx, gb) {
  ctx.gb = gb;
  ctx.G = gb;
  ctx.enemies = gb.enemies;
  ctx.stats = gb.stats;
  return ctx;
}

// 供 UI / 调试面复用的常量
export { FINAL_WAVE, BOSS_ORDER, LANES, CORRIDOR_SPAN, UNIT };
