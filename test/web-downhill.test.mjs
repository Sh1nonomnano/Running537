import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const sandbox = { console, Math, Object, Set };
sandbox.globalThis = sandbox;
runInContext(readFileSync(new URL("../web/js/downhill.js", import.meta.url), "utf8"), createContext(sandbox));
const { UsagiDownhill } = sandbox;
const { createSession, localToSlope, CONFIG } = UsagiDownhill;

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
  assert.ok(s.player.stumble > 0);
  assert.ok(s.popups.some((p) => p.text.includes("踉跄")));
  assert.ok(s.bonus < 0);
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
  assert.ok(s.bonus >= 40);
  assert.ok(s.popups.some((p) => p.text.includes("翻转")));
});

test("身体撞上岩石就结束", () => {
  const s = empty();
  s.obstacles.push({ kind: "rock", s: s.player.s + 6, w: 36, hgt: 48, alive: true });
  const events = s.update(1 / 60);
  assert.equal(s.player.alive, false);
  assert.equal(s.cause, "撞上障碍");
  assert.ok(events.includes("dead"));
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
