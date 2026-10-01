// ============================================================
//  sim.js —— 最小敌人模拟（复用第 1 步的抽象，零像素硬编码）
// ============================================================
//
// 这一步**不引入 core.js**（那是第 4 步的事）。这里手写一个最小状态机，
// 目的是证明第 1 步的「去像素化」成果是真的可用：
//
//   · 敌人的位置真值只有 lane + progress
//   · 移动 = progress += progressSpeed(speed) * dt
//   · 3D 坐标完全由 enemyWorldPos3D() 派生，模拟层不碰 x/z
//
// 如果这段代码写得很顺（没出现任何「像素」字样），就说明第 1 步的
// 抽象方向是对的；第 4 步接 core.js 时只是把这个函数换掉而已。
//
// 行为对照 2D 版的 walk 状态机（core.js ~1137 行的普通敌人分支）：
//   walking  : progress 0→1，门在 progress=1 处
//   knocking : 抵达门后停下敲门（2D 版是撞门扣耐久）
//   breached : 敲门足够久 → 门破，进房间（3D 版先只标记状态）
// ============================================================

import { LANES, progressSpeed, enemyWorldPos3D } from './world.js';

export const WALK_SPEED = 42;      // 逻辑像素/秒（约合 2D 版的普通杂兵）
export const KNOCK_TIME = 2.4;     // 敲门多久破门（秒）
export const MAX_ALIVE = 24;

let nextId = 1;

/**
 * 创建一个敌人。注意：**没有 x/y 字段**——这是本次迁移的核心成果。
 */
export function makeEnemy(lane, opts = {}) {
  return {
    id: nextId++,
    lane: lane % LANES.length,
    progress: 0,
    speed: opts.speed ?? WALK_SPEED,
    hp: opts.hp ?? 100,
    maxHp: opts.hp ?? 100,
    state: 'walking',   // walking | knocking | breached
    knockT: 0,
    color: opts.color ?? 0x9ef01a,
    bobPhase: Math.random() * Math.PI * 2, // 走路上下起伏的相位
  };
}

/**
 * 推进一个敌人一帧。纯逻辑，不碰渲染对象。
 */
export function stepEnemy(e, dt, world) {
  if (e.state === 'walking') {
    e.progress = Math.min(1, e.progress + progressSpeed(e.speed) * dt);
    if (e.progress >= 1) {
      e.state = 'knocking';
      e.knockT = 0;
      if (world) world.doorHits++;
    }
  } else if (e.state === 'knocking') {
    e.knockT += dt;
    // 敲门时不推进 progress，门在 progress=1（即 WALL_X - APPROACH 处）
    if (e.knockT >= KNOCK_TIME) {
      e.state = 'breached';
      e.progress = 1;
      if (world) world.breaches++;
    }
  }
  // breached 之后暂时不动（第 4 步再接房间内的行进）
}

/** 取敌人当前的世界坐标（给渲染层用）。 */
export function enemyPos(e) {
  return enemyWorldPos3D(e, e.progress);
}

// ─── 世界状态（3D 侧自己的，与 2D 的 G 无关）───────────────────

export function createWorld() {
  return {
    time: 0,
    enemies: [],
    spawnTimer: 0,
    /** 出怪间隔（秒）。设为 0 或负数即关闭自动出怪（测试与「静场」模式用）。 */
    spawnInterval: 1.6,
    spawned: 0,
    doorHits: 0,
    breaches: 0,
    cursor: 0,
  };
}

/**
 * 逐步推进整个世界。这一帧只出让逻辑，不负责出怪节奏之外的任何表现。
 */
export function stepWorld(world, dt) {
  world.time += dt;

  // 出怪节奏：三条车道轮转。
  // ⚠️ cursor 只在**自动出怪**时推进 —— 手动 spawn 不碰它，
  //    否则两条推进路径会互相插队，导致某条车道永远轮不到。
  //
  // ⚠️ 用 spawnInterval > 0 作为「自动出怪开关」。
  //    不能靠把 spawnInterval 设成巨大值来禁用 ——
  //    spawnTimer 初值是 0，第一帧必然触发一次出怪，
  //    测试里就会莫名其妙多出一只敌人（曾导致断言不稳定地 1/2 跳动）。
  if (world.spawnInterval > 0) {
    world.spawnTimer -= dt;
    if (world.spawnTimer <= 0 && world.enemies.length < MAX_ALIVE) {
      world.spawnTimer = world.spawnInterval;
      world.enemies.push(makeEnemy(world.cursor % LANES.length, {
        color: [0x9ef01a, 0x7fdfff, 0xff5d8f][world.cursor % 3],
        speed: WALK_SPEED * (0.85 + Math.random() * 0.3),
      }));
      world.cursor++;
      world.spawned++;
    }
  }

  for (const e of world.enemies) stepEnemy(e, dt, world);

  // 已破门的移出（第 4 步改成进房间继续走）
  world.enemies = world.enemies.filter((e) => e.state !== 'breached');
  return world.enemies;
}
