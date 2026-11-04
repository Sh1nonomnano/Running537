import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const sandbox = { console, Math, Object, Set };
sandbox.globalThis = sandbox;
runInContext(readFileSync(new URL("../web/js/downhill.js", import.meta.url), "utf8"), createContext(sandbox));
const { UsagiDownhill } = sandbox;
const { createSession, localToSlope, slopeAngle, slopeKappa, zoomTarget, CONFIG } = UsagiDownhill;

function empty() {
  return createSession({ empty: true, rng: () => 0.5 });
}

test("正立时头朝天、脚朝坡，翻转后朝向反过来", () => {
  const up = localToSlope(0, 0, -10);
  assert.ok(up.h > 9, JSON.stringify(up));
  const fwd = localToSlope(0, 10, 0);
  assert.ok(fwd.s > 9);
  assert.ok(Math.abs(fwd.h) < 1e-6);
  const flipped = localToSlope(Math.PI, 20, 0);
  assert.ok(flipped.s < -19, JSON.stringify(flipped));
  assert.ok(Math.abs(flipped.h) < 1e-6);
});

test("贴着坡面往下滑，分数跟着距离涨", () => {
  const s = empty();
  const start = s.player.s;
  s.update(1);
  assert.equal(s.player.grounded, true);
  assert.equal(s.player.alive, true);
  assert.ok(s.player.s > start + 200);
  assert.ok(Math.abs(s.player.h - CONFIG.feet) < 1);
  assert.ok(s.score > 0);
});

test("地上按方向不会转，跳起来才会转", () => {
  const ground = empty();
  ground.setRotate(1);
  ground.update(0.35);
  assert.equal(ground.player.grounded, true);
  assert.ok(Math.abs(ground.player.rot) < 0.02);

  const air = empty();
  assert.equal(air.jump(), true);
  assert.equal(air.player.grounded, false);
  air.setRotate(1);
  air.update(0.25);
  assert.ok(air.player.rot > 0.45, String(air.player.rot));

  const other = empty();
  other.jump();
  other.setRotate(-1);
  other.update(0.25);
  assert.ok(other.player.rot < -0.45, String(other.player.rot));
});

test("正立落地不会踉跄", () => {
  const s = empty();
  s.jump();
  for (let i = 0; i < 200 && !s.player.grounded; i++) s.update(1 / 60);
  assert.equal(s.player.grounded, true);
  assert.equal(s.player.stumble, 0);
  assert.equal(s.player.alive, true);
});

test("倒着落地会踉跄并扣分", () => {
  const s = empty();
  s.jump();
  for (let i = 0; i < 200; i++) {
    if (s.player.grounded) break;
    s.player.rot = Math.PI;
    s.player.omega = 0;
    s.update(1 / 60);
  }
  assert.equal(s.player.grounded, true);
  assert.equal(s.player.alive, true);
  assert.ok(s.player.stumble > 0);
  assert.ok(s.popups.some((p) => p.text.includes("踉跄")));
  assert.ok(s.bonus < 0);
  assert.ok(s.chase < CONFIG.chaseStart);
});

test("空中转满一圈再正立落地有翻转加分", () => {
  const s = empty();
  s.jump();
  for (let i = 0; i < 200; i++) {
    if (s.player.grounded) break;
    s.player.rot = 0.2;
    s.player.omega = 0;
    s.player.airRot = Math.PI * 2;
    s.update(1 / 60);
  }
  assert.equal(s.player.stumble, 0);
  assert.equal(s.player.alive, true);
  assert.ok(s.bonus >= 40);
  assert.ok(s.chase > CONFIG.chaseStart);
  assert.ok(s.popups.some((p) => p.text.includes("翻转")));
});

test("撞上岩石会急减速踉跄，但人还活着", () => {
  const s = empty();
  const before = s.chase;
  const rock = { kind: "rock", s: s.player.s + 6, w: 36, hgt: 48, alive: true };
  s.obstacles.push(rock);
  const events = s.update(1 / 60);
  assert.equal(s.player.alive, true);
  assert.equal(s.cause, "");
  assert.ok(s.player.stumble > 0);
  assert.ok(s.player.vs < 220);
  assert.ok(s.chase < before - 40);
  assert.ok(events.includes("hit"));
  assert.equal(events.includes("dead"), false);
  assert.equal(rock.alive, true);
});

test("挥棍能打碎身前的岩石，自己还活着", () => {
  const s = empty();
  s.player.vs = 150;
  const rock = { kind: "rock", s: s.player.s + 70, w: 32, hgt: 48, alive: true };
  s.obstacles.push(rock);
  assert.equal(s.smash(), true);
  for (let i = 0; i < 30; i++) s.update(1 / 60);
  assert.equal(rock.alive, false);
  assert.equal(s.player.alive, true);
  assert.ok(s.bonus >= 15);
  assert.ok(s.chase >= CONFIG.chaseStart + CONFIG.smashGap - 1);
  assert.ok(s.popups.some((p) => p.text.includes("击碎")));
});

test("翻转途中挥棍打向当前朝向", () => {
  const s = empty();
  s.player.grounded = false;
  s.player.h = 220;
  s.player.vh = 80;
  s.player.rot = Math.PI;
  s.player.omega = 0;
  const rock = { kind: "rock", s: s.player.s - 150, w: 110, hgt: 600, alive: true };
  s.obstacles.push(rock);
  s.smash();
  for (let i = 0; i < 24; i++) {
    s.player.rot = Math.PI;
    s.player.omega = 0;
    s.update(1 / 60);
  }
  assert.equal(rock.alive, false);
  assert.equal(s.player.alive, true);
});

test("冲出跳台会离地", () => {
  const s = empty();
  s.obstacles.push({ kind: "ramp", s: 30, len: 120, peak: 48, alive: true });
  let launched = false;
  for (let i = 0; i < 180; i++) {
    const events = s.update(1 / 60);
    if (events.includes("launch")) launched = true;
  }
  assert.equal(launched, true);
  assert.equal(s.player.alive, true);
});

test("默认坡道上有跳台和岩石", () => {
  const s = createSession({ rng: () => 0.2 });
  assert.ok(s.obstacles.some((o) => o.kind === "ramp"));
  assert.ok(s.obstacles.some((o) => o.kind === "rock"));
  assert.equal(s.player.alive, true);
  assert.equal(s.kind, "downhill");
});

test("坡度沿路程变化，凹弧比相近坡度的凸弧更快", () => {
  const a0 = slopeAngle(0);
  const a1 = slopeAngle(260);
  assert.ok(Math.abs(a0 - a1) > 0.05, `${a0} ${a1}`);

  let pair = null;
  for (let s = 0; s <= 8000 && !pair; s += 3) {
    const k = slopeKappa(s);
    const ang = slopeAngle(s);
    if (k > -0.00075) continue;
    for (let t = s; t <= s + 900; t += 3) {
      const k2 = slopeKappa(t);
      const ang2 = slopeAngle(t);
      if (k2 > 0.00075 && Math.abs(ang2 - ang) < 0.04) {
        pair = { s, t, k, k2, ang, ang2 };
        break;
      }
    }
  }
  assert.ok(pair, "没有找到坡度接近、曲率相反的两段");
  const run = (at) => {
    const session = empty();
    session.player.s = at;
    session.player.vs = 240;
    session.player.grounded = true;
    session.update(1 / 40);
    return session.player.vs;
  };
  const vCon = run(pair.s);
  const vVex = run(pair.t);
  assert.ok(vCon > vVex, JSON.stringify({ pair, vCon, vVex }));
});

test("跳台抛得更高，并沿坡加速", () => {
  const s = empty();
  s.player.vs = 280;
  s.obstacles.push({ kind: "ramp", s: 20, len: 90, peak: 40, alive: true });
  let launched = false;
  for (let i = 0; i < 160; i++) {
    const before = s.player.vs;
    const grounded = s.player.grounded;
    const events = s.update(1 / 60);
    if (events.includes("launch")) {
      launched = true;
      assert.ok(s.player.vh > CONFIG.jumpV * 1.15, String(s.player.vh));
      assert.equal(s.player.grounded, false);
      assert.ok(s.player.vs > before - 5);
      assert.ok(!grounded || s.player.vs >= 280);
      break;
    }
  }
  assert.equal(launched, true);
  assert.equal(s.player.alive, true);
});

test("跳台后面留出落地空档", () => {
  const opening = createSession({ rng: () => 0.2 });
  const openingRamp = opening.obstacles.find((o) => o.kind === "ramp");
  const openingHazards = opening.obstacles.filter((o) => o.kind === "rock" || o.kind === "tree");
  assert.ok(openingRamp);
  assert.ok(openingHazards.length >= 2);
  for (const hazard of openingHazards) {
    assert.ok(hazard.s >= openingRamp.s + openingRamp.len + CONFIG.rampClear);
  }
  for (let i = 1; i < openingHazards.length; i++) {
    assert.ok(openingHazards[i].s - openingHazards[i - 1].s >= 700);
  }

  const script = [0.9, 0.4, 0.5, 0.1, 0.05, 0.3, 0.1, 0.05, 0.2, 0.1];
  let cursor = 0;
  const spawned = createSession({
    rng: () => script[Math.min(cursor++, script.length - 1)]
  });
  spawned.player.s = 2500;
  spawned.player.vs = 320;
  spawned.player.grounded = true;
  spawned.player.h = CONFIG.feet;
  spawned.update(1 / 30);
  const ramps = spawned.obstacles.filter((o) => o.kind === "ramp" && o.s >= 2000);
  const hazards = spawned.obstacles.filter((o) => (o.kind === "rock" || o.kind === "tree") && o.s >= 2000);
  assert.ok(ramps.length >= 1, JSON.stringify(spawned.obstacles.map((o) => o.kind + "@" + Math.round(o.s))));
  assert.ok(hazards.length >= 1, JSON.stringify(spawned.obstacles.map((o) => o.kind + "@" + Math.round(o.s))));
  for (const ramp of ramps) {
    const end = ramp.s + ramp.len;
    for (const hazard of hazards) {
      if (hazard.s < ramp.s) continue;
      assert.ok(hazard.s >= end + CONFIG.rampClear - 1, `障碍 ${hazard.s} 贴着跳台终点 ${end}`);
    }
  }

  const launch = empty();
  launch.player.vs = 340;
  launch.obstacles.push({ kind: "ramp", s: 16, len: 88, peak: 34, alive: true });
  const rock = { kind: "rock", s: 120, w: 32, hgt: 40, alive: true };
  launch.obstacles.push(rock);
  let sawLaunch = false;
  for (let i = 0; i < 160 && !sawLaunch; i++) {
    const events = launch.update(1 / 60);
    if (events.includes("launch")) {
      sawLaunch = true;
      assert.ok(rock.s >= 120 + CONFIG.landClear * 0.5, String(rock.s));
    }
  }
  assert.equal(sawLaunch, true);
  assert.equal(launch.player.alive, true);
});

test("飞鼠距离耗尽会被追上", () => {
  const s = empty();
  s.chase = 6;
  s.player.vs = 40;
  let caught = false;
  for (let i = 0; i < 180; i++) {
    const events = s.update(1 / 60);
    if (events.includes("catch")) caught = true;
    if (!s.player.alive) break;
  }
  assert.equal(caught, true);
  assert.equal(s.player.alive, false);
  assert.equal(s.cause, "被飞鼠追上");
});

test("摔出坡面或飞出界外会立刻结束", () => {
  const deep = empty();
  deep.player.grounded = false;
  deep.player.h = CONFIG.deepFall - 40;
  deep.player.vh = -80;
  deep.update(1 / 60);
  assert.equal(deep.player.alive, false);
  assert.equal(deep.cause, "严重摔出");

  const high = empty();
  high.player.grounded = false;
  high.player.h = CONFIG.oobHigh + 80;
  high.player.vh = 0;
  high.player.vs = 80;
  high.update(1 / 60);
  assert.equal(high.player.alive, false);
  assert.equal(high.cause, "飞出界外");
});

test("倒着落地不会立刻死亡", () => {
  const s = empty();
  s.jump();
  for (let i = 0; i < 240; i++) {
    if (s.player.grounded) break;
    s.player.rot = Math.PI;
    s.player.omega = 0;
    s.update(1 / 60);
  }
  assert.equal(s.player.grounded, true);
  assert.equal(s.player.alive, true);
  assert.notEqual(s.cause, "严重摔出");
  assert.notEqual(s.cause, "飞出界外");
});

test("速度越快镜头越远，慢下来会平滑拉回", () => {
  const zSlow = zoomTarget(180);
  const zMid = zoomTarget(370);
  const zFast = zoomTarget(560);
  assert.ok(zSlow < 1);
  assert.ok(zSlow > zMid && zMid > zFast);
  assert.ok(zFast > 0.5);

  const s = empty();
  const z0 = s.zoom;
  for (let i = 0; i < 120; i++) {
    s.player.vs = 560;
    s.update(1 / 60);
  }
  const far = s.zoom;
  assert.ok(far < z0 - 0.04, `${far} vs ${z0}`);
  for (let i = 0; i < 180; i++) {
    s.player.vs = 160;
    s.player.grounded = true;
    s.update(1 / 60);
  }
  assert.ok(s.zoom > far + 0.04, `${s.zoom} vs ${far}`);
});
