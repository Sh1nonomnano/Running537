/*
 * 下山模式。
 * s 是沿坡弧长，h 是离坡面的高度，rot 是相对坡面的转角（正值为顺时针）。
 * 坡度沿路程起伏：凹弧略加速，凸弧略减速，也更容易离地。
 * 撞上岩石或树不会立刻结束，只会急减速并踉跄；飞鼠从后面追，距离耗尽才抓住。
 * 摔到坡面以下太深，或飞得离开可玩范围，会直接结束。
 * 飞鼠用切图贴在坡上，朝下坡追。捡到小车会开一阵，撞开障碍，时间一到恢复滑行。
 */
(function (root) {
  "use strict";

  var DH = {
    width: 800,
    height: 450,
    gravity: 1800,
    drag: 2.05,
    airDrag: 0.28,
    maxVs: 640,
    jumpV: 640,
    feet: 40,
    bodyR: 22,
    landTol: 0.72,
    stumbleTime: 0.9,
    // 空中转得更快，松手也收得更快，落地仍看原来的正立容差。
    rotAccel: 48,
    maxOmega: 16,
    swing: 0.22,
    windup: 0.1,
    recover: 0.18,
    stick: 74,
    scorePer: 64,
    anchorX: 246,
    anchorY: 262,

    // 跳台：更高的起抛，以及沿坡速度加成。
    rampVs: 125,
    rampVhMul: 1.18,
    rampVhAdd: 120,

    // 障碍间距。rampClear / bufferTime 大约是 0.5 秒路程，避免刚离台或刚落地就撞上。
    rockGapMin: 720,
    rockGapRand: 420,
    treeGapMin: 780,
    treeGapRand: 380,
    rampGapMin: 960,
    rampGapRand: 440,
    gapTighten: 120,
    gapMin: 640,
    rampClear: 360,
    landClear: 240,
    bufferTime: 0.55,

    // 飞鼠追赶。chase 是它落后玩家的弧长，0 表示抓住。
    chaseStart: 168,
    chaseMax: 460,
    chaseCruise: 350,
    chaseFollow: 0.3,
    flipGap: 64,
    smashGap: 48,
    hitGap: 130,
    stumbleGap: 100,
    hitVsMul: 0.36,
    hitStumble: 0.8,
    catchTime: 0.85,
    chaseDanger: 100,

    // 小车强化。限时加速，撞上障碍按挥棍那套撞开，不改追赶距离的加减规则。
    kartTime: 5.2,
    kartAccel: 240,
    kartMaxVs: 760,
    kartBoost: 90,
    kartPad: 220,
    kartGapMin: 1080,
    kartGapRand: 480,

    // 二次失败：掉到坡面底下，或飞出可玩高度。
    deepFall: -220,
    oobHigh: 1500,
    landWindow: 80,

    // 曲率。凹（kappa < 0）加速，凸（kappa > 0）减速并减轻贴地。
    concaveK: 52000,
    convexK: 42000,
    crestLift: 0.55,
    lookMax: 120,
    lookGain: 0.5,
    lookSmooth: 7,

    // 镜头。数值越小越远。慢速靠近 zoomNear，高速靠近 zoomFar。
    zoomNear: 0.88,
    zoomFar: 0.67,
    zoomVsSlow: 210,
    zoomVsFast: 540,
    zoomSmooth: 2.35,

    // 动态坡。基准仍是 30°，上下起伏。
    arcBase: 36 * Math.PI / 180,
    arcAmp1: 0.34,
    arcWave1: 150,
    arcAmp2: 0.11,
    arcWave2: 86,
    arcPhase2: 0.7
  };

  function wrap(a) {
    return Math.atan2(Math.sin(a), Math.cos(a));
  }

  function hash01(n) {
    var x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  function slopeAngle(s) {
    return DH.arcBase
      + DH.arcAmp1 * Math.sin(s / DH.arcWave1)
      + DH.arcAmp2 * Math.sin(s / DH.arcWave2 + DH.arcPhase2);
  }

  function slopeKappa(s) {
    return (DH.arcAmp1 / DH.arcWave1) * Math.cos(s / DH.arcWave1)
      + (DH.arcAmp2 / DH.arcWave2) * Math.cos(s / DH.arcWave2 + DH.arcPhase2);
  }

  function zoomTarget(vs) {
    var span = DH.zoomVsFast - DH.zoomVsSlow;
    var t = span !== 0 ? (vs - DH.zoomVsSlow) / span : 0;
    t = clamp(t, 0, 1);
    t = t * t * (3 - 2 * t);
    return DH.zoomNear + (DH.zoomFar - DH.zoomNear) * t;
  }

  // 弧长积分。只跟 s 有关，各局共用一份缓存。
  var curve = {
    s0: -8000,
    step: 4,
    xs: [0],
    ys: [0]
  };

  function ensureCurve(targetS) {
    var step = curve.step;
    var s = curve.s0 + (curve.xs.length - 1) * step;
    var x = curve.xs[curve.xs.length - 1];
    var y = curve.ys[curve.ys.length - 1];
    if (targetS <= s) return;
    var limit = s + 24000;
    if (targetS > limit) targetS = limit;
    while (s < targetS) {
      var th = slopeAngle(s + step * 0.5);
      s += step;
      x += Math.cos(th) * step;
      y += Math.sin(th) * step;
      curve.xs.push(x);
      curve.ys.push(y);
    }
  }

  function curvePos(s) {
    ensureCurve(s + curve.step);
    var idx = (s - curve.s0) / curve.step;
    if (idx < 0) idx = 0;
    var i = Math.floor(idx);
    var max = curve.xs.length - 2;
    if (i > max) i = max;
    if (i < 0) i = 0;
    var f = idx - i;
    if (f < 0) f = 0;
    if (f > 1) f = 1;
    return {
      x: curve.xs[i] + (curve.xs[i + 1] - curve.xs[i]) * f,
      y: curve.ys[i] + (curve.ys[i + 1] - curve.ys[i]) * f
    };
  }

  function pointOnSlope(s, h) {
    var th = slopeAngle(s);
    var p = curvePos(s);
    return {
      x: p.x + Math.sin(th) * h,
      y: p.y - Math.cos(th) * h,
      th: th
    };
  }

  ensureCurve(6000);

  // 手在身前。平时棍子从这里斜横过身前，不沿坡刺出去，也不从头顶竖起。
  function stickPivot() {
    return { x: 22, y: 18 };
  }

  function stickAngle(phase) {
    var e = 1 - Math.pow(1 - clamp(phase, 0, 1), 3);
    // 从身侧的手横过身前，再扫到坡下。0 是沿坡向下。
    return -1.05 + 1.9 * e;
  }

  // 击打判定仍用 stickAngle。起势往上抬一点，挥完收回横持。
  function visualStickAngle(pose) {
    var idle = stickAngle(0);
    if (!pose || pose.mode === "idle") return idle;
    if (pose.mode === "windup") {
      var cocked = idle - 0.55;
      return idle + (cocked - idle) * Math.sin(clamp(pose.phase, 0, 1) * Math.PI);
    }
    if (pose.mode === "swing") {
      var base = stickAngle(pose.phase);
      var p = clamp(pose.phase, 0, 1);
      if (p > 0.86) return base + 0.26 * ((p - 0.86) / 0.14);
      return base;
    }
    if (pose.mode === "recover") {
      var end = stickAngle(1) + 0.26;
      var p = clamp(pose.phase, 0, 1);
      var e = 1 - Math.pow(1 - p, 2);
      return end + (idle - end) * e - Math.sin(p * Math.PI) * 0.1;
    }
    return idle;
  }

  function stickLocals(phase) {
    var phi = stickAngle(phase);
    var piv = stickPivot();
    var len = DH.stick;
    var pts = [];
    var i;
    for (i = 1; i <= 5; i++) {
      var t = i / 5;
      pts.push({
        x: piv.x + Math.cos(phi) * len * t,
        y: piv.y + Math.sin(phi) * len * t,
        phi: phi
      });
    }
    return pts;
  }

  // 角色局部坐标：+x 朝坡下，+y 朝脚下。rot 为相对正立的顺时针转角。
  function localToSlope(rot, lx, ly) {
    var c = Math.cos(rot);
    var s = Math.sin(rot);
    return {
      s: lx * c - ly * s,
      h: -lx * s - ly * c
    };
  }

  function rampProfile(o, s) {
    var t = (s - o.s) / o.len;
    if (t < 0 || t >= 1) return 0;
    if (t < 0.78) return o.peak * (t / 0.78);
    return o.peak;
  }

  function createSession(options) {
    var rng = (options && options.rng) || Math.random;
    var empty = !!(options && options.empty);
    var rotateDir = 0;
    var smashQueued = false;
    var smashMode = "idle";
    var smashPhase = 0;
    var smashGround = false;
    var bonus = 0;
    var pulse = 0;
    var chase = DH.chaseStart;
    var sprintMode = "idle";
    var sprintK = 0;
    var sprintCd = 0;
    var sprintLeft = 0;
    var sprintFrom = 0;
    var sprintDest = 0;
    var sprintRate = 0;
    var zoom = zoomTarget(260);
    var look = 0;
    var bag = {};
    var popups = [];
    var bits = [];
    var safeS = 0;

    var player = {
      s: 0,
      h: DH.feet,
      vs: 260,
      vh: 0,
      rot: 0,
      omega: 0,
      grounded: true,
      alive: true,
      stumble: 0,
      airRot: 0,
      invuln: 0,
      caught: false,
      catchT: 0,
      kart: 0
    };
    zoom = zoomTarget(player.vs);

    var obstacles = [];
    var nextS = 1400;
    if (!empty) {
      obstacles.push({ kind: "ramp", s: 440, len: 176, peak: 56, alive: true });
      obstacles.push({ kind: "rock", s: 1180, w: 36, hgt: 42, alive: true });
      obstacles.push({ kind: "kart", s: 1560, w: 36, hgt: 36, alive: true });
      obstacles.push({ kind: "tree", s: 2140, w: 28, hgt: 74, alive: true });
      nextS = 3000;
    }

    var clouds = [
      { s: 160, h: 220, kind: "cloud1" },
      { s: 620, h: 270, kind: "yjr" },
      { s: 1080, h: 200, kind: "cloud2" }
    ];
    var flakes = [];
    var f;
    for (f = 0; f < 18; f++) {
      flakes.push({
        s: -180 + f * 70,
        h: 30 + hash01(f + 4) * 160,
        r: 1.2 + hash01(f + 9) * 1.6
      });
    }

    function terrainHeight(s) {
      var h = 0;
      var i;
      for (i = 0; i < obstacles.length; i++) {
        var o = obstacles[i];
        if (o.kind !== "ramp") continue;
        var p = rampProfile(o, s);
        if (p > h) h = p;
      }
      return h;
    }

    function floorH(s) {
      return terrainHeight(s) + DH.feet;
    }

    function rampAt(s) {
      var i;
      for (i = 0; i < obstacles.length; i++) {
        var o = obstacles[i];
        if (o.kind === "ramp" && s >= o.s && s < o.s + o.len) return o;
      }
      return null;
    }

    function rampLipBefore(s) {
      var lip = -1e9;
      var i;
      for (i = 0; i < obstacles.length; i++) {
        var o = obstacles[i];
        if (o.kind !== "ramp") continue;
        var end = o.s + o.len;
        if (end <= s && end > lip) lip = end;
      }
      return lip;
    }

    function mark(name) {
      bag[name] = true;
    }

    function pop(text, s, h) {
      popups.push({ text: text, s: s, h: h, life: 0.95 });
      if (popups.length > 6) popups.shift();
    }

    function burst(s, h) {
      var n = bits.length + Math.floor(s);
      var i;
      for (i = 0; i < 6; i++) {
        bits.push({
          s: s,
          h: h,
          vs: (hash01(n + i * 3) - 0.5) * 140,
          vh: 40 + hash01(n + i * 5) * 110,
          life: 0.42
        });
      }
      if (bits.length > 48) bits.splice(0, bits.length - 48);
    }

    function circleHits(cx, cy, rad, o) {
      var nx = Math.max(o.s, Math.min(cx, o.s + o.w));
      var ny = Math.max(0, Math.min(cy, o.hgt));
      var dx = cx - nx;
      var dy = cy - ny;
      return dx * dx + dy * dy <= rad * rad;
    }

    function addGap(amount) {
      chase = clamp(chase + amount, 0, DH.chaseMax);
      if (amount > 0 && sprintMode === "dash") sprintDest += amount;
    }

    // 用自己的随机，不占用关卡生成的 rng。间隔忽长忽短，第一次略晚。
    function sprintUnit() {
      return Math.random();
    }

    function sprintGap(first) {
      if (first) return 5.6 + sprintUnit() * 4.0;
      var roll = sprintUnit();
      if (roll < 0.35) return 2.4 + sprintUnit() * 1.6;
      if (roll < 0.7) return 4.2 + sprintUnit() * 2.2;
      return 6.5 + sprintUnit() * 3.2;
    }

    function armSprint() {
      if (!player.alive || player.caught || chase < 78) {
        sprintMode = "idle";
        sprintK = 0;
        sprintCd = 1.3 + sprintUnit() * 2.1;
        return;
      }
      sprintMode = "windup";
      sprintLeft = 0.38;
      sprintK = 0;
    }

    function launchSprint() {
      var margin = 28 + sprintUnit() * 16;
      if (!(chase > margin + 70)) {
        sprintMode = "idle";
        sprintK = 0;
        sprintCd = 1.5 + sprintUnit() * 2.4;
        return;
      }
      sprintMode = "dash";
      sprintFrom = chase;
      sprintDest = margin;
      sprintLeft = 0.34;
      sprintRate = 0;
      sprintK = 1;
    }

    function tickSprint(dt) {
      if (!player.alive || player.caught) return;
      if (sprintMode === "idle") {
        sprintCd -= dt;
        sprintK = 0;
        if (sprintCd <= 0) armSprint();
        return;
      }
      if (sprintMode === "windup") {
        sprintLeft -= dt;
        sprintK = clamp(1 - sprintLeft / 0.38, 0, 1);
        if (sprintLeft <= 0) launchSprint();
        return;
      }
      sprintLeft -= dt;
      sprintK = 1;
      if (chase > sprintDest) {
        var left = sprintLeft > 0.016 ? sprintLeft : 0.016;
        var gap = chase - sprintDest;
        chase -= gap * Math.min(1, dt / left);
        if (chase < sprintDest) chase = sprintDest;
      }
      if (sprintLeft <= 0) {
        sprintMode = "idle";
        sprintK = 0;
        sprintCd = sprintGap(false);
      }
    }

    function pushHazards(fromS, minS) {
      if (!(minS > fromS)) return;
      var list = [];
      var i;
      for (i = 0; i < obstacles.length; i++) {
        var o = obstacles[i];
        if (!o.alive) continue;
        if (o.kind !== "rock" && o.kind !== "tree" && o.kind !== "kart") continue;
        if (o.s < fromS || o.s >= minS) continue;
        list.push(o);
      }
      list.sort(function (a, b) { return a.s - b.s; });
      var cursor = minS;
      for (i = 0; i < list.length; i++) {
        list[i].s = cursor;
        cursor += Math.max(100, (list[i].w || 30) + 80);
      }
    }

    function noteClear() {
      var dist = Math.max(DH.landClear, player.vs * DH.bufferTime);
      var until = player.s + dist;
      if (until > safeS) safeS = until;
      pushHazards(player.s - 4, until);
    }

    function die(reason) {
      if (!player.alive) return;
      player.alive = false;
      player.caught = false;
      session.cause = reason;
      mark("dead");
    }

    function beginCatch() {
      if (player.caught || !player.alive) return;
      player.caught = true;
      player.catchT = DH.catchTime;
      player.stumble = DH.catchTime;
      chase = 0;
      session.cause = "被飞鼠追上";
      mark("catch");
    }

    function speedCap() {
      return player.kart > 0 ? DH.kartMaxVs : DH.maxVs;
    }

    function breakObstacle(o) {
      if (!o.alive) return;
      o.alive = false;
      o.grazed = true;
      player.vs = Math.min(speedCap(), player.vs + 110);
      if (player.grounded) {
        player.grounded = false;
        player.h += 4;
      }
      player.vh = Math.max(player.vh, 180);
      bonus += 15;
      addGap(DH.smashGap);
      pulse += 1;
      mark("smash");
      pop("击碎 +15", o.s + o.w * 0.5, o.hgt + 44);
      burst(o.s + o.w * 0.5, Math.max(16, o.hgt * 0.55));
    }

    function land(floor) {
      player.h = floor;
      player.vh = 0;
      player.grounded = true;
      var ang = wrap(player.rot);
      if (Math.abs(ang) > DH.landTol) {
        player.stumble = DH.stumbleTime;
        player.vs *= 0.62;
        bonus -= 8;
        addGap(-DH.stumbleGap);
        player.rot = 0;
        player.omega = 0;
        mark("stumble");
        pop("踉跄 -8", player.s + 78, player.h + 6);
      } else {
        var spins = Math.floor((Math.abs(player.airRot) + 0.35) / (Math.PI * 2));
        if (spins > 0) {
          var add = spins * 40;
          bonus += add;
          addGap(spins * DH.flipGap);
          mark("flip");
          pop("翻转 +" + add, player.s + 78, player.h + 18);
        }
        player.rot = ang;
        player.omega = 0;
      }
      player.airRot = 0;
      noteClear();
    }

    function resolveSmash() {
      if (smashMode !== "swing") return;
      if (smashPhase < 0.12 || smashPhase > 0.98) return;
      var locals = stickLocals(smashPhase);
      var i, k;
      for (i = 0; i < locals.length; i++) {
        var off = localToSlope(player.rot, locals[i].x, locals[i].y);
        var ss = player.s + off.s;
        var hh = player.h + off.h;
        if (!smashGround && !player.grounded && smashPhase > 0.35 && hh <= terrainHeight(ss) + 2) {
          smashGround = true;
          player.vh = Math.max(player.vh, 300);
          player.vs = Math.min(speedCap(), player.vs + 55);
          player.h = Math.max(player.h, floorH(player.s) + 6);
          mark("smash");
          pop("撑了一下", player.s + 78, player.h + 14);
        }
        for (k = 0; k < obstacles.length; k++) {
          var o = obstacles[k];
          if (!o.alive || (o.kind !== "rock" && o.kind !== "tree")) continue;
          if (circleHits(ss, hh, 16, o)) breakObstacle(o);
        }
      }
    }

    function resolveBody() {
      if (!player.alive || player.caught || player.invuln > 0) return;
      var i;
      for (i = 0; i < obstacles.length; i++) {
        var o = obstacles[i];
        if (!o.alive || o.grazed || (o.kind !== "rock" && o.kind !== "tree")) continue;
        if (!circleHits(player.s, player.h, DH.bodyR, o)) continue;
        if (player.kart > 0) {
          breakObstacle(o);
          continue;
        }
        o.grazed = true;
        player.invuln = 0.7;
        player.stumble = Math.max(player.stumble, DH.hitStumble);
        player.vs = Math.max(70, player.vs * DH.hitVsMul);
        if (player.grounded) {
          player.grounded = false;
          player.h += 8;
          player.vh = Math.max(player.vh, 110);
        } else {
          player.vh = Math.min(player.vh, 80);
        }
        player.s = Math.max(player.s, o.s + o.w + DH.bodyR + 2);
        bonus -= 6;
        addGap(-DH.hitGap);
        mark("hit");
        pop("撞上了", player.s + 36, player.h + 28);
        break;
      }
    }

    function caughtStep(dt) {
      player.catchT -= dt;
      player.stumble = Math.max(0, player.catchT);
      player.vs = Math.max(0, player.vs - 260 * dt);
      if (player.grounded) {
        player.s += player.vs * dt;
        player.h = floorH(player.s);
        player.vh = 0;
      } else {
        player.vh -= DH.gravity * Math.cos(slopeAngle(player.s)) * dt;
        player.s += player.vs * dt;
        player.h += player.vh * dt;
        var floor = floorH(player.s);
        if (player.h <= floor) {
          player.h = floor;
          player.vh = 0;
          player.grounded = true;
        }
      }
      if (player.catchT <= 0) die("被飞鼠追上");
    }

    function step(dt) {
      if (!player.alive) return;
      if (player.caught) {
        caughtStep(dt);
        return;
      }
      if (player.kart > 0) {
        player.kart -= dt;
        if (player.kart < 0) player.kart = 0;
      }

      if (player.invuln > 0) {
        player.invuln -= dt;
        if (player.invuln < 0) player.invuln = 0;
      }
      if (player.stumble > 0) {
        player.stumble -= dt;
        if (player.stumble < 0) player.stumble = 0;
      }

      if (smashMode === "windup") {
        smashPhase += dt / DH.windup;
        if (smashPhase >= 1) {
          smashMode = "swing";
          smashPhase = 0;
          smashGround = false;
        }
      } else if (smashMode === "swing") {
        smashPhase += dt / DH.swing;
        if (smashPhase >= 1) {
          smashMode = "recover";
          smashPhase = 0;
        }
      } else if (smashMode === "recover") {
        smashPhase += dt / DH.recover;
        if (smashPhase >= 1) {
          smashMode = "idle";
          smashPhase = 0;
        }
      }
      if (smashQueued && player.stumble <= 0 && player.alive && smashMode === "idle") {
        smashQueued = false;
        smashMode = "windup";
        smashPhase = 0;
      } else if (smashQueued && player.stumble > 0) {
        smashQueued = false;
      }

      var canTurn = player.stumble <= 0;
      if (!player.grounded && canTurn) {
        if (rotateDir > 0) player.omega += DH.rotAccel * dt;
        else if (rotateDir < 0) player.omega -= DH.rotAccel * dt;
        else player.omega *= Math.exp(-1.65 * dt);
        player.omega = clamp(player.omega, -DH.maxOmega, DH.maxOmega);
        var dRot = player.omega * dt;
        player.rot += dRot;
        player.airRot += dRot;
      }

      var th = slopeAngle(player.s);
      var kappa = slopeKappa(player.s);
      var drag = player.grounded ? DH.drag : DH.airDrag;
      var accel = DH.gravity * Math.sin(th) - drag * player.vs;
      if (player.grounded) {
        if (kappa < 0) accel += DH.concaveK * (-kappa);
        else accel -= DH.convexK * kappa;
      }
      if (player.kart > 0 && player.stumble <= 0) accel += DH.kartAccel;
      player.vs += accel * dt;
      player.vs = clamp(player.vs, 0, speedCap());

      if (player.grounded && !rampAt(player.s) && kappa > 0.0009 && player.vs > 545) {
        var hold = DH.gravity * Math.cos(th);
        var light = DH.crestLift * kappa * player.vs * player.vs;
        if (light > hold * 0.62) {
          player.grounded = false;
          player.vh = Math.min(200, (light - hold * 0.62) * 0.2);
          player.h += 3;
          player.airRot = 0;
          mark("crest");
        }
      }

      if (player.grounded) {
        var before = rampAt(player.s);
        var prevS = player.s;
        player.s += player.vs * dt;
        var after = rampAt(player.s);
        if (before && !after) {
          player.grounded = false;
          player.vs = Math.min(speedCap(), player.vs + DH.rampVs);
          player.vh = Math.max(DH.jumpV * DH.rampVhMul, player.vs * 0.4 + DH.rampVhAdd);
          player.h = terrainHeight(prevS) + DH.feet + 2;
          player.airRot = 0;
          mark("launch");
          noteClear();
        } else {
          player.h = floorH(player.s);
          player.vh = 0;
          if (canTurn) {
            player.omega = 0;
            player.rot *= Math.exp(-10 * dt);
            if (Math.abs(player.rot) < 0.015) player.rot = 0;
          }
        }
      } else {
        var airTh = slopeAngle(player.s);
        var airK = slopeKappa(player.s);
        player.vh += (-DH.gravity * Math.cos(airTh) + DH.crestLift * airK * player.vs * player.vs) * dt;
        player.s += player.vs * dt;
        player.h += player.vh * dt;
        if (player.h < DH.deepFall) {
          die("严重摔出");
          return;
        }
        if (player.h > DH.oobHigh) {
          die("飞出界外");
          return;
        }
        var floor = floorH(player.s);
        if (player.h <= floor && player.vh <= 0) {
          if (player.h < floor - DH.landWindow) {
            die("严重摔出");
            return;
          }
          land(floor);
        }
      }

      if (!player.alive) return;
      resolveSmash();
      resolveBody();
      resolvePickup();
      chase += (player.vs - DH.chaseCruise) * DH.chaseFollow * dt;
      tickSprint(dt);
      chase = clamp(chase, 0, DH.chaseMax);
      if (chase <= 0) beginCatch();
    }

    function hazardNear(s, pad) {
      var i;
      for (i = 0; i < obstacles.length; i++) {
        var o = obstacles[i];
        if (!o.alive) continue;
        if (o.kind !== "rock" && o.kind !== "tree" && o.kind !== "kart" && o.kind !== "ramp") continue;
        var end = o.s + (o.len || o.w || 30);
        if (s + 28 > o.s - pad && s < end + pad) return o;
      }
      return null;
    }

    function resolvePickup() {
      if (!player.alive || player.caught) return;
      var i;
      for (i = 0; i < obstacles.length; i++) {
        var o = obstacles[i];
        if (o.kind !== "kart" || !o.alive) continue;
        var ds = player.s - (o.s + (o.w || 36) * 0.5);
        var dh = player.h - (terrainHeight(o.s) + 24);
        if (ds * ds + dh * dh > 48 * 48) continue;
        o.alive = false;
        player.kart = DH.kartTime;
        player.vs = Math.min(DH.kartMaxVs, player.vs + DH.kartBoost);
        if (player.stumble > 0.2) player.stumble = 0.2;
        mark("kart");
        pop("开车!", player.s + 48, player.h + 28);
        break;
      }
    }

    function spawnOne() {
      var roll = rng();
      var kind = roll < 0.4 ? "rock" : (roll < 0.62 ? "tree" : (roll < 0.78 ? "kart" : "ramp"));
      var guard = 0;
      if (kind !== "ramp") {
        var lip = rampLipBefore(nextS + 0.001);
        if (lip > -1e8 && nextS < lip + DH.rampClear) nextS = lip + DH.rampClear;
        if (nextS < safeS) nextS = safeS;
        while (guard < 4) {
          var blocked = null;
          var i;
          for (i = 0; i < obstacles.length; i++) {
            var o = obstacles[i];
            if (o.kind !== "ramp") continue;
            if (nextS < o.s + o.len + DH.rampClear && nextS + 40 > o.s) {
              blocked = o;
              break;
            }
          }
          if (!blocked) break;
          nextS = blocked.s + blocked.len + DH.rampClear;
          guard += 1;
        }
      }

      var gap;
      if (kind === "rock") {
        obstacles.push({
          kind: "rock",
          s: nextS,
          w: 34,
          hgt: 36 + Math.floor(rng() * 12),
          alive: true
        });
        gap = DH.rockGapMin + rng() * DH.rockGapRand;
      } else if (kind === "tree") {
        obstacles.push({ kind: "tree", s: nextS, w: 28, hgt: 72, alive: true });
        gap = DH.treeGapMin + rng() * DH.treeGapRand;
      } else if (kind === "kart") {
        var padGuard = 0;
        while (padGuard < 5) {
          var near = hazardNear(nextS, DH.kartPad);
          if (!near) break;
          nextS = near.s + (near.len || near.w || 30) + DH.kartPad;
          padGuard += 1;
        }
        obstacles.push({ kind: "kart", s: nextS, w: 36, hgt: 36, alive: true });
        gap = DH.kartGapMin + rng() * DH.kartGapRand;
      } else {
        var len = 156 + Math.floor(rng() * 36);
        obstacles.push({
          kind: "ramp",
          s: nextS,
          len: len,
          peak: 46 + rng() * 24,
          alive: true
        });
        gap = DH.rampGapMin + rng() * DH.rampGapRand;
        var end = nextS + len;
        var advance = Math.max(DH.gapMin, gap - Math.min(DH.gapTighten, player.s / 180));
        nextS += advance;
        if (nextS < end + DH.rampClear) nextS = end + DH.rampClear;
        return;
      }
      var tighten = Math.min(DH.gapTighten, player.s / 180);
      nextS += Math.max(DH.gapMin, gap - tighten);
    }

    sprintCd = sprintGap(true);

    var session = {
      player: player,
      obstacles: obstacles,
      popups: popups,
      bits: bits,
      cause: "",
      kind: "downhill",
      time: 0
    };

    Object.defineProperty(session, "score", {
      get: function () {
        var v = Math.floor(player.s / DH.scorePer + 1e-6) + bonus;
        return v > 0 ? v : 0;
      }
    });
    Object.defineProperty(session, "bonus", {
      get: function () { return bonus; }
    });
    Object.defineProperty(session, "chase", {
      get: function () { return chase; },
      set: function (v) { chase = clamp(Number(v) || 0, 0, DH.chaseMax); }
    });
    Object.defineProperty(session, "zoom", {
      get: function () { return zoom; }
    });
    Object.defineProperty(session, "look", {
      get: function () { return look; }
    });
    Object.defineProperty(session, "pulse", {
      get: function () { return pulse; }
    });
    Object.defineProperty(session, "sprintMode", {
      get: function () { return sprintMode; }
    });
    Object.defineProperty(session, "sprintK", {
      get: function () { return sprintK; }
    });

    session.setRotate = function (dir) {
      rotateDir = dir > 0 ? 1 : (dir < 0 ? -1 : 0);
    };

    session.jump = function () {
      if (!player.alive || !player.grounded || player.stumble > 0 || player.caught) return false;
      player.grounded = false;
      player.vh = DH.jumpV;
      player.h += 3;
      player.vs = Math.min(speedCap(), player.vs + 24);
      player.airRot = 0;
      return true;
    };

    session.smash = function () {
      if (!player.alive || player.caught) return false;
      smashQueued = true;
      return true;
    };

    session.stickPose = function () {
      return {
        mode: smashMode,
        phase: smashPhase
      };
    };

    function easeZoom(dt) {
      var target = zoomTarget(player.vs);
      var k = 1 - Math.exp(-DH.zoomSmooth * dt);
      zoom += (target - zoom) * k;
      var lift = 0;
      if (!player.grounded) lift = Math.max(0, player.h - terrainHeight(player.s) - DH.feet);
      var lookTarget = Math.min(DH.lookMax, lift * DH.lookGain);
      var lookK = 1 - Math.exp(-DH.lookSmooth * dt);
      look += (lookTarget - look) * lookK;
    }

    session.update = function (dt) {
      if (!player.alive) return ["dead"];
      if (!(dt > 0)) return [];
      bag = {};
      var steps = Math.ceil(dt / (1 / 120));
      if (steps < 1) steps = 1;
      if (steps > 10) steps = 10;
      var hdt = dt / steps;
      var n;
      for (n = 0; n < steps; n++) {
        step(hdt);
        if (!player.alive) break;
      }

      session.time += dt;
      easeZoom(dt);
      ensureCurve(player.s + 5000);

      var i;
      for (i = popups.length - 1; i >= 0; i--) {
        popups[i].life -= dt;
        popups[i].h += 26 * dt;
        if (popups[i].life <= 0) popups.splice(i, 1);
      }
      for (i = bits.length - 1; i >= 0; i--) {
        var b = bits[i];
        b.life -= dt;
        b.s += b.vs * dt;
        b.h += b.vh * dt;
        b.vh -= 520 * dt;
        if (b.life <= 0) bits.splice(i, 1);
      }
      for (i = 0; i < clouds.length; i++) {
        var cloud = clouds[i];
        cloud.s += player.vs * dt * 0.42;
        if (cloud.s < player.s - 280) {
          cloud.s = player.s + 860 + hash01(cloud.s + i) * 240;
          cloud.h = 190 + hash01(cloud.s + 4) * 110;
          var roll = hash01(cloud.s + 8);
          cloud.kind = roll < 0.18 ? "yjr" : (roll < 0.55 ? "cloud1" : "cloud2");
        }
      }
      for (i = 0; i < flakes.length; i++) {
        if (flakes[i].s < player.s - 320) flakes[i].s += 1400;
      }

      if (!empty && player.alive) {
        var guard = 0;
        while (nextS < player.s + 1900 && guard < 8) {
          spawnOne();
          guard += 1;
        }
      }
      obstacles = obstacles.filter(function (o) {
        if ((o.kind === "rock" || o.kind === "tree" || o.kind === "kart") && !o.alive) return false;
        var end = o.s + (o.len || o.w || 0);
        return end > player.s - 1600;
      });
      session.obstacles = obstacles;

      var events = [];
      for (var key in bag) {
        if (Object.prototype.hasOwnProperty.call(bag, key) && bag[key]) events.push(key);
      }
      return events;
    };

    session._terrain = terrainHeight;
    session._clouds = clouds;
    session._flakes = flakes;

    return session;
  }

  function roundRect(ctx, x, y, w, h, r) {
    var radius = r;
    if (radius > w / 2) radius = w / 2;
    if (radius > h / 2) radius = h / 2;
    if (radius < 0) radius = 0;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function ink(ctx, text, x, y, font) {
    ctx.font = font;
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = "#3c342c";
    ctx.fillText(text, x, y);
  }

  // 4 倍角色贴图缩回画面时保持各自宽高比。约等于原来 90px 左右的身高。
  var SPRITE_SCALE = 0.27;
  var FOOT_Y = 46;

  var rig = {
    session: null,
    time: 0,
    grounded: true,
    vs: 0,
    takeoff: 0,
    land: 0,
    sy: 1,
    sx: 1,
    lean: 0,
    whip: 0,
    air: 0,
    duck: 0,
    kart: 0,
    bob: 0,
    camY: 0,
    camV: 0,
    phase: 0,
    pulse: 0,
    ghosts: [],
    ghostT: 0
  };

  function bitmapSize(img, scale) {
    var ih = (img && (img.naturalHeight || img.height)) || 1;
    var iw = (img && (img.naturalWidth || img.width)) || 1;
    if (ih < 1) ih = 1;
    if (iw < 1) iw = 1;
    return { w: iw * scale, h: ih * scale };
  }

  function paintSprite(ctx, img, scale, footY, alpha) {
    if (!img || !(alpha > 0.02)) return;
    var size = bitmapSize(img, scale);
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.drawImage(img, -size.w / 2, footY - size.h, size.w, size.h);
    ctx.restore();
  }

  function easeToward(current, target, dt, speed) {
    if (!(dt > 0)) return current;
    return current + (target - current) * (1 - Math.exp(-speed * dt));
  }

  function syncRig(session, pose, reduce, phase) {
    var p = session.player;
    if (rig.session !== session) {
      rig.session = session;
      rig.time = session.time || 0;
      rig.grounded = !!p.grounded;
      rig.vs = p.vs || 0;
      rig.takeoff = 0;
      rig.land = 0;
      rig.sy = 1;
      rig.sx = 1;
      rig.lean = 0;
      rig.whip = 0;
      rig.air = p.grounded ? 0 : 1;
      rig.duck = p.stumble > 0 ? 1 : 0;
      rig.kart = p.kart > 0 ? 1 : 0;
      rig.bob = 0;
      rig.camY = 0;
      rig.camV = 0;
      rig.phase = phase || 0;
      rig.pulse = session.pulse || 0;
      rig.sprintMode = "idle";
      rig.ghosts = [];
      rig.ghostT = 0;
      return;
    }

    var dt = (session.time || 0) - rig.time;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.05) dt = 0.05;
    rig.time = session.time || 0;
    rig.phase = phase || 0;

    if (rig.grounded && !p.grounded && p.alive) {
      rig.takeoff = 0.2;
      rig.land = 0;
      if (!reduce) rig.camV -= 66;
    } else if (!rig.grounded && p.grounded && p.alive) {
      rig.land = 0.24;
      rig.takeoff = 0;
      if (!reduce) rig.camV += 60;
    }
    if ((session.pulse || 0) !== rig.pulse) {
      rig.pulse = session.pulse || 0;
      if (!reduce) rig.camV += 46;
    }
    var spNow = session.sprintMode || "idle";
    if (spNow === "dash" && rig.sprintMode !== "dash" && !reduce) rig.camV += 36;
    rig.sprintMode = spNow;
    rig.grounded = !!p.grounded;
    if (rig.takeoff > 0) rig.takeoff = Math.max(0, rig.takeoff - dt);
    if (rig.land > 0) rig.land = Math.max(0, rig.land - dt);

    var sy = 1;
    if (rig.takeoff > 0) {
      var u = 1 - rig.takeoff / 0.2;
      if (u < 0) u = 0;
      if (u > 1) u = 1;
      if (u < 0.45) sy = 1 - 0.22 * Math.sin((u / 0.45) * Math.PI);
      else sy = 0.86 + 0.32 * Math.sin(((u - 0.45) / 0.55) * Math.PI * 0.5);
    } else if (rig.land > 0) {
      var landed = 1 - rig.land / 0.24;
      if (landed < 0) landed = 0;
      if (landed > 1) landed = 1;
      if (landed < 0.4) sy = 1 - 0.26 * Math.sin((landed / 0.4) * Math.PI);
      else {
        var k = (landed - 0.4) / 0.6;
        sy = 0.78 + 0.22 * k + 0.08 * Math.sin(k * Math.PI);
      }
    } else if (p.grounded && !(p.kart > 0) && p.stumble <= 0) {
      var step = Math.sin(rig.phase * Math.PI * 4);
      sy = 1 + step * 0.06 + Math.min(0.05, Math.max(0, (p.vs - 320) / 5000));
    } else if (!p.grounded) {
      sy = 1 + clamp((p.vh || 0) / 1400, -0.06, 0.1);
    }
    if (p.stumble > 0 && rig.land <= 0 && rig.takeoff <= 0) sy *= 0.94;
    if (reduce) sy = 1 + (sy - 1) * 0.35;
    var sx = 1 / Math.pow(Math.max(0.68, sy), 0.7);
    rig.sy = easeToward(rig.sy, sy, dt, 18);
    rig.sx = easeToward(rig.sx, sx, dt, 18);

    var accel = dt > 0.0001 ? (p.vs - rig.vs) / dt : 0;
    var kappa = slopeKappa(p.s);
    var lean = clamp(accel / 2800, -0.14, 0.16);
    if (p.grounded) lean += clamp((p.vs - 240) / 3200, 0, 0.07);
    lean += clamp(-kappa * p.vs * 0.045, -0.07, 0.07);
    if (!p.grounded) lean = clamp((p.vh || 0) / 4200, -0.05, 0.06);
    if (p.stumble > 0) lean *= 0.4;
    if (p.kart > 0) lean *= 0.55;
    if (reduce) lean *= 0.4;
    rig.lean = easeToward(rig.lean, lean, dt, 6.5);
    rig.vs = p.vs;

    var whip = 0;
    if (!reduce && pose) {
      if (pose.mode === "windup") whip = -0.16 * Math.sin(clamp(pose.phase, 0, 1) * Math.PI);
      else if (pose.mode === "swing") whip = 0.18 * Math.sin(clamp(pose.phase, 0, 1) * Math.PI);
      else if (pose.mode === "recover") whip = 0.08 * (1 - clamp(pose.phase, 0, 1));
    }
    rig.whip = easeToward(rig.whip, whip, dt, 16);

    var duckT = p.stumble > 0 ? 1 : 0;
    rig.duck = easeToward(rig.duck, duckT, dt, 12);
    var airT = (!p.grounded && p.stumble <= 0) ? (rig.takeoff > 0.1 ? 0.12 : 1) : 0;
    rig.air = easeToward(rig.air, airT, dt, 15);
    rig.kart = easeToward(rig.kart, p.kart > 0 ? 1 : 0, dt, 7);

    var bob = 0;
    if (p.grounded && !(p.kart > 0) && p.stumble <= 0 && !reduce) {
      var stride = Math.sin(rig.phase * Math.PI * 4);
      bob = Math.max(0, stride) * (2.6 + Math.min(4.4, p.vs / 200));
    }
    rig.bob = easeToward(rig.bob, bob, dt, 14);

    var gi;
    for (gi = rig.ghosts.length - 1; gi >= 0; gi--) {
      rig.ghosts[gi].life -= dt;
      if (rig.ghosts[gi].life <= 0) rig.ghosts.splice(gi, 1);
    }
    if (!reduce && dt > 0 && p.alive && !p.caught) {
      var speedT = (p.vs - 430) / 240;
      if (p.kart > 0) speedT = Math.max(speedT, (p.vs - 380) / 240);
      if (speedT > 0) {
        rig.ghostT -= dt;
        if (rig.ghostT <= 0) {
          rig.ghostT = 0.05;
          rig.ghosts.push({
            s: p.s,
            h: p.h,
            rot: p.rot,
            lean: rig.lean + rig.whip,
            kart: rig.kart > 0.55,
            life: 0.12,
            max: 0.12,
            speed: speedT > 1 ? 1 : speedT
          });
          if (rig.ghosts.length > 4) rig.ghosts.shift();
        }
      }
    }

    if (!reduce && dt > 0) {
      var spring = 92;
      var damp = 13;
      rig.camV += (-spring * rig.camY - damp * rig.camV) * dt;
      rig.camY += rig.camV * dt;
      if (rig.camY > 12) rig.camY = 12;
      if (rig.camY < -12) rig.camY = -12;
    } else if (reduce) {
      rig.camY = 0;
      rig.camV = 0;
    }
  }

  function drawWorld(ctx, session, env) {
    var images = env.images;
    var player = session.player;
    var font = env.font;
    var reduce = !!(env && env.reduceMotion);
    var pose = session.stickPose();
    syncRig(session, pose, reduce, (env && env.animPhase) || 0);
    var zoom = session.zoom || 1;
    if (zoom < 0.45) zoom = 0.45;
    if (zoom > 1.05) zoom = 1.05;
    var origin = pointOnSlope(player.s, player.h - (session.look || 0));

    function world(s, h) {
      var p = pointOnSlope(s, h);
      return {
        x: DH.anchorX + (p.x - origin.x),
        y: DH.anchorY + (p.y - origin.y)
      };
    }

    var sky = ctx.createLinearGradient(0, 0, 80, DH.height);
    sky.addColorStop(0, "#8fd0ea");
    sky.addColorStop(0.42, "#d0f4f7");
    sky.addColorStop(1, "#fff1dc");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, DH.width, DH.height);

    drawMountains(ctx, player.s);

    ctx.save();
    if (!reduce && rig.camY) ctx.translate(0, rig.camY);
    ctx.translate(DH.anchorX, DH.anchorY);
    ctx.scale(zoom, zoom);
    ctx.translate(-DH.anchorX, -DH.anchorY);

    drawClouds(ctx, images, session._clouds, world);

    var pts = [];
    var ds;
    for (ds = -2100; ds <= 2800; ds += 18) {
      pts.push(world(player.s + ds, 0));
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    var i;
    for (i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    var tail = world(player.s + 2800, -2600);
    var head = world(player.s - 2100, -2600);
    ctx.lineTo(tail.x, tail.y);
    ctx.lineTo(head.x, head.y);
    ctx.closePath();
    var snow = ctx.createLinearGradient(0, 80, 0, DH.height);
    snow.addColorStop(0, "#f8fcff");
    snow.addColorStop(0.35, "#e7f3f6");
    snow.addColorStop(1, "#e6d3b2");
    ctx.fillStyle = snow;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 7;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.strokeStyle = "#3c342c";
    ctx.lineWidth = 3;
    ctx.stroke();

    drawRamps(ctx, session.obstacles, world);
    drawTracks(ctx, player.s, world);
    drawObstacles(ctx, session.obstacles, world, images, session.time);
    drawBits(ctx, session.bits, world);
    drawFlakes(ctx, session._flakes, world);
    drawShadow(ctx, player, world, session._terrain);
    drawWind(ctx, session, world, reduce);
    if (!player.caught) drawMomonga(ctx, session, world, images, reduce, false);
    drawGhosts(ctx, world, images, env && env.anim);
    drawRider(ctx, player, images, env.anim, pose, world, reduce);
    if (player.caught) drawMomonga(ctx, session, world, images, reduce, true);
    drawPopups(ctx, session.popups, world, font);
    ctx.restore();
  }

  function drawMountains(ctx, playerS) {
    var scroll = (playerS * 0.18) % 260;
    ctx.fillStyle = "#9fd4cf";
    ctx.beginPath();
    ctx.moveTo(0, 230);
    var x;
    for (x = -1; x <= 12; x++) {
      var px = x * 110 - scroll;
      var peak = 118 + hash01(x + 20) * 52;
      ctx.lineTo(px, peak);
      ctx.lineTo(px + 58, 214);
    }
    ctx.lineTo(DH.width, 250);
    ctx.lineTo(0, 250);
    ctx.fill();
  }

  function drawClouds(ctx, images, clouds, world) {
    if (!images || !clouds) return;
    var i;
    for (i = 0; i < clouds.length; i++) {
      var c = clouds[i];
      var img = images[c.kind] || images.cloud1;
      if (!img) continue;
      var p = world(c.s, c.h);
      ctx.drawImage(img, p.x - 50, p.y - 30, 100, 60);
    }
  }

  function drawRamps(ctx, obstacles, world) {
    var i;
    for (i = 0; i < obstacles.length; i++) {
      var o = obstacles[i];
      if (o.kind !== "ramp") continue;
      var start = world(o.s, 0);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      var k;
      for (k = 1; k <= 8; k++) {
        var t = (k / 8) * 0.78;
        var p = world(o.s + o.len * t, o.peak * (t / 0.78));
        ctx.lineTo(p.x, p.y);
      }
      var lip = world(o.s + o.len * 0.98, o.peak);
      var face = world(o.s + o.len, 0);
      ctx.lineTo(lip.x, lip.y);
      ctx.lineTo(face.x, face.y);
      ctx.closePath();
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#3c342c";
      ctx.lineJoin = "round";
      ctx.stroke();
    }
  }

  function drawTracks(ctx, playerS, world) {
    ctx.strokeStyle = "rgba(130, 164, 176, 0.55)";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    var base = Math.floor((playerS - 400) / 22) * 22;
    var s;
    for (s = base; s < playerS + 1400; s += 22) {
      if (hash01(s * 0.17) < 0.35) continue;
      var yOff = hash01(s + 2) > 0.5 ? 3 : 8;
      var a = world(s, yOff);
      var b = world(s + 12, yOff);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }

  function drawObstacles(ctx, obstacles, world, images, time) {
    var i;
    for (i = 0; i < obstacles.length; i++) {
      var o = obstacles[i];
      if (o.kind === "rock" && o.alive) drawRock(ctx, o, world);
      else if (o.kind === "tree" && o.alive) drawTree(ctx, o, world);
      else if (o.kind === "kart" && o.alive) drawKartPickup(ctx, o, world, images, time);
    }
  }

  function drawKartPickup(ctx, o, world, images, time) {
    var bob = Math.sin((time || 0) * 5 + o.s * 0.01) * 6;
    var mid = o.s + (o.w || 36) * 0.5;
    var p = world(mid, 34 + bob);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(slopeAngle(mid));
    ctx.strokeStyle = "#e2a84b";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, 10, 24, 8, 0, 0, Math.PI * 2);
    ctx.stroke();
    var img = images && images["usagi-car"];
    if (img) {
      var dh = 42;
      var dw = dh * ((img.width || 248) / (img.height || 299));
      ctx.drawImage(img, -dw / 2, -dh + 12, dw, dh);
    } else {
      ctx.fillStyle = "#7eb6e0";
      ctx.fillRect(-16, -14, 32, 18);
    }
    ctx.restore();
  }

  function drawRock(ctx, o, world) {
    var mid = o.s + o.w * 0.5;
    var top = world(mid, o.hgt);
    var left = world(o.s - 2, o.hgt * 0.35);
    var right = world(o.s + o.w + 2, o.hgt * 0.42);
    var footL = world(o.s + 2, 0);
    var footR = world(o.s + o.w - 2, 0);
    ctx.beginPath();
    ctx.moveTo(footL.x, footL.y);
    ctx.lineTo(left.x, left.y);
    ctx.lineTo(top.x, top.y);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(footR.x, footR.y);
    ctx.closePath();
    ctx.fillStyle = "#d9c6b2";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#3c342c";
    ctx.lineJoin = "round";
    ctx.stroke();
    var eye = world(mid - 4, o.hgt * 0.62);
    ctx.fillStyle = "#3c342c";
    ctx.beginPath();
    ctx.arc(eye.x, eye.y, 2.2, 0, Math.PI * 2);
    ctx.arc(eye.x + 8, eye.y + 1, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawTree(ctx, o, world) {
    var mid = o.s + o.w * 0.5;
    var base = world(mid, 0);
    var trunk = world(mid, o.hgt * 0.28);
    ctx.strokeStyle = "#6b4632";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(trunk.x, trunk.y);
    ctx.stroke();
    var layers = [0.42, 0.68, 0.96];
    var colors = ["#3f8f55", "#57a864", "#8dce8a"];
    var k;
    for (k = 0; k < layers.length; k++) {
      var y = o.hgt * layers[k];
      var half = 16 + (layers.length - k) * 8;
      var tip = world(mid, y + 16);
      var l = world(mid - half, y - 8);
      var r = world(mid + half, y - 6);
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(r.x, r.y);
      ctx.lineTo(l.x, l.y);
      ctx.closePath();
      ctx.fillStyle = colors[k];
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#3c342c";
      ctx.stroke();
    }
  }

  function drawBits(ctx, bits, world) {
    var i;
    for (i = 0; i < bits.length; i++) {
      var b = bits[i];
      var p = world(b.s, b.h);
      ctx.globalAlpha = Math.max(0, Math.min(1, b.life / 0.42));
      ctx.fillStyle = "#fffaf3";
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
  }

  function drawFlakes(ctx, flakes, world) {
    if (!flakes) return;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    var i;
    for (i = 0; i < flakes.length; i++) {
      var flake = flakes[i];
      var p = world(flake.s, flake.h);
      ctx.beginPath();
      ctx.arc(p.x, p.y, flake.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawWind(ctx, session, world, reduceMotion) {
    if (reduceMotion) return;
    var player = session.player;
    var t = (player.vs - 420) / 260;
    if (player.kart > 0) t = Math.max(t, 0.28);
    if (!(t > 0)) return;
    if (t > 1) t = 1;
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(62, 104, 124, " + (0.1 + t * 0.2) + ")";
    ctx.lineWidth = 2;
    var i;
    for (i = 0; i < 4; i++) {
      var back = 34 + i * 26 + ((rig.time * 110 + i * 37) % 30);
      var lift = 22 + (i * 19) % 46;
      var len = 16 + t * 22;
      var a = world(player.s - back, player.h + lift);
      var b = world(player.s - back - len, player.h + lift + (i % 2 ? 3 : -2));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawGhosts(ctx, world, images, anim) {
    if (!images || !rig.ghosts.length) return;
    var i;
    for (i = 0; i < rig.ghosts.length; i++) {
      var g = rig.ghosts[i];
      var img = null;
      if (g.kart) img = images["usagi-car"];
      else if ((rig.air || 0) > 0.5 && images.jump) img = images.jump;
      else if (anim && anim.current) img = anim.current();
      else img = images.jump;
      if (!img) continue;
      var p = world(g.s, g.h);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(slopeAngle(g.s) + g.rot + (g.lean || 0));
      ctx.globalAlpha = Math.max(0, g.life / g.max) * 0.15 * (g.speed || 1);
      if (g.kart) {
        var kh = 90;
        var kw = kh * ((img.naturalWidth || img.width || 1) / (img.naturalHeight || img.height || 1));
        ctx.scale(-1, 1);
        ctx.drawImage(img, -kw / 2, FOOT_Y - kh, kw, kh);
      } else {
        paintSprite(ctx, img, SPRITE_SCALE, FOOT_Y, 1);
      }
      ctx.restore();
    }
  }

  function drawShadow(ctx, player, world, terrain) {
    var ground = terrain(player.s);
    var feet = world(player.s, ground);
    var lift = Math.max(0, player.h - ground - DH.feet);
    var spread = 0.82 + 0.18 * (rig.sx || 1);
    var rx = Math.max(8, 20 - lift * 0.04) * spread;
    var th = slopeAngle(player.s);
    ctx.fillStyle = "rgba(60, 52, 44, " + (lift > 80 ? 0.08 : 0.2) + ")";
    ctx.beginPath();
    ctx.ellipse(feet.x, feet.y, rx, 6, th, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawMomonga(ctx, session, world, images, reduceMotion, lunging) {
    var player = session.player;
    var chase = session.chase || 0;
    var terrain = session._terrain;
    var vs = player.vs || 0;
    var urgency = 1 - chase / 240;
    if (urgency < 0) urgency = 0;
    if (urgency > 1) urgency = 1;
    var stride = 0;
    var step = 0;
    if (!reduceMotion) {
      stride = (session.time || 0) * (8.2 + vs / 150 + urgency * 5);
      step = Math.sin(stride);
    }
    var sy = 1 + (reduceMotion ? 0 : step * (0.075 + urgency * 0.04));
    var sx = 1 + (reduceMotion ? 0 : -step * 0.05);
    if (!reduceMotion && step < 0) {
      sy -= -step * (0.07 + urgency * 0.04);
      sx += -step * 0.05;
    }
    var bob = 0;
    if (!reduceMotion) bob = Math.max(0, step) * (6 + urgency * 5);
    var rock = reduceMotion ? 0 : Math.sin(stride) * (0.045 + urgency * 0.03);
    var ms = player.s - chase;
    var mh = terrain(ms) + bob * 0.45;
    var reach = 0;
    var lunge = 0;
    var sp = lunging ? "idle" : (session.sprintMode || "idle");
    var sk = lunging ? 0 : (session.sprintK || 0);
    if (sp === "windup") {
      sy = 0.74 - sk * 0.08;
      sx = 1.1 + sk * 0.1;
      bob = 0;
      rock = -0.18 * sk;
      reach = -14 * sk;
      mh = terrain(ms) + 2;
    } else if (sp === "dash") {
      sy = 0.8;
      sx = 1.22 + 0.42 * sk;
      bob = 0;
      rock = 0.22 * sk;
      reach = 22 * sk;
      mh = terrain(ms) + 1;
    }
    if (sp !== "idle" && !reduceMotion) {
      ctx.save();
      ctx.strokeStyle = "rgba(64, 104, 122, " + (0.16 + sk * 0.34) + ")";
      ctx.lineWidth = sp === "dash" ? 3.5 : 2.5;
      ctx.lineCap = "round";
      var nLine = sp === "dash" ? 4 : 2;
      var n;
      for (n = 0; n < nLine; n++) {
        var back = 18 + n * 16;
        var a = world(ms - back, mh + 14 + n * 6);
        var b = world(ms - back - (sp === "dash" ? 36 : 16), mh + 16 + n * 5);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (lunging) {
      var u = 1 - clamp(player.catchT / DH.catchTime, 0, 1);
      var wind = u < 0.28 ? u / 0.28 : 1;
      var strike = u < 0.28 ? 0 : clamp((u - 0.28) / 0.3, 0, 1);
      var ease = strike * strike * (3 - 2 * strike);
      var cock = Math.sin(wind * Math.PI) * (1 - ease);
      ms = player.s - (1 - ease) * 50 - cock * 8;
      mh = terrain(ms) + cock * 10 + ease * 2;
      sy = 0.8 + ease * 0.34 - cock * 0.1;
      sx = 0.92 + ease * 0.42 + cock * 0.1;
      rock = -0.14 * cock + 0.16 * ease;
      lunge = ease;
      reach = ease * 16 - cock * 8;
    }
    if (lunge > 0.25 && !reduceMotion) {
      ctx.save();
      ctx.strokeStyle = "rgba(64, 104, 122, " + (0.12 + lunge * 0.28) + ")";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      var n;
      for (n = 0; n < 3; n++) {
        var a = world(ms - 20 - n * 14, mh + 16 + n * 7);
        var b = world(ms - 46 - n * 18, mh + 20 + n * 5);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.restore();
    }
    var p = world(ms, mh);
    var th = slopeAngle(ms);
    var sprite = images && images["momonga-chaser"];
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(th + rock);
    ctx.translate(reach, 0);
    if (sprite) {
      var dh = 74;
      var dw = dh * ((sprite.naturalWidth || sprite.width || 394) / (sprite.naturalHeight || sprite.height || 334));
      ctx.fillStyle = "rgba(60, 52, 44, 0.18)";
      ctx.beginPath();
      ctx.ellipse(0, 4, dw * 0.28 * sx, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      var foot = 12;
      ctx.translate(0, foot);
      ctx.scale(-sx, sy);
      ctx.translate(0, -foot);
      // 原图尾巴在右侧。翻过来让脸朝坡下，脚落在坡面上。
      ctx.drawImage(sprite, -dw / 2, -dh + foot, dw, dh);
      ctx.restore();
      return;
    }
    ctx.scale(sx * 1.15, sy * 1.15);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "#3c342c";
    ctx.lineWidth = 3;

    ctx.fillStyle = "#7a4b32";
    ctx.beginPath();
    ctx.ellipse(-36, 2, 15, 9, -0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#efc2a0";
    ctx.beginPath();
    ctx.moveTo(-6, 0);
    ctx.quadraticCurveTo(10, -30, 32, -2);
    ctx.lineTo(12, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#8d5a3c";
    ctx.beginPath();
    ctx.ellipse(0, 0, 26, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#f6e6d4";
    ctx.beginPath();
    ctx.ellipse(2, 4, 13, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#8d5a3c";
    ctx.beginPath();
    ctx.arc(24, -3, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(18, -12);
    ctx.lineTo(23, -22);
    ctx.lineTo(28, -11);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#3c342c";
    ctx.beginPath();
    ctx.arc(28, -4, 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(34, -1, 1.6, 0, Math.PI * 2);
    ctx.fill();

    if (lunging) {
      ctx.strokeStyle = "rgba(60, 52, 44, 0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-52, 6);
      ctx.lineTo(-34, 2);
      ctx.moveTo(-48, -6);
      ctx.lineTo(-30, -2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawRider(ctx, player, images, anim, pose, world, reduceMotion) {
    if (!images) return;
    var p = world(player.s, player.h);
    var foot = FOOT_Y;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(slopeAngle(player.s) + player.rot + (rig.lean || 0) + (rig.whip || 0));
    if (player.stumble > 0) {
      var k = player.stumble / DH.stumbleTime;
      if (k > 1) k = 1;
      var wob = Math.sin(player.stumble * 34) * 0.42 * k;
      if (reduceMotion) wob *= 0.35;
      ctx.rotate(wob);
    }
    ctx.translate(0, -(rig.bob || 0));
    ctx.translate(0, foot);
    ctx.scale(rig.sx || 1, rig.sy || 1);
    ctx.translate(0, -foot);

    var kartA = rig.kart || 0;
    var hop = Math.sin(Math.min(1, Math.max(0, kartA)) * Math.PI) * 11;
    var kartImg = images["usagi-car"];
    if (kartImg && kartA > 0.03) {
      ctx.save();
      ctx.globalAlpha *= kartA;
      ctx.translate(0, -hop);
      var grow = 0.84 + 0.16 * kartA;
      ctx.translate(0, foot);
      ctx.scale(grow, grow);
      ctx.translate(0, -foot);
      // 车头朝局部 +x，也就是坡下、前进方向。
      ctx.scale(-1, 1);
      var kh = 90;
      var kw = kh * ((kartImg.naturalWidth || kartImg.width || 248) / (kartImg.naturalHeight || kartImg.height || 299));
      var drive = 0;
      if (!reduceMotion && kartA > 0.75) {
        drive = Math.sin((rig.time || 0) * (12 + Math.min(8, player.vs / 120))) * 1.4;
      }
      ctx.drawImage(kartImg, -kw / 2, foot - kh + drive, kw, kh);
      ctx.restore();
    }

    var bodyA = 1 - kartA;
    if (bodyA > 0.03) {
      ctx.save();
      ctx.translate(0, -hop * 0.65);
      var duckW = clamp(rig.duck || 0, 0, 1);
      var airW = clamp(rig.air || 0, 0, 1) * (1 - duckW);
      var runW = 1 - duckW - airW;
      if (runW < 0) runW = 0;
      var runImg = anim && anim.current ? anim.current() : null;
      paintSprite(ctx, runImg, SPRITE_SCALE, foot, bodyA * runW);
      paintSprite(ctx, images.jump, SPRITE_SCALE, foot, bodyA * airW);
      paintSprite(ctx, images.duck, SPRITE_SCALE, foot, bodyA * duckW);
      if (kartA < 0.5) {
        ctx.save();
        ctx.globalAlpha *= bodyA;
        drawStick(ctx, pose, reduceMotion);
        ctx.restore();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  function drawStick(ctx, pose, reduceMotion) {
    var angle = visualStickAngle(pose);
    var width = 8;
    if (pose.mode === "swing") width = 8 + 3.5 * Math.sin(clamp(pose.phase, 0, 1) * Math.PI);
    else if (pose.mode === "windup") width = 7;
    ctx.lineCap = "round";
    if (!reduceMotion && (pose.mode === "swing" || pose.mode === "windup")) {
      var back = pose.mode === "swing"
        ? visualStickAngle({ mode: "swing", phase: Math.max(0, pose.phase - 0.16) })
        : visualStickAngle({ mode: "windup", phase: Math.max(0, pose.phase - 0.18) });
      ctx.strokeStyle = pose.mode === "windup" ? "rgba(226, 168, 75, 0.28)" : "rgba(226, 168, 75, 0.4)";
      ctx.lineWidth = width + 1;
      strokeStick(ctx, back);
    }
    ctx.strokeStyle = "#e2a84b";
    ctx.lineWidth = width;
    var tip = strokeStick(ctx, angle);
    ctx.strokeStyle = "#fffaf2";
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x + Math.cos(angle) * 14, tip.y + Math.sin(angle) * 14);
    ctx.stroke();
  }

  function strokeStick(ctx, phi) {
    var piv = stickPivot();
    var tipX = piv.x + Math.cos(phi) * DH.stick;
    var tipY = piv.y + Math.sin(phi) * DH.stick;
    ctx.beginPath();
    ctx.moveTo(piv.x, piv.y);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    return { x: tipX, y: tipY };
  }

  function drawPopups(ctx, popups, world, font) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var face = "700 18px " + font;
    var i;
    for (i = 0; i < popups.length; i++) {
      var item = popups[i];
      var p = world(item.s, item.h);
      ctx.globalAlpha = Math.max(0, Math.min(1, item.life / 0.95));
      ink(ctx, item.text, p.x, p.y, face);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawDanger(ctx, session) {
    var chase = session.chase;
    var caught = !!(session.player && session.player.caught);
    var sp = session.sprintMode || "idle";
    var sk = session.sprintK || 0;
    var charging = sp === "windup" || sp === "dash";
    if (!caught && !(chase < DH.chaseDanger) && !charging) return;
    var k = caught ? 1 : 0;
    if (!caught && chase < DH.chaseDanger) k = (DH.chaseDanger - chase) / DH.chaseDanger;
    if (charging) k = Math.max(k, 0.42 + 0.58 * sk);
    if (k < 0) k = 0;
    if (k > 1) k = 1;
    var alpha = 0.14 + 0.32 * k;
    var g = ctx.createRadialGradient(
      DH.width / 2, DH.height / 2, DH.width * 0.28,
      DH.width / 2, DH.height / 2, DH.width * 0.68
    );
    g.addColorStop(0, "rgba(168, 48, 36, 0)");
    g.addColorStop(1, "rgba(168, 48, 36, " + alpha + ")");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, DH.width, DH.height);
  }

  function drawHud(ctx, session, env) {
    var font = env.font;
    var chase = session.chase;
    ctx.save();
    drawDanger(ctx, session);

    ctx.fillStyle = "rgba(255,248,239,0.92)";
    ctx.strokeStyle = "#3c342c";
    ctx.lineWidth = 2;
    roundRect(ctx, 10, 10, 268, 118, 12);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ink(ctx, "分数 " + session.score, 22, 16, "700 22px " + font);
    ink(ctx, "最高 " + (env.highScore || 0) + "  速度 " + Math.round(session.player.vs), 22, 44, "700 14px " + font);
    ink(ctx, "飞鼠 " + Math.round(chase), 22, 68, "700 14px " + font);

    var barX = 96;
    var barY = 70;
    var barW = 164;
    var barH = 12;
    var frac = clamp(chase / DH.chaseMax, 0, 1);
    ctx.fillStyle = "rgba(60,52,44,0.12)";
    roundRect(ctx, barX, barY, barW, barH, 6);
    ctx.fill();
    var danger = chase < DH.chaseDanger;
    ctx.fillStyle = danger ? "#d4533a" : (frac < 0.42 ? "#e2a84b" : "#3f8f55");
    if (frac > 0.01) {
      roundRect(ctx, barX, barY, Math.max(8, barW * frac), barH, 6);
      ctx.fill();
    }
    var tick = barX + barW * (DH.chaseDanger / DH.chaseMax);
    ctx.strokeStyle = "rgba(60,52,44,0.55)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(tick, barY - 2);
    ctx.lineTo(tick, barY + barH + 2);
    ctx.stroke();

    var hint = session.player && session.player.kart > 0
      ? ("开车 " + session.player.kart.toFixed(1) + "s")
      : "←→ 翻转   J 挥棍";
    ink(ctx, hint, 22, 96, "700 14px " + font);
    if (env.muted) {
      ctx.textAlign = "left";
      ink(ctx, "静音", DH.width - 64, 14, "700 16px " + font);
    }
    if (session.player && session.player.caught) drawCatchBanner(ctx, font);
    if (env.tip > 0) drawTip(ctx, env, font);
    ctx.restore();
  }

  function drawCatchBanner(ctx, font) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var text = "被追上了";
    var face = "700 34px " + font;
    ctx.font = face;
    var w = ctx.measureText(text).width + 56;
    var h = 62;
    var x = (DH.width - w) / 2;
    var y = 168;
    ctx.fillStyle = "rgba(255,248,239,0.95)";
    ctx.strokeStyle = "#3c342c";
    ctx.lineWidth = 3;
    roundRect(ctx, x, y, w, h, 14);
    ctx.fill();
    ctx.stroke();
    ink(ctx, text, DH.width / 2, y + h / 2, face);
    ctx.restore();
  }

  function drawTip(ctx, env, font) {
    var alpha = env.tip < 0.7 ? Math.max(0, env.tip / 0.7) : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    var x = 430;
    var y = 16;
    var w = 354;
    var h = 128;
    ctx.fillStyle = "rgba(255, 248, 239, 0.94)";
    ctx.strokeStyle = "#3c342c";
    ctx.lineWidth = 3;
    roundRect(ctx, x, y, w, h, 14);
    ctx.fill();
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#3c342c";
    ctx.font = "700 18px " + font;
    ctx.fillText("下山", x + 16, y + 12);
    ctx.font = "700 15px " + font;
    ctx.fillStyle = "#3c342c";
    ctx.fillText("空格 / ↑ 跳跃，跳台会把你抛起来", x + 16, y + 40);
    ctx.fillText("空中 ← 顺时针，→ 逆时针", x + 16, y + 64);
    ctx.fillText("J 挥棍。捡到小车会开一阵", x + 16, y + 88);
    ctx.restore();
  }

  root.UsagiDownhill = {
    CONFIG: DH,
    createSession: createSession,
    localToSlope: localToSlope,
    stickLocals: stickLocals,
    stickAngle: stickAngle,
    slopeAngle: slopeAngle,
    slopeKappa: slopeKappa,
    zoomTarget: zoomTarget,
    drawWorld: drawWorld,
    drawHud: drawHud
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
