/*
 * 下山模式。
 * 经典跑酷是平地横向卷轴；这里单独用坡面坐标：
 * s 沿坡向下，h 离坡面的高度，rot 相对坡面的转角（正值为顺时针）。
 * 落地时 rot 接近 0 就算稳住，歪得厉害会踉跄。挥棍的扇形跟着当前朝向走。
 */
(function (root) {
  "use strict";

  var ALPHA = 30 * Math.PI / 180;
  var TX = Math.cos(ALPHA);
  var TY = Math.sin(ALPHA);
  var NX = Math.sin(ALPHA);
  var NY = -Math.cos(ALPHA);

  var DH = {
    width: 800,
    height: 450,
    alpha: ALPHA,
    gravity: 1800,
    gSin: 1800 * Math.sin(ALPHA),
    gCos: 1800 * Math.cos(ALPHA),
    drag: 2.05,
    airDrag: 0.28,
    maxVs: 560,
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
    anchorY: 172
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
    var bag = {};
    var popups = [];
    var bits = [];

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
      airRot: 0
    };

    var obstacles = [];
    var nextS = 1400;
    if (!empty) {
      obstacles.push({ kind: "ramp", s: 280, len: 168, peak: 52, alive: true });
      obstacles.push({ kind: "rock", s: 980, w: 36, hgt: 40, alive: true });
      obstacles.push({ kind: "tree", s: 1320, w: 28, hgt: 74, alive: true });
      nextS = 1680;
    }

    var clouds = [
      { s: 160, h: 200, kind: "cloud1" },
      { s: 620, h: 250, kind: "yjr" },
      { s: 1080, h: 180, kind: "cloud2" }
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

    function breakObstacle(o) {
      if (!o.alive) return;
      o.alive = false;
      player.vs = Math.min(DH.maxVs, player.vs + 110);
      if (player.grounded) {
        player.grounded = false;
        player.h += 4;
      }
      player.vh = Math.max(player.vh, 180);
      bonus += 15;
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
        player.rot = 0;
        player.omega = 0;
        mark("stumble");
        pop("踉跄 -8", player.s + 78, player.h + 6);
      } else {
        var spins = Math.floor((Math.abs(player.airRot) + 0.35) / (Math.PI * 2));
        if (spins > 0) {
          var add = spins * 40;
          bonus += add;
          mark("flip");
          pop("翻转 +" + add, player.s + 78, player.h + 18);
        }
        player.rot = ang;
        player.omega = 0;
      }
      player.airRot = 0;
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
          player.vs = Math.min(DH.maxVs, player.vs + 55);
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
      if (!player.alive) return;
      var i;
      for (i = 0; i < obstacles.length; i++) {
        var o = obstacles[i];
        if (!o.alive || (o.kind !== "rock" && o.kind !== "tree")) continue;
        if (circleHits(player.s, player.h, DH.bodyR, o)) {
          player.alive = false;
          session.cause = "撞上障碍";
          mark("hit");
          mark("dead");
          return;
        }
      }
    }

    function step(dt) {
      if (!player.alive) return;
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

      var drag = player.grounded ? DH.drag : DH.airDrag;
      player.vs += (DH.gSin - drag * player.vs) * dt;
      player.vs = clamp(player.vs, 0, DH.maxVs);

      if (player.grounded) {
        var before = rampAt(player.s);
        var prevS = player.s;
        player.s += player.vs * dt;
        var after = rampAt(player.s);
        if (before && !after) {
          player.grounded = false;
          player.vh = Math.max(DH.jumpV * 0.92, player.vs * 0.72);
          player.h = terrainHeight(prevS) + DH.feet + 2;
          player.airRot = 0;
          mark("launch");
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
        player.vh -= DH.gCos * dt;
        player.s += player.vs * dt;
        player.h += player.vh * dt;
        var floor = floorH(player.s);
        if (player.h <= floor && player.vh <= 0) land(floor);
      }

      resolveSmash();
      resolveBody();
    }

    function spawnOne() {
      var roll = rng();
      var gap;
      if (roll < 0.5) {
        obstacles.push({
          kind: "rock",
          s: nextS,
          w: 34,
          hgt: 36 + Math.floor(rng() * 12),
          alive: true
        });
        gap = 320 + rng() * 230;
      } else if (roll < 0.74) {
        obstacles.push({ kind: "tree", s: nextS, w: 28, hgt: 72, alive: true });
        gap = 360 + rng() * 220;
      } else {
        obstacles.push({
          kind: "ramp",
          s: nextS,
          len: 156 + Math.floor(rng() * 36),
          peak: 42 + rng() * 22,
          alive: true
        });
        gap = 460 + rng() * 180;
      }
      var tighten = Math.min(110, player.s / 90);
      nextS += Math.max(220, gap - tighten);
    }

    var session = {
      player: player,
      obstacles: obstacles,
      popups: popups,
      bits: bits,
      cause: "",
      kind: "downhill"
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

    session.setRotate = function (dir) {
      rotateDir = dir > 0 ? 1 : (dir < 0 ? -1 : 0);
    };

    session.jump = function () {
      if (!player.alive || !player.grounded || player.stumble > 0) return false;
      player.grounded = false;
      player.vh = DH.jumpV;
      player.h += 3;
      player.vs = Math.min(DH.maxVs, player.vs + 24);
      player.airRot = 0;
      return true;
    };

    session.smash = function () {
      if (!player.alive) return false;
      smashQueued = true;
      return true;
    };

    session.stickPose = function () {
      return {
        mode: smashMode,
        phase: smashPhase
      };
    };

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
          cloud.h = 170 + hash01(cloud.s + 4) * 100;
          var roll = hash01(cloud.s + 8);
          cloud.kind = roll < 0.18 ? "yjr" : (roll < 0.55 ? "cloud1" : "cloud2");
        }
      }
      for (i = 0; i < flakes.length; i++) {
        if (flakes[i].s < player.s - 320) flakes[i].s += 1400;
      }

      if (!empty) {
        var guard = 0;
        while (nextS < player.s + 1500 && guard < 8) {
          spawnOne();
          guard += 1;
        }
      }
      obstacles = obstacles.filter(function (o) {
        if ((o.kind === "rock" || o.kind === "tree") && !o.alive) return false;
        var end = o.s + (o.len || o.w || 0);
        return end > player.s - 900;
      });
      session.obstacles = obstacles;

      var events = [];
      for (var key in bag) {
        if (Object.prototype.hasOwnProperty.call(bag, key) && bag[key]) events.push(key);
      }
      return events;
    };

    function world(s, h) {
      var ds = s - player.s;
      var dh = h - player.h;
      return {
        x: DH.anchorX + ds * TX + dh * NX,
        y: DH.anchorY + ds * TY + dh * NY
      };
    }

    session._world = world;
    session._terrain = terrainHeight;
    session._clouds = clouds;

    return session;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
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

    function world(s, h) {
      var ds = s - player.s;
      var dh = h - player.h;
      return {
        x: DH.anchorX + ds * TX + dh * NX,
        y: DH.anchorY + ds * TY + dh * NY
      };
    }

    var sky = ctx.createLinearGradient(0, 0, 80, DH.height);
    sky.addColorStop(0, "#8fd0ea");
    sky.addColorStop(0.42, "#d0f4f7");
    sky.addColorStop(1, "#fff1dc");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, DH.width, DH.height);

    drawMountains(ctx, player.s);
    drawClouds(ctx, images, session._clouds, world);

    var pts = [];
    var ds;
    for (ds = -1500; ds <= 1700; ds += 40) {
      pts.push(world(player.s + ds, 0));
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    var i;
    for (i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    var tail = pts[pts.length - 1];
    var head = pts[0];
    ctx.lineTo(tail.x - NX * 1600, tail.y - NY * 1600);
    ctx.lineTo(head.x - NX * 1600, head.y - NY * 1600);
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
    ctx.stroke();
    ctx.strokeStyle = "#3c342c";
    ctx.lineWidth = 3;
    ctx.stroke();

    drawRamps(ctx, session.obstacles, world);
    drawTracks(ctx, player.s, world);
    drawObstacles(ctx, session.obstacles, world);
    drawBits(ctx, session.bits, world);
    drawShadow(ctx, player, world, session._terrain);
    drawRider(ctx, player, images, env.anim, session.stickPose(), world, env.reduceMotion);
    drawPopups(ctx, session.popups, world, font);
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
    if (!images) return;
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
    for (s = base; s < playerS + 980; s += 22) {
      if (hash01(s * 0.17) < 0.35) continue;
      var yOff = hash01(s + 2) > 0.5 ? 3 : 8;
      var a = world(s, yOff);
      var b = world(s + 12, yOff);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }

  function drawObstacles(ctx, obstacles, world) {
    var i;
    for (i = 0; i < obstacles.length; i++) {
      var o = obstacles[i];
      if (o.kind === "rock" && o.alive) drawRock(ctx, o, world);
      else if (o.kind === "tree" && o.alive) drawTree(ctx, o, world);
    }
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

  function drawShadow(ctx, player, world, terrain) {
    var ground = terrain(player.s);
    var feet = world(player.s, ground);
    var lift = Math.max(0, player.h - ground - DH.feet);
    var rx = Math.max(8, 20 - lift * 0.04);
    ctx.fillStyle = "rgba(60, 52, 44, " + (lift > 80 ? 0.08 : 0.2) + ")";
    ctx.beginPath();
    ctx.ellipse(feet.x, feet.y, rx, 6, ALPHA, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawRider(ctx, player, images, anim, pose, world, reduceMotion) {
    var p = world(player.s, player.h);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(ALPHA + player.rot);
    if (player.stumble > 0) {
      var k = player.stumble / DH.stumbleTime;
      var wob = Math.sin(player.stumble * 34) * 0.42 * k;
      if (reduceMotion) wob *= 0.35;
      ctx.rotate(wob);
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
    } else {
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
      var pop = popups[i];
      var p = world(pop.s, pop.h);
      ctx.globalAlpha = Math.max(0, Math.min(1, pop.life / 0.95));
      ink(ctx, pop.text, p.x, p.y, face);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawHud(ctx, session, env) {
    var font = env.font;
    ctx.save();
    ctx.fillStyle = "rgba(255,248,239,0.92)";
    ctx.strokeStyle = "#3c342c";
    ctx.lineWidth = 2;
    roundRect(ctx, 10, 10, 176, 74, 12);
    ctx.fill();
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ink(ctx, "分数 " + session.score, 22, 16, "700 22px " + font);
    ink(ctx, "最高 " + (env.highScore || 0) + "  速度 " + Math.round(session.player.vs), 22, 44, "700 14px " + font);
    ink(ctx, "←→ 翻转   J 挥棍", 22, 64, "700 14px " + font);
    if (env.muted) ink(ctx, "静音", DH.width - 64, 14, "700 16px " + font);
    if (env.tip > 0) drawTip(ctx, env, font);
    ctx.restore();
  }

  function drawTip(ctx, env, font) {
    var alpha = env.tip < 0.7 ? Math.max(0, env.tip / 0.7) : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    var x = 458;
    var y = 16;
    var w = 326;
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
    ctx.fillText("空格 / ↑ 跳跃", x + 16, y + 40);
    ctx.fillText("空中 ← 顺时针，→ 逆时针", x + 16, y + 64);
    ctx.fillText("J 挥棍。落地要接近正立", x + 16, y + 88);
    ctx.restore();
  }

  root.UsagiDownhill = {
    CONFIG: DH,
    createSession: createSession,
    localToSlope: localToSlope,
    stickLocals: stickLocals,
    stickAngle: stickAngle,
    drawWorld: drawWorld,
    drawHud: drawHud
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
