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
    rotAccel: 30,
    maxOmega: 12,
    swing: 0.22,
    recover: 0.13,
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

  function stickAngle(phase) {
    var e = 1 - Math.pow(1 - clamp(phase, 0, 1), 3);
    return -1.65 + 2.8 * e;
  }

  function stickLocals(phase) {
    var phi = stickAngle(phase);
    var pivX = 16;
    var pivY = -12;
    var len = DH.stick;
    var pts = [];
    var i;
    for (i = 1; i <= 5; i++) {
      var t = i / 5;
      pts.push({
        x: pivX + Math.cos(phi) * len * t,
        y: pivY + Math.sin(phi) * len * t,
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
    var chase = DH.chaseStart;
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

      if (smashMode === "swing") {
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
        smashMode = "swing";
        smashPhase = 0;
        smashGround = false;
      } else if (smashQueued && player.stumble > 0) {
        smashQueued = false;
      }

      var canTurn = player.stumble <= 0;
      if (!player.grounded && canTurn) {
        if (rotateDir > 0) player.omega += DH.rotAccel * dt;
        else if (rotateDir < 0) player.omega -= DH.rotAccel * dt;
        else player.omega *= Math.exp(-0.45 * dt);
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

  function drawWorld(ctx, session, env) {
    var images = env.images;
    var player = session.player;
    var font = env.font;
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
    if (!player.caught) drawMomonga(ctx, session, world, images, env.reduceMotion, false);
    drawRider(ctx, player, images, env.anim, session.stickPose(), world, env.reduceMotion);
    if (player.caught) drawMomonga(ctx, session, world, images, env.reduceMotion, true);
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

  function drawShadow(ctx, player, world, terrain) {
    var ground = terrain(player.s);
    var feet = world(player.s, ground);
    var lift = Math.max(0, player.h - ground - DH.feet);
    var rx = Math.max(8, 20 - lift * 0.04);
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
    var bob = 0;
    if (!reduceMotion) bob = Math.sin((session.time || 0) * 6.2) * 3;
    var ms = player.s - chase;
    var mh = terrain(ms) + bob;
    var scale = 1;
    if (lunging) {
      var u = 1 - clamp(player.catchT / DH.catchTime, 0, 1);
      ms = player.s - (1 - u) * 42;
      mh = terrain(ms) + 6 + (1 - u) * 10;
      scale = 1.05 + u * 0.25;
    }
    var p = world(ms, mh);
    var th = slopeAngle(ms);
    var sprite = images && images["momonga-chaser"];
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(th);
    if (sprite) {
      var dh = 72 * scale;
      var dw = dh * ((sprite.width || 394) / (sprite.height || 334));
      ctx.fillStyle = "rgba(60, 52, 44, 0.18)";
      ctx.beginPath();
      ctx.ellipse(0, 4, dw * 0.28, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      // 原图尾巴在右侧。翻过来让脸朝坡下，脚落在坡面上。
      ctx.scale(-1, 1);
      ctx.drawImage(sprite, -dw / 2, -dh + 12, dw, dh);
      ctx.restore();
      return;
    }
    ctx.scale(scale * 1.15, scale * 1.15);
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
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(slopeAngle(player.s) + player.rot);
    if (player.stumble > 0) {
      var k = player.stumble / DH.stumbleTime;
      if (k > 1) k = 1;
      var wob = Math.sin(player.stumble * 34) * 0.42 * k;
      if (reduceMotion) wob *= 0.35;
      ctx.rotate(wob);
    }
    var kartImg = player.kart > 0 && images["usagi-car"];
    if (kartImg) {
      var kh = 90;
      var kw = kh * ((kartImg.width || 248) / (kartImg.height || 299));
      // 车头朝局部 +x，也就是坡下、前进方向。
      ctx.scale(-1, 1);
      ctx.drawImage(kartImg, -kw / 2, -kh + 40, kw, kh);
      ctx.restore();
      return;
    }
    var img = images.jump;
    if (player.stumble > 0 && images.duck) img = images.duck;
    else if (player.grounded && anim) img = anim.current();
    if (img === images.duck) {
      var ih = img.height || 70;
      var iw = img.width || 72;
      var dh = 60;
      var dw = dh * (iw / ih);
      ctx.drawImage(img, -dw / 2, -dh + 46, dw, dh);
    } else if (img) {
      ctx.drawImage(img, -34, -54, 68, 102);
    }
    drawStick(ctx, pose, reduceMotion);
    ctx.restore();
  }

  function drawStick(ctx, pose, reduceMotion) {
    var angle = stickAngle(0);
    if (pose.mode === "swing") angle = stickAngle(pose.phase);
    else if (pose.mode === "recover") {
      var end = stickAngle(1);
      var idle = stickAngle(0);
      angle = end + (idle - end) * clamp(pose.phase, 0, 1);
    }
    if (pose.mode === "swing" && !reduceMotion && pose.phase > 0.18) {
      ctx.strokeStyle = "rgba(226, 168, 75, 0.35)";
      ctx.lineWidth = 8;
      ctx.lineCap = "round";
      strokeStick(ctx, stickAngle(Math.max(0, pose.phase - 0.14)));
    }
    ctx.strokeStyle = "#e2a84b";
    ctx.lineWidth = 8;
    ctx.lineCap = "round";
    var tip = strokeStick(ctx, angle);
    ctx.strokeStyle = "#fffaf2";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x + Math.cos(angle) * 14, tip.y + Math.sin(angle) * 14);
    ctx.stroke();
  }

  function strokeStick(ctx, phi) {
    var pivX = 16;
    var pivY = -12;
    var tipX = pivX + Math.cos(phi) * DH.stick;
    var tipY = pivY + Math.sin(phi) * DH.stick;
    ctx.beginPath();
    ctx.moveTo(pivX, pivY);
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
    if (!caught && !(chase < DH.chaseDanger)) return;
    var k = caught ? 1 : (DH.chaseDanger - chase) / DH.chaseDanger;
    if (k < 0) k = 0;
    if (k > 1) k = 1;
    var alpha = 0.1 + 0.2 * k;
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
