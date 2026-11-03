// 심야자습 출석부 index.html의 드라이브 백업(지문 건너뜀·자동 백업 순서·토큰·업로드·작업 줄)을 꺼내 vm에서 확인하는 시험(서현관 심야자습 저장소가 옆에 있으면 함께)
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import vm from "node:vm";
import { REPO, SIBLING, read, hasSibling, block, fakeStorage, context, run, inlineScripts } from "./helpers.mjs";

const APPS = [{ name: "심야 태하관", dir: REPO }];
if (hasSibling()) APPS.push({ name: "심야 서현관", dir: SIBLING });

for (const app of APPS) {
  const html = read(join(app.dir, "index.html"));

  test(`${app.name}: 인라인 스크립트가 모두 문법 오류 없이 읽힌다`, () => {
    const scripts = inlineScripts(html);
    assert.ok(scripts.length >= 2);
    scripts.forEach((code, i) => assert.doesNotThrow(() => new vm.Script(code, { filename: `inline-${i}.js` }), `인라인 ${i}`));
  });

  test(`${app.name}: 옛 4초 지연이 없고, 서비스 워커 캐시 이름이 올라가 새 화면을 받는다`, () => {
    assert.ok(!/\},\s*4000\)/.test(html), "4초 타이머 없음");
    assert.ok(!html.includes("driveBackupNow(false),800"), "0.8초 타이머 없음");
    const sw = read(join(app.dir, "sw.js"));
    assert.match(sw, /const CACHE_NAME = 'pwa-nightcheck-(taeha|seo)-v2';/);
  });

  test(`${app.name}: 지문 기록 키는 백업 대상이 아니다(nsBackupKeys 접두어에 안 걸린다)`, () => {
    const pre = html.match(/const NS_PREFIXES = (\[[^\]]*\]);/)[1];
    const prefixes = vm.runInNewContext(pre);
    const k = "studyDriveStamp:/nightcheck-taeha";
    assert.ok(!prefixes.some((p) => k.startsWith(p)) && k !== "nightStudyDriveCfg");
  });

  // ---------- 백업 지문 ----------
  function stampCtx(extra = {}) {
    const store = fakeStorage();
    const ctx = context({ localStorage: store, location: { pathname: "/nightcheck-taeha/index.html" }, ...extra });
    run(block(html, "backup-stamp"), ctx, "backup-stamp.js");
    return { ctx, store };
  }

  test(`${app.name}: 지문 — 같은 내용이면 같고, 드라이브 설정(nightStudyDriveCfg)·자동 비움 시각(lastAutoClearTimestamp_v2)은 빼고, 기록이 바뀌면 달라진다`, async () => {
    const { ctx } = stampCtx();
    const base = { smartAttendanceHistory_v2: '{"20261103":{}}', nightStudyTheme: "dark", nightStudyDriveCfg: '{"a":1}', lastAutoClearTimestamp_v2: "1" };
    const h1 = await ctx.studyBackupHash(base);
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.equal(await ctx.studyBackupHash({ ...base, nightStudyDriveCfg: '{"a":2,"folderId":"x"}', lastAutoClearTimestamp_v2: "999" }), h1);
    assert.notEqual(await ctx.studyBackupHash({ ...base, smartAttendanceHistory_v2: '{"20261103":{"x":1}}' }), h1);
    const { ctx: c2 } = stampCtx({ crypto: undefined });
    assert.equal(await c2.studyBackupHash(base), "", "계산이 안 되면 빈 값(올린다)");
  });

  test(`${app.name}: 건너뛰기 — 지문·클라이언트 ID·폴더가 모두 같고 7일 안일 때만, 기록 키는 경로 정규화`, () => {
    const { ctx } = stampCtx();
    const now = Date.UTC(2026, 10, 4, 10);
    const st = { hash: "h", clientId: "c", folder: "f_백업", uploadedAt: now - 3600000 };
    assert.equal(ctx.driveCanSkip(st, "h", "c", "f_백업", now), true);
    assert.equal(ctx.driveCanSkip(st, "h2", "c", "f_백업", now), false);
    assert.equal(ctx.driveCanSkip(st, "h", "c2", "f_백업", now), false);
    assert.equal(ctx.driveCanSkip(st, "h", "c", "g_백업", now), false);
    assert.equal(ctx.driveCanSkip({ ...st, uploadedAt: now - 7 * 86400000 }, "h", "c", "f_백업", now), false, "7일 지남");
    assert.equal(ctx.driveCanSkip({ ...st, uploadedAt: now + 1 }, "h", "c", "f_백업", now), false);
    assert.equal(ctx.driveStampKey(), "studyDriveStamp:/nightcheck-taeha");
  });

  // ---------- 자동 백업 순서 ----------
  async function autoRun({ cfg, cfgAfter, hash = "h", stamp = {}, gsiOk = true, gsiDelay = 0, readyState = "complete", fireLoad = true } = {}) {
    const calls = [];
    let saved = null, gdCalls = 0;
    const loads = [];
    const clk = { v: Date.now() };
    const ctx = context({
      Date: { now: () => clk.v },
      document: { readyState },
      addEventListener: (type, fn) => { if (type === "load") loads.push(fn); },
      gd: () => (gdCalls++ === 0 || !cfgAfter ? cfg : cfgAfter),
      buildNightBackup: () => ({ store: { a: "1" } }),
      studyBackupHash: async () => hash,
      driveStamp: () => ({ ...stamp }),
      driveStampSave: (s) => { saved = s; },
      driveCanSkip: (st, h, c, f, now) => !!h && st.hash === h && st.clientId === c && st.folder === f && now - st.uploadedAt < 7 * 86400000,
      gdriveFolder: () => "f_백업",
      ensureGsi: async () => { clk.v += gsiDelay; calls.push("gsi"); return gsiOk; },
      driveBackupNow: async (i) => { calls.push(["now", i]); },
      setTimeout: () => { throw new Error("타이머를 쓰지 않는다"); },
    });
    run(block(html, "auto-backup"), ctx, "auto-backup.js");
    await new Promise((r) => setImmediate(r));
    const beforeLoad = [...calls];
    if (fireLoad) loads.forEach((fn) => fn());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return { calls, saved, beforeLoad, loads: loads.length };
  }

  test(`${app.name}: 자동 백업 — 화면 준비(onload) 뒤 load 때, 같은 내용이면 구글 모듈 없이 건너뜀, 바뀌었으면 모듈 성공 뒤에만 조용한 업로드`, async () => {
    const now = Date.now();
    let r = await autoRun({ cfg: { auto: true, clientId: "c" }, stamp: { hash: "h", clientId: "c", folder: "f_백업", uploadedAt: now - 1000 } });
    assert.deepEqual(r.calls, []);
    assert.ok(r.saved && typeof r.saved.skippedAt === "number");
    r = await autoRun({ cfg: { auto: true, clientId: "c" }, stamp: { hash: "old" } });
    assert.deepEqual(r.calls, ["gsi", ["now", false]]);
    r = await autoRun({ cfg: { auto: true, clientId: "c" }, gsiOk: false });
    assert.deepEqual(r.calls, ["gsi"]);
    r = await autoRun({ cfg: { auto: true, clientId: "c" }, readyState: "loading", stamp: { hash: "old" } });
    assert.equal(r.loads, 1);
    assert.deepEqual(r.beforeLoad, [], "load 전에는 아무것도 안 한다");
    assert.deepEqual(r.calls, ["gsi", ["now", false]]);
    for (const cfg of [{}, { auto: true }, { clientId: "c" }]) {
      r = await autoRun({ cfg });
      assert.deepEqual(r.calls, [], JSON.stringify(cfg));
    }
    const cfg = { auto: true, clientId: "c" };
    r = await autoRun({ cfg, stamp: { hash: "old" }, gsiDelay: 2900 });
    assert.deepEqual(r.calls, ["gsi", ["now", false]], "3초 안이면 올린다");
    r = await autoRun({ cfg, stamp: { hash: "old" }, gsiDelay: 3100 });
    assert.deepEqual(r.calls, ["gsi"], "3초가 지나 준비되면 로그인 창을 늦게 열지 않는다");
    r = await autoRun({ cfg, cfgAfter: { auto: false, clientId: "c" }, stamp: { hash: "old" } });
    assert.deepEqual(r.calls, [], "도중에 자동 백업을 끄면 멈춘다");
    r = await autoRun({ cfg, cfgAfter: { auto: true, clientId: "c2" }, stamp: { hash: "old" } });
    assert.deepEqual(r.calls, [], "도중에 ID를 바꾸면 멈춘다");
  });

  // ---------- 구글 준비·토큰 ----------
  test(`${app.name}: 구글 준비 실패 — 자동(false)이면 토스트 없이, 수동이면 토스트`, async () => {
    for (const [cfg, ready] of [[{}, true], [{ clientId: "c" }, false]]) {
      for (const interactive of [false, true]) {
        const toasts = [];
        const ctx = context({ gd: () => cfg, gisReady: () => ready, ensureGsi: async () => false, nsToast: (m) => toasts.push(m), GDRIVE_SCOPE: "s" });
        run(`var gTokenClient=null, gAccessToken="", gTokenExp=0, gTokenCb=null, gAccessTokenFor="";\n` + block(html, "init-client"), ctx, "init-client.js");
        assert.equal(await ctx.gInitClient(interactive), false);
        assert.equal(toasts.length, interactive === false ? 0 : 1);
      }
    }
  });

  test(`${app.name}: 로그인 응답 — ID를 바꾼 뒤 늦게 온 옛 응답은 무시, 지금 객체의 응답만 받는다`, async () => {
    const made = [];
    const ctx = context({
      gd: () => ({ clientId: "A" }), gisReady: () => true, ensureGsi: async () => true, nsToast: () => {}, GDRIVE_SCOPE: "s",
      google: { accounts: { oauth2: { initTokenClient: (o) => { const tc = { o }; made.push(tc); return tc; } } } },
    });
    run(`var gTokenClient=null, gAccessToken="", gTokenExp=0, gTokenCb=null, gAccessTokenFor="";\n` + block(html, "init-client"), ctx, "init-client.js");
    await ctx.gInitClient(true);
    let called = 0;
    run("gTokenClient = null;", ctx);
    ctx.__cb = () => { called++; };
    run("gTokenCb = window.__cb;", ctx);
    made[0].o.callback({ access_token: "old", expires_in: 3600 });
    assert.equal(run("gAccessToken", ctx), "");
    assert.equal(called, 0);
    await ctx.gInitClient(true);
    made[1].o.callback({ access_token: "new", expires_in: 3600 });
    assert.equal(run("gAccessTokenFor", ctx), "A");
    assert.equal(called, 1);
  });

  test(`${app.name}: 토큰 — 같은 ID 토큰만 다시 쓰고, 응답이 없으면 시간 초과, 준비 예외도 실패`, async () => {
    const timers = [];
    const mk = (init, request, ginit = async () => true) => {
      const ctx = context({ gd: () => ({ clientId: "c" }), gInitClient: ginit, setTimeout: (fn) => { timers.push(fn); return 1; }, clearTimeout: () => {} });
      run(init + "\n" + block(html, "token"), ctx, "token.js");
      ctx.__request = request;
      return ctx;
    };
    const far = Date.now() + 3600000;
    let asked = 0;
    let ctx = mk(`var gTokenClient={ requestAccessToken: (o) => window.__request(o) }, gAccessToken="t", gTokenExp=${far}, gTokenCb=null, gAccessTokenFor="c";`, () => { asked++; });
    assert.equal(await ctx.gGetToken(false), true);
    assert.equal(asked, 0);
    ctx = mk(`var gTokenClient={ requestAccessToken: (o) => window.__request(o) }, gAccessToken="", gTokenExp=0, gTokenCb=null, gAccessTokenFor="";`, () => {});
    const p = ctx.gGetToken(false);
    await new Promise((r) => setImmediate(r));
    timers.at(-1)();
    assert.equal(await p, false);
    assert.equal(run("gTokenClient", ctx), null, "시간 초과면 그 로그인 객체를 버린다");
    ctx = mk(`var gTokenClient=null, gAccessToken="", gTokenExp=0, gTokenCb=null, gAccessTokenFor="";`, () => {}, async () => { throw new Error("x"); });
    assert.equal(await ctx.gGetToken(false), false);
  });

  test(`${app.name}: 구글 모듈 로드 — 15초 제한, 실패하면 다음에 다시 시도`, async () => {
    const scripts = [], timers = [];
    const ctx = context({
      document: { createElement: () => ({}), head: { appendChild: (s) => scripts.push(s) } },
      setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
      setInterval: (fn) => setInterval(fn, 1), clearInterval: (id) => clearInterval(id),
    });
    run(block(html, "gsi"), ctx, "gsi.js");
    let p = ctx.ensureGsi();
    timers[0]();
    assert.equal(await p, false);
    p = ctx.ensureGsi();
    assert.equal(scripts.length, 2);
    run("globalThis.google = { accounts: { oauth2: {} } };", ctx);
    scripts[1].onload();
    assert.equal(await p, true);
  });

  // ---------- 업로드·폴더·작업 줄·ID 바꿈 ----------
  async function uploadRun({ failAt = null, changeAfterPut = 0, idAfter = "c", tokenFor = "c" } = {}) {
    const puts = [], stamps = [];
    let builds = 0, ensure = 0;
    const live = { smartAttendanceHistory_v2: "v1" };
    const cur = { id: "c" };
    const ctx = context({
      gAccessTokenFor: tokenFor,
      gEnsureFolder: async () => { ensure++; return "folder1"; },
      buildNightBackup: () => { builds++; return { _app: "nightStudyAttendance", store: { ...live } }; },
      studyBackupHash: async (store) => "hash:" + store.smartAttendanceHistory_v2,
      gFindFile: async () => { live.smartAttendanceHistory_v2 = "v2"; return null; },
      gPutFile: async (name, json) => {
        puts.push([name, JSON.parse(json).store.smartAttendanceHistory_v2]);
        if (failAt === puts.length) throw new Error("upload 500");
        if (changeAfterPut === puts.length) cur.id = idAfter;
        return { id: "x", name };
      },
      nsTodayStr: () => "2026-11-04",
      gd: () => ({ clientId: cur.id, keepDays: 30 }),
      gdriveFolder: () => "f_백업",
      driveStampSave: (s) => stamps.push(s),
      gCleanOld: () => {},
    });
    run(block(html, "upload"), ctx, "upload.js");
    let err = null;
    try { await ctx.gUploadBackup(); } catch (e) { err = e; }
    return { puts, stamps, builds, err, ensure };
  }

  test(`${app.name}: 업로드 — 한 번 만든 내용의 지문을 두 파일 성공 뒤에만, ID가 바뀌면 기록 안 함, 다른 ID 토큰이면 올리지 않음`, async () => {
    let r = await uploadRun();
    assert.equal(r.builds, 1);
    assert.deepEqual(r.puts, [["최신.json", "v1"], ["2026-11-04.json", "v1"]]);
    assert.equal(r.stamps.length, 1);
    assert.equal(r.stamps[0].hash, "hash:v1");
    for (const failAt of [1, 2]) { r = await uploadRun({ failAt }); assert.ok(r.err); assert.equal(r.stamps.length, 0); }
    r = await uploadRun({ changeAfterPut: 2, idAfter: "c2" });
    assert.equal(r.stamps.length, 0);
    r = await uploadRun({ tokenFor: "old" });
    assert.ok(r.err);
    assert.equal(r.ensure, 0);
    assert.equal(r.puts.length, 0);
  });

  test(`${app.name}: 폴더 확인 — 최신 설정에 폴더 칸만 합치고, ID가 바뀌었으면 저장 안 함`, async () => {
    let cfg = { clientId: "c", auto: true, keepDays: 30 };
    const saves = [];
    const ctx = context({
      gd: () => JSON.parse(JSON.stringify(cfg)), gdSave: (c) => { saves.push(c); cfg = c; }, gdriveFolder: () => "f_백업",
      gFetch: async () => { cfg = { ...cfg, keepDays: 60 }; return { ok: true, json: async () => ({ files: [{ id: "old1" }] }) }; },
    });
    run(block(html, "ensure-folder"), ctx, "ensure-folder.js");
    assert.equal(await ctx.gEnsureFolder(), "old1");
    assert.equal(saves[0].keepDays, 60);
    assert.equal(saves[0].folderId, "old1");
    let cfg2 = { clientId: "c" };
    const saves2 = [];
    const ctx2 = context({
      gd: () => ({ ...cfg2 }), gdSave: (c) => saves2.push(c), gdriveFolder: () => "f_백업",
      gFetch: async () => { cfg2 = { clientId: "c2" }; return { ok: true, json: async () => ({ files: [{ id: "old1" }] }) }; },
    });
    run(block(html, "ensure-folder"), ctx2, "ensure-folder.js");
    await ctx2.gEnsureFolder();
    assert.equal(saves2.length, 0);
  });

  test(`${app.name}: 드라이브 작업 — 겹쳐도 차례대로, 자동은 조용히, 앞 작업이 실패해도 줄이 막히지 않음`, async () => {
    const log = [];
    let cfg = { clientId: "c", auto: true };
    const ctx = context({
      gd: () => cfg, gInitClient: async () => true,
      gGetToken: async (loud) => { log.push(`token:${loud}`); await new Promise((r) => setImmediate(r)); return true; },
      gUploadBackup: async () => { log.push("up:start"); await new Promise((r) => setImmediate(r)); log.push("up:end"); return { name: "x.json" }; },
      gEnsureFolder: async () => { log.push("folder"); }, renderDriveStatus: () => {}, nsToast: (m) => log.push(`toast:${m}`),
    });
    run(block(html, "drive-ops"), ctx, "drive-ops.js");
    const all = [ctx.driveBackupNow(false), ctx.driveBackupNow(true), ctx.driveConnect()];
    assert.deepEqual(log, ["toast:앞의 드라이브 작업이 끝나면 이어서 백업합니다", "toast:앞의 드라이브 작업이 끝나면 이어서 연결합니다"], "수동 작업은 줄을 서기 전에 바로 안내");
    log.length = 0;
    await Promise.all(all);
    assert.deepEqual(log.filter((x) => !x.startsWith("toast:")), ["token:false", "up:start", "up:end", "token:true", "up:start", "up:end", "token:true", "folder"]);
    assert.deepEqual(log.slice(0, 3), ["token:false", "up:start", "up:end"]);
    log.length = 0; cfg = {};
    await ctx.driveBackupNow(false);
    assert.deepEqual(log, []);
    cfg = { clientId: "c", auto: false };
    await ctx.driveBackupNow(false);
    assert.deepEqual(log, [], "줄을 서는 사이 자동 백업이 꺼졌으면 하지 않는다");
    cfg = { clientId: "c", auto: true };
    ctx.gUploadBackup = async () => { throw new Error("x"); };
    await ctx.driveBackupNow(false);
    ctx.gUploadBackup = async () => { log.push("again"); return { name: "y" }; };
    await ctx.driveBackupNow(false);
    assert.ok(log.includes("again"));
  });

  test(`${app.name}: 복원 — 이 앱의 백업 키만 받고, 끝나면 드라이브 지문 기록을 지운다`, () => {
    const store = fakeStorage({ nightStudyTheme: "old" });
    let cleared = 0, reloaded = 0;
    const prefixes = vm.runInNewContext(html.match(/const NS_PREFIXES = (\[[^\]]*\]);/)[1]);
    const file = { _app: "nightStudyAttendance", store: { nightStudyTheme: "new", smartAttendanceHistory_v2: "{}", nightStudyDriveCfg: "{}", "studyDriveStamp:/nightcheck-taeha": '{"hash":"x"}', 남의키: "x" } };
    const ctx = context({
      localStorage: store, NS_PREFIXES_SRC: JSON.stringify(prefixes),
      FileReader: class { readAsText() { this.onload({ target: { result: JSON.stringify(file) } }); } },
      confirm: () => true, nsToast: () => {}, driveStampClear: () => { cleared++; },
      nsBackupKeys: () => ["nightStudyTheme"], setTimeout: (fn) => fn(), location: { reload: () => { reloaded++; } },
    });
    run(`var NS_PREFIXES = JSON.parse(NS_PREFIXES_SRC);\n` + block(html, "restore"), ctx, "restore.js");
    ctx.doNightRestore({ target: { files: [{}], value: "x" } });
    assert.equal(store.getItem("nightStudyTheme"), "new");
    assert.equal(store.getItem("smartAttendanceHistory_v2"), "{}");
    assert.equal(store.getItem("nightStudyDriveCfg"), "{}");
    assert.equal(store.getItem("studyDriveStamp:/nightcheck-taeha"), null, "복원 파일의 지문 기록은 받지 않는다");
    assert.equal(store.getItem("남의키"), null);
    assert.equal(cleared, 1);
    assert.equal(reloaded, 1);
  });

  test(`${app.name}: 클라이언트 ID를 바꾸면 토큰·지문 기록을 버리고 기다리던 요청은 실패로`, () => {
    let pending = null, cleared = 0;
    const ctx = context({
      gd: () => ({ clientId: "old" }), gdSave: () => {}, document: { getElementById: () => ({ value: "new" }) },
      driveStampClear: () => { cleared++; }, renderDriveStatus: () => {},
    });
    ctx.__pending = (ok) => { pending = ok; };
    run(`var gTokenClient={}, gAccessToken="t", gAccessTokenFor="old", gTokenExp=9, gTokenCb=window.__pending;\n` + block(html, "client-id"), ctx, "client-id.js");
    ctx.saveDriveClientId();
    assert.equal(pending, false);
    assert.equal(run("gAccessToken", ctx), "");
    assert.equal(run("gAccessTokenFor", ctx), "");
    assert.equal(cleared, 1);
  });
}

test("심야 두 앱의 백업 구간이 같다", () => {
  // 서현관 심야자습 저장소가 없으면 건너뛰지 않고 실패한다(두 앱이 같아야 한다는 규칙을 확인하지 못한 채 통과하지 않게)
  assert.ok(hasSibling(), `서현관 심야자습 저장소(${SIBLING})가 옆에 있어야 한다 — 같은 상위 폴더에 nightcheck-seo를 받아 두고 시험하세요`);
  const a = read(join(REPO, "index.html")), b = read(join(SIBLING, "index.html"));
  for (const name of ["gsi", "backup-stamp", "init-client", "token", "ensure-folder", "auto-backup", "upload", "drive-ops", "client-id", "restore"]) assert.equal(block(b, name), block(a, name), name);
});
