/*!
 * tim1e · render.js
 * Canvas 渲染：孔版印刷（Risograph）风格的钟面、回声、粒子与「回声印刷品」海报。
 * 所有图形均由代码实时绘制，无外部图片素材。
 */
(function () {
  'use strict';
  var Core = window.Tim1eCore, CFG = Core.CFG;
  var TAU = Math.PI * 2;
  var LOOP = CFG.LOOP_TICKS;

  var INK = {
    paper: '#f3ecdd', face: '#ece2cc',
    blue: '#2c48d6', pink: '#ff4a8a', yellow: '#ffc531',
    green: '#00a383', gold: '#f2a900', dark: '#1e1c3a'
  };
  var SERIF = '"Songti SC","Noto Serif SC","Source Han Serif SC","STSong",ui-serif,Georgia,serif';
  var SANS = 'system-ui,-apple-system,"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",sans-serif';
  var MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,monospace';

  // 与页面 SVG 字标共用的笔画（viewBox 0 0 400 160）
  var WORDMARK = [
    'M40 30 V106 q0 16 16 16 h12 M18 62 H68',
    'M100 66 V122',
    'M140 122 V84 a22 22 0 0 1 44 0 V122 M184 84 a22 22 0 0 1 44 0 V122',
    'M254 52 L276 32 V122',
    'M312 92 H370 A30 30 0 1 0 361 113'
  ];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function makeGrain(size) {
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var x = c.getContext('2d'), img = x.createImageData(size, size), d = img.data;
    for (var i = 0; i < size * size; i++) {
      var r = Math.random();
      if (r < 0.22) {
        d[i * 4] = 30; d[i * 4 + 1] = 28; d[i * 4 + 2] = 58; d[i * 4 + 3] = 8 + Math.random() * 34;
      } else if (r > 0.985) {
        d[i * 4] = 255; d[i * 4 + 1] = 255; d[i * 4 + 2] = 255; d[i * 4 + 3] = 70;
      }
    }
    x.putImageData(img, 0, 0);
    return c;
  }

  /** 画一个「1」字形（以中心为锚点），s ≈ 半高 */
  function strokeOne(ctx, x, y, s, tilt, color, lw) {
    ctx.save();
    ctx.translate(x, y);
    if (tilt) ctx.rotate(tilt);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw || s * 0.3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(-s * 0.4, -s * 0.36);
    ctx.lineTo(s * 0.08, -s * 0.8);
    ctx.lineTo(s * 0.08, s * 0.8);
    ctx.stroke();
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  /* ======================================================================= */

  function Renderer(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 300; this.h = 300; this.dpr = 1;
    this.cx = 150; this.cy = 150; this.R = 100;
    this.reduced = false;
    this.grain = makeGrain(180);
    this.grainPat = null;
    this.dots = []; this.dotSp = 6;
    this.parts = []; this.rings = [];
    this.shake = 0; this.flash = 0; this.flashColor = INK.pink;
    this.resize();
  }
  var P = Renderer.prototype;

  P.reset = function () {
    this.parts.length = 0; this.rings.length = 0;
    this.shake = 0; this.flash = 0;
  };

  P.resize = function () {
    var r = this.c.getBoundingClientRect();
    var w = Math.max(1, r.width), h = Math.max(1, r.height);
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = w; this.h = h; this.dpr = dpr;
    this.c.width = Math.round(w * dpr);
    this.c.height = Math.round(h * dpr);
    var top = w < 600 ? 72 : 86, bottom = w < 600 ? 24 : 32;
    var availH = Math.max(120, h - top - bottom);
    this.R = Math.max(60, Math.min(w * 0.45, availH * 0.47));
    this.cx = w / 2;
    this.cy = top + availH / 2;
    this.grainPat = this.ctx.createPattern(this.grain, 'repeat');
    this.buildDots();
  };

  P.buildDots = function () {
    var sp = this.R / 15, lim = this.R * 0.96, out = [], row = 0;
    for (var y = -lim; y <= lim; y += sp * 0.866, row++) {
      for (var x = -lim + (row % 2 ? sp / 2 : 0); x <= lim; x += sp) {
        var d = Math.hypot(x, y);
        if (d > lim || d < sp * 0.8) continue;
        out.push(x, y, Math.atan2(y, x));
      }
    }
    this.dots = out;
    this.dotSp = sp;
  };

  P.begin = function (dt) {
    var ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = INK.paper;
    ctx.fillRect(0, 0, this.w, this.h);
    if (this.shake > 0) {
      if (!this.reduced) {
        var m = this.shake * this.R * 0.05;
        ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
      }
      this.shake = Math.max(0, this.shake - dt * 2.2);
    }
  };

  P.end = function (dt) {
    var ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    if (this.flash > 0) {
      ctx.globalAlpha = Math.min(0.5, this.flash * 0.5) * (this.reduced ? 0.5 : 1);
      ctx.fillStyle = this.flashColor;
      ctx.fillRect(0, 0, this.w, this.h);
      this.flash = Math.max(0, this.flash - dt * 2);
    }
    ctx.globalAlpha = 1;
    if (this.grainPat) {
      ctx.fillStyle = this.grainPat;
      ctx.fillRect(0, 0, this.w, this.h);
    }
  };

  /* ---------- 钟面 ---------- */
  P.drawDial = function (prog) {
    var ctx = this.ctx, cx = this.cx, cy = this.cy, R = this.R;
    var a, c, s, k;
    ctx.fillStyle = INK.face;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();

    ctx.globalCompositeOperation = 'multiply';

    // 半调网点：跟随指针扫过的「影子」
    var hand = -Math.PI / 2 + prog * TAU, dots = this.dots, span = 1.5, sp = this.dotSp;
    ctx.fillStyle = INK.pink;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    for (var i = 0; i < dots.length; i += 3) {
      var d = hand - dots[i + 2];
      d = d - Math.floor(d / TAU) * TAU;
      if (d < span) {
        var rr = Math.pow(1 - d / span, 1.6) * sp * 0.46;
        if (rr > 0.35) {
          ctx.moveTo(cx + dots[i] + rr, cy + dots[i + 1]);
          ctx.arc(cx + dots[i], cy + dots[i + 1], rr, 0, TAU);
        }
      }
    }
    ctx.fill();
    ctx.globalAlpha = 1;

    // 外圈（两色套印错位）
    var lw = Math.max(1.5, R * 0.012);
    ctx.lineWidth = lw;
    ctx.strokeStyle = INK.yellow;
    ctx.beginPath(); ctx.arc(cx + lw * 0.9, cy + lw * 0.7, R, 0, TAU); ctx.stroke();
    ctx.strokeStyle = INK.blue;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();

    // 刻度线
    ctx.beginPath();
    for (k = 0; k < 60; k++) {
      if (k % 5 === 0) continue;
      a = -Math.PI / 2 + k / 60 * TAU; c = Math.cos(a); s = Math.sin(a);
      ctx.moveTo(cx + c * R * 0.95, cy + s * R * 0.95);
      ctx.lineTo(cx + c * R * 0.985, cy + s * R * 0.985);
    }
    ctx.lineWidth = Math.max(1, R * 0.005);
    ctx.stroke();
    ctx.beginPath();
    for (k = 0; k < 12; k++) {
      a = -Math.PI / 2 + k / 12 * TAU; c = Math.cos(a); s = Math.sin(a);
      ctx.moveTo(cx + c * R * 0.9, cy + s * R * 0.9);
      ctx.lineTo(cx + c * R * 0.985, cy + s * R * 0.985);
    }
    ctx.lineWidth = Math.max(2, R * 0.014);
    ctx.stroke();

    // 数字：只有「1」是粉色的
    ctx.font = '600 ' + Math.round(R * 0.07) + 'px ' + SERIF;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var hr = 1; hr <= 12; hr++) {
      a = -Math.PI / 2 + hr / 12 * TAU;
      ctx.fillStyle = hr === 1 ? INK.pink : 'rgba(44,72,214,0.45)';
      ctx.fillText(String(hr), cx + Math.cos(a) * R * 0.8, cy + Math.sin(a) * R * 0.8);
    }

    // 一圈的进度弧
    ctx.lineCap = 'round';
    ctx.strokeStyle = INK.pink;
    ctx.lineWidth = Math.max(3, R * 0.026);
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.045, -Math.PI / 2, -Math.PI / 2 + Math.max(0.002, prog) * TAU);
    ctx.stroke();

    // 指针
    ctx.strokeStyle = 'rgba(44,72,214,0.32)';
    ctx.lineWidth = Math.max(1.5, R * 0.008);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(hand) * R * 0.93, cy + Math.sin(hand) * R * 0.93);
    ctx.stroke();
    ctx.fillStyle = INK.blue;
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(3, R * 0.018), 0, TAU); ctx.fill();
    ctx.lineCap = 'butt';
    ctx.globalCompositeOperation = 'source-over';
  };

  P.poly = function (path, from, to, step) {
    var ctx = this.ctx, cx = this.cx, cy = this.cy, R = this.R;
    ctx.beginPath();
    ctx.moveTo(cx + path[2 * from] * R, cy + path[2 * from + 1] * R);
    for (var i = from + step; i < to; i += step) ctx.lineTo(cx + path[2 * i] * R, cy + path[2 * i + 1] * R);
    ctx.lineTo(cx + path[2 * (to - 1)] * R, cy + path[2 * (to - 1) + 1] * R);
  };

  P.drawShard = function (x, y, time) {
    var ctx = this.ctx, R = this.R, sx = this.cx + x * R, sy = this.cy + y * R;
    var pulse = this.reduced ? 0.45 : (time * 1.4) % 1;
    ctx.globalAlpha = 0.6 * (1 - pulse);
    ctx.strokeStyle = INK.gold;
    ctx.lineWidth = Math.max(1.5, R * 0.008);
    ctx.beginPath(); ctx.arc(sx, sy, R * (0.05 + pulse * 0.06), 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(this.reduced ? 0.6 : time * 1.8);
    var L = R * 0.075, W = R * 0.026;
    ctx.fillStyle = INK.yellow;
    roundRect(ctx, -L / 2, -W / 2, L, W, W / 2); ctx.fill();
    ctx.strokeStyle = INK.blue;
    ctx.lineWidth = Math.max(1, R * 0.006);
    ctx.translate(R * 0.005, R * 0.004);
    roundRect(ctx, -L / 2, -W / 2, L, W, W / 2); ctx.stroke();
    ctx.restore();
  };

  P.drawGold = function (x, y, time) {
    var ctx = this.ctx, R = this.R, sx = this.cx + x * R, sy = this.cy + y * R;
    var rot = this.reduced ? 0 : time * 0.9;
    ctx.strokeStyle = INK.gold;
    ctx.lineWidth = Math.max(1.5, R * 0.008);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (var k = 0; k < 12; k++) {
      var a = rot + k / 12 * TAU, c = Math.cos(a), s = Math.sin(a);
      ctx.moveTo(sx + c * R * 0.085, sy + s * R * 0.085);
      ctx.lineTo(sx + c * R * (k % 3 === 0 ? 0.115 : 0.1), sy + s * R * (k % 3 === 0 ? 0.115 : 0.1));
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
    var bob = this.reduced ? 0 : Math.sin(time * 3) * R * 0.006;
    strokeOne(ctx, sx + R * 0.009, sy + R * 0.007 + bob, R * 0.075, 0, INK.pink, R * 0.026);
    strokeOne(ctx, sx, sy + bob, R * 0.075, 0, INK.gold, R * 0.026);
  };

  /* ---------- 粒子 / 特效 ---------- */
  P.burst = function (x, y, color, n, speed) {
    var k = this.reduced ? Math.ceil(n / 3) : n;
    for (var i = 0; i < k && this.parts.length < 420; i++) {
      var a = Math.random() * TAU, sp = (0.2 + Math.random() * 0.8) * (speed || 0.6);
      this.parts.push({
        x: x, y: y,
        vx: this.reduced ? 0 : Math.cos(a) * sp, vy: this.reduced ? 0 : Math.sin(a) * sp,
        life: 1, decay: 0.9 + Math.random() * 0.9,
        r: 0.006 + Math.random() * 0.014, color: color
      });
    }
  };
  P.text = function (x, y, str, color) {
    this.parts.push({ x: x, y: y, vx: 0, vy: this.reduced ? 0 : -0.12, life: 1, decay: 0.8, text: str, color: color });
  };
  P.ring = function (color) {
    if (!this.reduced) this.rings.push({ life: 1, color: color });
  };

  P.drawFx = function (dt) {
    var ctx = this.ctx, R = this.R, cx = this.cx, cy = this.cy, i;
    for (i = this.rings.length - 1; i >= 0; i--) {
      var rg = this.rings[i];
      rg.life -= dt * 1.4;
      if (rg.life <= 0) { this.rings.splice(i, 1); continue; }
      ctx.globalAlpha = rg.life * 0.6;
      ctx.strokeStyle = rg.color;
      ctx.lineWidth = Math.max(1, R * 0.02 * rg.life);
      ctx.beginPath(); ctx.arc(cx, cy, R * (0.08 + 0.95 * (1 - rg.life)), 0, TAU); ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (i = this.parts.length - 1; i >= 0; i--) {
      var p = this.parts[i];
      p.life -= dt * p.decay;
      if (p.life <= 0) { this.parts.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      var damp = Math.max(0, 1 - dt * 2.5);
      p.vx *= damp; p.vy *= damp;
      if (p.text) {
        ctx.globalAlpha = Math.min(1, p.life * 1.5);
        ctx.fillStyle = p.color;
        ctx.font = '700 ' + Math.max(12, Math.round(R * 0.06)) + 'px ' + MONO;
        ctx.fillText(p.text, cx + p.x * R, cy + p.y * R - R * 0.07);
      } else {
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(cx + p.x * R, cy + p.y * R, p.r * R * (0.5 + p.life * 0.5), 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  };

  P.drawRewind = function (time) {
    var ctx = this.ctx, w = this.w, h = this.h, y;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgba(44,72,214,0.14)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(44,72,214,0.10)';
    for (y = this.reduced ? 0 : (time * 240) % 6; y < h; y += 6) ctx.fillRect(0, y, w, 2);
    ctx.globalCompositeOperation = 'source-over';
    if (!this.reduced) {
      for (var i = 0; i < 3; i++) {
        var by = Math.random() * h, bh = 4 + Math.random() * 18;
        ctx.drawImage(this.c, 0, by * this.dpr, this.c.width, bh * this.dpr, (Math.random() - 0.5) * 24, by, w, bh);
      }
    }
    ctx.font = '800 ' + Math.round(this.R * 0.16) + 'px ' + MONO;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = INK.pink;
    ctx.fillText('◀◀ 1s', this.cx + 3, this.cy - this.R * 0.42 + 2);
    ctx.fillStyle = INK.blue;
    ctx.fillText('◀◀ 1s', this.cx, this.cy - this.R * 0.42);
  };

  /* ---------- 游戏画面 ---------- */
  P.drawGame = function (g, dt, time, opt) {
    opt = opt || {};
    var fxDt = opt.paused ? 0 : dt;
    var ctx = this.ctx, R = this.R, cx = this.cx, cy = this.cy;
    var i, e, n = g.echoes.length;
    var t = Math.min(g.loopTick, LOOP - 1);

    this.begin(fxDt);
    this.drawDial(g.loopTick / LOOP);

    ctx.globalCompositeOperation = 'multiply';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // 1) 每个回声完整的一圈轨迹（淡）——让玩家能预判
    ctx.lineWidth = Math.max(1, R * 0.004);
    ctx.strokeStyle = INK.blue;
    for (i = 0; i < n; i++) {
      this.poly(g.echoes[i].path, 0, LOOP, 3);
      ctx.globalAlpha = i === n - 1 ? 0.22 : 0.1;
      ctx.stroke();
    }
    // 2) 你这一圈的轨迹（下一圈它就会变成回声）
    if (g.loopTick > 2) {
      this.poly(g.rec, 0, Math.min(g.loopTick, LOOP), 2);
      ctx.setLineDash([R * 0.012, R * 0.02]);
      ctx.strokeStyle = INK.pink;
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = Math.max(1, R * 0.006);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;

    // 3) 刻度与金色的 1
    if (g.shard) this.drawShard(g.shard.x, g.shard.y, time);
    if (g.gold) this.drawGold(g.gold.x, g.gold.y, time);

    // 4) 回声
    for (i = 0; i < n; i++) {
      e = g.echoes[i];
      var ex = e.path[2 * t], ey = e.path[2 * t + 1];
      var t0 = Math.max(0, t - 28);
      if (t - t0 >= 2) {
        this.poly(e.path, t0, t + 1, 1);
        ctx.strokeStyle = INK.blue;
        ctx.globalAlpha = 0.25;
        ctx.lineWidth = R * 0.016;
        ctx.stroke();
      }
      var pt = Math.max(0, t - 1);
      var tilt = clamp((ex - e.path[2 * pt]) * 25, -0.45, 0.45);
      var active = Core.isEchoActive(g, e);
      var sxe = cx + ex * R, sye = cy + ey * R;
      ctx.globalAlpha = active ? 1 : 0.35;
      strokeOne(ctx, sxe + R * 0.007, sye + R * 0.005, R * 0.052, tilt, INK.green, R * 0.017);
      strokeOne(ctx, sxe, sye, R * 0.052, tilt, INK.blue, R * 0.017);
      if (!active) {
        var k = 1 - g.loopTick / CFG.ECHO_GRACE;
        ctx.globalAlpha = 0.75;
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = INK.blue;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(sxe, sye, R * (0.05 + 0.1 * k), 0, TAU); ctx.stroke();
        ctx.setLineDash([]);
        if (opt.hints && g.loopIndex <= 2) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = INK.blue;
          ctx.font = '700 ' + Math.max(12, Math.round(R * 0.042)) + 'px ' + SANS;
          ctx.textAlign = sxe > cx ? 'right' : 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(sxe > cx ? '6 秒前的你 →' : '← 6 秒前的你', sxe + (sxe > cx ? -1 : 1) * R * 0.09, sye);
        }
      }
      ctx.globalAlpha = 1;
    }

    // 5) 玩家
    var px = cx + g.px * R, py = cy + g.py * R;
    if (opt.hints && g.score === 0 && g.loopIndex === 0 && g.shard && g.mode === 'play') {
      ctx.setLineDash([4, 6]);
      ctx.strokeStyle = INK.pink;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px, py);
      ctx.lineTo(cx + g.shard.x * R, cy + g.shard.y * R); ctx.stroke();
      ctx.setLineDash([]);
    }
    var ptilt = clamp(g.vx * 0.45, -0.45, 0.45);
    var blink = g.invuln > 0 && Math.floor(time * 14) % 2 === 0;
    ctx.globalAlpha = blink ? 0.35 : 1;
    if (g.mode !== 'over' || this.flash > 0.2) {
      strokeOne(ctx, px + R * 0.009, py + R * 0.007, R * 0.06, ptilt, INK.yellow, R * 0.021);
      strokeOne(ctx, px, py, R * 0.06, ptilt, INK.pink, R * 0.021);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = INK.dark;
    ctx.beginPath(); ctx.arc(px, py, Math.max(1.5, R * 0.007), 0, TAU); ctx.fill();

    // 6) 特效
    this.drawFx(fxDt);
    ctx.globalCompositeOperation = 'source-over';

    if (g.energy < 3 && g.mode !== 'over') {
      var amt = (1 - g.energy / 3) * (this.reduced ? 0.3 : 0.22 + 0.12 * Math.sin(time * 8));
      var grd = ctx.createRadialGradient(cx, cy, R * 0.85, cx, cy, Math.max(this.w, this.h) * 0.75);
      grd.addColorStop(0, 'rgba(255,74,138,0)');
      grd.addColorStop(1, 'rgba(255,74,138,' + clamp(amt, 0, 0.5).toFixed(3) + ')');
      ctx.fillStyle = grd;
      ctx.fillRect(-20, -20, this.w + 40, this.h + 40);
    }
    if (g.mode === 'rewind') this.drawRewind(time);
    this.end(fxDt);
  };

  /* ---------- 标题背景：自动演示 ---------- */
  var CURVES = [
    [3, 2, 0.0, 0.62, 0.55],
    [5, 4, 1.1, 0.55, 0.4],
    [2, 3, 2.3, 0.7, 0.5],
    [4, 1, 0.7, 0.45, 0.6],
    [1, 2, 1.9, 0.66, 0.45]
  ];
  P.drawAttract = function (dt, time) {
    var t = this.reduced ? 3.4 : time;
    this.begin(dt);
    this.drawDial((t / 6) % 1);
    var ctx = this.ctx, R = this.R, cx = this.cx, cy = this.cy;
    ctx.globalCompositeOperation = 'multiply';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    this.drawShard(0.34, -0.38, t);
    for (var k = CURVES.length - 1; k >= 0; k--) {
      var c = CURVES[k], a = c[0], b = c[1], ph = c[2], A = c[3], sp = c[4];
      ctx.beginPath();
      for (var i = 0; i <= 180; i++) {
        var u0 = i / 180 * TAU;
        var x0 = cx + A * Math.sin(a * u0 + ph) * R, y0 = cy + A * Math.sin(b * u0) * R;
        if (i) ctx.lineTo(x0, y0); else ctx.moveTo(x0, y0);
      }
      ctx.strokeStyle = k === 0 ? INK.pink : INK.blue;
      ctx.globalAlpha = k === 0 ? 0.3 : 0.13;
      ctx.lineWidth = Math.max(1, R * 0.005);
      ctx.stroke();
      ctx.globalAlpha = 1;
      var u = t * sp;
      var x = A * Math.sin(a * u + ph), y = A * Math.sin(b * u);
      var xn = A * Math.sin(a * (u + 0.03) + ph);
      var tilt = clamp((xn - x) * 12, -0.45, 0.45);
      if (k === 0) {
        strokeOne(ctx, cx + x * R + R * 0.009, cy + y * R + R * 0.007, R * 0.06, tilt, INK.yellow, R * 0.021);
        strokeOne(ctx, cx + x * R, cy + y * R, R * 0.06, tilt, INK.pink, R * 0.021);
      } else {
        strokeOne(ctx, cx + x * R + R * 0.007, cy + y * R + R * 0.005, R * 0.052, tilt, INK.green, R * 0.017);
        strokeOne(ctx, cx + x * R, cy + y * R, R * 0.052, tilt, INK.blue, R * 0.017);
      }
    }
    this.drawFx(dt);
    ctx.globalCompositeOperation = 'source-over';
    this.end(dt);
  };

  /* ======================================================================= */
  /* 回声印刷品（1080×1350 海报）                                              */
  /* ======================================================================= */

  function pad(n) { n = String(n); while (n.length < 3) n = '0' + n; return n; }
  function two(n) { return n < 10 ? '0' + n : String(n); }
  function fmtDate(d) {
    return d.getFullYear() + '.' + two(d.getMonth() + 1) + '.' + two(d.getDate()) + '  ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }

  function regMark(x, px, py) {
    x.strokeStyle = INK.dark;
    x.lineWidth = 2;
    x.beginPath(); x.arc(px, py, 11, 0, TAU);
    x.moveTo(px - 18, py); x.lineTo(px + 18, py);
    x.moveTo(px, py - 18); x.lineTo(px, py + 18);
    x.stroke();
  }

  function drawWordmark(x) {
    if (typeof Path2D !== 'function') return;
    var paths = WORDMARK.map(function (d) { return new Path2D(d); });
    x.lineCap = 'round'; x.lineJoin = 'round'; x.lineWidth = 20;
    x.save();
    x.translate(5, 4);
    x.strokeStyle = INK.yellow;
    paths.forEach(function (p) { x.stroke(p); });
    x.fillStyle = INK.yellow;
    x.beginPath(); x.arc(100, 32, 11, 0, TAU); x.fill();
    x.restore();
    paths.forEach(function (p, i) { x.strokeStyle = i === 3 ? INK.pink : INK.blue; x.stroke(p); });
    x.fillStyle = INK.blue;
    x.beginPath(); x.arc(100, 32, 11, 0, TAU); x.fill();
  }

  function trace(x, path, len, cx, cy, R) {
    x.beginPath();
    x.moveTo(cx + path[0] * R, cy + path[1] * R);
    for (var i = 1; i < len; i++) x.lineTo(cx + path[2 * i] * R, cy + path[2 * i + 1] * R);
  }

  function makePoster(g, st) {
    var W = 1080, H = 1350;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var x = c.getContext('2d');
    var i, k, a;
    x.fillStyle = INK.paper;
    x.fillRect(0, 0, W, H);
    x.globalCompositeOperation = 'multiply';

    // 背景里巨大的「1」
    strokeOne(x, 850, 330, 300, 0.1, 'rgba(255,197,49,0.45)', 84);

    // 钟面
    var cx = 540, cy = 700, RR = 430;
    x.fillStyle = 'rgba(236,226,204,0.8)';
    x.beginPath(); x.arc(cx, cy, RR, 0, TAU); x.fill();
    x.strokeStyle = 'rgba(44,72,214,0.6)';
    x.lineWidth = 3;
    x.beginPath(); x.arc(cx, cy, RR, 0, TAU); x.stroke();
    x.beginPath();
    for (k = 0; k < 60; k++) {
      a = -Math.PI / 2 + k / 60 * TAU;
      var r0 = k % 5 === 0 ? 0.9 : 0.95;
      x.moveTo(cx + Math.cos(a) * RR * r0, cy + Math.sin(a) * RR * r0);
      x.lineTo(cx + Math.cos(a) * RR * 0.985, cy + Math.sin(a) * RR * 0.985);
    }
    x.lineWidth = 2;
    x.stroke();

    // 所有圈的轨迹，四色叠印
    var paths = Core.printPaths(g);
    var inks = [INK.blue, INK.pink, INK.green, INK.gold];
    x.lineJoin = 'round'; x.lineCap = 'round';
    for (i = 0; i < paths.length; i++) {
      var p = paths[i], isLast = i === paths.length - 1;
      if (p.len < 2) continue;
      var col = isLast ? INK.pink : inks[i % inks.length];
      var off = inks[(i + 1) % inks.length];
      trace(x, p.path, p.len, cx + 5, cy + 4, RR);
      x.strokeStyle = off; x.globalAlpha = 0.22; x.lineWidth = isLast ? 5 : 3;
      x.stroke();
      trace(x, p.path, p.len, cx, cy, RR);
      x.strokeStyle = col; x.globalAlpha = isLast ? 0.95 : 0.72; x.lineWidth = isLast ? 6 : 3.4;
      x.stroke();
    }
    x.globalAlpha = 1;
    if (paths.length) {
      var f = paths[0].path;
      x.fillStyle = INK.blue;
      x.beginPath(); x.arc(cx + f[0] * RR, cy + f[1] * RR, 10, 0, TAU); x.fill();
      var lp = paths[paths.length - 1], li = Math.max(0, lp.len - 1);
      var ex = cx + lp.path[2 * li] * RR, ey = cy + lp.path[2 * li + 1] * RR;
      x.strokeStyle = INK.dark; x.lineWidth = 6;
      x.beginPath();
      x.moveTo(ex - 16, ey - 16); x.lineTo(ex + 16, ey + 16);
      x.moveTo(ex + 16, ey - 16); x.lineTo(ex - 16, ey + 16);
      x.stroke();
    }

    // 字标
    x.save(); x.translate(60, 56); x.scale(0.75, 0.75); drawWordmark(x); x.restore();

    x.globalCompositeOperation = 'source-over';
    x.fillStyle = INK.dark;
    x.textBaseline = 'alphabetic';
    x.textAlign = 'left';
    x.font = '400 26px ' + SERIF;
    x.fillText('多出来的那一秒，在钟面上留下的轨迹', 66, 222);

    x.textAlign = 'right';
    x.font = '700 26px ' + MONO;
    x.fillText('ECHO PRINT № ' + pad(st.run), W - 64, 100);
    x.font = '400 22px ' + MONO;
    x.fillText(fmtDate(st.date), W - 64, 136);
    x.fillText('seed ' + (st.seed >>> 0).toString(36), W - 64, 168);

    // 底部数据
    x.textAlign = 'left';
    x.font = '800 128px ' + MONO;
    x.fillStyle = INK.pink;
    x.fillText(String(st.score), 60, 1240);
    var sw = x.measureText(String(st.score)).width;
    x.fillStyle = INK.dark;
    x.font = '700 36px ' + SERIF;
    x.fillText('刻度', 60 + sw + 16, 1240);
    x.font = '400 26px ' + SANS;
    x.fillText(st.loops + ' 圈 · 抹去 ' + st.erased + ' 道回声 · 倒带 ' + st.rewinds + ' 次', 64, 1292);
    x.textAlign = 'right';
    x.font = '700 30px ' + SERIF;
    x.fillText(st.cause === 'echo' ? '—— 撞上了过去的自己' : '—— 余秒耗尽', W - 64, 1292);

    // 油墨色票
    var swatch = [INK.blue, INK.pink, INK.green, INK.gold, INK.yellow];
    for (i = 0; i < swatch.length; i++) {
      x.fillStyle = swatch[i];
      x.fillRect(W - 64 - (swatch.length - i) * 32 + 8, 1186, 24, 24);
    }

    regMark(x, 32, 32); regMark(x, W - 32, 32); regMark(x, 32, H - 32); regMark(x, W - 32, H - 32);

    var pat = x.createPattern(makeGrain(180), 'repeat');
    if (pat) { x.fillStyle = pat; x.fillRect(0, 0, W, H); }
    return c;
  }

  window.Tim1eRender = {
    Renderer: Renderer,
    makePoster: makePoster,
    INK: INK
  };
})();
