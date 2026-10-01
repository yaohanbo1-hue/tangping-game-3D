// ============================================================
//  fx.js —— 表现层：把规则层的 fx 回调画成 Three.js 的东西
// ============================================================
//
// rules/combat.js 通过一组回调「点菜」：
//
//   fx.text(x, y, s, color, big)      飘字
//   fx.parts(x, y, n, color, spd, life) 粒子爆发
//   fx.shake(power)                   震屏
//   fx.effect({ type, ... })          几何特效（激光/电弧/环/爆炸）
//   fx.sfx(name)                      音效
//   fx.hitStop(sec)                   命中停顿（时间缩放）
//
// 本文件把这六种都实现出来。
//
// ── 坐标换算只在这里做一次 ────────────────────────────────
//
// ⚠️ 规则层发出来的 x/y 是**逻辑像素**（0-1280 / 0-720），
//    这里统一乘 UNIT 变米。别在别处再乘一次。
//
// ── 关于「飘字」为什么也放在 3D 里 ──────────────────────────
//
// 2D 版的飘字是画在 canvas 上的。3D 这边有两条路：
//   (a) 用 DOM 元素浮在 canvas 上方（简单、清晰）
//   (b) 用 Three.js 的 Sprite + CanvasTexture（真正的空间字）
//
// 选 (b)：因为塔防里「伤害数字从敌人头上冒出来」是重要的空间信息，
// 如果做成屏幕空间，敌人走到哪玩家都得重新找对应关系。
// Sprite 跟随世界坐标，缩放和遮挡都自然。
// 代价是每个数字一个 sprite —— 所以池化了，别每帧 new。
// ============================================================

import * as THREE from 'three';
import { UNIT, WORLD_D } from './world.js';
import { makeFx } from './rules/combat.js';

const MAX_TEXTS = 40;
const MAX_PARTS = 600;
const MAX_EFFECTS = 48;

/** 逻辑像素 → 世界米 */
const w = (px) => px * UNIT;

// ─── 飘字：用 canvas 画一张贴图，再贴到 Sprite 上 ─────────────

const TEXT_CANVAS_W = 128;
const TEXT_CANVAS_H = 64;

function makeTextSprite() {
  const cv = document.createElement('canvas');
  cv.width = TEXT_CANVAS_W;
  cv.height = TEXT_CANVAS_H;
  const ctx2d = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(w(90), w(45), 1);
  sp.visible = false;
  sp.renderOrder = 20;
  return { sp, cv, ctx2d, tex };
}

function drawText(o, str, color, big) {
  const { cv, ctx2d, tex } = o;
  ctx2d.clearRect(0, 0, cv.width, cv.height);
  const size = big ? 34 : 26;
  ctx2d.font = `700 ${size}px "Segoe UI", "Microsoft YaHei", sans-serif`;
  ctx2d.textAlign = 'center';
  ctx2d.textBaseline = 'middle';
  // 描边让数字在任何背景上都读得出来
  ctx2d.lineWidth = 5;
  ctx2d.strokeStyle = 'rgba(4,6,14,0.9)';
  ctx2d.strokeText(str, cv.width / 2, cv.height / 2);
  ctx2d.fillStyle = color || '#ffffff';
  ctx2d.fillText(str, cv.width / 2, cv.height / 2);
  tex.needsUpdate = true;
}

// ─── 主工厂 ────────────────────────────────────────────────

/**
 * @param {THREE.Scene} scene
 * @param {object} [opts] { onShake(power), onSfx(name), onHitStop(sec) }
 * @returns {object} fx 对象 + 每帧的 update(dt) + 统计
 */
export function createFxLayer(scene, opts = {}) {
  // ══ 飘字池 ══
  const textPool = [];
  for (let i = 0; i < MAX_TEXTS; i++) {
    const o = makeTextSprite();
    o.life = 0; o.maxLife = 0; o.vy = 0;
    scene.add(o.sp);
    textPool.push(o);
  }
  let textCursor = 0;

  // ══ 粒子池：一个 Points 装所有粒子，只是每帧重写 position ══
  const partPos = new Float32Array(MAX_PARTS * 3);
  const partCol = new Float32Array(MAX_PARTS * 3);
  const partGeo = new THREE.BufferGeometry();
  partGeo.setAttribute('position', new THREE.BufferAttribute(partPos, 3));
  partGeo.setAttribute('color', new THREE.BufferAttribute(partCol, 3));
  const partMat = new THREE.PointsMaterial({
    size: w(7), vertexColors: true, transparent: true, opacity: 0.95,
    depthWrite: false, sizeAttenuation: true,
  });
  const points = new THREE.Points(partGeo, partMat);
  points.frustumCulled = false;
  points.renderOrder = 15;
  scene.add(points);

  /** 粒子状态（与 GPU buffer 分离，方便做物理） */
  const parts = new Array(MAX_PARTS);
  for (let i = 0; i < MAX_PARTS; i++) parts[i] = { alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, r: 1, g: 1, b: 1 };
  let partCursor = 0;
  let liveParts = 0;

  // ══ 几何特效池（激光线 / 电弧 / 冲击环 / 爆炸球）══
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const fxPool = [];
  const ringGeo = new THREE.RingGeometry(0.5, 0.62, 28);
  const sphereGeo = new THREE.SphereGeometry(0.5, 12, 10);

  function makeEffectMesh(kind) {
    let mesh;
    if (kind === 'line') {
      const g = lineGeo.clone();
      mesh = new THREE.Line(g, new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }));
    } else if (kind === 'ring') {
      mesh = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
      }));
      mesh.rotation.x = -Math.PI / 2;   // 平铺在 XZ 平面上
    } else {
      mesh = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
    }
    mesh.visible = false;
    mesh.renderOrder = 18;
    scene.add(mesh);
    return mesh;
  }

  const LINE_POOL = 16, RING_POOL = 12, BOOM_POOL = 12;
  const lines = Array.from({ length: LINE_POOL }, () => makeEffectMesh('line'));
  const rings = Array.from({ length: RING_POOL }, () => makeEffectMesh('ring'));
  const booms = Array.from({ length: BOOM_POOL }, () => makeEffectMesh('boom'));
  let lineCursor = 0, ringCursor = 0, boomCursor = 0;

  // ══ 震屏状态（由外部读到 camera 上）══
  let shakePower = 0;
  let hitStopT = 0;

  // ══ 粒子发射 ══
  function emitParts(x, y, n, colorHex, spd, life) {
    const c = new THREE.Color(colorHex || '#ffffff');
    for (let i = 0; i < n; i++) {
      const p = parts[partCursor];
      partCursor = (partCursor + 1) % MAX_PARTS;
      p.alive = true;
      p.x = w(x); p.y = w(14); p.z = w(y);
      const a = Math.random() * Math.PI * 2;
      const s = (spd || 2) * (0.4 + Math.random() * 0.9);
      p.vx = Math.cos(a) * s * UNIT * 22;
      p.vz = Math.sin(a) * s * UNIT * 22;
      p.vy = (0.8 + Math.random() * 1.8) * UNIT * 22;
      p.life = p.maxLife = (life || 0.5) * (0.7 + Math.random() * 0.6);
      p.r = c.r; p.g = c.g; p.b = c.b;
    }
  }

  // ══ 特效发射 ══
  function emitEffect(e) {
    if (!e) return;
    const p = { x: w(e.x || 0), z: w(e.y || 0) };
    if (e.type === 'laser' || e.type === 'arc') {
      const m = lines[lineCursor]; lineCursor = (lineCursor + 1) % LINE_POOL;
      const pos = m.geometry.attributes.position;
      pos.setXYZ(0, w(e.x), w(30), w(e.y));
      pos.setXYZ(1, w(e.x2 || e.x), w(30), w(e.y2 || e.y));
      pos.needsUpdate = true;
      m.geometry.computeBoundingSphere();
      m.material.color.set(e.color || '#67e8f9');
      m.material.opacity = 1;
      m.userData.life = m.userData.maxLife = e.maxLife || 0.18;
      m.visible = true;
    } else if (e.type === 'ring') {
      const m = rings[ringCursor]; ringCursor = (ringCursor + 1) % RING_POOL;
      m.position.set(p.x, w(6), p.z);
      m.scale.setScalar(0.01);
      m.material.color.set(e.color || '#f0abfc');
      m.material.opacity = 0.85;
      m.userData.targetR = w(e.r || 200);
      m.userData.life = m.userData.maxLife = e.maxLife || 0.3;
      m.visible = true;
    } else if (e.type === 'boom') {
      const m = booms[boomCursor]; boomCursor = (boomCursor + 1) % BOOM_POOL;
      m.position.set(p.x, w(16), p.z);
      m.scale.setScalar(w(e.r || 40));
      m.material.color.set(e.color || '#ff9a3c');
      m.material.opacity = 0.7;
      m.userData.life = m.userData.maxLife = e.maxLife || 0.3;
      m.visible = true;
    }
  }

  // ══ fx 回调组 ══
  const fx = makeFx({
    text(x, y, s, color, big) {
      const o = textPool[textCursor];
      textCursor = (textCursor + 1) % MAX_TEXTS;
      drawText(o, String(s), color, big);
      // 数字带一点随机横向偏移，密集击杀时不会完全重叠
      o.sp.position.set(w(x) + (Math.random() - 0.5) * w(8), w(58), w(y));
      o.sp.material.opacity = 1;
      o.sp.visible = true;
      o.life = o.maxLife = big ? 1.1 : 0.8;
      o.vy = w(52);
    },
    parts: emitParts,
    shake(power) {
      shakePower = Math.max(shakePower, power || 3);
      if (opts.onShake) opts.onShake(power);
    },
    effect: emitEffect,
    sfx(name) { if (opts.onSfx) opts.onSfx(name); },
    hitStop(sec) { hitStopT = Math.max(hitStopT, sec || 0); },
  });

  // ══ 每帧推进（表现层自己也有时间，与逻辑帧无关）══
  let t = 0;
  function update(dt) {
    t += dt;
    dt = Math.min(dt, 0.05);

    // 飘字：上浮 + 淡出
    for (const o of textPool) {
      if (o.life <= 0) continue;
      o.life -= dt;
      if (o.life <= 0) { o.sp.visible = false; continue; }
      o.sp.position.y += o.vy * dt;
      const k = Math.max(0, o.life / o.maxLife);
      o.sp.material.opacity = k > 0.7 ? 1 : k / 0.7;
    }

    // 粒子
    liveParts = 0;
    for (let i = 0; i < MAX_PARTS; i++) {
      const p = parts[i];
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; continue; }
      p.vy -= 9.8 * UNIT * 26 * dt;   // 一点重力，让火星落下来
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < w(6)) { p.y = w(6); p.vy *= -0.35; p.vx *= 0.7; p.vz *= 0.7; }
      const k = p.life / p.maxLife;
      const idx = liveParts++;
      partPos[idx * 3] = p.x; partPos[idx * 3 + 1] = p.y; partPos[idx * 3 + 2] = p.z;
      partCol[idx * 3] = p.r * k; partCol[idx * 3 + 1] = p.g * k; partCol[idx * 3 + 2] = p.b * k;
    }
    partGeo.setDrawRange(0, liveParts);
    partGeo.attributes.position.needsUpdate = true;
    partGeo.attributes.color.needsUpdate = true;

    // 特效
    for (const m of lines) {
      if (!m.visible) continue;
      m.userData.life -= dt;
      if (m.userData.life <= 0) { m.visible = false; continue; }
      m.material.opacity = m.userData.life / m.userData.maxLife;
    }
    for (const m of rings) {
      if (!m.visible) continue;
      m.userData.life -= dt;
      if (m.userData.life <= 0) { m.visible = false; continue; }
      const k = 1 - m.userData.life / m.userData.maxLife;
      m.scale.setScalar(Math.max(0.01, m.userData.targetR * k));
      m.material.opacity = 0.85 * (1 - k);
    }
    for (const m of booms) {
      if (!m.visible) continue;
      m.userData.life -= dt;
      if (m.userData.life <= 0) { m.visible = false; continue; }
      const k = 1 - m.userData.life / m.userData.maxLife;
      m.scale.setScalar(Math.max(0.01, m.userData.target || 1) * (0.5 + k * 0.8));
      m.material.opacity = 0.7 * (1 - k);
    }

    // 震屏衰减
    if (shakePower > 0) shakePower = Math.max(0, shakePower - dt * 26);
    if (hitStopT > 0) hitStopT = Math.max(0, hitStopT - dt);
  }

  return {
    fx,
    update,
    /** 当前震屏强度（像素量级，外部自己决定怎么用） */
    get shake() { return shakePower; },
    /** 命中停顿剩余时间（秒）。>0 时逻辑层可以放慢 */
    get hitStop() { return hitStopT; },
    stats() { return { liveParts, texts: textPool.filter((o) => o.life > 0).length }; },
  };
}
