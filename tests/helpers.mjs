// 시험 도우미 — index.html의 표시 구간을 꺼내 vm에서 돌리고, 가짜 localStorage를 만든다(자습실 출석부 시험 도우미와 같은 모양)
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, "..");
export const SIBLING = join(REPO, "..", "nightcheck-seo"); // 서현관 심야자습 저장소(같은 PC에 있을 때만 함께 시험)

export function read(path) { return readFileSync(path, "utf8").replace(/\r\n/g, "\n"); }
export function hasSibling() { return existsSync(join(SIBLING, "index.html")); }

// "// [이름:start]" ~ "// [이름:end]" 사이를 꺼낸다(둘 다 정확히 한 번 있어야 한다)
export function block(html, name) {
  const s = `// [${name}:start]`, e = `// [${name}:end]`;
  const i = html.indexOf(s), j = html.indexOf(e);
  if (i < 0 || j < 0 || html.indexOf(s, i + 1) >= 0 || html.indexOf(e, j + 1) >= 0) throw new Error(`${name} 구간을 찾지 못했다`);
  return html.slice(i, j + e.length);
}

export function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    _map: m,
  };
}

// window = 전역인 vm 문맥
export function context(extra = {}) {
  const ctx = { console, crypto: webcrypto, TextEncoder, Date, JSON, Math, setTimeout, clearTimeout, ...extra };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

export function run(code, ctx, filename = "block.js") { return new vm.Script(code, { filename }).runInContext(ctx); }

// index.html 안의 인라인 <script>들(src 없는 것)
export function inlineScripts(html) {
  const out = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) if (!/\bsrc\s*=/.test(m[1] || "")) out.push(m[2]);
  return out;
}
