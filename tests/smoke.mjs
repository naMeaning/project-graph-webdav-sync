// 用 Node 模拟 Project Graph 宿主环境，跑通同步引擎的主流程。
// 运行：node tests/smoke.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");

assert.ok(!/^\s*import\s/m.test(source), "扩展运行在 Blob URL Worker，不允许 import 语句");
assert.ok(!/^\s*export\s/m.test(source), "主程序把代码包进 async IIFE 执行，export 会导致 SyntaxError");
assert.ok(!/require\s*\(/.test(source), "扩展不允许 CommonJS require");
// 按主程序 ExtensionRuntime 的真实包装方式做语法检查（这正是上一版 export {} 翻车的原因）
new vm.Script(`(async () => {\n${source}\n})();`);

const tmpFile = path.join(ROOT, "tests", ".tmp-extension.mjs");
fs.writeFileSync(tmpFile, source, "utf8");

// ── 模拟环境 ──────────────────────────────────────────────
const settings = new Map();
const commands = new Map();
const toasts = [];
const copies = [];
const writes = [];
const remoteFiles = new Map(); // pathname -> Uint8Array
const remoteEtags = new Map();
const s3Meta = new Map();
let etagCounter = 0;
const answers = { buttons: [], inputs: [], confirm: true, form: undefined };
// 模拟「工程目录只读」：写入 .sync.json 失败，配置流程必须退回弹窗而不是卡死
let failConfigWrite = false;
const capturedS3 = [];

// 模拟磁盘（既是配置文件所在的磁盘，也是目录同步要遍历的本地目录树）
const localFiles = new Map(); // uriPath -> Uint8Array
function vfsSet(p, content) {
  localFiles.set(p, typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content));
}
function vfsText(p) {
  const bytes = localFiles.get(p);
  return bytes ? new TextDecoder().decode(bytes) : "";
}
function vfsClear() {
  localFiles.clear();
}
const formCalls = [];

// 模拟主程序对话框的真实时序：resolve 之后遮罩还要 ~60ms 才真正消失。
// 若扩展连续弹窗而不留间隔，dialogsMaxActive 会 > 1（真机上表现为后一个对话框被前一个遮罩盖住）。
const dialogStats = { input: 0, buttons: 0, confirm: 0, copy: 0 };
let dialogsActive = 0;
let dialogsMaxActive = 0;
function trackDialog(kind, fn) {
  return async (...args) => {
    dialogStats[kind] += 1;
    dialogsActive += 1;
    if (dialogsActive > dialogsMaxActive) dialogsMaxActive = dialogsActive;
    try {
      return await fn(...args);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 60));
      dialogsActive -= 1;
    }
  };
}

const state = {
  content: prgBytes("local-v1"),
  disk: prgBytes("local-v1"),
  stageHash: "hash-local-v1",
};

function prgBytes(tag) {
  const body = new TextEncoder().encode(tag);
  const bytes = new Uint8Array(2 + body.length);
  bytes[0] = 0x50;
  bytes[1] = 0x4b;
  bytes.set(body, 2);
  return bytes;
}

function asArrayBuffer(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function mockResponse(status, headers, bytes) {
  return {
    status: Promise.resolve(status),
    headers: Promise.resolve({
      get: async (name) => headers[String(name).toLowerCase()] ?? null,
    }),
    arrayBuffer: async () => asArrayBuffer(bytes || new Uint8Array(0)),
  };
}

function isS3(init) {
  return String(init.headers?.authorization || "").startsWith("AWS4-HMAC-SHA256");
}

async function fetchImpl(url, init) {
  const parsed = new URL(url);
  const key = parsed.pathname;
  const headers = init.headers || {};
  const method = init.method;
  const s3 = isS3(init);

  assert.ok(s3 || headers.Authorization?.startsWith("Basic "), "WebDAV 请求必须带 Basic 认证头");

  if (s3 && method === "PUT") {
    const body = new Uint8Array(init.body);
    const expectedHash = crypto.createHash("sha256").update(body).digest("hex");
    assert.equal(headers["x-amz-content-sha256"], expectedHash, "S3 payload hash 必须等于请求体 SHA-256");
    assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=.+, SignedHeaders=.+, Signature=[0-9a-f]{64}$/);
    capturedS3.push({ url, headers, body });
    s3Meta.set(key, {
      "x-amz-meta-pg-hash": headers["x-amz-meta-pg-hash"],
      "content-length": String(body.byteLength),
      etag: `s3-etag-${++etagCounter}`,
    });
    remoteFiles.set(key, body);
    return mockResponse(200, { etag: s3Meta.get(key).etag }, new Uint8Array(0));
  }

  if (method === "MKCOL") return mockResponse(remoteFiles.has(key) ? 405 : 201, {}, new Uint8Array(0));
  if (method === "DELETE") {
    const target = key.replace(/\/+$/, "");
    for (const k of [...remoteFiles.keys()]) {
      if (k === target || k.startsWith(`${target}/`)) {
        remoteFiles.delete(k);
        remoteEtags.delete(k);
        s3Meta.delete(k);
      }
    }
    return mockResponse(204, {}, new Uint8Array(0));
  }
  // 目录同步：Depth:1 列目录（含目录自身，与真实 WebDAV 一致）
  if (method === "PROPFIND" && String(headers.Depth || headers.depth || "0") === "1") {
    const dir = key.replace(/\/+$/, "");
    const children = [];
    const seen = new Set();
    for (const p of remoteFiles.keys()) {
      if (!p.startsWith(`${dir}/`)) continue;
      const rest = p.slice(dir.length + 1);
      const name = rest.split("/")[0];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const isDir = rest.includes("/");
      children.push({
        href: `${dir}/${name}${isDir ? "/" : ""}`,
        isDir,
        etag: isDir ? "" : s3Meta.get(p)?.etag || remoteEtags.get(p) || "",
        size: isDir ? 0 : remoteFiles.get(p).byteLength,
      });
    }
    const xml =
      `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">` +
      `<d:response><d:href>${dir}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>` +
      children
        .map(
          (c) =>
            `<d:response><d:href>${encodeURI(c.href)}</d:href><d:propstat><d:prop>${
              c.isDir
                ? "<d:resourcetype><d:collection/></d:resourcetype>"
                : `<d:getcontentlength>${c.size}</d:getcontentlength><d:getetag>"${c.etag}"</d:getetag>`
            }</d:prop></d:propstat></d:response>`,
        )
        .join("") +
      `</d:multistatus>`;
    return mockResponse(207, {}, new TextEncoder().encode(xml));
  }
  if (method === "PUT") {
    assert.ok(init.body instanceof Uint8Array, "PUT body 必须是 Uint8Array");
    remoteFiles.set(key, new Uint8Array(init.body));
    remoteEtags.set(key, `etag-${++etagCounter}`);
    return mockResponse(201, { etag: remoteEtags.get(key) }, new Uint8Array(0));
  }
  if (method === "HEAD") {
    if (!remoteFiles.has(key)) return mockResponse(404, {}, new Uint8Array(0));
    const meta = s3Meta.get(key) || {};
    return mockResponse(
      200,
      {
        etag: meta.etag || remoteEtags.get(key) || "",
        "content-length": String(remoteFiles.get(key).byteLength),
        ...meta,
      },
      new Uint8Array(0),
    );
  }
  if (method === "GET") {
    if (!remoteFiles.has(key)) return mockResponse(404, {}, new Uint8Array(0));
    return mockResponse(200, { etag: remoteEtags.get(key) || "" }, remoteFiles.get(key));
  }
  throw new Error(`mock: 未实现的方法 ${method}`);
}

function makeUri() {
  return {
    scheme: Promise.resolve("file"),
    fsPath: Promise.resolve("C:/notes/demo.prg"),
    path: Promise.resolve("/C:/notes/demo.prg"),
    with: async (change) => ({ ...makeUri(), path: Promise.resolve(change.path) }),
  };
}

const project = {
  get uri() {
    return Promise.resolve(makeUri());
  },
  get fs() {
    return Promise.resolve({
      read: async (uri) => {
        const target = await uri.path;
        if (localFiles.has(target)) return new Uint8Array(localFiles.get(target));
        if (target === "/C:/notes/demo.prg") return new Uint8Array(state.disk);
        throw new Error(`ENOENT: ${target}`);
      },
      write: async (uri, bytes) => {
        const target = await uri.path;
        if (failConfigWrite && target.endsWith(".sync.json")) throw new Error("EACCES: readonly");
        writes.push({ path: target, bytes: new Uint8Array(bytes) });
        if (target === "/C:/notes/demo.prg") {
          state.disk = new Uint8Array(bytes);
          return;
        }
        localFiles.set(target, new Uint8Array(bytes));
      },
      // 目录同步依赖：逐层列出目录、删除文件
      readDir: async (uri) => {
        const dir = String(await uri.path).replace(/\/+$/, "");
        const out = [];
        const seen = new Set();
        for (const p of localFiles.keys()) {
          if (!p.startsWith(`${dir}/`)) continue;
          const rest = p.slice(dir.length + 1);
          const name = rest.split("/")[0];
          if (!name || seen.has(name)) continue;
          seen.add(name);
          const isDir = rest.includes("/");
          out.push({ name, isDirectory: isDir, isFile: !isDir, isSymlink: false });
        }
        return out;
      },
      remove: async (uri) => {
        const target = String(await uri.path);
        for (const p of [...localFiles.keys()]) {
          if (p === target || p.startsWith(`${target}/`)) localFiles.delete(p);
        }
      },
      exists: async (uri) => localFiles.has(String(await uri.path)),
      mkdir: async () => {},
    });
  },
  get stageHash() {
    return Promise.resolve(state.stageHash);
  },
  getFileContent: async () => new Uint8Array(state.content),
  save: async () => {
    state.disk = new Uint8Array(state.content);
  },
  init: async () => {
    state.content = new Uint8Array(state.disk);
    state.stageHash = `hash-${new TextDecoder().decode(state.content.slice(2))}`;
  },
};

globalThis.prg = {
  settings_getOwn: async (key) => (settings.has(key) ? JSON.parse(JSON.stringify(settings.get(key))) : undefined),
  settings_setOwn: async (key, value) => settings.set(key, JSON.parse(JSON.stringify(value))),
  toast: async (m) => toasts.push(["info", m]),
  toast_success: async (m) => toasts.push(["success", m]),
  toast_error: async (m) => toasts.push(["error", m]),
  toast_warning: async (m) => toasts.push(["warning", m]),
  dialog_confirm: trackDialog("confirm", async () => answers.confirm),
  dialog_input: trackDialog("input", async (_title, _desc, options) => {
    const next = answers.inputs.length ? answers.inputs.shift() : (options?.defaultValue ?? "");
    // 特殊标记：模拟「对话框不可用」和「用户点取消」
    if (next === "__unsupported__") throw new Error("dialog_input is not available");
    if (next === "__cancel__") throw undefined;
    return next;
  }),
  dialog_buttons: trackDialog("buttons", async () =>
    answers.buttons.length ? answers.buttons.shift() : "cancel",
  ),
  dialog_copy: trackDialog("copy", async (...args) => copies.push(args)),
  keybinds_register: async (id, _icon, _key, callback) => commands.set(id, callback),
  fetch: fetchImpl,
  // prg.form 模拟：undefined / "unsupported" → 抛错（版本不支持）；"cancel" → reject()（用户取消）；
  // 对象 → 正常提交
  form: async (schema, options) => {
    formCalls.push({ schema, options });
    if (answers.form === undefined || answers.form === "unsupported") {
      throw new Error("prg.form is not available");
    }
    if (answers.form === "cancel") throw undefined;
    return JSON.parse(JSON.stringify(answers.form));
  },
  shell_execute: async () => ({ code: 0, stdout: "\n200", stderr: "" }),
  tabs_getCurrentProject: async () => project,
};

globalThis.Comlink = { proxy: (fn) => fn };

// ── 加载扩展 ──────────────────────────────────────────────
// 配置必须是扁平键：主程序设置面板只渲染已存在的键，且只支持 boolean / 字符串
const FLAT_WEBDAV = {
  backend: "webdav",
  "webdav.root": "https://dav.jianguoyun.com/dav/",
  "webdav.username": "user@example.com",
  "webdav.appPassword": "app-secret",
  "webdav.remoteDir": "ProjectGraph",
  "s3.endpoint": "",
  "s3.region": "us-east-1",
  "s3.accessKeyId": "",
  "s3.secretAccessKey": "",
  "s3.bucket": "",
  "s3.prefix": "project-graph",
  "s3.forcePathStyle": true,
  // 场景 1-20 都是单文件同步，显式指定 file 模式（默认已是 dir）
  mode: "file",
  localDir: "",
  remoteSubdir: "",
  ignore: "*.sync.json",
  syncDelete: false,
  maxFiles: "800",
  maxTotalMB: "300",
  autoSync: false,
  intervalMinutes: "10",
  maxSizeMB: "480",
  requestBudget: "600",
};
const FLAT_S3 = {
  ...FLAT_WEBDAV,
  backend: "s3",
  "s3.endpoint": "s3.example.com",
  "s3.region": "us-east-1",
  "s3.accessKeyId": "AKIDEXAMPLE",
  "s3.secretAccessKey": "secret",
  "s3.bucket": "my-bucket",
  "s3.prefix": "project-graph",
  "s3.forcePathStyle": true,
};
function setFlatConfig(flat) {
  for (const key of Object.keys(flat)) settings.set(key, flat[key]);
}
function resetState() {
  settings.set("_syncState", JSON.stringify({ baselines: {}, deviceId: "" }));
}

// 只预置账号密码，其余键应由扩展启动时的 ensureSettings() 补齐
settings.set("webdav.username", FLAT_WEBDAV["webdav.username"]);
settings.set("webdav.appPassword", FLAT_WEBDAV["webdav.appPassword"]);
// 场景 1-20 验证单文件同步，显式指定 file 模式（扩展默认是 dir）
settings.set("mode", "file");

// 主程序 Worker 里 Comlink 是全局对象，注册快捷键时用它包装回调。
// v0.2.0 起改成直接传普通函数，实测注册全部失败 —— 这里必须验证回调确实被 proxy 包过。
const proxiedHandlers = [];
globalThis.Comlink = {
  proxy: (fn) => {
    proxiedHandlers.push(fn);
    return fn;
  },
};

await import(pathToFileURL(tmpFile).href);
// 命令 ID 必须全部来自「用户磁盘 keybinds2.json 里已存在」的白名单。
// 新增 ID 会让主程序走写盘分支并失败，导致连已有命令都不显示 —— 用户机器实测过。
const KNOWN_IDS = [
  "sync-now",
  "sync-upload",
  "sync-download",
  "sync-config",
  "sync-status",
  "sync-reset",
];
assert.equal(commands.size, 6, "应注册 6 个命令");
for (const id of commands.keys()) {
  assert.ok(KNOWN_IDS.includes(id), `命令 ID ${id} 不在已有白名单内，会导致注册失败`);
}
assert.ok(String(settings.get("_keybinds") || "").includes("ok"), "_keybinds 应记录注册结果");
assert.ok(proxiedHandlers.length >= 6, `快捷键回调必须用 Comlink.proxy 包装（实际 ${proxiedHandlers.length} 次）`);
assert.ok(String(settings.get("_capabilities") || "").includes("form"), "_capabilities 应记录能力探测");
assert.ok(settings.has("backend") && settings.has("autoSync") && settings.has("intervalMinutes"),
  "启动后必须补齐设置键，否则扩展详情页显示「该扩展没有设置项」");
assert.equal(settings.get("autoSync"), false, "布尔项应保持 boolean（设置页才会渲染开关）");

const remoteKey = "/dav/ProjectGraph/demo.prg";

async function run(id) {
  toasts.length = 0;
  await commands.get(id)();
  const errors = toasts.filter((t) => t[0] === "error");
  assert.equal(errors.length, 0, `命令 ${id} 不应报错：${errors.map((e) => e[1]).join("; ")}`);
}

async function lastAction() {
  copies.length = 0;
  await commands.get("sync-status")();
  const payload = JSON.parse(copies[copies.length - 1][2]);
  return payload.runtime.lastAction;
}

// 场景 1：首次同步，远端为空 → 上传
await run("sync-now");
assert.equal(await lastAction(), "upload");
assert.ok(remoteFiles.has(remoteKey), "首次同步应上传远端文件");
assert.equal(new TextDecoder().decode(remoteFiles.get(remoteKey).slice(2)), "local-v1");
console.log("✓ 首次同步 → 上传");

// 场景 2：两端都无变化 → noop
await run("sync-now");
assert.equal(await lastAction(), "noop");
console.log("✓ 无变化 → 跳过");

// 场景 3：只有本地改 → 上传
state.content = prgBytes("local-v2");
state.stageHash = "hash-local-v2";
await run("sync-now");
assert.equal(await lastAction(), "upload");
assert.equal(new TextDecoder().decode(remoteFiles.get(remoteKey).slice(2)), "local-v2");
console.log("✓ 仅本地变更 → 上传");

// 场景 4：只有远端改 → 下载 + 备份 + 刷新画布
remoteFiles.set(remoteKey, prgBytes("remote-v3"));
remoteEtags.set(remoteKey, `etag-${++etagCounter}`);
writes.length = 0;
await run("sync-now");
assert.equal(await lastAction(), "download");
assert.equal(new TextDecoder().decode(state.disk.slice(2)), "remote-v3", "磁盘应写入远端版本");
assert.ok(writes.some((w) => w.path.includes("backup-")), "下载前应先写本地备份");
assert.equal(new TextDecoder().decode(state.content.slice(2)), "remote-v3", "init() 应刷新画布内容");
console.log("✓ 仅远端变更 → 下载 + 备份 + 刷新");

// 场景 5：两端都改 → 冲突，用户选「两份都保留」
state.content = prgBytes("local-v4");
state.stageHash = "hash-local-v4";
remoteFiles.set(remoteKey, prgBytes("remote-v4"));
remoteEtags.set(remoteKey, `etag-${++etagCounter}`);
writes.length = 0;
answers.buttons.push("both");
await run("sync-now");
assert.ok(writes.some((w) => w.path.includes("conflict-")), "应生成冲突副本");
assert.equal(new TextDecoder().decode(state.content.slice(2)), "local-v4", "保留两份时当前工程不应被改动");
console.log("✓ 双端变更 → 冲突弹窗 → 两份都保留");

// 场景 6：冲突时用户选用远端覆盖本地
state.content = prgBytes("local-v5");
state.stageHash = "hash-local-v5";
remoteFiles.set(remoteKey, prgBytes("remote-v5"));
remoteEtags.set(remoteKey, `etag-${++etagCounter}`);
answers.buttons.push("remote");
await run("sync-now");
assert.equal(await lastAction(), "download");
assert.equal(new TextDecoder().decode(state.content.slice(2)), "remote-v5");
console.log("✓ 冲突选择「用远端覆盖本地」");

// 场景 7：远端被删 → 询问
remoteFiles.delete(remoteKey);
answers.buttons.push("upload");
await run("sync-now");
assert.equal(await lastAction(), "upload");
assert.ok(remoteFiles.has(remoteKey), "选择重新上传后远端应恢复");
console.log("✓ 远端被删 → 询问后重新上传");

// 场景 8：S3 后端签名与自定义元数据
resetState();
setFlatConfig(FLAT_S3);
remoteFiles.clear();
remoteEtags.clear();
capturedS3.length = 0;
state.content = prgBytes("s3-v1");
state.stageHash = "hash-s3-v1";
await run("sync-now");
assert.equal(await lastAction(), "upload");
assert.equal(capturedS3.length, 1, "S3 PUT 应发生一次");
const s3Put = capturedS3[0];
assert.ok(s3Put.url.includes("/my-bucket/project-graph/demo.prg"), "path-style URL 应包含 bucket 与 prefix");
assert.match(s3Put.headers["x-amz-meta-pg-hash"], /^sha256-[0-9a-f]{64}$/);
assert.ok(s3Put.headers["x-amz-date"].endsWith("Z"));
console.log("✓ S3 后端 SigV4 签名 / path-style URL / 自定义元数据");

// 场景 9：用 Node crypto 独立重算 SigV4，交叉验证插件的 WebCrypto 实现
function independentSigV4(url, headers, body, cfg) {
  const u = new URL(url);
  const amzDate = headers["x-amz-date"];
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash("sha256").update(body).digest("hex");
  const all = { host: u.host, ...headers };
  delete all.authorization;
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(all[n]).trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const uri = u.pathname
    .split("/")
    .map((s) => encodeURIComponent(decodeURIComponent(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
  const canonicalRequest = ["PUT", uri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${cfg.s3.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const hmac = (key, text) => crypto.createHmac("sha256", key).update(text).digest();
  let key = hmac(`AWS4${cfg.s3.secretAccessKey}`, dateStamp);
  key = hmac(key, cfg.s3.region);
  key = hmac(key, "s3");
  key = hmac(key, "aws4_request");
  return crypto.createHmac("sha256", key).update(stringToSign).digest("hex");
}
const cfgForCheck = {
  s3: { region: settings.get("s3.region"), secretAccessKey: settings.get("s3.secretAccessKey") },
};
const expected = independentSigV4(s3Put.url, s3Put.headers, s3Put.body, cfgForCheck);
const actual = /Signature=([0-9a-f]{64})/.exec(s3Put.headers.authorization)[1];
assert.equal(actual, expected, "SigV4 签名与独立实现不一致");
console.log("✓ SigV4 签名与独立实现一致");

// 场景 10：中文工程名的 URL 编码
resetState();
setFlatConfig(FLAT_WEBDAV);
remoteFiles.clear();
remoteEtags.clear();
const originalUri = project.uri;
Object.defineProperty(project, "uri", {
  configurable: true,
  get: () =>
    Promise.resolve({
      scheme: Promise.resolve("file"),
      fsPath: Promise.resolve("C:/notes/架构图.prg"),
      path: Promise.resolve("/C:/notes/架构图.prg"),
      with: async (change) => ({ path: Promise.resolve(change.path) }),
    }),
});
await run("sync-upload");
assert.ok(
  [...remoteFiles.keys()].some((k) => k.includes(encodeURIComponent("架构图.prg"))),
  "中文文件名必须 URL 编码",
);
Object.defineProperty(project, "uri", { configurable: true, get: () => originalUri });
console.log("✓ 中文文件名 URL 编码");

// 场景 11：prg.fetch 无法跨线程传二进制 → 自动降级 curl 受限模式
resetState();
setFlatConfig(FLAT_WEBDAV);
globalThis.prg.fetch = async () => {
  throw new Error("DataCloneError: Response object could not be cloned");
};
answers.buttons.push("upload");
const curlFile = path.join(ROOT, "tests", ".tmp-extension-curl.mjs");
fs.writeFileSync(curlFile, source, "utf8");
await import(`${pathToFileURL(curlFile).href}?curl=1`);
toasts.length = 0;
await commands.get("sync-now")();
assert.equal(
  toasts.filter((t) => t[0] === "error").length,
  0,
  `curl 降级不应报错：${toasts.filter((t) => t[0] === "error").map((t) => t[1]).join("; ")}`,
);
assert.ok(
  toasts.some((t) => String(t[1]).includes("curl 受限模式")),
  "应明确告知用户已进入 curl 受限模式",
);
assert.ok(toasts.some((t) => String(t[1]).includes("已上传")), "curl 上传应成功");
globalThis.prg.fetch = fetchImpl;
fs.unlinkSync(curlFile);
console.log("✓ 二进制通道失败 → 自动降级 curl 受限模式");

// 场景 12：首次按配置键 → 在工程同目录生成 .sync.json 模板，全程零弹窗
resetState();
setFlatConfig(FLAT_WEBDAV);
vfsClear();
answers.form = undefined;
answers.inputs = ["__unsupported__"];
answers.buttons = [];
dialogStats.input = 0;
dialogStats.buttons = 0;
toasts.length = 0;
await commands.get("sync-config")();
const configPath = "/C:/notes/demo.sync.json";
assert.ok(localFiles.has(configPath), "首次配置应在工程同目录生成 .sync.json 模板");
assert.ok(vfsText(configPath).includes("账号="), "模板必须包含「账号=」行");
assert.equal(dialogStats.input, 1, "文件通道是最后一级：先试过 1 次对话框才降级");
assert.equal(dialogStats.buttons, 0, "文件通道不应弹按钮框");
assert.ok(
  toasts.some((t) => t[0] === "warning" && String(t[1]).includes("demo.sync.json")),
  `必须提示配置文件路径：${toasts.map((t) => t[1]).join(" | ")}`,
);
console.log("✓ 首次配置生成 .sync.json 模板，零弹窗");

// 场景 13：把模板填好后再次按键 → 直接生效（输入端全废也能配置）
vfsSet(
  configPath,
  [
    "# 注释行必须被忽略",
    "账号=me@example.com",
    "密码=app-pass-123",
    "地址=https://dav.jianguoyun.com/dav/",
    "目录=MyGraph",
    "自动同步=no",
    "间隔分钟=15",
  ].join("\n"),
);
answers.form = undefined;
answers.inputs = ["__unsupported__"];
dialogStats.input = 0;
dialogsMaxActive = 0;
await run("sync-config");
assert.equal(dialogStats.input, 1, "文件通道是最后一级：先试过 1 次对话框");
assert.equal(settings.get("backend"), "webdav");
assert.equal(settings.get("webdav.username"), "me@example.com");
assert.equal(settings.get("webdav.appPassword"), "app-pass-123");
assert.equal(settings.get("webdav.remoteDir"), "MyGraph");
assert.equal(settings.get("autoSync"), false);
assert.equal(settings.get("intervalMinutes"), "15");
console.log("✓ 从 .sync.json 载入配置并生效（零弹窗）");

// 场景 14：S3 配置同样走文件通道
vfsSet(
  configPath,
  ["类型=s3", "endpoint=s3.example.com", "region=us-east-1", "AK=AKIDX", "SK=SECRETX", "桶=bucket1", "前缀=pg", "pathstyle=yes"].join(
    "\n",
  ),
);
answers.form = undefined;
answers.inputs = ["__unsupported__"];
await run("sync-config");
assert.equal(settings.get("backend"), "s3");
assert.equal(settings.get("s3.bucket"), "bucket1");
assert.equal(settings.get("s3.accessKeyId"), "AKIDX");
assert.equal(settings.get("s3.forcePathStyle"), true);
console.log("✓ S3 配置从 .sync.json 生效");

// 场景 15：表单窗口不可用时，退回「单框对话框」——同样在软件内、打字正常回显
vfsClear();
answers.form = undefined;
answers.inputs = ["账号=dialog@example.com\n密码=dialog-pass"];
dialogStats.input = 0;
dialogsMaxActive = 0;
await run("sync-config");
assert.equal(dialogStats.input, 1, "退回对话框时只允许 1 个输入框");
assert.equal(dialogsMaxActive, 1, "同一时刻只允许 1 个对话框");
assert.equal(settings.get("backend"), "webdav");
assert.equal(settings.get("webdav.username"), "dialog@example.com");
console.log("✓ 表单不可用 → 退回单框对话框（软件内、1 个框、不重叠）");

// 场景 16：配置文件漏填必填项要明确报错，不能静默保存
settings.set("backend", "webdav");
settings.set("webdav.appPassword", "");
vfsSet(configPath, "账号=only-user");
answers.form = undefined;
answers.inputs = ["__unsupported__"];
toasts.length = 0;
await commands.get("sync-config")();
assert.ok(
  toasts.some((t) => t[0] === "error" && String(t[1]).includes("密码")),
  `缺密码时必须明确提示：${toasts.map((t) => t[1]).join(" | ")}`,
);
console.log("✓ 配置文件缺必填项时明确报错");

// 场景 17：表单窗口通道（FormWindow 的输入框本地 state 管理，打字正常回显）
resetState();
setFlatConfig(FLAT_WEBDAV);
vfsClear();
answers.form = { 账号: "form@example.com", 密码: "form-pass", 目录: "FormDir" };
formCalls.length = 0;
await run("sync-config");
assert.ok(formCalls.length >= 1, "应调用过 prg.form");
assert.equal(settings.get("backend"), "webdav");
assert.equal(settings.get("webdav.username"), "form@example.com");
assert.equal(settings.get("webdav.appPassword"), "form-pass");
assert.equal(settings.get("webdav.remoteDir"), "FormDir");
const formSchema = formCalls[formCalls.length - 1].schema;
assert.equal(formSchema.type, "object", "schema 必须是 object（FormWindow 只支持 ZodObject）");
assert.ok(
  String(formSchema.$schema || "").includes("json-schema.org"),
  "schema 必须带 $schema 声明：主线程用 z.fromJSONSchema 解析，缺了会直接抛错",
);
const fieldKeys = Object.keys(formSchema.properties);
assert.ok(fieldKeys.length <= 5, `表单字段不能超过 5 个（窗口高度有限，多了保存按钮会被挤出可视区）：${fieldKeys.join(",")}`);
assert.ok(!formSchema.required || formSchema.required.length === 0,
  "不能带 required：只改账号密码时会被必填校验卡住");
for (const key of fieldKeys) {
  assert.equal(formSchema.properties[key].type, "string", `字段「${key}」必须是 string 才能渲染成 Textarea`);
  const desc = String(formSchema.properties[key].description || "");
  assert.ok(desc.length <= 30, `字段标签「${desc}」太长，FormWindow 会把 description 当标题渲染，会占多行`);
}
assert.equal(formCalls[formCalls.length - 1].options.confirmText, "保存");
console.log("✓ 表单窗口通道：填写并保存成功，schema 结构正确（≤5 字段、非必填、短标签）");

// 场景 18：表单全部留空 → 「留空 = 保持不变」，配置原样
settings.set("webdav.username", "keep-me");
settings.set("webdav.appPassword", "keep-pass");
answers.form = {};
toasts.length = 0;
await commands.get("sync-config")();
assert.ok(
  toasts.some((t) => t[0] === "warning" && String(t[1]).includes("留空")),
  `全空时应提示未改动：${toasts.map((t) => t[1]).join(" | ")}`,
);
assert.equal(settings.get("webdav.username"), "keep-me", "留空时账号不应被覆盖");
assert.equal(settings.get("webdav.appPassword"), "keep-pass", "留空时密码不应被覆盖");
console.log("✓ 表单全留空 → 配置保持不变");

// 场景 19：S3 后端时表单应展示 S3 字段
settings.set("backend", "s3");
settings.set("s3.accessKeyId", "");
settings.set("s3.secretAccessKey", "");
settings.set("s3.bucket", "");
answers.form = { 类型: "s3", AK: "AKIDF", SK: "SECF", 桶: "bucketF", pathstyle: "yes" };
formCalls.length = 0;
await run("sync-config");
assert.ok(formCalls.length >= 1, "S3 模式也应打开表单");
assert.ok("AK" in formCalls[0].schema.properties, "S3 模式的表单必须包含 AK 字段");
assert.equal(settings.get("backend"), "s3");
assert.equal(settings.get("s3.accessKeyId"), "AKIDF");
assert.equal(settings.get("s3.secretAccessKey"), "SECF");
assert.equal(settings.get("s3.bucket"), "bucketF");
assert.equal(settings.get("s3.forcePathStyle"), true);
console.log("✓ S3 表单通道：按当前后端展示对应字段");

// 场景 20：用户点「取消」→ 安静结束，不报错、不 fallback
answers.form = "cancel";
toasts.length = 0;
await commands.get("sync-config")();
assert.ok(
  toasts.every((t) => t[0] !== "error"),
  "用户取消不应产生错误提示",
);
assert.ok(toasts.some((t) => String(t[1]).includes("取消")), "取消应提示「已取消」");
answers.form = undefined;
console.log("✓ 表单取消 → 安静结束");

// ── 目录同步（整文件夹）──────────────────────────────────────
// 场景 11 把实例切到了 curl 受限模式，这里重新加载一个干净实例（fetch 正常），
// 等价于用户重载应用后的状态。
const dirModule = path.join(ROOT, "tests", ".tmp-extension-dir.mjs");
fs.writeFileSync(dirModule, source, "utf8");
await import(`${pathToFileURL(dirModule).href}?dir=1`);
globalThis.prg.fetch = fetchImpl;

const DIR_BASE = {
  ...FLAT_WEBDAV,
  mode: "dir",
  localDir: "",
  remoteSubdir: "",
  ignore: "node_modules, .git, *.tmp, *.sync.json",
  syncDelete: false,
  maxFiles: "800",
  maxTotalMB: "300",
  maxSizeMB: "480",
};
const DIR_REMOTE = "/dav/ProjectGraph/notes";

function resetDirWorld() {
  settings.set("_syncState", JSON.stringify({ baselines: {}, deviceId: "" }));
  vfsClear();
  remoteFiles.clear();
  remoteEtags.clear();
  s3Meta.clear();
  vfsSet("/C:/notes/a.txt", "alpha");
  vfsSet("/C:/notes/sub/b.txt", "beta");
  vfsSet("/C:/notes/node_modules/skip.js", "should-not-upload");
}

// 场景 21：首次目录同步 → 递归上传，忽略规则生效
setFlatConfig(DIR_BASE);
resetDirWorld();
await run("sync-now");
assert.ok(remoteFiles.has(`${DIR_REMOTE}/a.txt`), "应上传根目录文件");
assert.ok(remoteFiles.has(`${DIR_REMOTE}/sub/b.txt`), "应递归上传子目录文件");
assert.ok(!remoteFiles.has(`${DIR_REMOTE}/node_modules/skip.js`), "忽略规则必须生效");
assert.equal(new TextDecoder().decode(remoteFiles.get(`${DIR_REMOTE}/a.txt`)), "alpha");
console.log("✓ 目录同步：首次递归上传，忽略规则生效");

// 场景 22：无变化 → 不再上传
const dirCountBefore = remoteFiles.size;
await run("sync-now");
assert.equal(remoteFiles.size, dirCountBefore, "无变化时不应新增远端文件");
assert.ok(
  toasts.some((t) => String(t[1]).includes("已是最新")),
  `应提示目录已是最新：${toasts.map((t) => t[1]).join(" | ")}`,
);
console.log("✓ 目录同步：无变化时不重复上传");

// 场景 23：本地改一个文件 → 只上传它
vfsSet("/C:/notes/a.txt", "alpha-v2");
await run("sync-now");
assert.equal(new TextDecoder().decode(remoteFiles.get(`${DIR_REMOTE}/a.txt`)), "alpha-v2");
console.log("✓ 目录同步：本地变更 → 只上传该文件");

// 场景 24：远端新增文件 → 下载到本地
remoteFiles.set(`${DIR_REMOTE}/remote.txt`, new TextEncoder().encode("from-remote"));
remoteEtags.set(`${DIR_REMOTE}/remote.txt`, "etag-remote-1");
await run("sync-now");
assert.equal(vfsText("/C:/notes/remote.txt"), "from-remote", "远端新增文件应下载到本地");
console.log("✓ 目录同步：远端新增 → 下载");

// 场景 25：两端改同一文件 → 保留本地 + 生成冲突副本
vfsSet("/C:/notes/a.txt", "local-edit");
remoteFiles.set(`${DIR_REMOTE}/a.txt`, new TextEncoder().encode("remote-edit"));
remoteEtags.set(`${DIR_REMOTE}/a.txt`, "etag-conflict-1");
await run("sync-now");
assert.equal(vfsText("/C:/notes/a.txt"), "local-edit", "冲突时必须保留本地版本");
const conflictPath = [...localFiles.keys()].find((p) => p.includes(".conflict-") && p.endsWith("/a.conflict-") === false && /\/a\.conflict-[^/]*\.txt$/.test(p));
assert.ok(conflictPath, "必须生成冲突副本文件");
assert.equal(vfsText(conflictPath), "remote-edit", "冲突副本内容应是远端版本");
console.log("✓ 目录同步：冲突 → 保留本地 + 另存远端副本");

// 场景 26：未开启「同步删除」时，本地删除不应删远端
localFiles.delete("/C:/notes/sub/b.txt");
await run("sync-now");
assert.ok(remoteFiles.has(`${DIR_REMOTE}/sub/b.txt`), "未开启同步删除时远端文件必须保留");
console.log("✓ 目录同步：未开启删除 → 远端保留");

// 场景 27：开启「同步删除」后，本地删除会同步到远端
setFlatConfig({ ...DIR_BASE, syncDelete: true });
await run("sync-now");
assert.ok(!remoteFiles.has(`${DIR_REMOTE}/sub/b.txt`), "开启同步删除后应删除远端文件");
console.log("✓ 目录同步：开启删除 → 远端同步删除");

// 场景 28：超过单文件大小上限 → 跳过
setFlatConfig({ ...DIR_BASE, maxSizeMB: "0.01" });
vfsSet("/C:/notes/big.bin", new Uint8Array(20000));
await run("sync-now");
assert.ok(!remoteFiles.has(`${DIR_REMOTE}/big.bin`), "超过上限的文件必须跳过");
assert.ok(
  toasts.some((t) => String(t[1]).includes("跳过")),
  `应提示跳过了超限文件：${toasts.map((t) => t[1]).join(" | ")}`,
);
console.log("✓ 目录同步：超大文件跳过");

// 场景 29：S3 后端不支持目录模式 → 明确报错而不是静默失败
setFlatConfig({ ...FLAT_S3, mode: "dir" });
toasts.length = 0;
await commands.get("sync-now")();
assert.ok(
  toasts.some((t) => t[0] === "error" && String(t[1]).includes("WebDAV")),
  `S3 目录模式应明确提示只支持 WebDAV：${toasts.map((t) => t[1]).join(" | ")}`,
);
console.log("✓ S3 目录模式 → 明确报错");

fs.unlinkSync(tmpFile);
if (fs.existsSync(dirModule)) fs.unlinkSync(dirModule);
console.log("\n全部冒烟测试通过");
