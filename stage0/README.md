# WebDAV 能力自检（阶段 0）

这是一个临时验证插件，不是最终产品。它用来确认 4 个决定架构的假设，因为「Comlink 能否跨线程传二进制」只能在本机 Project Graph 里实测。

## 安装

1. 生成安装包：在项目根目录运行 `python tools/build_probe.py`，产物为 `out/com.workbuddy.webdav-sync-probe-0.0.1.prg`（仓库中已附带）。
2. 在 Project Graph 里打开 / 拖入该 `.prg` 文件安装；或把它解压成同名文件夹，放进设置里显示的「扩展目录」。
3. 在快捷键设置里找到「重载应用」，绑定一个快捷键（例如 `Ctrl+F5`）。**注意：重载会丢失所有未保存的文件，先保存好工程。**
4. 重载后会看到 toast「WebDAV 自检已加载」。若想在设置页确认扩展确实运行过：打开「设置 → 扩展 → WebDAV 能力自检 → 设置」，应能看到 `_loadedAt` 这一项（记录加载时间）。若显示「该扩展没有设置项」，说明扩展没运行，请点扩展页左下的「重载扩展」。

## 运行

打开任意一个 `.prg` 工程，按 `Ctrl+Shift+Alt+D`（也可在快捷键设置里给 `stage0-run-probe` 重新绑定）。

自检分两段：

- **本地段**（自动执行，只读、不改工程）：settings 往返、`tabs_getCurrentProject`、`project.uri.fsPath`、`getFileContent()` 是否返回 Uint8Array、`project.fs.read()`、`stageHash`。
- **网络段**（会先弹确认框）：填写 WebDAV 根地址、账号、应用密码、测试目录，然后依次执行 `PROPFIND Depth:1`、`MKCOL`、`PUT`（16 字节）、`GET + arrayBuffer`、`HEAD`，最后 `DELETE` 清理临时文件。

坚果云填写示例：

| 字段 | 值 |
| --- | --- |
| 根地址 | `https://dav.jianguoyun.com/dav/` |
| 账号 | 注册邮箱 |
| 应用密码 | 网页端 → 账户信息 → 安全选项 → 添加应用密码（**不是登录密码**） |
| 测试目录 | 建议全英文，如 `ProjectGraphProbe` |

## 反馈

结束后弹出「WebDAV 能力自检报告」，点复制，把整份 JSON 发回即可。**报告不含账号和密码**。

重点看这几行是否 `ok: true`：

- `project.getFileContent (Uint8Array)` → 决定能否上传当前工程
- `fetch PUT binary body` → 决定能否把二进制 PUT 出去
- `fetch GET + arrayBuffer` 里的 `identical=true` → 决定能否把远端文件取回来
- `project.fs.read` → 决定能否读本地文件（写回能力下一步验证）

任何一项失败都不用慌，插件本身没有副作用；把报告发回来，我据此切换实现路径（例如改用 `shell_execute` 调 curl）。

## 已知注意点

- 坚果云免费版限制每 30 分钟 600 次请求，`PROPFIND` 只支持 `Depth: 1`；运行一次自检约 6 个请求，安全。
- 若开了微信二次验证，WebDAV 会返回 403，需要在安全选项里关闭。
- 远端目录若已存在，`MKCOL` 返回 405 属于正常，不算失败。
