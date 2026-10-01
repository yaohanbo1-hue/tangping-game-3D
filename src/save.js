// ============================================================
//  save.js —— 3D 版存档（localStorage，不依赖像素布局）
// ============================================================
//
// ── 与 2D 版存档的根本差别 ─────────────────────────────────
//
//   2D 版的存档是把整个 `G` JSON 化之后塞进 localStorage。它能跑，
//   但有两个隐患：
//     · `G` 里有 500+ 个字段，其中一大半是**每帧重建的缓存**
//       （bstat 缓存、索敌结果、渲染中间量）。存它们是纯粹的浪费，
//       而且读回来之后还要担心「缓存和真值不一致」。
//     · 敌人的位置在 2D 里是 `e.x / e.y`。3D 已经**去像素化**了，
//       位置真值只有 `lane + progress` —— 如果有谁往存档里塞了 x/y，
//       读档之后就会出现「逻辑在 A、渲染在 B」的分裂。
//
//   所以 3D 的存档**显式列字段**，只存「真值」：
//     · gb 的推进/资源/科技/建筑/门的血量/床的血量/统计
//     · 敌人只存 lane + progress 等真值（永远不存 x/y）
//     · 叙事运行时的 snapshot（章节/词条/支线/事件/插叙进度）
//     · 秘密旋律的已触发列表
//     · 已解锁结局（跨局成就，单独一个 key）
//
//   代价是「新增 gb 字段时要记得加进 SAVE_FIELDS」。这是**有意的取舍**：
//   忘记存一个缓存字段不会出问题，忘记存一个真值字段会立刻被读档测试
//   抓住。反之（自动全存）忘记清理缓存字段是**静默**的错误。
//
// ── 读档之后为什么必须 resyncCtx ───────────────────────────
//
//   ctx 在创建时缓存了 gb.enemies / gb.stats / gb.doors / gb.bed 的**引用**。
//   读档是「原地灌值」而不是换对象（见 board.js::resetBoard 的长注释），
//   所以引用不变；但为了防住「以后有人改成换对象」，loadGame 的调用方
//   必须照旧调一次 resyncCtx —— 这条约束在 main.js 的读档分支里有注释。
// ============================================================

import { ENEMY_DEFS, BOSS_DEFS, BUILD_DEFS } from './rules/constants.js';

/** 存档格式版本。改了字段含义就要 +1，否则老存档会被读成错的状态。 */
export const SAVE_VERSION = 3;

/** localStorage 的两个 key：本局进度 + 跨局成就 */
const RUN_KEY = 'tangping3d_run';
const META_KEY = 'tangping3d_meta';

/**
 * 本局存档要保存的 gb 字段。
 *
 * 分三类：
 *   [推进] wave / waveTime / state / prepTimer —— 波次状态机
 *   [资源] gold / power / souls / grow —— 经济
 *   [养成] tech / buff / fate / prize / event / diffKey —— 跨波的成长
 *   [场景] grid / buildings / doors / bed / enemies —— 场上物件
 *   [统计] stats / combo / maxCombo —— 结算与结局判定要用
 *
 * ⚠️ 刻意**不存**：spawnQueue / bossQueue / spawnTimer / statFrame /
 *    __spawnFn / effects —— 前四个是「本波进行中」的瞬时状态
 *    （存档点一律在备战期，它们本来就该是空的），后两个是运行期句柄，
 *    JSON 化之后是垃圾（__spawnFn 会变成一个没有函数的空对象）。
 */
const SAVE_FIELDS = [
  // 推进
  'wave', 'waveTime', 'state', 'prepTimer',
  // 资源
  'gold', 'power', 'souls', 'grow', 'growTimer',
  // 养成
  'tech', 'buff', 'fate', 'fateWave', 'prize', 'event', 'diffKey',
  // 场景
  'grid', 'buildings', 'doors', 'bed', 'enemies',
  // 统计
  'stats', 'combo', 'comboT', 'maxCombo',
];

/**
 * 敌人的真值字段白名单。
 *
 * ⚠️ 这里是本文件最关键的一处约束：**永远不存 x / y**。
 *    敌人的位置真值只有 lane + progress，两者都在这张表里。
 *    如果有谁往表里加了 'x' 或 'y'，读档后 3D 侧会用存档里的像素坐标
 *    覆盖 lane+progress 派生的世界坐标 —— 表现为敌人瞬移到一个
 *    「上次存档时 2D 逻辑认为的位置」，而且之后再也不会更新。
 */
const ENEMY_FIELDS = [
  'id', 'type', 'lane', 'progress', 'laneOffset',
  'hp', 'maxHp', 'dmg', 'speed', 'r', 'state', 'atkCd',
  'slow', 'slowT', 'burn', 'burnT', 'burnDmg', 'burnStack',
  'poison', 'poisonT', 'poisonDps',
  'elem', 'vuln', 'vulnT', 'stealthT', 'alpha', 'untargetable', 'stun',
  'res', 'weak', 'affixes', 'affixRes', 'phase', 'summonT',
  'wob', 'anim', 'dead', 'boss', 'bossKey',
  'shield', 'shieldMax', 'phaseShield', 'segMax', 'segIdx', 'flat',
  'regenR', 'vamp', 'frenzyOn', 'splitN', 'explodeN', 'elite',
  'hitFlash', 'hasteT', 'hasteMul', 'inCombatT', 'maxPhase',
  'empT', 'reviveT', 'mimicRevealed', 'color', 'bobPhase',
];

// ══════════════════════════════════════════════════════════
//  localStorage 的安全访问
// ══════════════════════════════════════════════════════════
//
// localStorage 在几种情况下会直接抛异常而不是返回 null：
//   · 隐私模式 / 禁用 cookie（SecurityError）
//   · 配额写满（QuotaExceededError）
//   · 某些内嵌 iframe（SecurityError）
// 这些都不该让游戏崩掉 —— 存档失败是「少了个功能」，不是「不能玩」。

function lsGet(key) {
  try {
    return globalThis.localStorage ? globalThis.localStorage.getItem(key) : null;
  } catch (e) {
    console.warn('[save] localStorage 读取失败（可能是隐私模式）：', e && e.message);
    return null;
  }
}

function lsSet(key, val) {
  try {
    if (!globalThis.localStorage) return false;
    globalThis.localStorage.setItem(key, val);
    return true;
  } catch (e) {
    console.warn('[save] localStorage 写入失败（可能是配额或隐私模式）：', e && e.message);
    return false;
  }
}

function lsDel(key) {
  try {
    if (globalThis.localStorage) globalThis.localStorage.removeItem(key);
  } catch (e) { /* 忽略 */ }
}

/** 深拷贝（JSON 语义），并且把 undefined / 函数 / NaN 都变成可 JSON 化的东西 */
function plain(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v !== 'object') return v;
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; }
}

// ══════════════════════════════════════════════════════════
//  收集 / 应用
// ══════════════════════════════════════════════════════════

/**
 * 把 gb 里"该存的部分"摘出来。
 * @param {object} gb
 * @returns {object} 可 JSON 化的纯数据
 */
export function collectBoard(gb) {
  const out = {};
  for (const k of SAVE_FIELDS) {
    if (k === 'enemies') {
      out.enemies = (gb.enemies || []).map((e) => {
        const o = {};
        for (const f of ENEMY_FIELDS) {
          if (e[f] !== undefined) o[f] = plain(e[f]);
        }
        return o;
      });
      continue;
    }
    out[k] = plain(gb[k]);
  }
  return out;
}

/**
 * 把存档里的值**原地**写回 gb。
 *
 * ⚠️ 全部用原地写法（数组 length=0 + push、对象逐键删/写），
 *    与 board.js::resetBoard 的理由完全相同：
 *    ctx 握着 gb.stats / gb.enemies / gb.doors / gb.bed 的引用，
 *    一旦这里换成新对象，规则层写新对象、HUD 读新对象、
 *    但任何还握着旧引用的地方永远读到 0 —— 最典型的表现是
 *    「读档之后塔不开火 / 伤害永远是 0」。
 *
 * @param {object} gb
 * @param {object} data  collectBoard 的产物
 */
export function applyBoard(gb, data) {
  if (!data || typeof data !== 'object') return gb;

  for (const k of SAVE_FIELDS) {
    if (!(k in data)) continue;
    const nv = data[k];
    const ov = gb[k];

    if (Array.isArray(ov)) {
      ov.length = 0;
      // enemies / doors / buildings / grid 的元素是**重建**的（来自 JSON），
      // 所以这里 push 进去的都是新对象 —— 这是可以的，因为
      // ctx.enemies 指向的是**数组本身**，不是数组里的元素。
      // 规则层每帧重新遍历数组取元素，所以元素换对象不影响。
      if (Array.isArray(nv)) for (const item of nv) ov.push(item);
    } else if (ov && typeof ov === 'object' && nv && typeof nv === 'object' && !Array.isArray(nv)) {
      for (const kk of Object.keys(ov)) if (!(kk in nv)) delete ov[kk];
      Object.assign(ov, nv);
    } else if (nv !== null || ov === null || typeof ov === 'object') {
      gb[k] = nv;
    }
  }

  // 敌人读回来之后要补上 def 引用（def 来自常数表，不进存档 ——
  // 存了的话改数值就会「老存档用老数值」，那是最难查的一类不一致）
  rehydrateEnemies(gb);

  // 建筑同理：`def.stat` 是函数，JSON 存不下来，必须按 type 现查补回。
  // 不补的话读档后第一座塔开火就会 `b.def.stat is not a function`。
  rehydrateBuildings(gb);

  // 读档后永远是「备战期」：不恢复到波次进行中。
  // 理由是存档点本来就只在备战期产生，而且恢复半个波次需要连
  // spawnQueue 一起存 —— 那会引入一堆「这波还剩几只」的边界情况，
  // 收益却只是「少点一下开始下一波」。不值得。
  gb.state = 'prep';
  gb.prepTimer = Math.max(3, gb.prepTimer || 8);
  delete gb.gameOver;
  delete gb.won;
  delete gb.__spawnFn;   // 让 stepBoard 用新的 gb 重建（车道轮转游标归零）

  // 建筑对象整体换过了（JSON 重建），bstat 的同帧缓存（b.__sf / b.__ss）
  // 要么不存在、要么挂在**旧对象**上；统一用 statFrame 撞一下，
  // 保证读档后的第一帧重新算面板数值。
  gb.statFrame = (gb.statFrame || 0) + 1;

  return gb;
}

/**
 * 给读回来的敌人补上 `def`（敌人定义）与派生常量。
 *
 * 为什么 def 不进存档：ENEMY_DEFS 是**设计规格**，存进存档会导致
 * 「改了平衡数值，老存档还在用老数值」，那种 bug 极其难发现。
 * 只存 type，读档时按 type 现查。
 *
 * ⚠️ 若某个 type 在新版本里被删掉了（比如策划取消了 'sprinter'），
 *    这里会把它剔除并记下来 —— 宁可少一只怪，也不能让
 *    「def 是 undefined」带着游戏一路崩到索敌里去。
 *
 * @returns {{dropped:string[]}} 被剔除的 type 列表（诊断用）
 */
export function rehydrateEnemies(gb) {
  const dropped = [];
  const kept = [];
  for (const e of gb.enemies || []) {
    // BOSS 的 type 统一存成 'boss'，真身在 bossKey 里 —— 这与
    // rules/wave.js::spawnEnemy 的写法一致（那边也是 type='boss'）。
    let d = null;
    if (e.type === 'boss' && e.bossKey) d = BOSS_DEFS[e.bossKey] || null;
    if (!d) d = ENEMY_DEFS[e.type] || null;
    if (!d) { dropped.push(e.type); continue; }
    e.def = d;
    kept.push(e);
  }
  gb.enemies.length = 0;
  for (const e of kept) gb.enemies.push(e);
  if (dropped.length) console.warn('[save] 读档时剔除了未知敌人类型：', dropped.join(', '));
  return { dropped };
}

/**
 * 给读回来的建筑补上 `def`（建筑定义）。
 *
 * ⚠️ 这是一个**真的踩过的坑**，不是防御性编程：
 *
 *   建筑对象里 `def` 直接挂在身上（`makeBuilding` 里 `def: BUILD_DEFS[type]`），
 *   而 `collectBoard` 走的是 `JSON.parse(JSON.stringify(...))` 式的浅净化 ——
 *   **JSON 里没有函数**，所以 `def.stat`（等级→面板数值的纯函数）在存档里
 *   被静默丢掉了，读回来只剩一个「有 name/cost/maxLv 但没有 stat」的空壳。
 *
 *   表现：读档后一切"看起来正常"（建筑数对得上、血条对得上、HUD 正常），
 *   直到第一座塔需要开火 → `bstat()` → `b.def.stat(b.level)` →
 *   `TypeError: b.def.stat is not a function`。
 *
 *   为什么之前没抓到：读档测试只断言了**建筑数量**（12 → 12），
 *   而"数量对不对"和"能不能开火"是两件事。只有把「读档 → 接着连打几十波」
 *   串起来跑，才会在下一次索敌时炸出来。
 *
 * 与敌人同样的取舍：def 是**设计规格**，不随存档走，读档时按 type 现查。
 * 这样改了平衡数值之后，老存档会立刻用上新数值（而不是冻在旧数值上）。
 *
 * @returns {{dropped:string[]}} 被剔除的 type（诊断用）
 */
export function rehydrateBuildings(gb) {
  const dropped = [];
  const kept = [];
  for (const b of gb.buildings || []) {
    const d = b && BUILD_DEFS[b.type];
    if (!d) { dropped.push(b && b.type); continue; }
    b.def = d;
    // 分支也可能只存了 key：把分支定义一起补回来（分支定义同样含 mod() 函数）
    if (b.branch && (!b.def.branch || !b.def.branch[b.branch])) {
      b.branch = null;
    }
    kept.push(b);
  }
  gb.buildings.length = 0;
  for (const b of kept) gb.buildings.push(b);
  if (dropped.length) console.warn('[save] 读档时剔除了未知建筑类型：', dropped.join(', '));
  return { dropped };
}

// ══════════════════════════════════════════════════════════
//  写档 / 读档 / 清档
// ══════════════════════════════════════════════════════════

/**
 * 存档。
 *
 * @param {object} gb
 * @param {object} [extra]
 *   story    —— narrative.snapshot()
 *   melodies —— audio.melodySnapshot()
 *   fps      —— 无关紧要，但存下来便于定位「卡在哪一波」
 * @returns {{ok:boolean, why?:string, bytes?:number, wave?:number}}
 */
export function saveGame(gb, extra = {}) {
  if (!gb) return { ok: false, why: '没有游戏状态' };
  if (gb.gameOver || gb.won) return { ok: false, why: '本局已结束，不再存档' };

  const payload = {
    v: SAVE_VERSION,
    at: Date.now(),
    board: collectBoard(gb),
    story: extra.story ? plain(extra.story) : null,
    melodies: Array.isArray(extra.melodies) ? extra.melodies.slice() : [],
    fps: typeof extra.fps === 'number' ? Math.round(extra.fps) : null,
  };

  let json;
  try { json = JSON.stringify(payload); } catch (e) { return { ok: false, why: '序列化失败：' + e.message }; }
  if (!lsSet(RUN_KEY, json)) return { ok: false, why: 'localStorage 写入被拒绝' };
  return { ok: true, bytes: json.length, wave: payload.board.wave };
}

/** 有没有存档 */
export function hasSave() {
  const raw = lsGet(RUN_KEY);
  if (!raw) return false;
  try {
    const p = JSON.parse(raw);
    return !!p && p.v === SAVE_VERSION;
  } catch (e) { return false; }
}

/**
 * 读档。
 *
 * ⚠️ 调用方读完之后**必须**调 resyncCtx(ctx, gb) —— 见文件头注释。
 *
 * @returns {{ok:boolean, why?:string, wave?:number, at?:number, story?:object, melodies?:string[]}}
 */
export function loadGame(gb, extra = {}) {
  const raw = lsGet(RUN_KEY);
  if (!raw) return { ok: false, why: '没有存档' };

  let p;
  try { p = JSON.parse(raw); } catch (e) { return { ok: false, why: '存档损坏（JSON 解析失败）' }; }
  if (!p || typeof p !== 'object') return { ok: false, why: '存档格式不对' };
  if (p.v !== SAVE_VERSION) {
    return { ok: false, why: `存档版本 ${p.v} 与当前 ${SAVE_VERSION} 不匹配，已忽略` };
  }

  applyBoard(gb, p.board);
  if (extra.narrative && p.story) {
    try { extra.narrative.restore(p.story); } catch (e) { console.warn('[save] 叙事状态恢复失败：', e); }
  }
  if (extra.audio && Array.isArray(p.melodies) && extra.audio.melodyRestore) {
    try { extra.audio.melodyRestore(p.melodies); } catch (e) { /* 忽略 */ }
  }
  return { ok: true, wave: p.board && p.board.wave, at: p.at, story: p.story, melodies: p.melodies };
}

/** 删除存档（重开一局） */
export function clearSave() { lsDel(RUN_KEY); }

/** 存档摘要（给「继续游戏」按钮显示「第 N 波 · 时间」用） */
export function saveInfo() {
  const raw = lsGet(RUN_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (!p || p.v !== SAVE_VERSION) return null;
    return {
      wave: (p.board && p.board.wave) || 0,
      at: p.at || 0,
      gold: (p.board && p.board.gold) || 0,
      buildings: (p.board && Array.isArray(p.board.buildings)) ? p.board.buildings.length : 0,
    };
  } catch (e) { return null; }
}

// ══════════════════════════════════════════════════════════
//  跨局成就（已解锁结局）
// ══════════════════════════════════════════════════════════
//
// 结局是**成就**不是进度：重开一局不该忘记「你曾经看到过哪个结局」。
// 所以单开一个 key，且 clearSave() 不清它。

export function loadMeta() {
  const raw = lsGet(META_KEY);
  if (!raw) return { endings: [] };
  try {
    const m = JSON.parse(raw);
    return { endings: Array.isArray(m.endings) ? m.endings : [] };
  } catch (e) { return { endings: [] }; }
}

export function saveMeta(meta) {
  const m = { endings: Array.isArray(meta && meta.endings) ? meta.endings : [] };
  return lsSet(META_KEY, JSON.stringify(m));
}

/** 记一个已解锁结局，返回是否是新解锁 */
export function unlockEnding(id) {
  if (!id) return false;
  const m = loadMeta();
  if (m.endings.includes(id)) return false;
  m.endings.push(id);
  saveMeta(m);
  return true;
}

export function clearMeta() { lsDel(META_KEY); }

// 供调试面 / 测试用
export const _keys = { RUN_KEY, META_KEY, SAVE_FIELDS, ENEMY_FIELDS };
