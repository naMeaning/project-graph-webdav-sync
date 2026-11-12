# 给 Project Graph 仓库提的 issue 草稿

仓库：https://github.com/graphif/project-graph
下面两个问题互相独立，建议分别提一条 issue（或合成一条，标题写清楚两点）。

---

## Issue 1：扩展设置页的输入框无法回显输入（值能写入，但界面不刷新）

**标题**：`扩展设置页的输入框无法回显：值已写入 Settings.extensionSettings，但 UI 不更新`

### 复现步骤

1. 安装任意带字符串设置项的扩展（例如把扩展 id 写进 `extensionSettings` 的插件）
2. 打开 设置 → 扩展 → 该扩展 → 「设置」标签
3. 在任意输入框里连续打字

### 实际行为

- 输入框内容不随输入变化，看起来「打不进去」
- 但关掉设置窗口再打开（或重载应用），会发现**新值其实已经保存了**
- 实测证据：`%APPDATA%\liren.project-graph\settings.json` 里
  `extensionSettings["<ext-id>"]["webdav.username"]` 的值等于用户输入的内容，而界面上始终显示旧值

### 期望行为

输入时立即回显（与其它设置项一致）。

### 定位

文件：`app/src/sub/SettingsWindow/extensions.tsx`，`TabsContent value="settings"` 分支：

```tsx
<Input
  value={String(value)}
  onChange={(e) => {
    const extensionId = self.metadata.extension?.id || "";
    const current = Settings.extensionSettings[extensionId] ?? {};
    Settings.extensionSettings = {
      ...Settings.extensionSettings,
      [extensionId]: { ...current, [key]: e.target.value },
    };
  }}
/>
```

`value` 每次渲染时从 `Settings.extensionSettings` 读取，但该组件**没有订阅** `extensionSettings` 的变化
（同一个文件里 `disabledExtensions` 与快捷键用的是订阅/atom 写法，`extensionSettings` 是直接读的）。
于是：`onChange` 改了 `Settings.extensionSettings` → 组件不重渲染 → `value` 仍是旧值 → 输入框被 React 重置回旧值。

### 建议修法（任选其一）

1. 把 `extensionSettings` 纳入 store/atom 并在组件里订阅，改完自动重渲染；
2. 或者输入框改成本地 `useState` 暂存，`onBlur` 再提交到 `Settings.extensionSettings`；
3. 布尔开关（`Switch`）同理——目前也有同样的隐患。

### 影响范围

所有在 `extensionSettings` 里存字符串/数字设置项的扩展，用户实际上无法正常配置（只能「盲打」）。

---

## Issue 2：Dialog 弹窗与 FormWindow 无法用 Esc 关闭

**标题**：`Dialog.confirm / Dialog.input / FormWindow 按 Esc 无法关闭，只能点按钮`

### 复现步骤

1. 在扩展里调用 `prg.dialog_buttons(...)` / `prg.dialog_confirm(...)`，或 `prg.form(...)`
2. 弹窗出现后按 `Esc`

### 实际行为

弹窗没有任何反应，只能点「取消 / 确定 / 保存」按钮才能关闭。
用户第一反应是「界面卡住了」。

### 定位

**1）Dialog 系列**：`app/src/components/ui/dialog.tsx`

```tsx
Dialog.confirm = (title, description, { destructive } = {}) => {
  return new Promise((resolve) => {
    function Component({ overlayId }) {
      const [open, setOpen] = React.useState(true);
      return (
        <Dialog open={open}>          // ← 没有传 onOpenChange
          <DialogContent showCloseButton={false}>
```

Radix 的 `Dialog` 在收到 Esc 时会请求关闭（内部 `onOpenChange(false)`），
但这里 `open` 是受控状态且**没有提供 `onOpenChange`**，请求被丢弃，`open` 保持 `true` → 弹窗不关。
`Dialog.input` / `Dialog.buttons` / `Dialog.copy` 是同一写法。
另外 `showCloseButton={false}` 意味着连右上角的 × 也没有，Esc 又无效，用户只剩「点按钮」一条路。

**2）FormWindow**：`app/src/sub/FormWindow.tsx` → `FormWindow.open`

```tsx
const win = createSubWindow("FormWindow", {
  ...
  closable: false,
  closeOnEscape: false,   // ← 显式禁止 Esc 关闭
});
```

### 期望行为

- Esc 关闭弹窗并返回「取消」语义（`resolve(undefined)` 或 `reject()`），与点「取消」一致
- 至少应与 `closeOnEscape` 的默认值保持一致，而不是硬编码 `false`

### 建议修法

```tsx
<Dialog
  open={open}
  onOpenChange={(next) => {
    if (!next) {
      resolve(false);           // 或 undefined，视方法而定
      setOpen(false);
      setTimeout(() => OverlayHost.close(overlayId!), 500);
    }
  }}
>
```

FormWindow 则可把 `closeOnEscape` 开放为 `FormOptions` 的一个字段，默认 `true`。

---

## 附：两点想确认的（可作为第 3 条）

1. `prg.form` 的返回类型签名是 `Promise<void>`，但 `FormWindow.open` 实际 resolve 的是表单数据对象。
   建议把类型改成 `Promise<z.infer<typeof schema> | undefined>`，否则扩展开发者拿不到返回值（TS 上完全不可用）。
2. `FormWindow` 的表单容器是 `flex flex-col gap-4 p-4`，**没有 `overflow-auto`**。
   字段较多时（约 6 个以上）内容会超出子窗口高度，底部「确认 / 取消」按钮被挤出可视区且无法滚动到——
   表现为「按钮点不到」。建议加 `overflow-y-auto`，或让窗口高度随字段数自适应。

   ——这一条我这边确实踩到了：一开始表单给了 10 个字段，保存按钮直接看不见。
