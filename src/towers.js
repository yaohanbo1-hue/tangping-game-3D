// ============================================================
//  towers.js —— 炮塔的 3D 呈现 + 建造交互
// ============================================================
//
// 职责边界（和第 3 步一脉相承的单向数据流）：
//
//   rules/buildings.js  ← 造塔/升级/出售/费用（纯逻辑，不 import three）
//   towers.js（本文件）  ← 读 gb.buildings，画出来；把点击变成 makeBuilding 调用
//
// ⚠️ 本文件**不复制**任何数值规则：费用、血量、射程、升级价全部问
//    rules/buildings.js。否则「面板显示 60 金、实际扣 80 金」这种
//    双份真相的 bug 一定会出现。
//
// ── 炮塔形状怎么定 ────────────────────────────────────────
//
// 2D 版是 emoji（🔫❄️⚡…）。3D 里如果用贴图 emoji 会很脏，所以改成
// 「几何体 + 颜色 + 炮管长度/粗细」来区分 10 种塔：
//   · 底座颜色 = def.color（沿用 2D 配色，玩家能对上号）
//   · 炮管长度 ∝ 射程（视觉上就能读出谁打得远，这是塔防的关键信息）
//   · 炮管俯仰 = s.angle（规则层算好的朝向）
//
// ── 建造交互 ──────────────────────────────────────────────
//
// 点格子 → 尝试建造当前选中的塔。用 Raycaster 打 terrain 的格子 mesh。
// 相机是正交的，所以射线是平行的，「点到哪个格子」的判断很稳定。
// ============================================================

import * as THREE from 'three';
import {
  BUILD_DEFS, BUILD_KEYS, TOWER_KEYS, BRANCH_AT, SELL_RATE, upgradeCost,
} from './rules/constants.js';
import {
  bstat, makeBuilding, tryUpgrade, tryBranch, sellBuilding, canAfford,
} from './rules/buildings.js';
import { UNIT, cellCenter, COLS, ROWS, px2len } from './world.js';
import { THEME } from './terrain.js';

const MAX_TOWERS = 64;
const BED_CELLS = [[7, 1], [7, 2]];

const w = (px) => px * UNIT;

// ══════════════════════════════════════════════════════════
//  单座塔的 mesh
// ══════════════════════════════════════════════════════════

/**
 * 造一座塔的可见体：底座 + 炮塔身 + 可转向的炮管。
 * 用 Group 包起来，这样「转炮管」只动子节点，不动整体。
 */
function buildTowerMesh(def, s) {
  const g = new THREE.Group();
  const baseColor = new THREE.Color(def.color || '#8ecae6');

  // 底座：矮圆柱，颜色即塔色
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(w(20), w(23), w(10), 12),
    new THREE.MeshStandardMaterial({
      color: baseColor.clone().multiplyScalar(0.55),
      roughness: 0.7, metalness: 0.2,
      emissive: baseColor, emissiveIntensity: 0.18,
    }),
  );
  pad.position.y = w(5);
  pad.castShadow = true;
  pad.receiveShadow = true;
  g.add(pad);

  // 塔身：方柱，带发光边
  const bodyH = w(26);
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(w(28), bodyH, w(28)),
    new THREE.MeshStandardMaterial({
      color: baseColor,
      roughness: 0.5, metalness: 0.3,
      emissive: baseColor, emissiveIntensity: 0.35,
    }),
  );
  body.position.y = w(10) + bodyH / 2;
  body.castShadow = true;
  g.add(body);

  // 炮管：转向的部分。
  // ⚠️ 长度**不能**按射程线性缩放。第一版用了 `range * 0.22`，
  //    机枪塔射程 520px → 炮管 114px = 1.14m，比整格还长一截，
  //    画面上全是一根根横躺的大棍子，完全读不出「这是座塔」。
  //    第二版改成 `w(26) * rangeK` 仍然偏长（26px ≈ 塔身 28px 的宽度），
  //    俯视正交下炮管会被压扁，看着像塔身上横插了一根棍。
  //    现在收到塔身宽度的 ~0.55-0.85：形状稳定是「带炮口的方块」，
  //    射程差异靠 ±25% 的微调 + 炮口灯亮度一起表达。
  const rangeK = Math.max(0.55, Math.min(0.85, 0.55 + ((s.range || 400) / 1000) * 0.3));
  const barrelLen = w(28) * rangeK;
  const barrel = new THREE.Mesh(
    new THREE.BoxGeometry(barrelLen, w(7), w(7)),
    new THREE.MeshStandardMaterial({
      color: 0xf6f7fb, roughness: 0.35, metalness: 0.5,
      emissive: baseColor, emissiveIntensity: 0.55,
    }),
  );
  // 让炮管的「中心」在塔身上，只往 +X 伸出去
  barrel.position.set(barrelLen / 2 + w(2), w(10) + bodyH, 0);
  barrel.castShadow = true;

  // 炮口小灯：开火时会亮（fireFx 驱动）
  const muzzle = new THREE.Mesh(
    new THREE.SphereGeometry(w(4.5), 8, 6),
    new THREE.MeshBasicMaterial({ color: baseColor, transparent: true, opacity: 0.9 }),
  );
  muzzle.position.set(barrelLen, 0, 0);
  barrel.add(muzzle);

  const head = new THREE.Group();
  head.add(barrel);
  head.position.y = 0;
  g.add(head);

  return { group: g, head, barrel, muzzle, pad, body, baseColor };
}

// ══════════════════════════════════════════════════════════
//  主图层
// ══════════════════════════════════════════════════════════

/**
 * @param {THREE.Scene} scene
 * @param {object} opts { gb, ctx, terrain, onSelect(b|null), onReject(reason), getBuildType() }
 */
export function createTowerLayer(scene, opts) {
  const { gb, ctx, terrain } = opts;

  /** building 对象 → { mesh 组 }，按引用关联，不靠 id（规则层没给 id） */
  const views = new Map();

  /** 建造预览：一个半透明幽灵塔，跟着鼠标走 */
  let ghost = null;
  let ghostType = null;
  let hoverCell = null;
  let selected = null;

  // ── 选中环：给当前选中的塔画一个圈 ──
  const selRing = new THREE.Mesh(
    new THREE.RingGeometry(w(30), w(36), 32),
    new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
  );
  selRing.rotation.x = -Math.PI / 2;
  selRing.visible = false;
  selRing.position.y = 0.09;
  scene.add(selRing);

  // ── 射程环：选中时显示这个塔能打多远（正交视角下这是刚需信息）──
  const rangeRing = new THREE.Mesh(
    new THREE.RingGeometry(0.99, 1, 64),
    new THREE.MeshBasicMaterial({ color: 0x7fdfff, transparent: true, opacity: 0.28, side: THREE.DoubleSide }),
  );
  rangeRing.rotation.x = -Math.PI / 2;
  rangeRing.visible = false;
  rangeRing.position.y = 0.05;
  scene.add(rangeRing);

  // ── 建造预览 ──
  function setGhost(type) {
    if (ghost) { scene.remove(ghost); ghost = null; }
    ghostType = type;
    if (!type) return;
    const def = BUILD_DEFS[type];
    if (!def) return;
    const s = def.stat(1);
    const parts = buildTowerMesh(def, s);
    // 幽灵态：整体半透明、不投影
    parts.group.traverse((n) => {
      if (n.isMesh) {
        n.material = n.material.clone();
        n.material.transparent = true;
        n.material.opacity = 0.45;
        n.castShadow = false;
        n.material.emissiveIntensity = 0.7;
      }
    });
    ghost = parts.group;
    ghost.visible = false;
    scene.add(ghost);
  }

  // ── 建筑物增删同步 ──
  function sync() {
    const alive = new Set(gb.buildings);
    // 移除已不在列表里的（被卖掉了）
    for (const [b, v] of views) {
      if (!alive.has(b)) {
        scene.remove(v.group);
        views.delete(b);
        if (selected === b) select(null);
      }
    }
    // 新增
    for (const b of gb.buildings) {
      if (views.has(b)) continue;
      const s = bstat(b, gb);
      const parts = buildTowerMesh(b.def, s);
      const c = cellCenter(b.col, b.row);
      parts.group.position.set(c.x, 0.09, c.z);
      views.set(b, parts);
      scene.add(parts.group);
      // 新建的塔加一个落成动画（从 0 弹到 1）
      parts.group.scale.setScalar(0.01);
      parts.spawnT = 0.28;
    }
  }

  // ── 每帧呈现同步 ──
  let t = 0;
  function updateViews(dt) {
    t += dt;
    sync();

    for (const [b, v] of views) {
      const s = bstat(b, gb);

      // 落成动画
      if (v.spawnT > 0) {
        v.spawnT -= dt;
        const k = 1 - Math.max(0, v.spawnT) / 0.28;
        // 一点点回弹，看起来像「啪」地立起来
        const e = 1 + Math.sin(k * Math.PI) * 0.18;
        v.group.scale.setScalar(Math.max(0.01, k * e));
      }

      // 炮管朝向：规则层的 s.angle 是「逻辑像素平面上的弧度」，
      // 3D 里 XZ 平面同构，所以直接把 y 分量映射到 -Z 即可
      // （2D 的 +y 向下 → 3D 的 +z，所以旋转取负）
      v.head.rotation.y = -(b.angle || 0);

      // 开火脉冲：炮管后座 + 炮口灯爆发
      if (b.fireFx > 0) {
        b.fireFx = Math.max(0, b.fireFx - dt);
        const k = b.fireFx / 0.25;
        v.head.position.x = -w(5) * k;
        v.muzzle.material.opacity = 0.35 + 0.65 * k;
        v.muzzle.scale.setScalar(1 + k * 1.6);
      } else {
        v.head.position.x = 0;
        v.muzzle.material.opacity = 0.5 + Math.sin(t * 3 + (b.pulse || 0)) * 0.15;
        v.muzzle.scale.setScalar(1);
      }

      // 受损：血量比例越低越发红
      const hpK = Math.max(0, Math.min(1, b.hp / b.maxHp));
      v.body.material.emissive.setRGB(
        v.baseColor.r * (0.35 + (1 - hpK) * 1.2),
        v.baseColor.g * 0.35,
        v.baseColor.b * 0.35,
      );

      // 瘫痪（EMP）：整体压暗
      v.group.visible = b.empT > 0 ? Math.floor(t * 12) % 2 === 0 : true;

      // 等级标记：底座每升一级长高一圈（纯视觉，不改逻辑）
      const lvK = 1 + (b.level - 1) * 0.02;
      v.pad.scale.set(lvK, 1, lvK);
    }

    // 选中环 & 射程环
    if (selected && views.has(selected)) {
      const v = views.get(selected);
      selRing.position.set(v.group.position.x, 0.09, v.group.position.z);
      selRing.visible = true;
      const s = bstat(selected, gb);
      const rr = w(s.range || 400);
      rangeRing.position.set(v.group.position.x, 0.05, v.group.position.z);
      rangeRing.scale.setScalar(rr);
      rangeRing.visible = true;
    } else {
      selRing.visible = false;
      rangeRing.visible = false;
    }

    // 幽灵跟随
    if (ghost && hoverCell) {
      const c = cellCenter(hoverCell.col, hoverCell.row);
      ghost.position.set(c.x, 0.09, c.z);
      ghost.visible = true;
    } else if (ghost) {
      ghost.visible = false;
    }
  }

  // ══════════════════════════════════════════════════════════
  //  格子拾取
  // ══════════════════════════════════════════════════════════

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  /**
   * 屏幕坐标 → 格子 {col,row, mesh} 或 null。
   * 打的是 terrain 里的 cell mesh（它们 userData 里有 col/row）。
   */
  function pickCell(clientX, clientY, camera, dom) {
    const r = dom.getBoundingClientRect();
    ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(terrain.cells, false);
    if (!hits.length) return null;
    const ud = hits[0].object.userData;
    if (!ud || ud.type !== 'cell') return null;
    return { col: ud.col, row: ud.row, mesh: hits[0].object, isBed: ud.isBed };
  }

  /** 该格能不能建这种塔 */
  function cellFree(col, row) {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return false;
    if (BED_CELLS.some(([c, r]) => c === col && r === row)) return false;
    return !gb.grid[row * COLS + col];
  }

  // ══════════════════════════════════════════════════════════
  //  建造 / 升级 / 出售
  // ══════════════════════════════════════════════════════════

  /** 在格子上造一座塔。返回 building 或 null（并回调原因） */
  function tryBuild(type, col, row) {
    const def = BUILD_DEFS[type];
    if (!def) { opts.onReject && opts.onReject('未知建筑：' + type); return null; }
    if (!cellFree(col, row)) { opts.onReject && opts.onReject('这格被占了或不能建'); return null; }
    if (!canAfford(gb, def.cost)) {
      opts.onReject && opts.onReject(`资源不足：需要 ${def.cost.gold}💰${def.cost.power ? ' / ' + def.cost.power + '⚡' : ''}`);
      return null;
    }
    const c = cellCenter(col, row);
    // ⚠️ 传进规则层的是**逻辑像素**坐标（cellCenter 给的是米，要除 UNIT 回去）
    const b = makeBuilding(type, col, row, c.x / UNIT, c.z / UNIT, gb);
    if (!b) { opts.onReject && opts.onReject('建造失败'); return null; }
    gb.grid[row * COLS + col] = b;
    sync();

    // 第 5 步：建造成功的**一次性**回调。
    // 用途是秘密旋律彩蛋（连续点击特定建筑触发）—— 它必须只在
    // "真的造出来"时发一次，所以放在资源校验和 makeBuilding 之后，
    // 而且**不能**放进 sync()（sync 每帧都跑，会变成每帧触发一次）。
    if (opts.onBuilt) {
      try { opts.onBuilt(b); } catch (e) { console.warn('[towers] onBuilt 回调异常：', e); }
    }
    return b;
  }

  /**
   * 丢弃全部塔的视图，下一帧由 sync() 按 gb.buildings 重建。
   *
   * 什么时候需要：**读档 / 重开**。这两种情况下 gb.buildings 里的
   * 对象被整批换掉了（applyBoard / resetBoard 都是原地改数组，
   * 但数组里的元素是新的），而 views 这个 Map 是按**对象引用**做键的
   * （规则层没给建筑 id）。不重建的话，Map 里还留着上一局的尸体，
   * 新建筑会被当成"没见过的"再建一遍视图 → 场上出现双份塔。
   *
   * 这条「views 按引用做键」的约束来自 towers.js 的设计，不是 bug：
   * 让规则层给建筑发 id 会为了一个渲染细节去改规则层的数据结构。
   */
  function rebuildViews() {
    for (const [, v] of views) scene.remove(v.group);
    views.clear();
    select(null);
    selRing.visible = false;
    rangeRing.visible = false;
    sync();
  }

  /** 升级选中的塔 */
  function upgradeSelected() {
    if (!selected) return { ok: false, why: '没选中任何塔' };
    const before = selected.level;
    const r = tryUpgrade(selected, gb);
    if (selected.level === before) return { ok: false, why: '等级已满或资源不足' };
    opts.onSelect && opts.onSelect(selected);
    return { ok: true, level: selected.level };
  }

  /** 转职（6 级解锁二个分支之一） */
  function branchSelected(which) {
    if (!selected) return { ok: false, why: '没选中任何塔' };
    if (selected.level < BRANCH_AT) return { ok: false, why: `需要 Lv${BRANCH_AT}` };
    const r = tryBranch(selected, which, gb);
    if (!r) return { ok: false, why: '转职失败（资源不足或已转职）' };
    // 转职后外观要换（颜色/炮管都变），所以重建 mesh
    const v = views.get(selected);
    if (v) {
      scene.remove(v.group);
      views.delete(selected);
      // 保留选中状态（下一帧 sync 会重建）
    }
    sync();
    opts.onSelect && opts.onSelect(selected);
    return { ok: true, branch: which };
  }

  /** 卖掉选中的塔，返还 SELL_RATE */
  function sellSelected() {
    if (!selected) return { ok: false, why: '没选中任何塔' };
    const b = selected;
    const back = sellBuilding(b, gb, SELL_RATE);
    gb.grid[b.row * COLS + b.col] = null;
    const v = views.get(b);
    if (v) { scene.remove(v.group); views.delete(b); }
    select(null);
    return { ok: true, refund: back };
  }

  function select(b) {
    selected = b;
    if (b) { selRing.visible = true; rangeRing.visible = true; }
    opts.onSelect && opts.onSelect(b);
  }

  // ══════════════════════════════════════════════════════════
  //  鼠标 / 触摸绑定
  // ══════════════════════════════════════════════════════════
  //
  // ── 为什么鼠标和触摸要走不同分支 ──────────────────────────
  //
  // 鼠标有 hover：光标移到哪一格，pointermove 就把那一格点亮，
  // 玩家「移动即预览」，抬手就落子，没有任何信息缺口。
  //
  // 触屏**没有 hover**：手指按下去之前屏幕上什么都没有。原来的实现
  // 只在 pointermove 里更新高亮，于是手机玩家的实际体验是
  // 「点一下 → 不知道会造在哪 → 抬手已经造下去了」。这是移动端最伤的
  // 一个缺口，光靠调大命中区救不了。
  //
  // 所以按 `pointerType` 分流：
  //   · mouse（以及 pointerType 缺失时的兜底）：保持原来的 hover 行为，一个字不改
  //   · touch / pen：**按下即预览**（高亮目标格 + 幽灵塔），**抬起才落子**。
  //     手指在抬起前能一直看到目标格，抬手同一格且没拖动才提交。
  //
  // ⚠️ 这条分流必须靠 pointerType 隔离，不能改成「所有人都要点两次」——
  //    那会让桌面玩家觉得点不动。pointerType 缺失时（老浏览器）一律当鼠标，
  //    即退回原来的行为，不会把桌面搞坏。
  //
  // ── 拖动阈值为什么按指针类型分开 ──────────────────────────
  //
  // 6px 对鼠标刚好（桌面手很稳），但手指落点抖动普遍比鼠标大，
  // 6px 会把「想点格子但滑了一下」误判成拖动 → 点击被静默吞掉，
  // 玩家只会觉得「点了没反应」。所以触屏放宽到 12px。
  // 12px 仍然远小于一个格子（格子 ≈ 60px 宽），不会把「明显想拖」当点击。

  /** 指针是否属于「没有 hover」的一类。缺失 pointerType 时当鼠标。 */
  const isTouchLike = (type) => type === 'touch' || type === 'pen';

  function bindInput(dom, camera, getCamera) {
    let downX = 0, downY = 0, dragging = false;
    let downType = 'mouse';

    const DRAG_MOUSE = 6;    // 桌面：沿用原来的阈值
    const DRAG_TOUCH = 12;   // 触屏：手指抖动更大，放宽

    /**
     * 点亮某一格、熄灭其余格。抽成一个函数是因为现在有两个入口
     * （pointermove 与触屏的 pointerdown），两处必须用完全一样的视觉，
     * 否则「按下时亮的」和「hover 时亮的」会不一致。
     */
    function applyHover(cell) {
      hoverCell = cell;
      for (const m of terrain.cells) {
        const ud = m.userData;
        const on = cell && ud.col === cell.col && ud.row === cell.row;
        m.material.emissiveIntensity = ud.isBed ? 0.5 : (on ? 1.1 : 0.22);
      }
    }

    /** 屏幕坐标 → 格子 → 点亮（相机每次现取，和原实现一致） */
    function hoverAt(clientX, clientY) {
      const cam = getCamera ? getCamera() : camera;
      applyHover(pickCell(clientX, clientY, cam, dom));
    }

    dom.addEventListener('pointermove', (ev) => {
      // 触屏拖动时 pointermove 也会跟着手指走，预览自然跟随，正好。
      hoverAt(ev.clientX, ev.clientY);
    });

    dom.addEventListener('pointerdown', (ev) => {
      downX = ev.clientX; downY = ev.clientY; dragging = false;
      downType = ev.pointerType || 'mouse';
      // 触屏：按下就先预览。这样玩家在抬手之前就能看清「会造在哪一格」，
      // 幽灵塔也会出现在这一格（setGhost 的跟随逻辑复用 hoverCell）。
      if (isTouchLike(downType)) hoverAt(ev.clientX, ev.clientY);
    });

    // 长按在画布上会弹系统菜单 / 触发文本选择，这纯属干扰（桌面右键也没绑定
    // 任何功能）。直接吞掉，是触屏「长按不弹菜单」的 JS 侧保障；
    // CSS 侧的 -webkit-touch-callout / user-select 由外壳负责。
    dom.addEventListener('contextmenu', (ev) => ev.preventDefault());

    dom.addEventListener('pointerup', (ev) => {
      // 以抬起事件自带的类型为准，拿不到再退回按下时记录的类型
      const type = ev.pointerType || downType || 'mouse';
      const touch = isTouchLike(type);
      const limit = touch ? DRAG_TOUCH : DRAG_MOUSE;

      if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > limit) {
        // 拖动 = 平移/查看，不算点击。触屏还要顺手清掉预览，
        // 否则手指离开后高亮会「粘」在最后一格上。
        if (touch) applyHover(null);
        return;
      }

      const cam = getCamera ? getCamera() : camera;
      const cell = pickCell(ev.clientX, ev.clientY, cam, dom);
      if (cell) {
        const buildType = opts.getBuildType && opts.getBuildType();
        if (buildType) {
          // 建造模式：点空格 = 造塔
          const existing = gb.grid[cell.row * COLS + cell.col];
          if (existing) select(existing);            // 点到已有的塔 → 当选中处理
          else tryBuild(buildType, cell.col, cell.row);
        } else {
          // 选择模式：点已有塔 = 选中，点空地 = 取消
          select(gb.grid[cell.row * COLS + cell.col] || null);
        }
      }

      // 触屏抬手后清掉预览：屏幕上没有光标，「一直亮着」会让玩家
      // 分不清哪一格才是当前目标。鼠标不清 —— 它的 hover 本来就该保留。
      if (touch) applyHover(null);
    });

    // 系统打断（来电、系统手势返回…）→ 清掉预览，别留下一个假高亮
    dom.addEventListener('pointercancel', () => { applyHover(null); });
  }

  return {
    views, selRing, rangeRing,
    sync, updateViews, bindInput, setGhost, rebuildViews,
    tryBuild, upgradeSelected, branchSelected, sellSelected, select,
    pickCell, cellFree,
    get selected() { return selected; },
    get ghostType() { return ghostType; },
    /** 选中塔的面板数据（供 HUD 渲染，避免 HUD 自己算） */
    selectedInfo() {
      if (!selected) return null;
      const b = selected;
      const s = bstat(b, gb);
      const uc = upgradeCost(b.def, b.level, gb.diff && gb.diff.eff);
      return {
        type: b.type, name: b.def.name, icon: b.def.icon,
        level: b.level, maxLv: b.def.maxLv,
        branch: b.branch, canBranch: b.level >= BRANCH_AT && !b.branch,
        branchAt: BRANCH_AT, branches: b.def.branch,
        hp: b.hp, maxHp: b.maxHp,
        stat: s,
        // ⚠️ statText 的签名是 (s) —— 吃的是**算好的面板对象**，
        //    不是 (level, branch)。它内部会读 s.dmg / s.rate / s.range，
        //    所以这里必须传 bstat() 的结果。
        statText: b.def.statText ? b.def.statText(s) : '',
        upgrade: uc,
        sell: Math.round((b.invested || 0) * SELL_RATE),
      };
    },
  };
}

export { BUILD_KEYS, TOWER_KEYS };
