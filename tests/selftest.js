/*
 * tim1e 玩法自检（只测 js/core.js 的纯逻辑，不依赖 DOM）
 *   Node：  node tests/selftest.js        （退出码 0 = 全部通过）
 *   浏览器：打开 tests/selftest.html
 */
(function (root) {
  'use strict';
  var Core = typeof require === 'function' ? require('../js/core.js') : root.Tim1eCore;
  var CFG = Core.CFG, LOOP = CFG.LOOP_TICKS;
  var results = [];

  function check(name, fn) {
    try { fn(); results.push({ name: name, ok: true }); }
    catch (e) { results.push({ name: name, ok: false, err: (e && e.message) || String(e) }); }
  }
  function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
  function near(a, b, eps, msg) {
    if (!(Math.abs(a - b) <= eps)) throw new Error((msg || '数值不符') + '：期望 ' + b + '，得到 ' + a);
  }
  function run(g, n, inputFn) {
    for (var i = 0; i < n; i++) Core.step(g, inputFn ? inputFn(i, g) : null);
    return g;
  }
  function wiggle(i) { return { dx: Math.cos(i * 0.05), dy: Math.sin(i * 0.031) }; }
  function fixedEcho(id, x, y, born) {
    var p = new Float32Array(LOOP * 2);
    for (var t = 0; t < LOOP; t++) { p[2 * t] = x; p[2 * t + 1] = y; }
    return { id: id, path: p, born: born === undefined ? -1 : born };
  }

  check('确定性：同种子 + 同输入 → 完全相同的结果', function () {
    var input = function (i) { return { tx: 0.6 * Math.cos(i * 0.021), ty: 0.6 * Math.sin(i * 0.034) }; };
    var a = run(Core.createGame({ seed: 42 }), 1500, input);
    var b = run(Core.createGame({ seed: 42 }), 1500, input);
    ['px', 'py', 'score', 'energy', 'mode', 'loopIndex', 'loopTick', 'seed', 'charges', 'rewinds', 'erased']
      .forEach(function (k) { assert(a[k] === b[k], k + ' 不一致：' + a[k] + ' vs ' + b[k]); });
    assert(a.echoes.length === b.echoes.length, '回声数量不一致');
    var c = Core.createGame({ seed: 43 }), d = Core.createGame({ seed: 42 });
    assert(c.shard.x !== d.shard.x || c.shard.y !== d.shard.y, '不同种子应产生不同的刻度位置');
  });

  check('回声：一圈结束后逐帧重演上一圈的轨迹，并有预告期', function () {
    var g = Core.createGame({ seed: 7 }), rec = [];
    for (var i = 0; i < LOOP; i++) { Core.step(g, wiggle(i)); rec.push([g.px, g.py]); }
    assert(g.mode === 'play', 'mode=' + g.mode);
    assert(g.loopIndex === 1 && g.loopTick === 0, '应进入第二圈');
    assert(g.echoes.length === 1, '应有 1 个回声');
    var e = g.echoes[0];
    for (var t = 0; t < LOOP; t++) {
      near(e.path[2 * t], rec[t][0], 1e-6, 'x@' + t);
      near(e.path[2 * t + 1], rec[t][1], 1e-6, 'y@' + t);
    }
    assert(!Core.isEchoActive(g, e), '新回声在预告期内应无害');
    run(g, CFG.ECHO_GRACE, function (k) { return wiggle(k + 1000); });
    assert(g.mode === 'play', '预告期内不应结束');
    assert(Core.isEchoActive(g, e), '预告期后回声应激活');
  });

  check('站着不动：下一圈撞上原地的自己 → 自动倒带（跨圈）→ 再撞则结束', function () {
    var g = Core.createGame({ seed: 3 }), saw = null, i = 0;
    while (g.mode !== 'over' && i < 5000) {
      Core.step(g, null);
      for (var k = 0; k < g.events.length; k++) if (g.events[k].type === 'rewindStart' && !saw) saw = g.events[k];
      g.events.length = 0;
      i++;
    }
    assert(saw, '没有触发倒带');
    assert(saw.loopIndex === 1 && saw.loopTick === CFG.ECHO_GRACE, '倒带时刻：' + saw.loopIndex + '/' + saw.loopTick);
    assert(g.mode === 'over' && g.deathCause === 'echo', '结束原因：' + g.deathCause);
    assert(g.rewinds === 1 && g.charges === 0, '应恰好用掉一次备用一秒');
    assert(g.echoes.length === 1 && g.echoes[0].id === 2, '跨圈倒带应撤销旧回声并在重新走完后重建（id=2）');
    assert(g.loopIndex === 1 && g.loopTick === CFG.ECHO_GRACE + 1, '死亡时刻：' + g.loopIndex + '/' + g.loopTick);
    assert(g.deathAgo === 1, 'deathAgo=' + g.deathAgo);
  });

  check('倒带：精确回到 60 帧前的状态，撤销「未来」的回声，并给予无敌', function () {
    var g = Core.createGame({ seed: 11 }), hist = [];
    var input = function (i) { return { tx: 0.5 * Math.cos(i * 0.03), ty: 0.5 * Math.sin(i * 0.03) }; };
    for (var i = 0; i < 200; i++) {
      hist.push({ px: g.px, py: g.py, score: g.score, energy: g.energy, loopTick: g.loopTick, seed: g.seed });
      Core.step(g, input(i));
    }
    assert(g.mode === 'play');
    g.vx = 0; g.vy = 0;
    g.echoes.push(fixedEcho(999, g.px, g.py, -1));
    Core.step(g, null);
    assert(g.mode === 'rewind', '应进入倒带：mode=' + g.mode);
    var guard = 0;
    while (g.mode === 'rewind' && guard++ < 100) Core.step(g, null);
    assert(g.mode === 'play', '倒带应结束');
    assert(guard === CFG.REWIND_TICKS / CFG.REWIND_SPEED, '倒带动画帧数：' + guard);
    var h = hist[200 - CFG.REWIND_TICKS + 1];
    assert(g.px === h.px && g.py === h.py, '位置未恢复');
    assert(g.loopTick === h.loopTick && g.score === h.score && g.energy === h.energy && g.seed === h.seed, '状态未恢复');
    assert(g.echoes.length === 0, '注入的回声属于「未来」，应被撤销');
    assert(g.invuln === CFG.INVULN_TICKS && g.charges === 0 && g.rewinds === 1, '无敌/次数不对');
  });

  check('余秒耗尽 → 结束', function () {
    var g = Core.createGame({ seed: 5 });
    g.energy = 0.001;
    Core.step(g, null);
    assert(g.mode === 'over' && g.deathCause === 'energy', 'cause=' + g.deathCause);
    var paths = Core.printPaths(g);
    assert(paths.length === 1 && paths[0].len === 1, '印刷品应包含最后半圈');
  });

  check('吃刻度：+1 分、+余秒、立即刷新下一枚', function () {
    var g = Core.createGame({ seed: 9 });
    g.shard = { x: g.px, y: g.py };
    var e0 = g.energy;
    Core.step(g, null);
    assert(g.score === 1 && g.collected === 1, 'score=' + g.score);
    near(g.energy, Math.min(CFG.ENERGY_MAX, e0 + CFG.ENERGY_GAIN) - Core.drainRate(g) * CFG.TICK, 1e-9, '余秒');
    assert(g.shard && Math.hypot(g.shard.x, g.shard.y) <= CFG.SPAWN_R + 1e-9, '新刻度应在钟面内');
    assert(Math.hypot(g.shard.x - g.px, g.shard.y - g.py) > 0.1, '新刻度不应刷在脚下');
    assert(g.events.some(function (e) { return e.type === 'shard'; }), '应发出 shard 事件');
  });

  check('金色的 1：抹去最旧的回声并 +3 分', function () {
    var g = Core.createGame({ seed: 13 });
    g.echoes.push(fixedEcho(101, 0.7, 0), fixedEcho(102, -0.7, 0), fixedEcho(103, 0, 0.7));
    g.shard = { x: 0.5, y: -0.5 };
    g.gold = { x: g.px, y: g.py };
    Core.step(g, null);
    assert(g.mode === 'play', 'mode=' + g.mode);
    assert(g.echoes.length === 2 && g.echoes[0].id === 102, '应移除 id=101');
    assert(g.erased === 1 && g.score === CFG.GOLD_BONUS && g.gold === null, '奖励不对');
  });

  check('补给节奏：每 4 圈补充备用一秒，每 3 圈刷出金色的 1', function () {
    var g = Core.createGame({ seed: 23 });
    g.echoes.push(fixedEcho(1, 0.8, 0), fixedEcho(2, -0.8, 0));
    g.charges = 0; g.loopIndex = 3; g.loopTick = LOOP - 1;
    Core.step(g, null);
    assert(g.loopIndex === 4 && g.charges === 1, '第 4 圈应补充：charges=' + g.charges);
    // 刚才那一圈（玩家原地不动）也成了回声，会正好落在脚下；这里只测补给节奏，先移除它
    g.echoes.length = 2;
    g.gold = null; g.loopIndex = 5; g.loopTick = LOOP - 1;
    Core.step(g, null);
    assert(g.loopIndex === 6 && g.gold !== null, '第 6 圈应刷出金色的 1');
  });

  check('边界：永远不会离开钟面，速度不超过上限', function () {
    var g = Core.createGame({ seed: 17 });
    for (var i = 0; i < 300; i++) {
      Core.step(g, i < 150 ? { tx: 5, ty: -3 } : { dx: 1, dy: 1 });
      assert(Math.hypot(g.px, g.py) <= CFG.ARENA_R + 1e-9, '越界 @' + i);
      assert(Math.hypot(g.vx, g.vy) <= CFG.SPEED + 1e-9, '超速 @' + i);
    }
    assert(g.mode === 'play');
  });

  check('刷新点：总在钟面内，且远离玩家', function () {
    var g = Core.createGame({ seed: 21 }), far = 0;
    for (var i = 0; i < 500; i++) {
      var p = Core.spawnPoint(g, CFG.SHARD_MIN_DIST);
      assert(p && Math.hypot(p.x, p.y) <= CFG.SPAWN_R + 1e-9, '越界');
      if (Math.hypot(p.x - g.px, p.y - g.py) >= CFG.SHARD_MIN_DIST) far++;
    }
    assert(far >= 495, '远离玩家的比例过低：' + far);
  });

  check('从容模式：余秒流逝更慢', function () {
    var a = Core.createGame({ seed: 1 }), b = Core.createGame({ seed: 1, relaxed: true });
    near(Core.drainRate(b), Core.drainRate(a) * CFG.RELAXED_DRAIN, 1e-12);
  });

  /* ---------- 输出 ---------- */
  var failed = results.filter(function (r) { return !r.ok; });
  var lines = results.map(function (r) { return (r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.err ? '\n     → ' + r.err : ''); });
  lines.push('');
  lines.push(failed.length ? (failed.length + ' / ' + results.length + ' 项失败') : ('全部 ' + results.length + ' 项通过'));

  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    console.log(lines.join('\n'));
    process.exitCode = failed.length ? 1 : 0;
  } else if (typeof document !== 'undefined') {
    var out = document.getElementById('out');
    if (out) {
      out.textContent = lines.join('\n');
      out.className = failed.length ? 'fail' : 'pass';
    }
    root.TIM1E_SELFTEST = { results: results, failed: failed.length };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
