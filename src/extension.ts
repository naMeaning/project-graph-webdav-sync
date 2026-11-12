// Project Graph WebDAV / S3 Sync
//
// 单文件扩展：Project Graph 的扩展运行在 Web Worker + Blob URL 中，无法 import 其他模块，
// 因此所有逻辑都放在这一个文件里，且只使用 prg / Comlink 注入的 API 与 Web 标准能力。
// 本文件保持纯 JavaScript 语法，因此既可被零依赖打包脚本直接使用，也能被 extprg/tsdown 编译。
//
// 设计要点：
//   - 同步单元 = 当前打开的 .prg 工程文件；两端工程文件名需一致。
//   - 三源元数据：本地 stageHash、远端指纹（ETag / S3 自定义元数据）、上次成功同步的基线。
//   - 坚果云不支持 PROPPATCH，云端 mtime 等于上传时间，绝不用于判冲突。
//   - prg.fetch 走不通时自动降级到 curl「受限模式」（只做显式上传/下载，不做自动判定）。

// ─────────────────────────────── 0. 常量 ───────────────────────────────

const EXT_VERSION = "0.5.4";
const K_STATE = "_syncState";
const NEEDS_RESYNC = "__NEEDS_RESYNC__";

// 主程序的「扩展 → 设置」面板只渲染扩展自己写过的键，
// 且只有两种控件：boolean → 开关，其它 → 单行文本框（值会被写成字符串）。
// 所以配置必须存成扁平的字符串/布尔键，不能存嵌套对象。
// 扩展启动时会把这里没写过的键补上默认值，设置页才会出现可编辑项。
const FLAT_DEFAULTS = {
  backend: "webdav",
  "webdav.root": "https://dav.jianguoyun.com/dav/",
  "webdav.username": "",
  "webdav.appPassword": "",
  "webdav.remoteDir": "ProjectGraph",
  "s3.endpoint": "",
  "s3.region": "us-east-1",
  "s3.accessKeyId": "",
  "s3.secretAccessKey": "",
  "s3.bucket": "",
  "s3.prefix": "project-graph",
  "s3.forcePathStyle": true,
  // ── 目录同步（默认模式）──
  mode: "dir",
  localDir: "",
  remoteSubdir: "",
  ignore:
    "node_modules, .git, .svn, .idea, __pycache__, *_backup, .DS_Store, Thumbs.db, desktop.ini, *.sync.json, *.conflict-*",
  syncDelete: false,
  maxFiles: "800",
  maxTotalMB: "300",
  autoSync: false,
  intervalMinutes: "10",
  maxSizeMB: "480",
  requestBudget: "600",
};

const DEFAULT_CONFIG = {
  backend: "webdav",
  webdav: {
    root: "https://dav.jianguoyun.com/dav/",
    username: "",
    appPassword: "",
    remoteDir: "ProjectGraph",
  },
  s3: {
    endpoint: "",
    region: "us-east-1",
    accessKeyId: "",
    secretAccessKey: "",
    bucket: "",
    prefix: "project-graph",
    forcePathStyle: true,
  },
  mode: "dir",
  localDir: "",
  remoteSubdir: "",
  ignore:
    "node_modules, .git, .svn, .idea, __pycache__, *_backup, .DS_Store, Thumbs.db, desktop.ini, *.sync.json, *.conflict-*",
  syncDelete: false,
  maxFiles: 800,
  maxTotalMB: 300,
  autoSync: false,
  intervalMinutes: 10,
  maxSizeMB: 480,
  requestBudget: 600,
};

let transportMode = "fetch";
let isSyncing = false;
let autoTimer = null;
let lastAutoSignature = "";
let wdDirEnsuredFor = "";
const requestLog = [];
const runtime = { lastError: "", lastSyncAt: "", lastAction: "" };

// ─────────────────────────────── 1. 通用工具 ───────────────────────────────

class TransportFallbackError extends Error {}

function errText(e) {
  if (e === null || e === undefined) return "unknown error";
  if (typeof e === "string") return e;
  return `${e.name || "Error"}: ${e.message || String(e)}`;
}

function toU8(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value && value.buffer instanceof ArrayBuffer) return new Uint8Array(value.buffer);
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error(`无法识别的二进制数据（${value && value.constructor ? value.constructor.name : typeof value}）`);
}

function hexOf(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fnvHex(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv-${h.toString(16).padStart(8, "0")}`;
}

async function sha256Raw(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : toU8(data);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function hashBytes(bytes) {
  try {
    if (globalThis.crypto && crypto.subtle) return `sha256-${hexOf(await sha256Raw(bytes))}`;
  } catch (e) {
    /* 退回非加密摘要，仅用于内容标识 */
  }
  return fnvHex(bytes);
}

async function hmacSha256(keyBytes, text) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return new Uint8Array(sig);
}

function b64Basic(user, pass) {
  const raw = `${user}:${pass}`;
  return `Basic ${btoa(unescape(encodeURIComponent(raw)))}`;
}

function encodeSegments(path) {
  return String(path)
    .split("/")
    .filter((s) => s.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

function joinUrl(root, parts) {
  const base = String(root).replace(/\/+$/, "");
  const tail = parts
    .filter((p) => p !== undefined && p !== null && String(p).length > 0)
    .map(encodeSegments)
    .filter((s) => s.length > 0)
    .join("/");
  return tail ? `${base}/${tail}` : `${base}/`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!patch || typeof patch !== "object") return out;
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object") {
      out[key] = deepMerge(out[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function maskedConfig(cfg) {
  const copy = JSON.parse(JSON.stringify(cfg));
  if (copy.webdav) copy.webdav.appPassword = copy.webdav.appPassword ? "******" : "";
  if (copy.s3) copy.s3.secretAccessKey = copy.s3.secretAccessKey ? "******" : "";
  return copy;
}

function looksLikeTransportError(e) {
  return /clon|serializ|DataClone|proxy|not a function|cannot read|postMessage/i.test(errText(e));
}

// ─────────────────────────────── 2. 设置持久化 ───────────────────────────────

async function readSetting(key, fallback) {
  const value = await prg.settings_getOwn(key);
  return value === undefined || value === null ? fallback : value;
}

function toBool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return fallback;
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 启动时补齐默认键：设置面板只显示「已经存在」的键，不写就一直显示「该扩展没有设置项」
async function ensureSettings() {
  for (const key of Object.keys(FLAT_DEFAULTS)) {
    const current = await prg.settings_getOwn(key);
    if (current === undefined || current === null) {
      await prg.settings_setOwn(key, FLAT_DEFAULTS[key]);
    }
  }
  // 每次启动都刷新，方便用户确认「装的是哪一版」以及看到配置入口提示
  await prg.settings_setOwn("_version", EXT_VERSION);
  await prg.settings_setOwn(
    "_help",
    "配置请按 Ctrl+Shift+Alt+C（表单窗口，打字正常回显）。本页输入框由主程序渲染，打字不回显，别在这里填",
  );
  await prg.settings_setOwn("_configFile", (await prg.settings_getOwn("_configFile")) || "");
}

async function loadConfig() {
  const cfg = deepMerge(DEFAULT_CONFIG, {});
  cfg.backend = String(await readSetting("backend", FLAT_DEFAULTS.backend));
  cfg.webdav = {
    root: String(await readSetting("webdav.root", FLAT_DEFAULTS["webdav.root"])),
    username: String(await readSetting("webdav.username", "")),
    appPassword: String(await readSetting("webdav.appPassword", "")),
    remoteDir: String(await readSetting("webdav.remoteDir", "ProjectGraph")),
  };
  cfg.s3 = {
    endpoint: String(await readSetting("s3.endpoint", "")),
    region: String(await readSetting("s3.region", "us-east-1")),
    accessKeyId: String(await readSetting("s3.accessKeyId", "")),
    secretAccessKey: String(await readSetting("s3.secretAccessKey", "")),
    bucket: String(await readSetting("s3.bucket", "")),
    prefix: String(await readSetting("s3.prefix", "project-graph")),
    forcePathStyle: toBool(await readSetting("s3.forcePathStyle", true), true),
  };
  cfg.mode = String(await readSetting("mode", "dir")) === "file" ? "file" : "dir";
  cfg.localDir = String(await readSetting("localDir", "")).trim();
  cfg.remoteSubdir = String(await readSetting("remoteSubdir", "")).trim();
  cfg.ignore = String(await readSetting("ignore", FLAT_DEFAULTS.ignore));
  cfg.syncDelete = toBool(await readSetting("syncDelete", false), false);
  cfg.maxFiles = toNumber(await readSetting("maxFiles", "800"), 800);
  cfg.maxTotalMB = toNumber(await readSetting("maxTotalMB", "300"), 300);
  cfg.autoSync = toBool(await readSetting("autoSync", false), false);
  cfg.intervalMinutes = toNumber(await readSetting("intervalMinutes", "10"), 10);
  cfg.maxSizeMB = toNumber(await readSetting("maxSizeMB", "480"), 480);
  cfg.requestBudget = toNumber(await readSetting("requestBudget", "600"), 600);
  return cfg;
}

async function saveConfig(cfg) {
  const flat = {
    backend: cfg.backend,
    "webdav.root": cfg.webdav.root,
    "webdav.username": cfg.webdav.username,
    "webdav.appPassword": cfg.webdav.appPassword,
    "webdav.remoteDir": cfg.webdav.remoteDir,
    "s3.endpoint": cfg.s3.endpoint,
    "s3.region": cfg.s3.region,
    "s3.accessKeyId": cfg.s3.accessKeyId,
    "s3.secretAccessKey": cfg.s3.secretAccessKey,
    "s3.bucket": cfg.s3.bucket,
    "s3.prefix": cfg.s3.prefix,
    "s3.forcePathStyle": Boolean(cfg.s3.forcePathStyle),
    mode: cfg.mode === "file" ? "file" : "dir",
    localDir: cfg.localDir || "",
    remoteSubdir: cfg.remoteSubdir || "",
    ignore: cfg.ignore || "",
    syncDelete: Boolean(cfg.syncDelete),
    maxFiles: String(cfg.maxFiles),
    maxTotalMB: String(cfg.maxTotalMB),
    autoSync: Boolean(cfg.autoSync),
    intervalMinutes: String(cfg.intervalMinutes),
    maxSizeMB: String(cfg.maxSizeMB),
    requestBudget: String(cfg.requestBudget),
  };
  for (const key of Object.keys(flat)) {
    await prg.settings_setOwn(key, flat[key]);
  }
}

async function loadState() {
  const raw = await prg.settings_getOwn(K_STATE);
  if (!raw) return { baselines: {}, deviceId: "" };
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      baselines: parsed && parsed.baselines && typeof parsed.baselines === "object" ? parsed.baselines : {},
      deviceId: parsed && parsed.deviceId ? String(parsed.deviceId) : "",
    };
  } catch (e) {
    return { baselines: {}, deviceId: "" };
  }
}

async function saveState(state) {
  await prg.settings_setOwn(K_STATE, JSON.stringify(state));
}

async function loadBaselines() {
  return (await loadState()).baselines;
}

async function saveBaselines(baselines) {
  const state = await loadState();
  state.baselines = baselines;
  await saveState(state);
}

async function setBaseline(fsPath, entry) {
  const baselines = await loadBaselines();
  baselines[fsPath] = entry;
  await saveBaselines(baselines);
}

async function getDeviceId() {
  const state = await loadState();
  if (!state.deviceId) {
    state.deviceId = `pg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await saveState(state);
  }
  return state.deviceId;
}

function validateConfig(cfg) {
  if (cfg.backend === "s3") {
    const s = cfg.s3;
    if (!s.accessKeyId || !s.secretAccessKey || !s.bucket || !s.region) {
      throw new Error("S3 配置不完整：需要 region / accessKeyId / secretAccessKey / bucket（endpoint 可选）");
    }
  } else {
    const w = cfg.webdav;
    if (!w.root || !w.username || !w.appPassword) {
      throw new Error("WebDAV 配置不完整：请先运行「同步配置」填写 root / username / appPassword");
    }
    if (!/^https?:\/\//i.test(w.root)) throw new Error("WebDAV root 必须是 http(s):// 开头的完整地址");
  }
}

// ─────────────────────────────── 3. 传输层 ───────────────────────────────

function noteRequest(budget) {
  const cutoff = Date.now() - 30 * 60 * 1000;
  while (requestLog.length && requestLog[0] < cutoff) requestLog.shift();
  const limit = Math.max(20, Math.floor((Number(budget) || 600) * 0.8));
  if (requestLog.length >= limit) {
    throw new Error("已接近 30 分钟请求上限（坚果云免费版 600 次），自动同步暂停，请稍后手动执行");
  }
  requestLog.push(Date.now());
}

async function httpRequest(method, url, headers, body, budget) {
  noteRequest(budget);
  const init = { method, headers: headers || {} };
  if (body !== undefined) init.body = body;

  let res;
  try {
    res = await prg.fetch(url, init);
  } catch (e) {
    if (looksLikeTransportError(e)) {
      transportMode = "curl";
      await prg.toast_warning("网络通道不可用，已切换到 curl 受限模式（仅显式上传/下载）");
      throw new TransportFallbackError(errText(e));
    }
    throw e;
  }

  const status = await res.status;
  let headersProxy = null;
  try {
    headersProxy = await res.headers;
  } catch (e) {
    /* 某些实现不暴露 headers */
  }
  const getHeader = async (name) => {
    if (!headersProxy) return "";
    try {
      const value = await headersProxy.get(name);
      return value === null || value === undefined ? "" : String(value);
    } catch (e) {
      return "";
    }
  };

  let bytes = new Uint8Array(0);
  if (method !== "HEAD") {
    try {
      bytes = toU8(await res.arrayBuffer());
    } catch (e) {
      /* 204 / 405 等响应可能没有 body */
    }
  }
  return { status, ok: status >= 200 && status < 300, getHeader, bytes };
}

function curlAuthStdin(cfg) {
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `-u "${esc(cfg.webdav.username)}:${esc(cfg.webdav.appPassword)}"\n`;
}

async function curlRequest(args, stdinText) {
  const out = await prg.shell_execute("curl", ["-sS", "-K", "-", ...args], stdinText);
  const stdout = String(out.stdout || "");
  const stderr = String(out.stderr || "");
  const matched = stdout.match(/(?:^|\n)(\d{3})\s*$/);
  const status = matched ? Number(matched[1]) : out.code === 0 ? 200 : 0;
  if (status < 200 || status >= 300) {
    throw new Error(`curl 失败（status=${status}, code=${out.code}）：${(stderr || stdout).slice(0, 200)}`);
  }
  return status;
}

async function curlUpload(cfg, localPath, url) {
  return curlRequest(
    [
      "-X",
      "PUT",
      "--data-binary",
      `@${localPath}`,
      "-H",
      "Content-Type: application/octet-stream",
      "-w",
      "\n%{http_code}",
      url,
    ],
    curlAuthStdin(cfg),
  );
}

async function curlDownload(cfg, localPath, url) {
  return curlRequest(["-o", localPath, "-w", "\n%{http_code}", url], curlAuthStdin(cfg));
}

// ─────────────────────────────── 4. WebDAV 后端 ───────────────────────────────

// ETag 在不同来源格式不一（HEAD 头、PROPFIND XML、S3 响应常带引号，弱校验还有 W/ 前缀），
// 不归一化会导致「明明没改却判定远端变了」，进而反复下载/误报冲突。
function normalizeEtag(value) {
  return String(value === null || value === undefined ? "" : value)
    .trim()
    .replace(/^W\//i, "")
    .replace(/^"+|"+$/g, "")
    .trim();
}

function wdAuth(cfg) {
  return { Authorization: b64Basic(cfg.webdav.username, cfg.webdav.appPassword) };
}

function wdUrl(cfg, remotePath) {
  return joinUrl(cfg.webdav.root, [cfg.webdav.remoteDir, remotePath]);
}

const PROPFIND_BODY =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>';

async function wdEnsureDir(cfg) {
  const key = `${cfg.webdav.root}|${cfg.webdav.remoteDir}`;
  if (wdDirEnsuredFor === key) return;
  const url = `${joinUrl(cfg.webdav.root, [cfg.webdav.remoteDir])}/`;
  const response = await httpRequest("MKCOL", url, wdAuth(cfg), undefined, cfg.requestBudget);
  // 405 = 目录已存在；409/301 也视为可继续，部分服务不允许显式 MKCOL
  if (!response.ok && ![301, 405, 409].includes(response.status)) {
    await prg.toast_warning(`创建远端目录返回 ${response.status}，仍会尝试上传`);
  }
  wdDirEnsuredFor = key;
}

async function wdStat(cfg, remotePath) {
  const url = wdUrl(cfg, remotePath);
  const response = await httpRequest("HEAD", url, wdAuth(cfg), undefined, cfg.requestBudget);
  if ([404, 410].includes(response.status)) return null;
  if (response.status === 405) {
    // 少数 WebDAV 服务不支持 HEAD，退回 Depth:0 的 PROPFIND
    const prop = await httpRequest(
      "PROPFIND",
      url,
      { ...wdAuth(cfg), Depth: "0", "Content-Type": "application/xml" },
      PROPFIND_BODY,
      cfg.requestBudget,
    );
    if (!prop.ok) throw new Error(`WebDAV PROPFIND 失败 (${prop.status})`);
    const xml = new TextDecoder().decode(prop.bytes);
    const etag = normalizeEtag((xml.match(/getetag[^>]*>([^<]+)</i) || [])[1] || "");
    const size = Number((xml.match(/getcontentlength[^>]*>([^<]+)</i) || [])[1] || 0);
    const mtime = (xml.match(/getlastmodified[^>]*>([^<]+)</i) || [])[1] || "";
    return { etag, size, hash: "", mtime };
  }
  if (!response.ok) {
    throw new Error(
      `WebDAV HEAD 失败 (${response.status})：403 通常是没用应用密码或开了微信二次验证；503 是请求过频`,
    );
  }
  return {
    etag: normalizeEtag(await response.getHeader("etag")),
    size: Number(await response.getHeader("content-length")) || 0,
    hash: "",
    mtime: await response.getHeader("last-modified"),
  };
}

async function wdRead(cfg, remotePath, options) {
  const response = await httpRequest("GET", wdUrl(cfg, remotePath), wdAuth(cfg), undefined, cfg.requestBudget);
  if (!response.ok) throw new Error(`WebDAV GET 失败 (${response.status})`);
  // 目录同步会读任意文件（图片、md…），只有单文件模式才需要校验 .prg 的 ZIP 魔数
  if (!(options && options.raw)) assertPrg(response.bytes);
  return response.bytes;
}

async function wdWrite(cfg, remotePath, bytes) {
  await wdEnsureDir(cfg);
  const response = await httpRequest(
    "PUT",
    wdUrl(cfg, remotePath),
    { ...wdAuth(cfg), "Content-Type": "application/octet-stream" },
    bytes,
    cfg.requestBudget,
  );
  if (!response.ok) {
    throw new Error(`WebDAV PUT 失败 (${response.status})：请检查应用密码、目录权限与 500MB 大小限制`);
  }
  return (await wdStat(cfg, remotePath)) || { etag: "", size: bytes.byteLength, hash: "", mtime: "" };
}

const webdavBackend = { name: "WebDAV", stat: wdStat, read: wdRead, write: wdWrite };

// ── 目录同步用到的 WebDAV 原语 ──

// 列一个远端目录（Depth: 1）。返回 [{ name, isDir, etag, size }]，不含目录自身。
async function wdList(cfg, remotePath) {
  const basePath = String(remotePath || "").replace(/^\/+|\/+$/g, "");
  const url = `${joinUrl(cfg.webdav.root, [cfg.webdav.remoteDir, basePath])}/`;
  const response = await httpRequest(
    "PROPFIND",
    url,
    { ...wdAuth(cfg), Depth: "1", "Content-Type": "application/xml" },
    PROPFIND_BODY,
    cfg.requestBudget,
  );
  if ([404, 409, 301].includes(response.status)) return [];
  if (!response.ok) {
    throw new Error(`WebDAV PROPFIND 列目录失败 (${response.status})：403 多为应用密码/微信二次验证，503 为请求过频`);
  }
  const xml = new TextDecoder().decode(response.bytes);
  let selfPath = "";
  try {
    selfPath = safeDecode(new URL(url).pathname).replace(/\/+$/, "");
  } catch (e) {
    selfPath = "";
  }

  const out = [];
  const blocks = xml.match(/<[^>]*\bresponse\b[\s\S]*?<\/[^>]*\bresponse>/gi) || [];
  for (const block of blocks) {
    const hrefRaw = (block.match(/<[^>]*\bhref\b[^>]*>([\s\S]*?)<\/[^>]*\bhref>/i) || [])[1] || "";
    const href = safeDecode(String(hrefRaw).trim());
    if (!href) continue;
    const isDir = /<[^>]*\bcollection\b[^>]*\/?>/i.test(block);
    const tail = href.replace(/\/+$/, "");
    const name = tail.split("/").pop() || "";
    if (!name) continue;
    if (selfPath && tail === selfPath) continue; // Depth:1 会带上目录自身
    const etag = (block.match(/<[^>]*\bgetetag\b[^>]*>([\s\S]*?)<\/[^>]*\bgetetag>/i) || [])[1] || "";
    const size = Number((block.match(/<[^>]*\bgetcontentlength\b[^>]*>([\s\S]*?)<\/[^>]*\bgetcontentlength>/i) || [])[1] || 0);
    out.push({ name, isDir, etag: normalizeEtag(etag), size });
  }
  return out;
}

// 逐级 MKCOL，已存在视为成功（405）
async function wdMkdirPath(cfg, remotePath) {
  const parts = String(remotePath || "").split("/").filter(Boolean);
  const created = [];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    const url = `${joinUrl(cfg.webdav.root, [cfg.webdav.remoteDir, acc])}/`;
    const response = await httpRequest("MKCOL", url, wdAuth(cfg), undefined, cfg.requestBudget);
    if (!response.ok && ![301, 405, 409].includes(response.status)) {
      throw new Error(`创建远端目录「${acc}」失败 (${response.status})`);
    }
    created.push(acc);
  }
  return created;
}

async function wdRemove(cfg, remotePath) {
  const response = await httpRequest("DELETE", wdUrl(cfg, remotePath), wdAuth(cfg), undefined, cfg.requestBudget);
  if (!response.ok && ![404, 410].includes(response.status)) {
    throw new Error(`WebDAV DELETE 失败 (${response.status})`);
  }
}

// ─────────────────────────────── 5. S3 后端（SigV4） ───────────────────────────────

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch (e) {
    return segment;
  }
}

function s3Location(cfg, remotePath) {
  const s = cfg.s3;
  const endpoint = String(s.endpoint || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const prefix = String(s.prefix || "").replace(/^\/+|\/+$/g, "");
  const key = [prefix, remotePath].filter((p) => p && String(p).length > 0).join("/");
  let host;
  let pathPrefix;
  if (!endpoint) {
    host = `${s.bucket}.s3.${s.region}.amazonaws.com`;
    pathPrefix = "";
  } else if (s.forcePathStyle) {
    host = endpoint;
    pathPrefix = `/${s.bucket}`;
  } else {
    host = `${s.bucket}.${endpoint}`;
    pathPrefix = "";
  }
  const encodedKey = key.split("/").map((seg) => awsEncode(safeDecode(seg))).join("/");
  const pathname = `${pathPrefix}/${encodedKey}`;
  return { url: `https://${host}${pathname}`, host, pathname };
}

async function s3SignedHeaders(cfg, method, urlString, extraHeaders, body) {
  if (!(globalThis.crypto && crypto.subtle)) {
    throw new Error("当前环境不支持 Web Crypto，无法为 S3 请求签名；请改用 WebDAV 后端");
  }
  const s = cfg.s3;
  const url = new URL(urlString);
  const amzDate = new Date().toISOString().replace(/[:-]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payload = body || new Uint8Array(0);
  const payloadHash = hexOf(await sha256Raw(payload));

  const headers = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  for (const key of Object.keys(extraHeaders || {})) {
    const value = extraHeaders[key];
    if (value !== undefined && value !== null && String(value) !== "") headers[key.toLowerCase()] = String(value);
  }

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${String(headers[name]).trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalUri = url.pathname
    .split("/")
    .map((seg) => awsEncode(safeDecode(seg)))
    .join("/");
  const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${s.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    hexOf(await sha256Raw(canonicalRequest)),
  ].join("\n");

  let key = await hmacSha256(new TextEncoder().encode(`AWS4${s.secretAccessKey}`), dateStamp);
  key = await hmacSha256(key, s.region);
  key = await hmacSha256(key, "s3");
  key = await hmacSha256(key, "aws4_request");
  const signature = hexOf(await hmacSha256(key, stringToSign));

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${s.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

async function s3Stat(cfg, remotePath) {
  const { url } = s3Location(cfg, remotePath);
  const headers = await s3SignedHeaders(cfg, "HEAD", url, {}, new Uint8Array(0));
  const response = await httpRequest("HEAD", url, headers, undefined, cfg.requestBudget);
  if (response.status === 404) return null;
  if (response.status === 403) throw new Error("S3 返回 403：签名、密钥、region 或桶权限有误");
  if (!response.ok) throw new Error(`S3 HEAD 失败 (${response.status})`);
  return {
    etag: await response.getHeader("etag"),
    size: Number(await response.getHeader("content-length")) || 0,
    hash: await response.getHeader("x-amz-meta-pg-hash"),
  };
}

async function s3Read(cfg, remotePath) {
  const { url } = s3Location(cfg, remotePath);
  const headers = await s3SignedHeaders(cfg, "GET", url, {}, new Uint8Array(0));
  const response = await httpRequest("GET", url, headers, undefined, cfg.requestBudget);
  if (!response.ok) throw new Error(`S3 GET 失败 (${response.status})`);
  assertPrg(response.bytes);
  return response.bytes;
}

async function s3Write(cfg, remotePath, bytes, meta) {
  const { url } = s3Location(cfg, remotePath);
  const extra = {
    "content-type": "application/octet-stream",
    "x-amz-meta-pg-hash": await hashBytes(bytes),
    "x-amz-meta-pg-mtime": String(Date.now()),
    "x-amz-meta-pg-device": meta.device || "",
  };
  const headers = await s3SignedHeaders(cfg, "PUT", url, extra, bytes);
  const response = await httpRequest("PUT", url, headers, bytes, cfg.requestBudget);
  if (!response.ok) throw new Error(`S3 PUT 失败 (${response.status})`);
  return (await s3Stat(cfg, remotePath)) || { etag: "", size: bytes.byteLength, hash: extra["x-amz-meta-pg-hash"] };
}

const s3Backend = { name: "S3", stat: s3Stat, read: s3Read, write: s3Write };

// ─────────────────────────────── 6. 同步引擎 ───────────────────────────────

function assertPrg(bytes) {
  if (!bytes || bytes.byteLength < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error("远端文件不是有效的 .prg（ZIP 头不是 PK），已中止，避免覆盖本地工程");
  }
}

function remoteFingerprint(meta) {
  if (!meta) return "";
  // 坚果云不支持 PROPPATCH，mtime 只能作为「ETag 缺失时」的兜底，绝不单独用来判冲突
  return meta.hash || meta.etag || meta.mtime || `${meta.size || 0}`;
}

function decideAction(base, localSignal, remote) {
  const currentFp = remoteFingerprint(remote);
  const localChanged = !base || base.localSignal === NEEDS_RESYNC || base.localSignal !== localSignal;
  const remoteChanged = !base ? Boolean(remote) : !remote || currentFp !== base.remoteFp;

  if (!base && !remote) return "upload";
  if (!base && remote) return "conflict";
  if (base && !remote) return "askRemoteDeleted";
  if (!localChanged && !remoteChanged) return "noop";
  if (localChanged && !remoteChanged) return "upload";
  if (!localChanged && remoteChanged) return "download";
  return "conflict";
}

async function requireProject() {
  const project = await prg.tabs_getCurrentProject();
  if (!project) throw new Error("当前没有打开的工程，请先打开一个 .prg 文件");
  const uri = await project.uri;
  const scheme = await uri.scheme;
  if (scheme !== "file") throw new Error("临时草稿 / 协作会话请先「另存为」本地 .prg 文件再同步");
  return { project, uri };
}

function remoteNameOf(uriPath) {
  return String(uriPath).split("/").pop() || "untitled.prg";
}

async function writeLocalCopy(project, uri, bytes, suffix) {
  const path = String(await uri.path);
  const stem = path.toLowerCase().endsWith(".prg") ? path.slice(0, -4) : path;
  const targetPath = `${stem}.${suffix}.prg`;
  const targetUri = await uri.with({ path: targetPath });
  const fs = await project.fs;
  await fs.write(targetUri, bytes);
  return targetPath;
}

async function askConflict(remotePath) {
  const choice = await uiButtons(
    "同步冲突：两端都改了",
    `${remotePath} 在本地和远端自上次同步后都发生了变化。.prg 是二进制文件，无法自动合并，请选择处理方式。`,
    [
      { id: "local", label: "用本地覆盖远端", variant: "default" },
      { id: "remote", label: "用远端覆盖本地", variant: "destructive" },
      { id: "both", label: "两份都保留", variant: "secondary" },
      { id: "cancel", label: "取消", variant: "ghost" },
    ],
  );
  const actions = { local: "upload", remote: "download", both: "both", cancel: "cancel" };
  return actions[choice] || "cancel";
}

async function askRemoteDeleted(remotePath) {
  const choice = await uiButtons(
    "远端文件不见了",
    `${remotePath} 在上次同步时存在，现在远端已不存在。可能是被其他设备删除，也可能是目录配置变了。`,
    [
      { id: "upload", label: "重新上传本地版本", variant: "default" },
      { id: "cancel", label: "先不动", variant: "secondary" },
    ],
  );
  return choice === "upload" ? "upload" : "cancel";
}

async function doUpload(cfg, backend, fsPath, remotePath, local, localSignal, deviceId) {
  const meta = await backend.write(cfg, remotePath, local, { device: deviceId });
  await setBaseline(fsPath, {
    localSignal,
    localHash: await hashBytes(local),
    remoteFp: remoteFingerprint(meta),
    remoteEtag: meta.etag || "",
    remotePath,
    deviceId,
    syncedAt: new Date().toISOString(),
  });
  runtime.lastAction = "upload";
  runtime.lastSyncAt = new Date().toISOString();
  await prg.toast_success(`已上传 ${remotePath}（${(local.byteLength / 1024).toFixed(1)} KB）`);
}

async function doDownload(cfg, backend, project, uri, fsPath, remotePath, deviceId) {
  const bytes = await backend.read(cfg, remotePath);
  const current = toU8(await project.getFileContent({ includeThumbnail: false }));

  let backupNote = "未创建备份";
  try {
    backupNote = await writeLocalCopy(project, uri, current, `backup-${stamp()}`);
  } catch (e) {
    backupNote = `备份失败：${errText(e)}`;
  }

  const beforeHash = String(await project.stageHash);
  const fs = await project.fs;
  await fs.write(uri, bytes);

  // 尝试让画布重新解析磁盘内容；失败则标记待重同步，绝不静默假设画布已刷新
  let refreshed = false;
  try {
    await project.init();
    refreshed = String(await project.stageHash) !== beforeHash;
  } catch (e) {
    refreshed = false;
  }

  const meta = await backend.stat(cfg, remotePath);
  await setBaseline(fsPath, {
    localSignal: refreshed ? String(await project.stageHash) : NEEDS_RESYNC,
    localHash: await hashBytes(bytes),
    remoteFp: remoteFingerprint(meta),
    remoteEtag: meta.etag || "",
    remotePath,
    deviceId,
    syncedAt: new Date().toISOString(),
  });
  runtime.lastAction = "download";
  runtime.lastSyncAt = new Date().toISOString();

  const message = refreshed
    ? "远端版本已写入磁盘并刷新画布。"
    : "远端版本已写入磁盘，但画布未能自动刷新。请重新打开该工程（或重载应用，注意会丢失未保存内容）；在重新打开前，下次同步会再次询问，避免误覆盖。";
  await uiCopy("已下载远端版本", message, `备份文件：${backupNote}\n远端路径：${remotePath}`);
}

async function doKeepBoth(cfg, backend, project, uri, fsPath, remotePath, localSignal, deviceId) {
  const bytes = await backend.read(cfg, remotePath);
  let copyPath;
  try {
    copyPath = await writeLocalCopy(project, uri, bytes, `conflict-${stamp()}`);
  } catch (e) {
    throw new Error(
      `无法创建冲突副本（${errText(e)}）。已中止，本地工程与远端都未被改动；请改用「用本地覆盖远端」或「用远端覆盖本地」。`,
    );
  }
  const meta = await backend.stat(cfg, remotePath);
  // 两端当前状态都已记录；后续本地再改动会走「上传」，不会反复弹窗
  await setBaseline(fsPath, {
    localSignal,
    localHash: await hashBytes(toU8(await project.getFileContent({ includeThumbnail: false }))),
    remoteFp: remoteFingerprint(meta),
    remoteEtag: meta.etag || "",
    remotePath,
    deviceId,
    syncedAt: new Date().toISOString(),
    note: "conflict kept both",
  });
  runtime.lastAction = "both";
  runtime.lastSyncAt = new Date().toISOString();
  await uiCopy(
    "两份都已保留",
    `远端版本已另存为 ${copyPath}；当前工程保持不变。请自行比对后再决定保留哪一份。`,
    copyPath,
  );
}

async function limitedSync(cfg, project, uri, fsPath, remotePath) {
  if (cfg.backend === "s3") {
    throw new Error("curl 受限模式只支持 WebDAV；S3 需要请求签名，请修复网络通道后使用 S3 后端");
  }
  const choice = await uiButtons(
    "curl 受限模式",
    "扩展无法直接使用网络通道。此模式不做自动冲突检测，请明确选择方向（操作前会先保存当前工程）。",
    [
      { id: "upload", label: "上传本地到远端", variant: "default" },
      { id: "download", label: "下载远端覆盖本地", variant: "destructive" },
      { id: "cancel", label: "取消", variant: "ghost" },
    ],
  );
  if (!choice || choice === "cancel") return;
  await project.save({ includeThumbnail: false });
  const url = wdUrl(cfg, remotePath);
  if (choice === "upload") {
    const dirUrl = `${joinUrl(cfg.webdav.root, [cfg.webdav.remoteDir])}/`;
    try {
      await curlRequest(["-X", "MKCOL", "-w", "\n%{http_code}", dirUrl], curlAuthStdin(cfg));
    } catch (e) {
      /* 405 = 目录已存在，忽略即可 */
    }
    await curlUpload(cfg, fsPath, url);
    await prg.toast_success("已上传（curl 受限模式）");
  } else {
    const current = toU8(await project.getFileContent({ includeThumbnail: false }));
    try {
      await writeLocalCopy(project, uri, current, `backup-${stamp()}`);
    } catch (e) {
      /* 备份失败不阻断显式下载 */
    }
    await curlDownload(cfg, fsPath, url);
    await setBaseline(fsPath, {
      localSignal: NEEDS_RESYNC,
      localHash: "",
      remoteFp: "",
      remotePath,
      syncedAt: new Date().toISOString(),
      note: "curl limited mode",
    });
    await prg.toast_warning("已下载并覆盖磁盘，请重新打开该工程");
  }
  runtime.lastAction = `curl-${choice}`;
}

async function syncCore(force, quiet) {
  if (isSyncing) {
    if (!quiet) await prg.toast_warning("上一次同步尚未结束，请稍候");
    return;
  }
  isSyncing = true;
  try {
    const cfg = await loadConfig();
    validateConfig(cfg);
    // 用户可能直接在「扩展 → 设置」面板里改了 autoSync，这里让定时器跟上最新配置
    scheduleAutoSync(cfg);

    // 目录模式（默认）：同步整个文件夹
    if (String(cfg.mode) !== "file") {
      await dirSyncCore(force, quiet, cfg);
      return;
    }

    const { project, uri } = await requireProject();
    const fsPath = String(await uri.fsPath);
    const remotePath = remoteNameOf(String(await uri.path));

    if (transportMode === "curl") {
      await limitedSync(cfg, project, uri, fsPath, remotePath);
      return;
    }

    const backend = cfg.backend === "s3" ? s3Backend : webdavBackend;
    const deviceId = await getDeviceId();

    // 先保存，保证本地磁盘与上传到云端的内容一致
    await project.save({ includeThumbnail: false });
    const local = toU8(await project.getFileContent({ includeThumbnail: false }));
    if (local.byteLength === 0) throw new Error("工程内容为空，已中止同步");
    const maxBytes = (Number(cfg.maxSizeMB) || 480) * 1024 * 1024;
    if (local.byteLength > maxBytes) {
      throw new Error(`工程文件 ${(local.byteLength / 1024 / 1024).toFixed(1)}MB 超过 ${cfg.maxSizeMB}MB 上限`);
    }
    const localSignal = String(await project.stageHash);

    let remote;
    try {
      remote = await backend.stat(cfg, remotePath);
    } catch (e) {
      if (e instanceof TransportFallbackError) {
        await limitedSync(cfg, project, uri, fsPath, remotePath);
        return;
      }
      throw e;
    }

    const baselines = await loadBaselines();
    const base = baselines[fsPath];
    let action = force || decideAction(base, localSignal, remote);

    if (action === "askRemoteDeleted") action = await askRemoteDeleted(remotePath);
    if (action === "conflict" && quiet) {
      await prg.toast_warning("检测到同步冲突，自动同步已跳过，请手动执行「立即同步」");
      return;
    }
    if (action === "conflict") action = await askConflict(remotePath);

    switch (action) {
      case "upload":
        await doUpload(cfg, backend, fsPath, remotePath, local, localSignal, deviceId);
        break;
      case "download":
        await doDownload(cfg, backend, project, uri, fsPath, remotePath, deviceId);
        break;
      case "both":
        await doKeepBoth(cfg, backend, project, uri, fsPath, remotePath, localSignal, deviceId);
        break;
      case "noop":
        runtime.lastAction = "noop";
        if (!quiet) await prg.toast("两端都没有变化，无需同步");
        break;
      case "cancel":
        if (!quiet) await prg.toast("已取消同步");
        break;
      default:
        throw new Error(`未知的同步动作：${action}`);
    }
  } finally {
    isSyncing = false;
  }
}

// ─────────────────────────────── 6.5 目录同步（整个文件夹） ───────────────────────────────
// 能力来源：project.fs 是 FileSystemProviderFile，直接落到 Tauri plugin-fs，
// readDir / read / write / mkdir / remove / exists 都按 uri.fsPath 工作，所以整目录同步不需要外部命令。

function fsPathToUriPath(input) {
  let s = String(input || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[A-Za-z]:\//.test(s)) s = `/${s}`;
  return s || "/";
}

function baseNameOf(input) {
  return String(input || "").split(/[\\/]/).filter(Boolean).pop() || "sync-root";
}

// 本地根目录：默认是当前 .prg 所在目录；localDir 可填绝对路径或相对工程目录的路径
async function resolveLocalRoot(cfg, uri) {
  const uriPath = String(await uri.path);
  const fsPath = String(await uri.fsPath);
  const fileName = uriPath.split("/").pop() || "";
  const parentUriPath =
    (uriPath.slice(0, Math.max(0, uriPath.length - fileName.length)) || "/").replace(/\/+$/, "") || "/";
  const parentFsPath = fsPath.slice(0, Math.max(0, fsPath.length - fileName.length)).replace(/[\\/]+$/, "");

  if (!cfg.localDir) {
    return { uriPath: parentUriPath, fsPath: parentFsPath, name: baseNameOf(parentFsPath) };
  }
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(cfg.localDir) || cfg.localDir.startsWith("/");
  const joined = isAbsolute ? cfg.localDir : `${parentFsPath}/${cfg.localDir.replace(/^[.][\\/]/, "")}`;
  const clean = joined.replace(/\\/g, "/").replace(/\/+$/, "");
  return { uriPath: fsPathToUriPath(clean), fsPath: clean, name: baseNameOf(clean) };
}

function buildIgnoreMatcher(cfg) {
  const patterns = String(cfg.ignore || "")
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, "/"));

  return (rel) => {
    const parts = String(rel).split("/");
    const base = parts[parts.length - 1];
    for (const p of patterns) {
      if (p.includes("*")) {
        const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
        if (re.test(base) || re.test(String(rel))) return true;
        continue;
      }
      if (p.endsWith("/")) {
        if (parts.includes(p.slice(0, -1))) return true;
        continue;
      }
      if (base === p || String(rel) === p || parts.includes(p)) return true;
    }
    return false;
  };
}

async function readLocalBytes(project, uri, uriPath) {
  const fs = await project.fs;
  const target = await uri.with({ path: uriPath });
  return toU8(await fs.read(target));
}

async function writeLocalBytes(project, uri, uriPath, bytes) {
  const fs = await project.fs;
  const target = await uri.with({ path: uriPath });
  await fs.write(target, bytes);
}

// 本地没有对应目录时（远端新增的子目录文件）要逐级建目录，Tauri 的 writeFile 不会自动建
async function ensureLocalDir(project, uri, dirUriPath) {
  const fs = await project.fs;
  const parts = String(dirUriPath || "").split("/").filter(Boolean);
  let acc = "";
  for (const part of parts) {
    acc = `${acc}/${part}`;
    try {
      const target = await uri.with({ path: acc });
      if (typeof fs.exists === "function" && (await fs.exists(target))) continue;
      await fs.mkdir(target);
    } catch (e) {
      /* 盘符根、已存在等情况忽略 */
    }
  }
}

function parentUriPathOf(uriPath) {
  const clean = String(uriPath || "").replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  return idx > 0 ? clean.slice(0, idx) : clean;
}

// 递归列出本地文件；返回 { files: Map<rel,{uriPath}>, dirs: Set<rel> }
async function walkLocal(project, uri, rootUriPath, shouldIgnore, limits) {
  const fs = await project.fs;
  const files = new Map();
  const dirs = new Set();
  const stack = [{ uriPath: rootUriPath, rel: "" }];
  const maxFiles = Math.max(20, Number(limits.maxFiles) || 800);

  while (stack.length > 0) {
    const cur = stack.pop();
    const dirUri = await uri.with({ path: cur.uriPath });
    let entries = [];
    try {
      entries = await fs.readDir(dirUri);
    } catch (e) {
      if (!cur.rel) {
        throw new Error(`无法读取本地目录 ${cur.uriPath}：${errText(e)}。请确认路径存在且可访问`);
      }
      continue;
    }
    for (const entry of entries || []) {
      const name = String(entry && entry.name ? entry.name : "");
      if (!name || name === "." || name === "..") continue;
      const rel = cur.rel ? `${cur.rel}/${name}` : name;
      if (shouldIgnore(rel)) continue;
      const childUriPath = `${cur.uriPath.replace(/\/+$/, "")}/${name}`;
      if (entry.isDirectory === true) {
        dirs.add(rel);
        stack.push({ uriPath: childUriPath, rel });
      } else {
        files.set(rel, { uriPath: childUriPath });
        if (files.size > maxFiles) {
          throw new Error(`本地文件数超过上限 ${maxFiles}，请在配置里调大「最大文件数」或补充忽略规则`);
        }
      }
    }
  }
  return { files, dirs };
}

// 递归列出远端；返回 Map<rel,{isDir,etag,size}>
async function listRemoteTree(cfg, rootRemotePath, shouldIgnore, quiet) {
  if (cfg.backend === "s3") {
    throw new Error(
      "目录同步目前只支持 WebDAV。要用 S3 请把配置里的「模式」设为 file（单文件同步），或改用 WebDAV 后端",
    );
  }
  const out = new Map();
  const stack = [""];
  let visited = 0;
  const maxDirs = 300; // 坚果云 30 分钟 600 次请求，逐层 PROPFIND 要留余量

  while (stack.length > 0) {
    const rel = stack.pop();
    visited += 1;
    if (visited > maxDirs) {
      throw new Error(`远端目录数超过 ${maxDirs}，已中止以免触发坚果云请求上限。请缩小同步目录或补充忽略规则`);
    }
    const parentRel = rel ? `${rootRemotePath}/${rel}` : rootRemotePath;
    const entries = await wdList(cfg, parentRel);
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (shouldIgnore(childRel)) continue;
      if (entry.isDir) {
        out.set(childRel, { isDir: true, etag: "", size: 0 });
        stack.push(childRel);
      } else {
        out.set(childRel, { isDir: false, etag: entry.etag, size: entry.size });
      }
    }
  }
  return out;
}

function conflictCopyName(rel) {
  const idx = rel.lastIndexOf("/");
  const dir = idx >= 0 ? rel.slice(0, idx + 1) : "";
  const file = idx >= 0 ? rel.slice(idx + 1) : rel;
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  return `${dir}${stem}.conflict-${stamp()}${ext}`;
}

// 目录同步主流程
async function dirSyncCore(force, quiet, preloadedCfg) {
  const cfg = preloadedCfg || (await loadConfig());
  validateConfig(cfg);
  if (transportMode === "curl") {
    throw new Error("目录同步需要直连网络通道，curl 受限模式不支持。请重载应用后再试");
  }

  const { project, uri } = await requireProject();
  // 先把当前工程落盘，保证磁盘上是最新的
  try {
    await project.save({ includeThumbnail: false });
  } catch (e) {
    /* 只读或未修改时忽略 */
  }

  const root = await resolveLocalRoot(cfg, uri);
  const shouldIgnore = buildIgnoreMatcher(cfg);
  const limits = { maxFiles: cfg.maxFiles, maxTotalMB: cfg.maxTotalMB };
  const deviceId = await getDeviceId();
  const remoteRoot = cfg.remoteSubdir ? `${cfg.remoteSubdir}/${root.name}` : root.name;

  await wdEnsureDir(cfg);
  await wdMkdirPath(cfg, remoteRoot);

  const local = await walkLocal(project, uri, root.uriPath, shouldIgnore, limits);
  const remote = await listRemoteTree(cfg, remoteRoot, shouldIgnore, quiet);

  const baseKey = `dir:${root.fsPath}`;
  const baselines = await loadBaselines();
  const stored = baselines[baseKey];
  const baseFiles = stored && stored.files && typeof stored.files === "object" ? stored.files : {};
  const hadBaseline = Boolean(stored && stored.files);

  const nextFiles = {};
  const plan = { upload: [], download: [], conflicts: [], removeRemote: [], removeLocal: [], skipped: 0 };
  const maxFileBytes = (Number(cfg.maxSizeMB) || 480) * 1024 * 1024;
  const totalBudget = (Number(cfg.maxTotalMB) || 300) * 1024 * 1024;
  let totalBytes = 0;
  let unchanged = 0;

  // —— 本地存在的文件 ——
  for (const [rel, info] of local.files) {
    const remoteEntry = remote.get(rel);
    const baseEntry = baseFiles[rel];
    const bytes = await readLocalBytes(project, uri, info.uriPath);
    const size = bytes.byteLength;
    if (size > maxFileBytes) {
      plan.skipped += 1;
      continue;
    }
    totalBytes += size;
    if (totalBytes > totalBudget) {
      throw new Error(`本地待同步数据超过 ${cfg.maxTotalMB}MB 上限，请缩小目录范围或调大「最大总量」`);
    }
    const hash = await hashBytes(bytes);

    if (force === "upload") {
      plan.upload.push({ rel, size });
      nextFiles[rel] = { hash, size, etag: "" };
      continue;
    }
    if (force === "download") {
      if (remoteEntry) {
        plan.download.push(rel);
        nextFiles[rel] = { hash: "", size: remoteEntry.size, etag: remoteEntry.etag };
      }
      continue;
    }

    if (!remoteEntry) {
      // 远端没有这个文件：本地新增，或远端被删
      if (baseEntry && baseEntry.hash === hash) {
        // 本地未变但远端消失 → 视为需要重新上传（不删本地）
        plan.upload.push({ rel, size });
        nextFiles[rel] = { hash, size, etag: "" };
      } else {
        plan.upload.push({ rel, size });
        nextFiles[rel] = { hash, size, etag: "" };
      }
      continue;
    }

    const localChanged = !baseEntry || baseEntry.hash !== hash;
    const remoteChanged = !baseEntry || String(baseEntry.etag || "") !== String(remoteEntry.etag || "");

    if (!baseEntry) {
      // 没有基线：大小相同就当作一致（省一次下载），否则算冲突
      if (remoteEntry.size === size) {
        nextFiles[rel] = { hash, size, etag: remoteEntry.etag };
        unchanged += 1;
      } else {
        plan.conflicts.push({ rel, kind: "首次同步两端内容不同" });
      }
      continue;
    }
    if (localChanged && remoteChanged) {
      plan.conflicts.push({ rel, kind: "两端都改过" });
      continue;
    }
    if (localChanged) {
      plan.upload.push({ rel, size });
      nextFiles[rel] = { hash, size, etag: "" };
      continue;
    }
    if (remoteChanged) {
      plan.download.push(rel);
      nextFiles[rel] = { hash: "", size: remoteEntry.size, etag: remoteEntry.etag };
      continue;
    }
    nextFiles[rel] = { hash, size, etag: remoteEntry.etag };
    unchanged += 1;
  }

  // —— 远端新增（本地没有、基线也没有）——
  for (const [rel, remoteEntry] of remote) {
    if (remoteEntry.isDir || local.files.has(rel) || baseFiles[rel]) continue;
    if (force === "upload") continue; // 强制上传时不拉远端新文件
    plan.download.push(rel);
    nextFiles[rel] = { hash: "", size: remoteEntry.size, etag: remoteEntry.etag };
  }

  // —— 基线里有、本地已删除 ——
  for (const rel of Object.keys(baseFiles)) {
    if (local.files.has(rel)) continue;
    const remoteEntry = remote.get(rel);
    if (!remoteEntry || remoteEntry.isDir) continue;
    const baseEntry = baseFiles[rel];
    const remoteChanged = String(baseEntry.etag || "") !== String(remoteEntry.etag || "");
    if (remoteChanged) {
      plan.conflicts.push({ rel, kind: "本地已删除但远端改过" });
      continue;
    }
    if (cfg.syncDelete) plan.removeRemote.push(rel);
    // 未开启删除时保留基线：否则下次再开启就认不出「本地删过这个文件」
    else nextFiles[rel] = baseEntry;
  }

  // —— 基线里有、远端已删除、本地还在但没改 ——
  for (const rel of Object.keys(baseFiles)) {
    if (!local.files.has(rel) || remote.has(rel)) continue;
    if (!cfg.syncDelete) continue;
    const bytes = await readLocalBytes(project, uri, local.files.get(rel).uriPath);
    const hash = await hashBytes(bytes);
    if (baseFiles[rel].hash === hash) plan.removeLocal.push(rel);
    else plan.conflicts.push({ rel, kind: "远端已删除但本地改过" });
  }

  const totalOps = plan.upload.length + plan.download.length + plan.conflicts.length + plan.removeRemote.length;
  if (totalOps === 0 && hadBaseline) {
    await saveBaselines({
      ...baselines,
      [baseKey]: { files: nextFiles, syncedAt: new Date().toISOString(), deviceId, root: root.fsPath, remoteRoot },
    });
    runtime.lastAction = "noop";
    runtime.lastSyncAt = new Date().toISOString();
    if (!quiet) {
      await prg.toast(`目录已是最新（${Object.keys(nextFiles).length} 个文件，${plan.skipped} 个超限跳过）`);
    }
    return;
  }

  // 冲突太多时不要闷头跑，先让用户看看
  if (plan.conflicts.length > 20) {
    throw new Error(
      `检测到 ${plan.conflicts.length} 个冲突文件，数量过多已中止。请先在配置里补充「忽略」规则缩小范围，或手动处理`,
    );
  }
  if (quiet && plan.conflicts.length > 0) {
    await prg.toast_warning(`目录同步检测到 ${plan.conflicts.length} 个冲突，自动同步已跳过`);
    return;
  }

  // —— 执行：先建远端目录 ——
  const neededDirs = new Set();
  for (const rel of plan.upload.map((x) => x.rel)) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i += 1) neededDirs.add(parts.slice(0, i).join("/"));
  }
  for (const rel of [...neededDirs].sort()) {
    await wdMkdirPath(cfg, `${remoteRoot}/${rel}`);
  }

  // —— 上传 ——
  let uploaded = 0;
  for (const item of plan.upload) {
    const bytes = await readLocalBytes(project, uri, local.files.get(item.rel).uriPath);
    const meta = await wdWrite(cfg, `${remoteRoot}/${item.rel}`, bytes);
    nextFiles[item.rel] = {
      hash: await hashBytes(bytes),
      size: bytes.byteLength,
      etag: meta.etag || "",
      deviceId,
    };
    uploaded += 1;
  }

  // —— 下载 ——
  let downloaded = 0;
  for (const rel of plan.download) {
    const bytes = await wdRead(cfg, `${remoteRoot}/${rel}`, { raw: true });
    const localInfo = local.files.get(rel);
    const targetUriPath = localInfo ? localInfo.uriPath : `${root.uriPath.replace(/\/+$/, "")}/${rel}`;
    await ensureLocalDir(project, uri, parentUriPathOf(targetUriPath));
    await writeLocalBytes(project, uri, targetUriPath, bytes);
    const remoteEntry = remote.get(rel);
    nextFiles[rel] = {
      hash: await hashBytes(bytes),
      size: bytes.byteLength,
      etag: remoteEntry ? remoteEntry.etag : "",
    };
    downloaded += 1;
  }

  // —— 冲突：一律「保留本地，远端另存副本」 ——
  let conflictsKept = 0;
  for (const item of plan.conflicts) {
    try {
      const bytes = await wdRead(cfg, `${remoteRoot}/${item.rel}`, { raw: true });
      const copyRel = conflictCopyName(item.rel);
      const copyUriPath = `${root.uriPath.replace(/\/+$/, "")}/${copyRel}`;
      await ensureLocalDir(project, uri, parentUriPathOf(copyUriPath));
      await writeLocalBytes(project, uri, copyUriPath, bytes);

      const localInfo = local.files.get(item.rel);
      if (localInfo) {
        const localBytes = await readLocalBytes(project, uri, localInfo.uriPath);
        nextFiles[item.rel] = {
          hash: await hashBytes(localBytes),
          size: localBytes.byteLength,
          etag: "",
        };
      } else {
        // 本地已删除但远端改过：副本已落地，记录远端基线以免下一轮重复报冲突
        const remoteEntry = remote.get(item.rel);
        nextFiles[item.rel] = { hash: "", size: remoteEntry ? remoteEntry.size : 0, etag: remoteEntry ? remoteEntry.etag : "" };
      }
      conflictsKept += 1;
    } catch (e) {
      // 单个冲突处理失败不影响整体，下一轮还会再检测到
    }
  }

  // —— 删除（默认关闭，需 syncDelete） ——
  let removed = 0;
  for (const rel of plan.removeRemote) {
    await wdRemove(cfg, `${remoteRoot}/${rel}`);
    removed += 1;
  }
  for (const rel of plan.removeLocal) {
    const fs = await project.fs;
    const target = await uri.with({ path: local.files.get(rel).uriPath });
    await fs.remove(target);
    removed += 1;
  }

  await saveBaselines({
    ...baselines,
    [baseKey]: {
      files: nextFiles,
      syncedAt: new Date().toISOString(),
      deviceId,
      root: root.fsPath,
      remoteRoot,
      fileCount: Object.keys(nextFiles).length,
    },
  });

  runtime.lastAction = "dir-sync";
  runtime.lastSyncAt = new Date().toISOString();
  runtime.lastDirStats = { uploaded, downloaded, conflictsKept, removed, skipped: plan.skipped, unchanged };

  const summary = `目录同步完成：上传 ${uploaded}，下载 ${downloaded}，冲突保留副本 ${conflictsKept}，删除 ${removed}，未变 ${unchanged}，超限跳过 ${plan.skipped}`;
  if (!quiet) await prg.toast_success(summary);
  else await prg.toast(summary);
}

// ─────────────────────────────── 7. 配置、命令与自动同步 ───────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 主程序 Dialog 的关闭顺序是：先 resolve()，再 setOpen(false)，最后 setTimeout 500ms 才真正卸载 overlay。
// 也就是说「对话框返回」并不等于「遮罩已经消失」。如果紧接着弹下一个对话框，
// 前一个的遮罩和 focus trap 还停在页面上，会盖住新对话框 —— 表现就是「字打不进去、按钮点了没反应」。
// 所以所有对话框统一走这个队列：串行执行，且每次结束后留出 DIALOG_GAP_MS 让遮罩退干净。
const DIALOG_GAP_MS = 700;
let dialogChain = Promise.resolve();

function ui(fn) {
  const runner = async () => {
    try {
      return await fn();
    } finally {
      await sleep(DIALOG_GAP_MS);
    }
  };
  const run = dialogChain.then(runner, runner);
  dialogChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// 用户按 Esc / 点取消时 Dialog 会 reject，这里统一转成「取消」，避免被当成同步失败
async function prompt(title, description, options) {
  return ui(async () => {
    try {
      const value = await prg.dialog_input(title, description, options || {});
      return value === null || value === undefined ? null : String(value);
    } catch (e) {
      return null;
    }
  });
}

async function uiButtons(title, description, buttons) {
  return ui(async () => {
    try {
      return await prg.dialog_buttons(title, description, buttons);
    } catch (e) {
      return null;
    }
  });
}

async function uiConfirm(title, description, options) {
  return ui(async () => {
    try {
      return !!(await prg.dialog_confirm(title, description, options || {}));
    } catch (e) {
      return false;
    }
  });
}

async function uiCopy(title, description, value) {
  return ui(async () => {
    try {
      await prg.dialog_copy(title, description, value);
    } catch (e) {
      /* 复制失败不影响主流程 */
    }
  });
}

// 解析「键=值」文本并应用保存。返回 "reset" 或后端名，便于调用方提示。
async function applyConfigText(cfg, text) {
  const patch = parseConfigText(text);

  if (patch.reset) {
    for (const key of Object.keys(FLAT_DEFAULTS)) {
      await prg.settings_setOwn(key, FLAT_DEFAULTS[key]);
    }
    wdDirEnsuredFor = "";
    scheduleAutoSync(await loadConfig());
    return "reset";
  }

  const next = deepMerge(cfg, patch);
  delete next.reset;

  // 后端判定：显式「类型=」优先；否则看这次实际填了哪一边；都没填就沿用原设置
  if (patch.backend === "s3" || patch.backend === "webdav") {
    next.backend = patch.backend;
  } else if (patch.webdav.username || patch.webdav.appPassword || patch.webdav.root) {
    next.backend = "webdav";
  } else if (patch.s3.accessKeyId || patch.s3.secretAccessKey || patch.s3.bucket || patch.s3.endpoint) {
    next.backend = "s3";
  }

  if (!next.webdav.remoteDir) next.webdav.remoteDir = "ProjectGraph";
  if (!next.s3.region) next.s3.region = "us-east-1";
  if (!next.s3.prefix) next.s3.prefix = "project-graph";

  if (next.backend === "s3") {
    if (!next.s3.accessKeyId || !next.s3.secretAccessKey || !next.s3.bucket) {
      throw new Error("S3 还缺必填项：AK / SK / 桶名（去掉模板里 S3 段前面的 # 再填）");
    }
  } else {
    if (!next.webdav.username || !next.webdav.appPassword) {
      throw new Error("还缺：账号 或 密码（坚果云网页 → 账户信息 → 安全选项 → 添加应用密码）");
    }
    if (!/^https?:\/\//i.test(next.webdav.root)) {
      throw new Error("地址必须是以 http:// 或 https:// 开头的完整地址");
    }
  }

  validateConfig(next);
  await saveConfig(next);
  wdDirEnsuredFor = "";
  scheduleAutoSync(next);
  return next.backend;
}

// 配置文件：与当前工程同目录，<工程名>.sync.json
// project.fs 直接落到 Tauri plugin-fs（用 uri.fsPath），所以能读写磁盘上的任意同级文件——
// 这条通道完全不经过主程序的输入框，是输入框失效时的救命路径。
async function configFileTarget(project, uri) {
  const uriPath = String(await uri.path);
  const fsPath = String(await uri.fsPath);
  const fileName = uriPath.split("/").pop() || "untitled.prg";
  const stem = fileName.toLowerCase().endsWith(".prg") ? fileName.slice(0, -4) : fileName;
  const targetPath = `${uriPath.slice(0, uriPath.length - fileName.length)}${stem}.sync.json`;
  const targetUri = await uri.with({ path: targetPath });
  const dirFs = fsPath.slice(0, Math.max(0, fsPath.length - fileName.length));
  return { targetUri, displayPath: `${dirFs}${stem}.sync.json`, stem };
}

async function readConfigFile(project, targetUri) {
  try {
    const fs = await project.fs;
    const bytes = await fs.read(targetUri);
    return new TextDecoder().decode(toU8(bytes));
  } catch (e) {
    return null;
  }
}

async function writeConfigFile(project, targetUri, text) {
  const fs = await project.fs;
  await fs.write(targetUri, new TextEncoder().encode(text));
}

// 表单通道：prg.form 打开主程序 FormWindow（独立子窗口）。
// 官方文档（/docs/extension/api/form）明确：
//   - 只支持 z.string / z.number / z.boolean / z.union([z.string]) 四种类型
//   - 每个字段用 .describe() 作为表单里显示的 label
//   - schema 由 z.toJSONSchema() 生成；**用户点取消会让 Promise 被 reject**
//   - 返回实际填写的表单数据
// 主线程侧是 z.fromJSONSchema(schema)，所以必须带上 $schema 声明，否则解析失败。
async function configViaForm(cfg) {
  const fields = cfg.backend === "s3" ? buildS3FormFields(cfg) : buildWebdavFormFields(cfg);
  // 不带 required：所有字段都是「可选」，留空 = 保持不变
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: fields,
  };

  let result;
  try {
    result = await prg.form(schema, {
      title: "同步配置",
      confirmText: "保存",
      cancelText: "取消",
    });
  } catch (e) {
    if (e === undefined || e === null) {
      await recordConfigStep("form:cancelled-by-user");
      await prg.toast("已取消，配置未改动");
      return true; // 用户点了取消（官方行为：取消 = reject），正常结束
    }
    runtime.lastError = `prg.form 失败：${errText(e).slice(0, 120)}`;
    await recordConfigStep(`form:error:${errText(e).slice(0, 100)}`);
    return false; // schema 不被接受 / 版本不支持，调用方换别的通道
  }
  if (!result || typeof result !== "object") {
    runtime.lastError = "prg.form 没有返回表单数据";
    await recordConfigStep("form:returned-nothing");
    return false;
  }
  await recordConfigStep("form:submitted");

  // 「留空 = 保持不变」：把非空字段转成「键=值」行，与文件/弹窗通道共用同一套解析与校验
  const lines = [];
  for (const [key, value] of Object.entries(result)) {
    const text = String(value === null || value === undefined ? "" : value).trim();
    if (text) lines.push(`${key}=${text}`);
  }
  if (lines.length === 0) {
    await prg.toast_warning("所有字段都留空了，配置未改动");
    return true;
  }
  const backend = await applyConfigText(cfg, lines.join("\n"));
  if (backend === "reset") {
    await prg.toast_success("已恢复默认设置");
    return true;
  }
  await prg.toast_success(`配置已保存（${backend}）｜按 Ctrl+Shift+Alt+S 同步`);
  return true;
}

function buildWebdavFormFields(cfg) {
  // 注意：FormWindow 把 description 直接当字段标题显示，所以这里必须是短标签。
  // 字段数也必须少——窗口高度约屏高 62%，字段多了【保存】按钮会被挤到窗口外。
  return {
    账号: { type: "string", description: "账号（坚果云注册邮箱）" },
    密码: { type: "string", description: "应用密码（不是登录密码）" },
    地址: { type: "string", description: "WebDAV 地址" },
    云端目录: { type: "string", description: "云端目录名（如 ProjectGraph）" },
    本地目录: { type: "string", description: "本地文件夹（留空＝当前工程目录）" },
  };
}

function buildS3FormFields(cfg) {
  return {
    endpoint: { type: "string", description: "S3 端点（如 s3.us-east-1.amazonaws.com）" },
    region: { type: "string", description: "区域（如 us-east-1，R2 填 auto）" },
    AK: { type: "string", description: "Access Key ID" },
    SK: { type: "string", description: "Secret Access Key" },
    桶: { type: "string", description: "Bucket 桶名" },
  };
}

// 把配置通道的尝试结果落盘（设置项 _lastConfig）。
// 作用：用户反馈「还是不行」时，直接读 settings.json 就能看到走了哪条通道、为什么失败，
// 不用再靠猜或者让用户复述界面现象。
async function recordConfigStep(step) {
  runtime.lastConfig = step;
  try {
    await prg.settings_setOwn("_lastConfig", `${new Date().toISOString()} ${step}`.slice(0, 300));
  } catch (e) {}
}

async function configWizard() {
  const cfg = await loadConfig();
  await recordConfigStep("start");
  // 先给一个即时反馈：让用户确认「快捷键确实触发了」，与设置页区分开
  try {
    await prg.toast("正在打开配置窗口…");
  } catch (e) {}

  // 【通道 1】主程序表单窗口：多字段、在软件内、打字正常回显。体验最好，优先用。
  if (typeof prg.form === "function") {
    const formDone = await configViaForm(cfg);
    if (formDone) return;
    await prg.toast_warning("表单窗口没打开，改用对话框填写（同样能正常打字显示）");
  } else {
    await recordConfigStep("form:missing-api");
  }

  // 【通道 2】单框对话框：同样在软件内、打字正常回显。
  // 注意只能「一个」框——连弹多个会被上一个的遮罩挡住（主程序遮罩延迟 500ms 移除）。
  const dialogDone = await configViaDialog(cfg);
  if (dialogDone) return;

  // 【通道 3】记事本：前两条都不可用时的兜底，100% 能输入
  let ctx = null;
  try {
    const { project, uri } = await requireProject();
    const target = await configFileTarget(project, uri);
    ctx = { project, targetUri: target.targetUri, displayPath: target.displayPath, stem: target.stem };
  } catch (e) {
    ctx = null;
  }

  if (!ctx) return;

  const existing = await readConfigFile(ctx.project, ctx.targetUri);
  if (existing === null || !existing.trim()) {
    try {
      await writeConfigFile(ctx.project, ctx.targetUri, buildConfigTemplate(cfg));
    } catch (e) {
      await prg.toast_error(`无法写入配置文件：${errText(e).slice(0, 60)}`);
      return;
    }
    await prg.settings_setOwn("_configFile", ctx.displayPath);
    const opened = await openInNotepad(ctx.displayPath);
    await prg.toast_warning(
      opened
        ? `已用记事本打开：${ctx.displayPath} ｜ 填好保存后，再按一次本快捷键`
        : `请用记事本打开并填写：${ctx.displayPath} ｜ 保存后再按一次本快捷键`,
    );
    return;
  }

  const backend = await applyConfigText(cfg, existing);
  await prg.settings_setOwn("_configFile", ctx.displayPath);
  if (backend === "reset") {
    await prg.toast_success("已按配置文件恢复默认设置");
    return;
  }
  await prg.toast_success(`配置已从 ${ctx.stem}.sync.json 载入（${backend}）｜按 Ctrl+Shift+Alt+S 同步`);
}

// 用系统记事本打开文件。用 cmd /c start 让它立即返回，不阻塞扩展线程。
async function openInNotepad(fsPath) {
  if (typeof prg.shell_execute !== "function") return false;
  const attempts = [
    ["cmd", ["/c", "start", "", "notepad.exe", fsPath]],
    ["notepad.exe", [fsPath]],
  ];
  for (const [program, args] of attempts) {
    try {
      await prg.shell_execute(program, args);
      return true;
    } catch (e) {
      continue;
    }
  }
  return false;
}

// 强制重新生成配置文件模板（覆盖原文件）
async function regenerateConfigFile() {
  const cfg = await loadConfig();
  const { project, uri } = await requireProject();
  const target = await configFileTarget(project, uri);
  await writeConfigFile(project, target.targetUri, buildConfigTemplate(cfg));
  await prg.settings_setOwn("_configFile", target.displayPath);
  await prg.toast_success(`已重新生成配置文件：${target.displayPath}`);
}

// 弹窗方式：输入框正常时更顺手；只弹 1 个框，避免遮挡
// 单框对话框：在软件内填写，打字正常回显。
// 只弹一个多行框（连弹多个会被上一个的残留遮罩挡住）。
// 返回 true = 已处理完（保存成功或用户取消）；false = 对话框不可用，交给上层兜底。
async function configViaDialog(cfg) {
  const base = cfg || (await loadConfig());
  let raw;
  try {
    raw = await ui(() =>
      prg.dialog_input(
        "同步配置",
        "改「账号」「密码」两行即可；其它行按需改。# 开头是注释。\n提交请按 Shift+Enter 或点【确定】；关闭请点【取消】（主程序不支持 Esc 关闭）。",
        { multiline: true, defaultValue: buildConfigTemplate(base) },
      ),
    );
  } catch (e) {
    // 主程序的「取消」是 reject(undefined)，据此区分「用户取消」和「对话框不可用」
    if (e === undefined || e === null) {
      await recordConfigStep("dialog:cancelled-by-user");
      await prg.toast("已取消，配置未改动");
      return true;
    }
    runtime.lastError = `dialog_input 不可用：${errText(e).slice(0, 100)}`;
    await recordConfigStep(`dialog:error:${errText(e).slice(0, 100)}`);
    return false;
  }
  if (raw === null || raw === undefined) {
    await recordConfigStep("dialog:cancelled-by-user");
    await prg.toast("已取消，配置未改动");
    return true;
  }
  await recordConfigStep("dialog:submitted");

  const text = String(raw);
  if (!text.trim()) {
    await prg.toast_warning("内容为空，配置未改动");
    return true;
  }

  const backend = await applyConfigText(base, text);
  if (backend === "reset") {
    await prg.toast_success("已恢复默认设置");
    return true;
  }
  await prg.toast_success(`配置已保存（${backend}）｜按 Ctrl+Shift+Alt+S 同步`);
  return true;
}

function buildConfigTemplate(cfg) {
  return [
    "# 每行「键=值」。# 开头是注释，可以整行删掉。",
    "# 坚果云：只改下面两行",
    `账号=${cfg.webdav.username}`,
    `密码=${cfg.webdav.appPassword}`,
    "",
    "# 以下通常不用改",
    `地址=${cfg.webdav.root}`,
    `目录=${cfg.webdav.remoteDir}`,
    `自动同步=${cfg.autoSync ? "yes" : "no"}`,
    `间隔分钟=${cfg.intervalMinutes}`,
    "",
    "# 改用 S3：删掉上面的「账号 / 密码 / 地址」，再去掉下面各行开头的 #",
    "#类型=s3",
    `#endpoint=${cfg.s3.endpoint}`,
    `#region=${cfg.s3.region}`,
    `#AK=${cfg.s3.accessKeyId}`,
    `#SK=${cfg.s3.secretAccessKey}`,
    `#桶=${cfg.s3.bucket}`,
    `#前缀=${cfg.s3.prefix}`,
    `#pathstyle=${cfg.s3.forcePathStyle ? "yes" : "no"}`,
    "",
    "# 想恢复出厂设置：去掉下一行开头的 # 再提交",
    "#重置=yes",
  ].join("\n");
}

const YES_RE = /^(1|true|yes|y|on|是|开|启用|对)$/i;

// 把「键=值」文本解析成配置补丁；不认识的键直接忽略，避免手滑写错导致整份配置失效
function parseConfigText(text) {
  const patch = { webdav: {}, s3: {} };
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase().replace(/[\s_-]/g, "");
    const value = line.slice(idx + 1).trim();
    if (key === "backend" || key === "类型") {
      patch.backend = value.toLowerCase();
    } else if (key === "root" || key === "地址" || key === "webdav.root" || key === "url") {
      patch.webdav.root = value;
    } else if (key === "账号" || key === "username" || key === "user" || key === "邮箱" || key === "webdav.username") {
      patch.webdav.username = value;
    } else if (
      key === "密码" ||
      key === "应用密码" ||
      key === "password" ||
      key === "apppassword" ||
      key === "webdav.apppassword"
    ) {
      patch.webdav.appPassword = value;
    } else if (key === "目录" || key === "云端目录" || key === "远端目录" || key === "remotedir" || key === "webdav.remotedir") {
      patch.webdav.remoteDir = value;
    } else if (key === "endpoint" || key === "s3.endpoint") {
      patch.s3.endpoint = value;
    } else if (key === "region" || key === "s3.region") {
      patch.s3.region = value;
    } else if (key === "ak" || key === "accesskeyid" || key === "s3.accesskeyid") {
      patch.s3.accessKeyId = value;
    } else if (key === "sk" || key === "secretaccesskey" || key === "s3.secretaccesskey") {
      patch.s3.secretAccessKey = value;
    } else if (key === "桶" || key === "桶名" || key === "bucket" || key === "s3.bucket") {
      patch.s3.bucket = value;
    } else if (key === "前缀" || key === "prefix" || key === "s3.prefix") {
      patch.s3.prefix = value;
    } else if (key === "pathstyle" || key === "s3.forcepathstyle") {
      patch.s3.forcePathStyle = YES_RE.test(value);
    } else if (key === "自动同步" || key === "autosync") {
      patch.autoSync = YES_RE.test(value);
    } else if (key === "间隔" || key === "间隔分钟" || key === "interval" || key === "intervalminutes") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) patch.intervalMinutes = n;
    } else if (key === "重置" || key === "reset") {
      patch.reset = YES_RE.test(value);
    } else if (key === "模式" || key === "mode") {
      patch.mode = value.toLowerCase().startsWith("file") ? "file" : "dir";
    } else if (key === "本地目录" || key === "localdir") {
      patch.localDir = value;
    } else if (key === "子目录" || key === "远端目录名" || key === "remotesubdir") {
      patch.remoteSubdir = value;
    } else if (key === "忽略" || key === "ignore") {
      patch.ignore = value;
    } else if (key === "同步删除" || key === "syncdelete") {
      patch.syncDelete = YES_RE.test(value);
    } else if (key === "最大文件数" || key === "maxfiles") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) patch.maxFiles = n;
    } else if (key === "最大总量" || key === "maxtotalmb") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) patch.maxTotalMB = n;
    }
  }
  return patch;
}

async function showStatus() {
  const cfg = await loadConfig();
  const baselines = await loadBaselines();
  const { project } = await requireProject().catch(() => ({ project: null }));
  let current = null;
  let scope = null;
  if (project) {
    const uri = await project.uri;
    const fsPath = String(await uri.fsPath);
    const root = await resolveLocalRoot(cfg, uri).catch(() => null);
    current = { fsPath, stageHash: String(await project.stageHash) };
    scope = root
      ? {
          mode: cfg.mode,
          localRoot: root.fsPath,
          remoteRoot: cfg.remoteSubdir ? `${cfg.remoteSubdir}/${root.name}` : root.name,
          baselineFiles: (() => {
            const record = baselines[`dir:${root.fsPath}`];
            return record && record.files ? Object.keys(record.files).length : 0;
          })(),
        }
      : null;
  }
  // 先发 toast 摘要：不依赖弹窗，任何时候都能看到关键状态
  const webdavReady = Boolean(cfg.webdav.username && cfg.webdav.appPassword);
  const s3Ready = Boolean(cfg.s3.accessKeyId && cfg.s3.secretAccessKey && cfg.s3.bucket);
  const ready = cfg.backend === "s3" ? s3Ready : webdavReady;
  try {
    await prg.toast(
      `v${EXT_VERSION}｜${cfg.backend} ${ready ? "已配置" : "未配置"}｜范围 ${
        cfg.mode === "file" ? "单文件" : "整目录"
      }${scope ? `（${scope.remoteRoot}）` : ""}｜通道 ${transportMode}`,
    );
    await prg.toast(
      `配置${ready ? "齐" : "缺账号或密码"}｜基线文件 ${scope ? scope.baselineFiles : 0} 个${
        runtime.lastError ? `｜错误 ${String(runtime.lastError).slice(0, 50)}` : ""
      }`,
    );
  } catch (e) {}

  let keybinds = "";
  let capabilities = "";
  try {
    keybinds = String((await prg.settings_getOwn("_keybinds")) || "");
    capabilities = String((await prg.settings_getOwn("_capabilities")) || "");
  } catch (e) {}

  try {
    await uiCopy(
      "同步状态",
      "复制这份内容可用于排查问题（不含密码）",
      JSON.stringify(
        {
          version: EXT_VERSION,
          config: maskedConfig(cfg),
          transportMode,
          runtime,
          requestCountIn30Min: requestLog.length,
          scope,
          current,
          baselineCount: Object.keys(baselines).length,
          keybinds,
          capabilities,
        },
        null,
        2,
      ),
    );
  } catch (e) {}
}

// 纯 toast 诊断：不依赖任何弹窗，用来判断「扩展到底跑没跑起来、配置有没有生效」
async function showDiagToast() {
  const cfg = await loadConfig();
  const webdavReady = Boolean(cfg.webdav.username && cfg.webdav.appPassword);
  const s3Ready = Boolean(cfg.s3.accessKeyId && cfg.s3.secretAccessKey && cfg.s3.bucket);
  const ready = cfg.backend === "s3" ? s3Ready : webdavReady;
  let projectName = "未打开工程";
  let fsState = "无工程";
  let configPath = "";
  const syncScope = cfg.mode === "file" ? "单文件" : "整目录";
  try {
    const { project, uri } = await requireProject();
    const full = String(await uri.fsPath);
    projectName = full.split(/[\\/]/).pop() || full;
    const target = await configFileTarget(project, uri);
    configPath = target.displayPath;
    try {
      const fs = await project.fs;
      fsState = typeof fs.read === "function" && typeof fs.write === "function" ? "可读写" : "不可用";
    } catch (e) {
      fsState = "不可用";
    }
  } catch (e) {
    projectName = "未打开工程";
  }
  await prg.toast(
    `v${EXT_VERSION}｜${cfg.backend} ${ready ? "已配置" : "未配置"}｜范围 ${syncScope}｜通道 ${transportMode}｜工程 ${projectName}`,
  );
  await prg.toast(
    `文件通道 ${fsState}${configPath ? `｜配置：${configPath}` : ""}${
      runtime.lastError ? `｜错误 ${runtime.lastError.slice(0, 50)}` : ""
    }`,
  );
}

async function resetBaseline() {
  const { uri } = await requireProject();
  const fsPath = String(await uri.fsPath);
  const ok = await uiConfirm(
    "重置同步基线？",
    "下次同步会重新比对本地与远端，若两端都有内容会进入冲突选择。不会删除任何文件。",
    { destructive: false },
  );
  if (!ok) return;
  const baselines = await loadBaselines();
  delete baselines[fsPath];
  await saveBaselines(baselines);
  await prg.toast_success("已重置当前工程的同步基线");
}

async function runCommand(fn) {
  try {
    await fn();
  } catch (e) {
    runtime.lastError = errText(e);
    if (!(e instanceof TransportFallbackError)) {
      await prg.toast_error(`同步失败：${errText(e).slice(0, 180)}`);
    }
  }
}

function scheduleAutoSync(cfg) {
  const signature = `${cfg.autoSync}|${cfg.intervalMinutes}`;
  if (signature === lastAutoSignature) return;
  lastAutoSignature = signature;
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  if (!cfg.autoSync) return;
  const minutes = Math.max(5, Number(cfg.intervalMinutes) || 10);
  autoTimer = setInterval(async () => {
    try {
      await syncCore(null, true);
    } catch (e) {
      runtime.lastError = errText(e);
    }
  }, minutes * 60 * 1000);
}

// ─────────────────────────────── 8. 启动与命令注册 ───────────────────────────────

// 只使用「用户磁盘上已经存在」的 6 个命令 ID。
// 原因（用户机器 keybinds2.json 实测）：新 ID 首次注册要写 keybinds2.json，
// 这条写入路径会失败；已存在的 ID 只走读取分支，不写盘，因此永远可用。
// 所以功能只能挂在这 6 个 ID 上，不再新增 ID。
const commands = [
  { id: "sync-now", icon: "RefreshCw", key: "C-S-A-s", run: () => syncCore(null, false) },
  { id: "sync-upload", icon: "Upload", key: "C-S-A-u", run: () => syncCore("upload", false) },
  { id: "sync-download", icon: "Download", key: "C-S-A-j", run: () => syncCore("download", false) },
  { id: "sync-config", icon: "Settings", key: "C-S-A-c", run: configWizard },
  { id: "sync-status", icon: "Info", key: "C-S-A-i", run: showStatus },
  { id: "sync-reset", icon: "RotateCcw", key: "C-S-A-r", run: resetBaseline },
];

const keybindReport = [];

async function registerOne(command) {
  const handler = () => runCommand(command.run);
  // 关键：主程序侧要拿到一个可跨线程调用的函数。v0.2.0 起直接传普通函数，
  // 实测注册全部失败（详情页一个命令都不显示）。用 Comlink.proxy 显式包装，
  // 与 v0.1.x（当时 6 个命令注册成功）保持一致的传参方式。
  let arg = handler;
  if (typeof Comlink !== "undefined" && typeof Comlink.proxy === "function") {
    try {
      arg = Comlink.proxy(handler);
    } catch (e) {
      arg = handler;
    }
  }
  try {
    await prg.keybinds_register(command.id, { $lucide: command.icon }, command.key, arg);
    keybindReport.push(`${command.id}:ok`);
    return true;
  } catch (e) {
    keybindReport.push(`${command.id}:${errText(e).slice(0, 80)}`);
    runtime.lastError = `注册命令 ${command.id} 失败：${errText(e)}`;
    return false;
  }
}

async function registerAllCommands() {
  for (const command of commands) {
    await registerOne(command);
  }
  // 幂等补注册一轮：主程序写 keybinds 存储存在竞态，隔一会儿再注册可自愈
  await sleep(600);
  for (const command of commands) {
    await registerOne(command);
  }
  // 把注册结果落盘，便于在设置页 / 状态里直接看到哪一条失败、为什么失败
  try {
    await prg.settings_setOwn("_keybinds", keybindReport.join(" | ").slice(0, 900));
  } catch (e) {}
}

// 能力探测：把本机到底支持哪些 API 记下来，出问题时一眼就能定位
async function probeCapabilities() {
  const cap = {
    form: typeof prg.form === "function",
    shell: typeof prg.shell_execute === "function",
    dialog: typeof prg.dialog_input === "function",
    comlink: typeof Comlink !== "undefined",
    keybinds: typeof prg.keybinds_register === "function",
  };
  try {
    await prg.settings_setOwn("_capabilities", JSON.stringify(cap));
  } catch (e) {}
  return cap;
}

// 必须先写入默认键，扩展详情页的「设置」标签才会出现可编辑项
await ensureSettings();

await probeCapabilities();

await registerAllCommands();

const startupConfig = await loadConfig();
scheduleAutoSync(startupConfig);

await prg.toast(
  `WebDAV / S3 Sync v${EXT_VERSION} 已加载｜C 配置 · S 同步整目录 · I 状态`,
);
