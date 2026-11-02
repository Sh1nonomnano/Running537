/*
 * 奔跑吧乌萨奇 — 网页版
 * 物理和生成规则来自 SimpleJavaGDF（Player / Block / Cloud / PlayState）。
 * 画面分数和结算共用同一个秒数；下蹲碰撞箱比站立更小；按住才蹲；
 * 开局砖块就是可见的。原作这四处不是这样。
 */
(function (root) {
  "use strict";

  var CONFIG = {
    width: 800,
    height: 450,
    groundY: 405,
    groundSnap: 406,
    playerX: 160,
    playerW: 66,
    playerH: 92,
    jumpV: -600,
    gravity: 1800,
    blockW: 20,
    blockH: 50,
    upperY: 275,
    lowerY: 355,
    blockStartX: 520,
    blockGap: 200,
    blockCount: 5,
    blockSpeed0: -200,
    blockSpeedLimit: -280,
    blockSpeedStep: -10,
    cloudV: -20,
    scoreRate: 60,
    speedEvery: 500,
    push: 50,
    duckInsetX: 12,
    duckTop: 46,
    duckH: 42
  };

  var GROUND = { x: 0, y: CONFIG.groundY, w: CONFIG.width, h: CONFIG.height - CONFIG.groundY };

  function intersects(a, b) {
    if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) return false;
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function rollBlockY(rng) {
    return Math.floor(rng() * 3) === 0 ? CONFIG.upperY : CONFIG.lowerY;
  }

  function createPlayer() {
    var p = {
      x: CONFIG.playerX,
      y: CONFIG.groundSnap - CONFIG.playerH,
      w: CONFIG.playerW,
      h: CONFIG.playerH,
      vy: 0,
      alive: true,
      ducked: false,
      duckHeld: false,
      standingRect: { x: 0, y: 0, w: 0, h: 0 },
      duckRect: { x: 0, y: 0, w: 0, h: 0 }
    };

    function sync() {
      p.standingRect.x = p.x + 10;
      p.standingRect.y = p.y;
      p.standingRect.w = p.w - 20;
      p.standingRect.h = p.h;
      p.duckRect.x = p.x + CONFIG.duckInsetX;
      p.duckRect.y = p.y + CONFIG.duckTop;
      p.duckRect.w = p.w - CONFIG.duckInsetX * 2;
      p.duckRect.h = CONFIG.duckH;
    }

    p.sync = sync;
    p.grounded = function () { return intersects(p.standingRect, GROUND); };
    p.hitbox = function () { return p.ducked ? p.duckRect : p.standingRect; };

    p.update = function (dt) {
      if (p.grounded()) {
        p.y = CONFIG.groundSnap - p.h;
        p.vy = 0;
      } else {
        p.vy += CONFIG.gravity * dt;
        p.y += p.vy * dt;
      }
      sync();
      p.ducked = p.grounded() && p.duckHeld;
    };

    p.jump = function () {
      if (!p.grounded()) return false;
      p.ducked = false;
      p.y -= 20;
      p.vy = CONFIG.jumpV;
      sync();
      return true;
    };

    p.pushBack = function (dist) {
      p.x -= dist;
      if (p.x < -p.w / 2) p.alive = false;
      sync();
    };

    sync();
    return p;
  }

  function createSession(options) {
    var rng = (options && options.rng) || Math.random;
    var player = createPlayer();
    var blocks = [];
    var i;
    for (i = 0; i < CONFIG.blockCount; i++) {
      blocks.push({
        x: CONFIG.blockStartX + i * CONFIG.blockGap,
        y: rollBlockY(rng),
        visible: true
      });
    }
    var clouds = [
      { x: 100, y: 100, kind: "cloud1" },
      { x: 500, y: 50, kind: "cloud2" },
      { x: 800, y: 80, kind: "yjr" }
    ];

    var session = {
      player: player,
      blocks: blocks,
      clouds: clouds,
      blockSpeed: CONFIG.blockSpeed0,
      elapsed: 0,
      ticks: 0,
      bucket: 0
    };

    Object.defineProperty(session, "score", {
      get: function () {
        return Math.floor(session.elapsed + 1e-4);
      }
    });

    session.setDuckHeld = function (held) {
      player.duckHeld = !!held;
    };

    session.jump = function () {
      return player.jump();
    };

    session.update = function (dt) {
      var events = [];
      if (!player.alive) {
        events.push("dead");
        return events;
      }
      if (!(dt > 0)) return events;

      session.elapsed += dt;
      session.ticks += dt * CONFIG.scoreRate;
      var bucket = Math.floor(session.ticks / CONFIG.speedEvery + 1e-6);
      var steps = bucket - session.bucket;
      var step;
      session.bucket = bucket;
      for (step = 0; step < steps; step++) {
        if (session.blockSpeed >= CONFIG.blockSpeedLimit) {
          session.blockSpeed += CONFIG.blockSpeedStep;
          events.push("speed");
        }
      }

      var wasDucked = player.ducked;
      player.update(dt);
      if (player.ducked && !wasDucked) events.push("duck");

      var c;
      for (c = 0; c < clouds.length; c++) {
        var cloud = clouds[c];
        cloud.x += CONFIG.cloudV * dt;
        if (cloud.x <= -200) {
          cloud.x += 1000;
          cloud.y = 20 + Math.floor(rng() * 80);
          // 第三朵云多数时候是 YJR；旁边的云偶尔也会换成这张彩蛋。
          if (c === 2) cloud.kind = rng() < 0.7 ? "yjr" : "cloud2";
          else cloud.kind = rng() < 0.12 ? "yjr" : (c === 0 ? "cloud1" : "cloud2");
        }
      }

      var b;
      for (b = 0; b < blocks.length; b++) {
        var block = blocks[b];
        block.x += session.blockSpeed * dt;
        while (block.x <= -50) {
          block.x += 1000;
          block.y = rollBlockY(rng);
          block.visible = true;
        }
        if (!block.visible) continue;
        var rect = { x: block.x, y: block.y, w: CONFIG.blockW, h: CONFIG.blockH };
        if (intersects(player.hitbox(), rect)) {
          block.visible = false;
          player.pushBack(CONFIG.push);
          events.push("hit");
        }
      }

      if (!player.alive) events.push("dead");
      return events;
    };

    return session;
  }

  function createAnim(frames) {
    var seq = [0, 1, 2, 3, 4, 2, 1];
    var ends = [];
    var total = 0;
    var i;
    for (i = 0; i < seq.length; i++) {
      total += 0.1;
      ends.push(total);
    }
    var time = 0;
    var index = 0;
    return {
      update: function (dt) {
        time += dt;
        if (time > total) {
          index = 0;
          time %= total;
        }
        while (index < ends.length - 1 && time > ends[index]) index++;
      },
      current: function () {
        return frames[seq[index]];
      }
    };
  }

  var api = {
    CONFIG: CONFIG,
    GROUND: GROUND,
    intersects: intersects,
    createSession: createSession,
    createAnim: createAnim
  };
  root.UsagiRun = api;

  if (typeof document === "undefined") return;

  var FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","WenQuanYi Micro Hei","Droid Sans Fallback",sans-serif';
  var HIGH_KEY = "running537.highScore";
  var MUTE_KEY = "running537.muted";

  function mount() {
    var canvas = document.getElementById("game");
    var ctx = canvas.getContext("2d");
    var actionEl = document.getElementById("btn-action");
    var muteEl = document.getElementById("btn-mute");
    var jumpEl = document.getElementById("btn-jump");
    var duckEl = document.getElementById("btn-duck");
    var bestEl = document.getElementById("best");
    var liveEl = document.getElementById("live");

    var mode = "loading";
    var selection = 0;
    var session = null;
    var anim = null;
    var images = null;
    var loadError = "";
    var menuTime = 0;
    var highScore = readNumber(HIGH_KEY);
    var muted = false;
    try { muted = localStorage.getItem(MUTE_KEY) === "1"; } catch (err) { muted = false; }
    var finalScore = 0;
    var newRecord = false;
    var overLock = 0;
    var overHeld = new Set();
    var shake = 0;
    var held = new Set();
    var chromeSig = "";
    var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    var sounds = {
      jump: makeSfx("assets/onjump.wav"),
      duck: makeSfx("assets/onduck.wav"),
      hit: makeSfx("assets/hit.wav")
    };

    function readNumber(key) {
      try { return Math.max(0, Math.floor(Number(localStorage.getItem(key))) || 0); }
      catch (err) { return 0; }
    }
    function writeStore(key, value) {
      try { localStorage.setItem(key, String(value)); } catch (err) {}
    }
    function makeSfx(src) {
      var el = new Audio(src);
      el.preload = "auto";
      el.volume = 0.75;
      return {
        play: function () {
          if (muted) return;
          try {
            if (el.readyState >= 1) el.currentTime = 0;
            var pending = el.play();
            if (pending && pending.catch) pending.catch(function () {});
          } catch (err) {}
        }
      };
    }

    function syncChrome(force) {
      var sig = [mode, highScore, muted ? 1 : 0, finalScore].join("|");
      if (!force && sig === chromeSig) return;
      chromeSig = sig;
      bestEl.textContent = "最高分：" + highScore;
      muteEl.textContent = muted ? "声音：关" : "声音：开";
      muteEl.setAttribute("aria-pressed", muted ? "true" : "false");
      var labels = {
        loading: "请稍候",
        error: "请稍候",
        menu: "开始游戏",
        play: "暂停",
        paused: "继续",
        over: "再来一局"
      };
      actionEl.textContent = labels[mode] || "开始游戏";
      actionEl.disabled = mode === "loading" || mode === "error";
      var live = {
        loading: "正在加载",
        error: loadError,
        menu: "菜单。最高分 " + highScore,
        play: "游戏开始",
        paused: "已暂停",
        over: "游戏结束。分数 " + finalScore + "。最高分 " + highScore
      };
      if (liveEl) liveEl.textContent = live[mode] || "";
    }

    function toggleMute() {
      muted = !muted;
      writeStore(MUTE_KEY, muted ? "1" : "0");
      syncChrome(true);
    }
    function togglePause() {
      if (mode === "play") mode = "paused";
      else if (mode === "paused") mode = "play";
      syncChrome(true);
      canvas.focus();
    }
    function startGame() {
      session = createSession();
      finalScore = 0;
      newRecord = false;
      shake = 0;
      mode = "play";
      syncChrome(true);
      canvas.focus();
    }
    function goMenu() {
      mode = "menu";
      session = null;
      selection = 0;
      syncChrome(true);
      canvas.focus();
    }
    function enterOver() {
      if (mode === "over") return;
      finalScore = session ? session.score : 0;
      newRecord = finalScore > highScore;
      if (newRecord) {
        highScore = finalScore;
        writeStore(HIGH_KEY, highScore);
      }
      overLock = performance.now() + 450;
      overHeld = new Set(held);
      mode = "over";
      syncChrome(true);
    }
    function confirmMenu() {
      if (selection === 0) startGame();
    }
    function duckWanted() {
      return held.has("ArrowDown") || held.has("KeyS") || held.has("TouchDuck");
    }
    function applyDuck() {
      if (session && mode === "play") session.setDuckHeld(duckWanted());
    }
    function doJump() {
      if (mode !== "play" || !session) return;
      if (session.jump()) sounds.jump.play();
    }

    function loadImage(src) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error(src)); };
        img.src = src;
      });
    }

    var names = [
      "welcome", "selector", "grass", "duck", "jump", "block",
      "cloud1", "cloud2", "yjr", "iconimage"
    ];
    Promise.all(names.map(function (name) { return loadImage("assets/" + name + ".png"); }))
      .then(function (loaded) {
        images = {};
        names.forEach(function (name, idx) { images[name] = loaded[idx]; });
        return Promise.all([1, 2, 3, 4, 5].map(function (n) {
          return loadImage("assets/run_anim" + n + ".png");
        }));
      })
      .then(function (frames) {
        images.run = frames;
        anim = createAnim(frames);
        mode = "menu";
        syncChrome(true);
        canvas.focus();
      })
      .catch(function (err) {
        loadError = "资源没加载上：" + (err && err.message ? err.message : "未知文件");
        mode = "error";
        syncChrome(true);
      });

    function logicalPoint(event) {
      var rect = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * (CONFIG.width / rect.width),
        y: (event.clientY - rect.top) * (CONFIG.height / rect.height)
      };
    }
    function inRect(p, r) {
      return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    }

    canvas.addEventListener("pointerdown", function (event) {
      canvas.focus();
      var p = logicalPoint(event);
      if (mode === "menu") {
        if (inRect(p, { x: 560, y: 280, w: 230, h: 90 })) {
          selection = 0;
          startGame();
        } else if (inRect(p, { x: 560, y: 372, w: 230, h: 78 })) {
          selection = 1;
        }
      } else if (mode === "over") {
        if (performance.now() >= overLock) startGame();
      } else if (mode === "paused") {
        togglePause();
      }
    });

    window.addEventListener("keydown", function (event) {
      var code = event.code;
      var onButton = event.target && event.target.tagName === "BUTTON";
      if (!onButton && (code === "Space" || code === "ArrowUp" || code === "ArrowDown" || code === "ArrowLeft" || code === "ArrowRight")) {
        event.preventDefault();
      }
      if (code === "KeyM" && !event.repeat) {
        toggleMute();
        return;
      }
      if (onButton) return;
      if (event.repeat && (code === "Space" || code === "ArrowUp" || code === "KeyW" || code === "Enter")) return;

      held.add(code);

      if (mode === "menu") {
        if (code === "ArrowUp" || code === "KeyW") selection = 0;
        else if (code === "ArrowDown" || code === "KeyS") selection = 1;
        else if (code === "Space" || code === "Enter") confirmMenu();
        return;
      }
      if (mode === "over") {
        if (event.repeat || overHeld.has(code)) return;
        if (performance.now() < overLock) return;
        if (code === "Escape") goMenu();
        else startGame();
        return;
      }
      if (mode === "play" || mode === "paused") {
        if ((code === "Escape" || code === "KeyP") && !event.repeat) {
          togglePause();
          return;
        }
        if (mode === "paused") return;
        if (code === "Space" || code === "ArrowUp" || code === "KeyW") doJump();
        applyDuck();
      }
    });

    window.addEventListener("keyup", function (event) {
      held.delete(event.code);
      overHeld.delete(event.code);
      applyDuck();
    });
    window.addEventListener("blur", function () {
      held.clear();
      if (session) session.setDuckHeld(false);
    });

    actionEl.addEventListener("click", function () {
      if (mode === "menu") startGame();
      else if (mode === "play" || mode === "paused") togglePause();
      else if (mode === "over") startGame();
      canvas.focus();
    });
    muteEl.addEventListener("click", function () {
      toggleMute();
      canvas.focus();
    });

    jumpEl.addEventListener("pointerdown", function (event) {
      event.preventDefault();
      if (mode === "menu") startGame();
      else doJump();
    });
    duckEl.addEventListener("contextmenu", function (event) { event.preventDefault(); });
    duckEl.addEventListener("pointerdown", function (event) {
      event.preventDefault();
      try { duckEl.setPointerCapture(event.pointerId); } catch (err) {}
      held.add("TouchDuck");
      applyDuck();
    });
    function releaseDuck() {
      held.delete("TouchDuck");
      applyDuck();
    }
    duckEl.addEventListener("pointerup", releaseDuck);
    duckEl.addEventListener("pointercancel", releaseDuck);
    duckEl.addEventListener("lostpointercapture", releaseDuck);

    function fit() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var cssW = canvas.clientWidth || CONFIG.width;
      var cssH = cssW * (CONFIG.height / CONFIG.width);
      var bw = Math.max(1, Math.round(cssW * dpr));
      var bh = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      ctx.setTransform(bw / CONFIG.width, 0, 0, bh / CONFIG.height, 0, 0);
      ctx.imageSmoothingEnabled = true;
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function drawWorld() {
      var player = session.player;
      ctx.fillStyle = "#d0f4f7";
      ctx.fillRect(0, 0, CONFIG.width, CONFIG.height);
      ctx.drawImage(images.grass, 0, CONFIG.groundY);
      var lift = player.grounded() ? 0 : Math.min(18, (CONFIG.groundSnap - player.h - player.y) / 8);
      ctx.fillStyle = "rgba(90, 60, 40, 0.18)";
      ctx.beginPath();
      ctx.ellipse(player.x + player.w / 2, 402, Math.max(10, 22 - lift), 5, 0, 0, Math.PI * 2);
      ctx.fill();
      drawPlayer(player);
      drawCloud(session.clouds[0]);
      drawCloud(session.clouds[1]);
      drawCloud(session.clouds[2]);
      var b;
      for (b = 0; b < session.blocks.length; b++) {
        var block = session.blocks[b];
        if (!block.visible) continue;
        ctx.drawImage(images.block, block.x, block.y, CONFIG.blockW, CONFIG.blockH);
      }
    }

    function drawCloud(cloud) {
      var img = images[cloud.kind] || images.cloud1;
      ctx.drawImage(img, cloud.x, cloud.y, 100, 60);
    }

    function drawPlayer(player) {
      if (!player.grounded()) {
        ctx.drawImage(images.jump, player.x, player.y, player.w, player.h);
        return;
      }
      if (player.ducked) {
        var ih = images.duck.height || 70;
        var iw = images.duck.width || 72;
        var dh = 62;
        var dw = dh * (iw / ih);
        var dx = player.x + (player.w - dw) / 2;
        var dy = player.y + player.h - dh;
        ctx.drawImage(images.duck, dx, dy, dw, dh);
        return;
      }
      ctx.drawImage(anim.current(), player.x, player.y, player.w, player.h);
    }

    function drawHud() {
      ctx.save();
      ctx.font = "700 25px " + FONT;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.lineJoin = "round";
      inkText("分数 " + (session ? session.score : 0), 16, 14);
      ctx.font = "700 16px " + FONT;
      inkText("最高 " + highScore, 16, 46);
      inkText("空格 ↑ 跳    按住 ↓ S 蹲", 16, 70);
      if (muted) inkText("静音", CONFIG.width - 64, 14);
      ctx.restore();
    }

    function inkText(text, x, y) {
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.strokeText(text, x, y);
      ctx.fillStyle = "#546068";
      ctx.fillText(text, x, y);
    }

    function drawWelcome() {
      ctx.drawImage(images.welcome, 0, 0, CONFIG.width, CONFIG.height);
      var bob = Math.sin(menuTime * 6) * 3;
      var arrowY = selection === 0 ? 308 : 392;
      ctx.drawImage(images.selector, 578 + bob, arrowY, 25, 45);
      var rabbit = selection === 0 ? [480, 271] : [480, 341];
      ctx.drawImage(anim.current(), rabbit[0], rabbit[1]);
      drawBadge("最高分 " + highScore, 16, 16);
      if (selection === 0) drawBadge("开始", 16, 52);
    }

    function drawBadge(text, x, y) {
      ctx.save();
      ctx.font = "700 16px " + FONT;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      var w = ctx.measureText(text).width + 18;
      ctx.fillStyle = "rgba(255,248,239,0.9)";
      ctx.strokeStyle = "#3c342c";
      ctx.lineWidth = 2;
      roundRect(x, y, w, 28, 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#3c342c";
      ctx.fillText(text, x + 9, y + 14);
      ctx.restore();
    }

    function drawPause() {
      ctx.fillStyle = "rgba(60, 52, 44, 0.45)";
      ctx.fillRect(0, 0, CONFIG.width, CONFIG.height);
      drawCard(340, ["已暂停", "按 Esc 或 P 继续"]);
    }

    function drawOver() {
      ctx.fillStyle = "#ffa500";
      ctx.fillRect(0, 0, CONFIG.width, CONFIG.height);
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#4e4a46";
      ctx.font = "700 56px " + FONT;
      ctx.fillText("游戏结束", CONFIG.width / 2, 130);
      ctx.font = "700 36px " + FONT;
      ctx.fillText("分数 " + finalScore, CONFIG.width / 2, 210);
      ctx.font = "700 28px " + FONT;
      ctx.fillText("最高分 " + highScore, CONFIG.width / 2, 262);
      if (newRecord) {
        ctx.fillStyle = "#8a3b22";
        ctx.fillText("新纪录", CONFIG.width / 2, 312);
      }
      ctx.fillStyle = "#4e4a46";
      ctx.font = "700 22px " + FONT;
      ctx.fillText("空格 / 回车 · 再来一局", CONFIG.width / 2, 368);
      ctx.fillText("Esc · 返回菜单", CONFIG.width / 2, 408);
      ctx.restore();
    }

    function drawCard(w, lines) {
      var h = 64 + lines.length * 34;
      var x = (CONFIG.width - w) / 2;
      var y = (CONFIG.height - h) / 2;
      ctx.save();
      ctx.fillStyle = "rgba(255,248,239,0.96)";
      ctx.strokeStyle = "#3c342c";
      ctx.lineWidth = 3;
      roundRect(x, y, w, h, 16);
      ctx.fill();
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#3c342c";
      var cursor = y + 40;
      var i;
      for (i = 0; i < lines.length; i++) {
        ctx.font = (i === 0 ? "700 30px " : "700 18px ") + FONT;
        ctx.fillText(lines[i], CONFIG.width / 2, cursor);
        cursor += i === 0 ? 42 : 32;
      }
      ctx.restore();
    }

    function drawLoading() {
      ctx.fillStyle = "#d0f4f7";
      ctx.fillRect(0, 0, CONFIG.width, CONFIG.height);
      ctx.fillStyle = "#3c342c";
      ctx.font = "700 28px " + FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(loadError || "乌萨奇正在系鞋带…", CONFIG.width / 2, CONFIG.height / 2);
    }

    function render() {
      fit();
      ctx.clearRect(0, 0, CONFIG.width, CONFIG.height);
      if (!images) {
        drawLoading();
        return;
      }
      var showWorld = session && (mode === "play" || mode === "paused" || mode === "over");
      ctx.save();
      if (mode === "play" && showWorld && shake > 0 && !reduceMotion) {
        var mag = shake * 6;
        ctx.translate((Math.random() - 0.5) * mag, (Math.random() - 0.5) * mag);
      }
      if (showWorld) drawWorld();
      else drawWelcome();
      ctx.restore();
      if (showWorld && mode !== "over") drawHud();
      if (mode === "paused") drawPause();
      if (mode === "over") drawOver();
      if (muted && mode === "menu") {
        ctx.font = "700 16px " + FONT;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        inkText("静音", CONFIG.width - 64, 16);
      }
    }

    var last = 0;
    function frame(now) {
      requestAnimationFrame(frame);
      var dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now;
      if (mode === "menu") {
        menuTime += dt;
        if (anim) anim.update(dt);
      } else if (mode === "play" && session) {
        applyDuck();
        var events = session.update(dt);
        if (anim) anim.update(dt);
        var i;
        for (i = 0; i < events.length; i++) {
          if (events[i] === "hit") {
            sounds.hit.play();
            shake = 1;
          } else if (events[i] === "duck") {
            sounds.duck.play();
          }
        }
        if (shake > 0) shake = Math.max(0, shake - dt * 3);
        if (events.indexOf("dead") !== -1) enterOver();
      }
      render();
    }
    requestAnimationFrame(frame);
    syncChrome(true);

    root.UsagiRun.snapshot = function () {
      return {
        mode: mode,
        score: session ? session.score : 0,
        finalScore: finalScore,
        highScore: highScore,
        muted: muted,
        ducked: !!(session && session.player.ducked),
        grounded: !!(session && session.player.grounded()),
        alive: session ? session.player.alive : null,
        x: session ? Math.round(session.player.x) : null,
        y: session ? Math.round(session.player.y) : null,
        speed: session ? session.blockSpeed : null,
        blocks: session ? session.blocks.filter(function (b) { return b.visible && b.x > -50 && b.x < CONFIG.width; }).length : 0
      };
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})(typeof globalThis !== "undefined" ? globalThis : this);
