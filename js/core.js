/*!
 * tim1e · core.js
 * 纯逻辑、确定性的游戏模拟（无 DOM），浏览器与 Node 共用。
 *
 * 坐标系：钟面圆心为原点，钟面半径 = 1，y 轴向下（与屏幕一致）。
 * 时间：固定步长 1/60 秒（tick）。一圈 = LOOP_TICKS 个 tick（6 秒）。
 *
 * 核心规则：
 *  - 玩家（粉色的 1）在钟面内移动，吃黄色「刻度」续「余秒」。
 *  - 每一圈结束时，这一圈的轨迹变成「回声」，此后每一圈都与指针同步重演。
 *  - 碰到已激活的回声 → 若有「备用的一秒」则自动倒带 60 tick，否则结束。
 *  - 余秒归零 → 结束。
 *  - 金色的 1：抹去最旧的回声。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Tim1eCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CFG = Object.freeze({
    TICK: 1 / 60,
    LOOP_TICKS: 360,        // 一圈 6 秒
    ARENA_R: 0.94,          // 玩家可活动半径
    SPEED: 0.95,            // 最高速度（钟面半径 / 秒）
    ACCEL: 10,              // 速度趋近系数
    PLAYER_R: 0.036,
    ECHO_R: 0.03,
    SHARD_R: 0.05,
    GOLD_R: 0.065,
    ENERGY_START: 8,
    ENERGY_MAX: 10,
    ENERGY_GAIN: 2.2,
    DRAIN_BASE: 1,
    DRAIN_GROWTH: 0.035,    // 每圈额外流逝
    DRAIN_MAX: 1.6,
    RELAXED_DRAIN: 0.6,     // 从容模式：余秒流逝倍率
    RELAXED_HIT: 0.8,       // 从容模式：判定半径倍率
    ECHO_GRACE: 45,         // 新回声的无害预告期（tick）
    REWIND_TICKS: 60,       // 倒带 1 秒
    REWIND_SPEED: 2,        // 倒带回放速度（每 tick 弹出几帧快照）
    INVULN_TICKS: 60,       // 倒带后无敌
    CHARGE_EVERY: 4,        // 每 4 圈补充备用一秒
    GOLD_EVERY: 3,          // 每 3 圈尝试刷出金色的 1
    GOLD_BONUS: 3,
    SHARD_MIN_DIST: 0.35,
    SPAWN_R: 0.82
  });
  var LOOP = CFG.LOOP_TICKS;

  /* ---------- 可复现随机数（mulberry32，状态存于 g.seed 以便倒带恢复） ---------- */
  function rand(g) {
    var t = (g.seed = (g.seed + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function createGame(opts) {
    opts = opts || {};
    var seed = opts.seed === undefined ? 20261117 : (opts.seed | 0);
    var g = {
      seed: seed,
      startSeed: seed,
      relaxed: !!opts.relaxed,
      mode: 'play',            // 'play' | 'rewind' | 'over'
      tick: 0,
      loopTick: 0,
      loopIndex: 0,
      px: 0, py: 0, vx: 0, vy: 0,
      rec: new Float32Array(LOOP * 2),   // 当前这一圈的轨迹（将成为下一个回声）
      echoes: [],                        // { id, path: Float32Array, born: loopIndex }
      echoSerial: 0,
      allPaths: [],                      // 已完成的每一圈（用于印刷品）
      shard: null,
      gold: null,
      score: 0,
      collected: 0,
      energy: CFG.ENERGY_START,
      charges: 1,
      lastChargeLoop: 0,
      invuln: 0,
      snaps: [],
      rewindLeft: 0,
      erased: 0,
      rewinds: 0,
      deathCause: null,
      deathAgo: 0,
      finalLen: 0,
      events: []
    };
    g.shard = spawnPoint(g, CFG.SHARD_MIN_DIST);
    return g;
  }

  function drainRate(g) {
    var d = Math.min(CFG.DRAIN_MAX, CFG.DRAIN_BASE + CFG.DRAIN_GROWTH * g.loopIndex);
    return g.relaxed ? d * CFG.RELAXED_DRAIN : d;
  }

  function isEchoActive(g, e) {
    return !(e.born === g.loopIndex && g.loopTick < CFG.ECHO_GRACE);
  }

  /** 在钟面内找一个离玩家足够远、也不贴着回声的位置。总会返回一个点。 */
  function spawnPoint(g, minDist) {
    var best = null, bestScore = -Infinity;
    var t = Math.min(g.loopTick, LOOP - 1);
    for (var i = 0; i < 32; i++) {
      var a = rand(g) * Math.PI * 2;
      var r = Math.sqrt(rand(g)) * CFG.SPAWN_R;
      var x = Math.cos(a) * r, y = Math.sin(a) * r;
      var dp = Math.hypot(x - g.px, y - g.py);
      var de = Infinity;
      for (var k = 0; k < g.echoes.length; k++) {
        var p = g.echoes[k].path;
        var d = Math.hypot(x - p[2 * t], y - p[2 * t + 1]);
        if (d < de) de = d;
      }
      var s = Math.min(dp / minDist, de / 0.15);
      if (s >= 1) return { x: x, y: y };
      if (s > bestScore) { bestScore = s; best = { x: x, y: y }; }
    }
    return best;
  }

  /* ---------- 移动 ---------- */
  function move(g, input) {
    var wx = 0, wy = 0, dt = CFG.TICK;
    if (input) {
      if (typeof input.dx === 'number') {
        var dx = input.dx, dy = input.dy || 0, m = Math.hypot(dx, dy);
        if (m > 1) { dx /= m; dy /= m; }
        wx = dx * CFG.SPEED; wy = dy * CFG.SPEED;
      } else if (typeof input.tx === 'number') {
        var ex = input.tx - g.px, ey = input.ty - g.py, d = Math.hypot(ex, ey);
        if (d > 1e-5) {
          var s = Math.min(CFG.SPEED, d * 7);
          wx = ex / d * s; wy = ey / d * s;
        }
      }
    }
    var k = 1 - Math.exp(-CFG.ACCEL * dt);
    g.vx += (wx - g.vx) * k;
    g.vy += (wy - g.vy) * k;
    g.px += g.vx * dt;
    g.py += g.vy * dt;
    var r = Math.hypot(g.px, g.py);
    if (r > CFG.ARENA_R) {
      var nx = g.px / r, ny = g.py / r;
      g.px = nx * CFG.ARENA_R; g.py = ny * CFG.ARENA_R;
      var vn = g.vx * nx + g.vy * ny;
      if (vn > 0) { g.vx -= vn * nx; g.vy -= vn * ny; }
    }
  }

  /* ---------- 快照 / 倒带 ---------- */
  function pushSnap(g) {
    g.snaps.push({
      px: g.px, py: g.py, vx: g.vx, vy: g.vy,
      tick: g.tick, loopTick: g.loopTick, loopIndex: g.loopIndex,
      rec: g.rec,
      echoes: g.echoes.slice(),
      allLen: g.allPaths.length,
      shard: g.shard ? { x: g.shard.x, y: g.shard.y } : null,
      gold: g.gold ? { x: g.gold.x, y: g.gold.y } : null,
      score: g.score, collected: g.collected, energy: g.energy,
      seed: g.seed, erased: g.erased
    });
    if (g.snaps.length > CFG.REWIND_TICKS) g.snaps.shift();
  }

  function applySnap(g, s) {
    g.px = s.px; g.py = s.py; g.vx = s.vx; g.vy = s.vy;
    g.tick = s.tick; g.loopTick = s.loopTick; g.loopIndex = s.loopIndex;
    g.rec = s.rec;
    g.echoes = s.echoes.slice();
    g.allPaths.length = s.allLen;
    g.shard = s.shard ? { x: s.shard.x, y: s.shard.y } : null;
    g.gold = s.gold ? { x: s.gold.x, y: s.gold.y } : null;
    g.score = s.score; g.collected = s.collected; g.energy = s.energy;
    g.seed = s.seed; g.erased = s.erased;
  }

  function stepRewind(g) {
    var n = CFG.REWIND_SPEED, s = null;
    while (n-- > 0 && g.rewindLeft > 0 && g.snaps.length) {
      s = g.snaps.pop();
      g.rewindLeft--;
    }
    if (s) applySnap(g, s);
    if (g.rewindLeft <= 0 || g.snaps.length === 0) {
      g.mode = 'play';
      g.rewindLeft = 0;
      g.invuln = CFG.INVULN_TICKS;
      g.events.push({ type: 'rewindEnd', x: g.px, y: g.py });
    }
  }

  function die(g, cause, echo) {
    g.mode = 'over';
    g.deathCause = cause;
    g.deathAgo = echo ? (g.loopIndex - echo.born + 1) : 0;
    g.finalLen = g.loopTick + 1;
    g.events.push({ type: 'death', cause: cause, x: g.px, y: g.py, echoId: echo ? echo.id : null, ago: g.deathAgo });
  }

  function onHit(g, e) {
    if (g.charges > 0 && g.snaps.length > 0) {
      g.charges--;
      g.rewinds++;
      g.mode = 'rewind';
      g.rewindLeft = Math.min(CFG.REWIND_TICKS, g.snaps.length);
      g.events.push({ type: 'rewindStart', x: g.px, y: g.py, echoId: e.id, loopIndex: g.loopIndex, loopTick: g.loopTick });
    } else {
      die(g, 'echo', e);
    }
  }

  function endLoop(g) {
    var e = { id: ++g.echoSerial, path: g.rec, born: g.loopIndex + 1 };
    g.echoes.push(e);
    g.allPaths.push(g.rec);
    g.rec = new Float32Array(LOOP * 2);
    g.loopIndex++;
    g.loopTick = 0;
    g.events.push({ type: 'loop', loopIndex: g.loopIndex, echoId: e.id });
    if (g.loopIndex % CFG.CHARGE_EVERY === 0 && g.charges < 1 && g.loopIndex > g.lastChargeLoop) {
      g.charges = 1;
      g.lastChargeLoop = g.loopIndex;
      g.events.push({ type: 'charge' });
    }
    if (!g.gold && g.echoes.length >= 2 && g.loopIndex % CFG.GOLD_EVERY === 0) {
      g.gold = spawnPoint(g, 0.45);
      if (g.gold) g.events.push({ type: 'goldSpawn', x: g.gold.x, y: g.gold.y });
    }
  }

  /* ---------- 单步 ---------- */
  /**
   * input: null | { tx, ty }（朝目标点移动，坐标为钟面坐标） | { dx, dy }（方向，-1..1）
   * 事件会追加到 g.events，由调用方读取后清空。
   */
  function step(g, input) {
    if (g.mode === 'over') return g;
    if (g.mode === 'rewind') { stepRewind(g); return g; }

    pushSnap(g);
    move(g, input);

    var t = g.loopTick;
    g.rec[2 * t] = g.px;
    g.rec[2 * t + 1] = g.py;

    // 回声碰撞
    if (g.invuln > 0) {
      g.invuln--;
    } else {
      var hitR = (CFG.PLAYER_R + CFG.ECHO_R) * (g.relaxed ? CFG.RELAXED_HIT : 1);
      var hr2 = hitR * hitR;
      for (var i = 0; i < g.echoes.length; i++) {
        var e = g.echoes[i];
        if (!isEchoActive(g, e)) continue;
        var dx = e.path[2 * t] - g.px, dy = e.path[2 * t + 1] - g.py;
        if (dx * dx + dy * dy < hr2) { onHit(g, e); return g; }
      }
    }

    // 刻度
    if (g.shard) {
      var sx = g.shard.x - g.px, sy = g.shard.y - g.py, sr = CFG.PLAYER_R + CFG.SHARD_R;
      if (sx * sx + sy * sy < sr * sr) {
        g.score++;
        g.collected++;
        g.energy = Math.min(CFG.ENERGY_MAX, g.energy + CFG.ENERGY_GAIN);
        g.events.push({ type: 'shard', x: g.shard.x, y: g.shard.y, score: g.score });
        g.shard = spawnPoint(g, CFG.SHARD_MIN_DIST);
      }
    }

    // 金色的 1
    if (g.gold) {
      var gx = g.gold.x - g.px, gy = g.gold.y - g.py, gr = CFG.PLAYER_R + CFG.GOLD_R;
      if (gx * gx + gy * gy < gr * gr) {
        var removed = g.echoes.length ? g.echoes.shift() : null;
        if (removed) g.erased++;
        g.score += CFG.GOLD_BONUS;
        g.energy = Math.min(CFG.ENERGY_MAX, g.energy + CFG.ENERGY_GAIN);
        g.events.push({
          type: 'gold', x: g.gold.x, y: g.gold.y,
          removed: removed ? { id: removed.id, x: removed.path[2 * t], y: removed.path[2 * t + 1] } : null
        });
        g.gold = null;
      }
    }

    // 余秒
    g.energy -= drainRate(g) * CFG.TICK;
    if (g.energy <= 0) { g.energy = 0; die(g, 'energy', null); return g; }

    g.loopTick++;
    g.tick++;
    if (g.loopTick >= LOOP) endLoop(g);
    return g;
  }

  /** 印刷品用：所有完整的圈 + 当前（或最后）未完成的一圈 */
  function printPaths(g) {
    var out = [];
    for (var i = 0; i < g.allPaths.length; i++) out.push({ path: g.allPaths[i], len: LOOP });
    var len = g.mode === 'over' ? g.finalLen : g.loopTick;
    if (len > 0) out.push({ path: g.rec, len: Math.min(len, LOOP) });
    return out;
  }

  return {
    version: '1.0.0',
    CFG: CFG,
    createGame: createGame,
    step: step,
    drainRate: drainRate,
    isEchoActive: isEchoActive,
    spawnPoint: spawnPoint,
    printPaths: printPaths,
    rand: rand
  };
});
