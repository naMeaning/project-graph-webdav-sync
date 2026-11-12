// Project Graph WebDAV Sync - Stage 0 capability probe
// 目的：在真机上验证 4 个决定架构的假设
//   1) prg.fetch 能否发自定义 method / headers / Uint8Array body
//   2) prg.fetch 返回的 Response 能否跨 Comlink 读 status / headers / arrayBuffer
//   3) Project 代理能否拿到 uri.fsPath / getFileContent() / fs.read()
//   4) settings_setOwn/getOwn 能否往返持久化
// 本插件不会修改当前工程文件；WebDAV 测试只上传一个 16 字节临时文件并立即删除。

const results = [];
let startedAt = 0;

function normalizeError(e) {
  if (e === null || e === undefined) return "unknown error";
  if (typeof e === "string") return e;
  return `${e.name || "Error"}: ${e.message || String(e)}`;
}

async function probe(name, fn) {
  const t = Date.now();
  try {
    const value = await fn();
    results.push({ name, ok: true, ms: Date.now() - t, value: String(value) });
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t, error: normalizeError(e) });
  }
}

function cleanInput(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function basicAuth(user, pass) {
  const raw = `${user}:${pass}`;
  const utf8 = unescape(encodeURIComponent(raw));
  return `Basic ${btoa(utf8)}`;
}

function joinUrl(root, segments) {
  const base = String(root).replace(/\/+$/, "");
  const tail = segments
    .filter((s) => s !== undefined && s !== null && String(s).length > 0)
    .map((s) => String(s).replace(/^\/+|\/+$/g, ""))
    .filter((s) => s.length > 0)
    .map((s) => s.split("/").map(encodeURIComponent).join("/"))
    .join("/");
  return tail ? `${base}/${tail}` : `${base}/`;
}

async function responseSummary(res, readBody) {
  const status = await res.status;
  let etag = "";
  try {
    const headers = await res.headers;
    etag = String((await headers.get("etag")) || "");
  } catch (e) {
    etag = `headers-unavailable: ${normalizeError(e)}`;
  }
  let body = "";
  if (readBody) {
    const text = await res.text();
    body = `${new TextEncoder().encode(text).length}B`;
  }
  return `status=${status} etag=${etag} ${body}`.trim();
}

let fileUrl = "";
let authHeader = "";
const payload = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

async function cleanupRemote() {
  if (!fileUrl || !authHeader) return;
  await probe("webdav DELETE cleanup", async () => {
    const res = await prg.fetch(fileUrl, {
      method: "DELETE",
      headers: { Authorization: authHeader },
    });
    return await responseSummary(res, false);
  });
}

async function runNetworkProbes() {
  const root = cleanInput(
    await prg.dialog_input("WebDAV 根地址", "坚果云填 https://dav.jianguoyun.com/dav/", {
      defaultValue: "https://dav.jianguoyun.com/dav/",
    }),
  );
  const user = cleanInput(await prg.dialog_input("账号", "通常是注册邮箱", {}));
  const pass = cleanInput(
    await prg.dialog_input("应用密码", "坚果云需在 安全选项 → 添加应用密码 生成；报告不会包含密码", {}),
  );
  const dir =
    cleanInput(
      await prg.dialog_input("远端测试目录", "建议全英文，测试文件会放这里", {
        defaultValue: "ProjectGraphProbe",
      }),
    ) || "ProjectGraphProbe";

  if (!root || !user || !pass) {
    results.push({ name: "webdav config", ok: false, error: "地址/账号/应用密码未填完整" });
    return;
  }

  authHeader = basicAuth(user, pass);
  const dirUrl = `${joinUrl(root, [dir])}/`;
  fileUrl = `${dirUrl}__pg_probe.bin`;

  await probe("fetch PROPFIND Depth:1", async () => {
    const res = await prg.fetch(`${joinUrl(root, [])}`, {
      method: "PROPFIND",
      headers: {
        Authorization: authHeader,
        Depth: "1",
        "Content-Type": "application/xml",
      },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>',
    });
    return await responseSummary(res, true);
  });

  await probe("fetch MKCOL", async () => {
    const res = await prg.fetch(dirUrl, {
      method: "MKCOL",
      headers: { Authorization: authHeader },
    });
    return await responseSummary(res, false);
  });

  await probe("fetch PUT binary body", async () => {
    const res = await prg.fetch(fileUrl, {
      method: "PUT",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/octet-stream",
      },
      body: payload,
    });
    return await responseSummary(res, false);
  });

  await probe("fetch GET + arrayBuffer", async () => {
    const res = await prg.fetch(fileUrl, {
      method: "GET",
      headers: { Authorization: authHeader },
    });
    const summary = await responseSummary(res, false);
    const buf = await res.arrayBuffer();
    const got = new Uint8Array(buf);
    let identical = false;
    try {
      identical = got.length === payload.length && got.every((b, i) => b === payload[i]);
    } catch (e) {
      identical = false;
    }
    return `${summary} bodyBytes=${got.length} identical=${identical}`;
  });

  await probe("fetch HEAD / If-None-Match", async () => {
    const res = await prg.fetch(fileUrl, {
      method: "HEAD",
      headers: { Authorization: authHeader },
    });
    return await responseSummary(res, false);
  });
}

async function runLocalProbes() {
  let project = null;
  let uri = null;

  await probe("settings_setOwn/getOwn", async () => {
    const token = `probe-${Date.now()}`;
    await prg.settings_setOwn("__stage0_probe", { token });
    const back = await prg.settings_getOwn("__stage0_probe");
    return `token=${token} back=${JSON.stringify(back)}`;
  });

  await probe("tabs_getCurrentProject", async () => {
    project = await prg.tabs_getCurrentProject();
    if (!project) throw new Error("当前没有打开的工程，请先打开一个 .prg 文件");
    return "Project proxy acquired";
  });

  if (!project) return;

  await probe("project.uri.fsPath / scheme", async () => {
    uri = await project.uri;
    const fsPath = await uri.fsPath;
    const scheme = await uri.scheme;
    return `scheme=${scheme} fsPath=${fsPath}`;
  });

  await probe("project.getFileContent (Uint8Array)", async () => {
    const bytes = await project.getFileContent({ includeThumbnail: false });
    const len = await (bytes?.byteLength ?? -1);
    const b0 = await bytes?.[0];
    const b1 = await bytes?.[1];
    const magic = b0 === 0x50 && b1 === 0x4b ? "PK(zip)" : `0x${Number(b0).toString(16)}/0x${Number(b1).toString(16)}`;
    return `byteLength=${len} magic=${magic} ctor=${bytes?.constructor?.name ?? "unknown"}`;
  });

  await probe("project.fs.read (local file)", async () => {
    const fs = await project.fs;
    if (!fs) throw new Error("project.fs 不可用");
    const currentUri = await project.uri;
    const bytes = await fs.read(currentUri);
    const len = await (bytes?.byteLength ?? -1);
    return `byteLength=${len} ctor=${bytes?.constructor?.name ?? "unknown"}`;
  });

  await probe("project.stageHash (change signal)", async () => {
    const hash = await project.stageHash;
    return `hash=${String(hash).slice(0, 80)}`;
  });
}

async function runProbe() {
  results.length = 0;
  startedAt = Date.now();
  await prg.toast("开始自检，请稍候…");

  try {
    await runLocalProbes();
  } catch (e) {
    results.push({ name: "local probes", ok: false, error: normalizeError(e) });
  }

  let doNetwork = false;
  try {
    doNetwork = Boolean(
      await prg.dialog_confirm(
        "是否测试 WebDAV 往返？",
        "会上传一个 16 字节临时文件并立即删除，不会改动你的工程文件。需要填写坚果云应用密码。",
        { destructive: false },
      ),
    );
  } catch (e) {
    results.push({ name: "network confirm", ok: false, error: normalizeError(e) });
  }

  if (doNetwork) {
    try {
      await runNetworkProbes();
    } catch (e) {
      results.push({ name: "network probes", ok: false, error: normalizeError(e) });
    } finally {
      try {
        await cleanupRemote();
      } catch (e) {
        results.push({ name: "remote cleanup", ok: false, error: normalizeError(e) });
      }
    }
  } else {
    results.push({ name: "webdav round-trip", ok: true, value: "skipped by user" });
  }

  const report = JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      hint: "请把整份报告复制给开发者；报告不含账号密码",
      results,
    },
    null,
    2,
  );

  await prg.dialog_copy("WebDAV 能力自检报告", "复制以下全部内容反馈给开发者", report);
  await prg.toast_success("自检完成，请复制报告");
}

await prg.keybinds_register(
  "stage0-run-probe",
  { $lucide: "Stethoscope" },
  "C-S-A-d",
  Comlink.proxy(runProbe),
);

// 写一个设置项，方便在「扩展 → 设置」里确认本扩展确实执行过
await prg.settings_setOwn("_loadedAt", new Date().toISOString());
await prg.toast("WebDAV 自检已加载：按 Ctrl+Shift+Alt+D 运行");
