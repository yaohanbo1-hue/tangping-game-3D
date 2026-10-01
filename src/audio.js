// ============================================================
//  audio.js —— 音效系统（WebAudio 合成，零外部资产）
// ============================================================
//
// ── 为什么用合成而不是音频文件 ─────────────────────────────
//
//   1. 这个项目**没有**经过音频资产管线，硬盘里没有一个 mp3/ogg。
//   2. 塔防的音效是**高频、短促、需要随机微扰**的（同一种开火声
//      连响 20 次不能听着像机器人）。合成天然支持每次微调音高/包络。
//   3. 加载 20 个音频文件要处理 CORS / 解码 / 首次交互解锁，
//      而合成只需要一个 AudioContext。
//
// ── 这个模块的职责 ────────────────────────────────────────
//
//   · 提供 fx.sfx(name) 需要的音效播放能力（40 个音效名）
//   · 提供深层梦境的**氛围音**（低频嗡鸣，按深度递进）
//   · 提供**秘密旋律**彩蛋（SOUND_MELODIES 的建筑点击序列）
//   · 处理浏览器的自动播放限制（首次用户手势才 resume）
//
// ⚠️ 合成音很容易做得很刺耳。这里的每个音都做了三件事：
//    · 用正弦/三角波而非方波（方波在短促音里特别扎）
//    · 指数衰减包络（而不是突然静音 —— 那会有咔哒声）
//    · 高频音压低音量（人耳对 2kHz+ 更敏感）
//
// ⚠️ 关于 SOUND_MELODIES 的一个**踩过的坑**（写在这里防止后来人重踩）：
//    它的 `sequence` 字段看起来像音符序列（['bed','repair','shield']），
//    但里面装的是**建筑 key**，不是频率。它是「连续点击这几座建筑
//    就解锁奖励」的彩蛋定义，既没有 freq 也没有 bpm。
//    第一版 setAmbient 就是照音符去解析它，结果拿到一堆 null。
//    正确做法见下面 tapBuild()。
// ============================================================

/**
 * @param {object} opts
 *   enabled  —— 初始是否开启
 *   volume   —— 主音量 0-1
 */
export function createAudio({ enabled = true, volume = 0.35 } = {}) {
  /** @type {AudioContext|null} */
  let ctx = null;
  let master = null;
  let ambientGain = null;
  let on = enabled;
  /**
   * 「音频通道已建立」的闩锁。语义是**至少成功创建过 AudioContext 并
   * 发起过解锁**，不代表此刻正在出声 —— 此刻的状态请看 `running` / `suspended`。
   * 保留这个语义是为了向后兼容（外部脚本/验收会读它）。
   */
  let unlocked = false;
  let lifecycleWired = false;
  let resuming = false;
  let lastStateResume = 0;

  /** 最近播放过的音效名与时间（用于节流：同一种音效 40ms 内不重复） */
  const lastPlayed = new Map();
  const THROTTLE_MS = 40;
  /** 常驻手势监听（dispose 时要摘掉） */
  const gestureListeners = [];

  function ensure() {
    if (ctx) return ctx;
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = on ? volume : 0;
      master.connect(ctx.destination);
      ambientGain = ctx.createGain();
      ambientGain.gain.value = 0;
      ambientGain.connect(master);

      // 状态又变成 suspended（锁屏 / 来电 / 系统回收音频通道）时，
      // 主动尝试恢复 —— 这是「静默失效」的最后一道兜底。
      // 带 1 秒节流，避免 resume 反复失败时在 statechange 上打转。
      ctx.addEventListener('statechange', () => {
        if (!ctx || ctx.state !== 'suspended') return;
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        const now = (globalThis.performance || Date).now();
        if (now - lastStateResume < 1000) return;
        lastStateResume = now;
        resumeIfNeeded();
      });
    } catch (e) {
      console.warn('[audio] AudioContext 创建失败，音效将不可用:', e);
      ctx = null;
    }
    return ctx;
  }

  /**
   * 尝试把 AudioContext 从 suspended 拉回 running。
   *
   * ⚠️ 这是「重新解锁」的唯一入口，必须**幂等**、可被反复调用：
   *    iOS 上 AudioContext 会在切后台 / 锁屏 / 来电后**再次被挂起**，
   *    而且**不会报错** —— 玩家回到游戏后就是静音，且没有任何异常可查。
   *    所以「回到前台」「状态又变 suspended」「下一次用户手势」都要能再走一次这里。
   *
   * ⚠️ 关于 `unlocked` 标志是否会导致提前 return（曾经被怀疑的静默失效点）：
   *    **不成立**。这里从头到尾没有 `if (unlocked) return` 这种短路；
   *    旧版 unlock() 也只是「state==='suspended' 就 resume」，同样不读 unlocked。
   *    真正的失效在**调用侧**：main.js 的解锁监听是**一次性**的
   *    （unlock 后立即 removeEventListener），所以 ctx 第二次被挂起时
   *    再没有任何人会调 unlock()。本模块现在自带生命周期监听
   *    （见 wireLifecycle），把那个缺口补上了。
   */
  function resumeIfNeeded() {
    const c = ensure();
    if (!c) return false;
    wireLifecycle();
    if (c.state === 'running') { unlocked = true; return true; }
    if (c.state === 'suspended' && !resuming) {
      resuming = true;
      Promise.resolve(c.resume())
        .then(() => { resuming = false; if (c.state === 'running') unlocked = true; })
        .catch(() => { resuming = false; });
    }
    return true;
  }

  /**
   * 挂载「自动重新解锁」的生命周期监听（只挂一次）。
   *
   *   1) visibilitychange → 回到可见：立刻 resume（iOS 切后台会挂起 ctx）
   *   2) 常驻手势兜底：iOS **只允许在用户手势里** resume。
   *      监听不能像调用侧那样一次性移除 —— 否则第二次被挂起后，
   *      再也不会有手势触发解锁。这里保留到 dispose()。
   */
  function wireLifecycle() {
    if (lifecycleWired) return;
    lifecycleWired = true;

    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') resumeIfNeeded();
      });
    }

    if (typeof globalThis.addEventListener === 'function') {
      const onGesture = () => { if (ctx && ctx.state !== 'running') resumeIfNeeded(); };
      for (const ev of ['pointerdown', 'touchend', 'keydown']) {
        globalThis.addEventListener(ev, onGesture, { passive: true });
        gestureListeners.push([ev, onGesture]);
      }
    }
  }

  /**
   * 浏览器要求音频必须在**用户手势**之后才能播放。
   * 首次点击/按键时调它解锁；后续被系统重新挂起时，本模块会自行恢复。
   */
  function unlock() {
    const c = ensure();
    if (!c) return false;
    unlocked = true;
    resumeIfNeeded();
    return true;
  }

  // ══════════════════════════════════════════════════════════
  //  基础音色：一个短促的「振荡器 + 指数衰减包络」
  // ══════════════════════════════════════════════════════════

  /**
   * @param {object} o
   *   freq     起始频率
   *   freq2    结束频率（滑音，省略则不变）
   *   dur      时长（秒）
   *   type     波形
   *   gain     峰值音量
   *   delay    延迟播放（秒）
   *   dest     目标节点（默认 master）
   */
  function tone({ freq, freq2, dur = 0.12, type = 'triangle', gain = 0.3, delay = 0, dest }) {
    const c = ensure();
    if (!c || !on) return;
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freq2 && freq2 !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq2), t0 + dur);
    // 指数衰减：起音 3ms 到峰值，然后指数落到近似 0
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(dest || master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** 噪声爆（爆炸 / 破门 / 命中）—— 用一个极短的白噪声缓冲 */
  function noise({ dur = 0.18, gain = 0.25, filter = 1200, delay = 0, q = 1 }) {
    const c = ensure();
    if (!c || !on) return;
    const t0 = c.currentTime + delay;
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      // 越往后振幅越小（噪声自带的衰减，配合包络更自然）
      data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    const bq = c.createBiquadFilter();
    bq.type = 'lowpass';
    bq.frequency.value = filter;
    bq.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bq); bq.connect(g); g.connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  // ══════════════════════════════════════════════════════════
  //  音效表 —— 名字对应 rules/combat.js 里调 fx.sfx(name) 的名字
  // ══════════════════════════════════════════════════════════

  const SFX = {
    // ── 建造 / 升级 ──
    build()      { tone({ freq: 320, freq2: 620, dur: 0.14, type: 'triangle', gain: 0.26 }); },
    upgrade()    { tone({ freq: 440, freq2: 880, dur: 0.18, type: 'triangle', gain: 0.24 });
                   tone({ freq: 660, freq2: 1320, dur: 0.16, type: 'sine', gain: 0.14, delay: 0.06 }); },
    sell()       { tone({ freq: 520, freq2: 260, dur: 0.14, type: 'sine', gain: 0.2 }); },

    // ── 开火（按塔种区分音色）──
    shoot()      { tone({ freq: 720 + Math.random() * 80, freq2: 380, dur: 0.055, type: 'square', gain: 0.09 }); },
    laser()      { tone({ freq: 1500, freq2: 700, dur: 0.07, type: 'sawtooth', gain: 0.07 }); },
    tesla()      { noise({ dur: 0.09, gain: 0.13, filter: 3200 }); },
    frost()      { tone({ freq: 1100, freq2: 1600, dur: 0.1, type: 'sine', gain: 0.09 }); },
    flame()      { noise({ dur: 0.22, gain: 0.15, filter: 700 }); },
    missile()    { tone({ freq: 200, freq2: 620, dur: 0.2, type: 'sawtooth', gain: 0.13 }); },
    cannon()     { tone({ freq: 150, freq2: 70, dur: 0.16, type: 'square', gain: 0.16 }); },

    // ── 命中 ──
    hit()        { tone({ freq: 300 + Math.random() * 60, freq2: 180, dur: 0.045, type: 'triangle', gain: 0.08 }); },
    crit()       { tone({ freq: 900, freq2: 1400, dur: 0.07, type: 'sine', gain: 0.14 }); },

    // ── 击杀 / 破门 ──
    kill()       { tone({ freq: 420, freq2: 200, dur: 0.1, type: 'triangle', gain: 0.13 }); },
    boss()       { tone({ freq: 120, freq2: 60, dur: 0.5, type: 'sawtooth', gain: 0.22 });
                   noise({ dur: 0.45, gain: 0.22, filter: 420 }); },
    doorBreak()  { noise({ dur: 0.5, gain: 0.3, filter: 900 });
                   tone({ freq: 180, freq2: 60, dur: 0.4, type: 'square', gain: 0.18 }); },

    // ── 经济 / 波次 ──
    coin()       { tone({ freq: 980, freq2: 1480, dur: 0.08, type: 'sine', gain: 0.12 }); },
    waveStart()  { tone({ freq: 260, freq2: 520, dur: 0.28, type: 'triangle', gain: 0.2 });
                   tone({ freq: 390, freq2: 780, dur: 0.32, type: 'sine', gain: 0.12, delay: 0.1 }); },
    waveClear()  { [0, 1, 2].forEach((i) => tone({ freq: 523 * Math.pow(1.26, i), dur: 0.16, type: 'sine', gain: 0.14, delay: i * 0.08 })); },

    // ── 失败 / 胜利 ──
    gameOver()   { tone({ freq: 300, freq2: 70, dur: 1.1, type: 'sawtooth', gain: 0.22 }); },
    victory()    { [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.4, type: 'sine', gain: 0.16, delay: i * 0.14 })); },

    // ── 剧情 ──
    dialog()     { tone({ freq: 620, freq2: 780, dur: 0.07, type: 'sine', gain: 0.1 }); },
    chapter()    { [392, 523, 659].forEach((f, i) => tone({ freq: f, dur: 0.5, type: 'sine', gain: 0.12, delay: i * 0.16 })); },
    lore()       { tone({ freq: 880, freq2: 1170, dur: 0.2, type: 'sine', gain: 0.1 }); },
    fragment()   { [784, 1047, 1319].forEach((f, i) => tone({ freq: f, dur: 0.22, type: 'sine', gain: 0.1, delay: i * 0.07 })); },
  };

  /**
   * 播放一个音效。
   * ⚠️ 做了节流：同一种音效 40ms 内不重复播放。
   *    塔防里 20 座塔同帧开火会产生 20 次调用 —— 不节流的话
   *    声音会叠成一坨噪音，而且 AudioContext 会被大量振荡器压垮。
   */
  function sfx(name) {
    if (!on) return;
    const c = ensure();
    if (!c) return;
    const now = (globalThis.performance || Date).now();
    const last = lastPlayed.get(name) || 0;
    if (now - last < THROTTLE_MS) return;
    lastPlayed.set(name, now);
    const fn = SFX[name];
    if (fn) fn();
  }

  // ══════════════════════════════════════════════════════════
  //  氛围音：深层梦境的低频嗡鸣
  // ══════════════════════════════════════════════════════════
  //
  // ⚠️ 这里刻意**不用** SOUND_MELODIES 当环境音 —— 我一开始就是那么写的，
  //    结果发现理解错了数据：SOUND_MELODIES 的 `sequence` 不是音符，
  //    是**建筑 key 的点击顺序**（['bed','repair','shield'] 之类），
  //    它描述的是一段「秘密旋律」的弹奏方式（连续点这几座塔就解锁奖励）。
  //    它既没有频率也没有 bpm，喂给振荡器只会得到 null。
  //
  //    所以环境音另走一条路：**按梦境深度生成低频嗡鸣**，
  //    与 2D 引擎 DreamSound.setAmbient(depth) 的做法保持一致
  //    （baseFreq = 60 - depth*10，gain = 0.03 + depth*0.015）。
  //    2D 那边是「一个持续振荡器」；这里做了一点增强：叠两个相差
  //    几赫兹的振荡器产生**拍频**，听起来是缓慢起伏的呼吸感，
  //    比单音更像「梦」而不像「设备故障」。

  let ambientNodes = null;
  let ambientDepth = 0;

  function stopAmbientNode() {
    if (!ambientNodes) return;
    try { ambientNodes.oscA.stop(); } catch (e) {}
    try { ambientNodes.oscB.stop(); } catch (e) {}
    ambientNodes = null;
  }

  /**
   * 切换氛围音深度。
   * @param {number} depth 0 = 浅层（静音），1/2/3 = 逐层加深
   */
  function setAmbient(depth) {
    const d = Math.max(0, Math.min(3, depth | 0));
    ambientDepth = d;
    const c = ensure();
    if (!c || !on) { stopAmbientNode(); return; }
    if (!ambientGain) return;

    stopAmbientNode();
    if (d === 0) return;   // 浅层不播放 —— 与 2D 一致

    const baseFreq = 60 - d * 10;          // 50 / 40 / 30 Hz
    const level = 0.03 + d * 0.015;        // 0.045 / 0.06 / 0.075

    const mk = (freq, gain, type) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, ctx.currentTime);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      // 渐入 —— 突然出现一个低频会吓人一跳
      g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + 1.6);
      o.connect(g); g.connect(ambientGain);
      o.start();
      return o;
    };

    const oscA = mk(baseFreq, level, 'sine');
    // 差 0.7Hz 的第二个振荡器 → 拍频，缓慢起伏
    const oscB = mk(baseFreq + 0.7, level * 0.7, 'sine');
    ambientNodes = { oscA, oscB };
    ambientGain.gain.setTargetAtTime(1, c.currentTime, 1.2);
  }

  function stopAmbient() {
    stopAmbientNode();
    if (ambientGain && ctx) ambientGain.gain.setTargetAtTime(0, ctx.currentTime, 0.5);
    ambientDepth = 0;
  }

  // ══════════════════════════════════════════════════════════
  //  秘密旋律（SOUND_MELODIES）—— 建筑点击序列彩蛋
  // ══════════════════════════════════════════════════════════
  //
  // SOUND_MELODIES 的真正语义：玩家**连续点击某几个建筑**构成一段序列，
  // 命中就解锁奖励（每段只触发一次）。2D 引擎在 DreamSound 里实现。
  //
  // 这里把它抽出来，顺便让每一「音」都发出一个不同的音高 ——
  // 这样玩家在敲序列时有**听觉反馈**，能自己听出「我敲到第几个了」，
  // 而不是盲敲。音高用建筑序位映射到一个五声音阶，保证敲出来的
  // 任何一段都不会难听（这是唯一的设计要求：别让彩蛋变成噪音）。

  /** 五声音阶（C 大调宫商角徵羽），落在人耳舒适区 */
  const PENTATONIC = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25];

  let melodyDefs = [];
  const melodyHistory = [];
  const melodyDone = new Set();

  function setMelodies(defs) {
    melodyDefs = Array.isArray(defs)
      ? defs.filter((m) => m && Array.isArray(m.sequence) && m.sequence.length)
      : [];
    melodyHistory.length = 0;
  }

  /**
   * 记录一次建筑点击，检查是否命中某段秘密旋律。
   *
   * @param {string} buildKey  建筑 key（如 'bed' / 'turret'）
   * @returns {{id:string, name:string, sequence:string[], reward:string, rewardSpec:object|null}|null}
   *          命中时返回该旋律的定义，否则 null
   */
  function tapBuild(buildKey) {
    if (!buildKey) return null;
    melodyHistory.push(buildKey);

    // 敲击音高：用建筑 key 的稳定哈希选一个音阶音，
    // 同一个建筑每次点击音高一致（玩家能形成「这个键是这个音」的记忆）
    let h = 0;
    for (let i = 0; i < buildKey.length; i++) h = (h * 31 + buildKey.charCodeAt(i)) >>> 0;
    tone({ freq: PENTATONIC[h % PENTATONIC.length], dur: 0.22, type: 'sine', gain: 0.13 });

    // 只保留可能构成最长序列的尾部，避免 history 无限增长
    const maxLen = melodyDefs.reduce((a, m) => Math.max(a, m.sequence.length), 0) || 8;
    while (melodyHistory.length > maxLen) melodyHistory.shift();

    for (const m of melodyDefs) {
      if (melodyDone.has(m.id)) continue;
      const seq = m.sequence;
      if (melodyHistory.length < seq.length) continue;
      // 比较尾部的 seq.length 项
      const tail = melodyHistory.slice(-seq.length);
      if (tail.every((v, i) => v === seq[i])) {
        melodyDone.add(m.id);
        // 命中：一段上行琶音作为「解锁」的听觉标记
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
          tone({ freq: f, dur: 0.5, type: 'sine', gain: 0.16, delay: i * 0.11 });
        });
        return {
          id: m.id, name: m.name, sequence: seq.slice(),
          reward: m.reward || '', rewardSpec: m.rewardSpec || null,
        };
      }
    }
    return null;
  }

  /** 已触发的旋律 id（存档用） */
  function melodySnapshot() { return Array.from(melodyDone); }
  function melodyRestore(ids) {
    melodyDone.clear();
    if (Array.isArray(ids)) for (const id of ids) melodyDone.add(id);
    melodyHistory.length = 0;
  }

  return {
    sfx, unlock,
    /** 幂等的「重新解锁」入口：可反复调用，用于切后台/锁屏后恢复出声 */
    resume: resumeIfNeeded,
    setAmbient, stopAmbient,
    setMelodies, tapBuild, melodySnapshot, melodyRestore,
    get ambientDepth() { return ambientDepth; },
    get melodyDefs() { return melodyDefs; },
    get enabled() { return on; },
    setEnabled(v) {
      const was = on;
      on = !!v;
      if (ctx && master) master.gain.setTargetAtTime(on ? volume : 0, ctx.currentTime, 0.05);
      // 关掉再打开时，氛围音振荡器需要按当前深度重建 ——
      // 否则会「静音开关修好了，但环境音再也不响了」。
      if (was !== on && ambientDepth > 0) setAmbient(ambientDepth);
      return on;
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      if (ctx && master && on) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.05);
      return volume;
    },
    get volume() { return volume; },
    /** 「曾经解锁过」的闩锁（向后兼容）。实时状态请用 running / suspended。 */
    get unlocked() { return unlocked; },
    /** 此刻 AudioContext 真的在 running（这是判断「有没有声音」的真值） */
    get running() { return !!ctx && ctx.state === 'running'; },
    /** 此刻被系统挂起（切后台/锁屏后常见）—— 需要 resume() 才能恢复 */
    get suspended() { return !!ctx && ctx.state === 'suspended'; },
    /** 可用音效名列表（调试/文档用） */
    get names() { return Object.keys(SFX); },
    dispose() {
      stopAmbient();
      for (const [ev, fn] of gestureListeners) {
        try { globalThis.removeEventListener(ev, fn); } catch (e) {}
      }
      gestureListeners.length = 0;
      lifecycleWired = false;
      if (ctx) { try { ctx.close(); } catch (e) {} ctx = null; }
    },
  };
}
