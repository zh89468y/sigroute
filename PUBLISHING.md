# 打包与发布指南

## 一、本地打包（生成 .vsix）

```bash
cd sigroute
npm install              # 首次需要
npm run package          # 等价于 npx @vscode/vsce package
```

产出 `sigroute-0.1.0.vsix`。安装到本机验证：

```bash
code --install-extension sigroute-0.1.0.vsix
```

或在 VSCode 里：扩展面板 → 右上角 `...` → **从 VSIX 安装…**

> `vsce package` 会自动先执行 `vscode:prepublish`（也就是 `npm run compile`），
> 所以不需要手动编译，但 Compile 报错会导致打包失败。

---

## 二、发布到 Marketplace

> ⚠️ 这一步**必须用你自己的账号**：PAT 等价于账号权限，只能由你生成；
> Publisher ID 也只能由你创建。工具链之外的部分我无法代劳，但下面的元数据、
> 图标、LICENSE、CHANGELOG 都已就位，`vsce publish` 应当一次通过。

### 第 1 步 · 创建 Publisher

1. 打开 <https://marketplace.visualstudio.com/manage>
2. 用 Microsoft 账号登录（没有就注册一个）
3. **Create publisher**，ID 建议用短小写标识，例如 `sigroute`

### 第 2 步 · 生成 PAT（Personal Access Token）

1. 打开 <https://dev.azure.com>（首次登录会要求创建一个组织，随便起名）
2. 右上角用户菜单 → **Personal access tokens** → **New Token**
3. 关键设置：
   - **Organization**：选 `All accessible organizations`（选错会导致 401）
   - **Scopes**：先点 `Show all scopes`，再勾 **Marketplace → Manage**
4. 创建后**立刻复制** token（页面关闭就再也看不到）

### 第 3 步 · 修改 package.json 里的占位信息

```jsonc
{
  "publisher": "你的-publisher-id",          // 现在是 "sigroute"，必须改成你自己的
  "repository": { "type": "git", "url": "https://github.com/你的名字/sigroute.git" },
  "bugs":       { "url": "https://github.com/你的名字/sigroute/issues" },
  "homepage":   "https://github.com/你的名字/sigroute#readme"
}
```

`repository` 会影响市场页面的"Repository"链接；没有仓库可以先填占位地址，
但建议先推到 GitHub 再发布。

### 第 4 步 · 发布

```bash
# 方式 A：登录一次，之后不用再带 token
npx @vscode/vsce login 你的-publisher-id    # 粘贴 PAT
npx @vscode/vsce publish

# 方式 B：直接带 token
npx @vscode/vsce publish -p <PAT>
```

版本递增发布：

```bash
npm run publish:patch    # 0.1.0 → 0.1.1
npm run publish:minor    # 0.1.0 → 0.2.0
npx @vscode/vsce publish major
```

### 第 5 步 · 验证

几分钟内可在市场搜到：

```
https://marketplace.visualstudio.com/items?itemName=<你的-publisher-id>.sigroute
```

---

## 三、发布前检查清单

- [ ] `publisher` 已改成你自己的 ID（当前为占位 `sigroute`）
- [ ] `repository` / `bugs` / `homepage` 已改成你的仓库地址
- [ ] `npm run compile` 无错误
- [ ] `npm run selfcheck` 通过（全部模块加载正常）
- [ ] `icon.png` 存在且 ≥128×128（当前 256×256，2.9 KB）
- [ ] `CHANGELOG.md` 的版本号与 `package.json` 的 `version` 一致
- [ ] 已用 `code --install-extension sigroute-0.1.0.vsix` 实测过功能

---

## 四、打包产物内容

`.vscodeignore` 已排除：`src/`、`tools/`（**但保留 `tools/ai.mjs` 与 `tools/mcp.mjs`**）、
`node_modules/`、`*.map`、`tsconfig.json`、`package-lock.json`。

最终 vsix 里只有：

```
package.json         插件清单
README.md            市场详情页正文
CHANGELOG.md         版本历史
LICENSE              MIT
icon.png             图标
out/**.js            编译产物（CommonJS，22 个文件）
tools/ai.mjs         AI 接口层 + 命令行（Node 直跑）
tools/mcp.mjs        MCP stdio 服务（给 AI 客户端挂）
```

> 为什么带上这两个文件：它们让"只装了插件"的人也能直接把 MCP 服务挂给 AI 客户端
> （`node <扩展目录>/tools/mcp.mjs --root <工程>`），不用 clone 仓库。
> 它们跑的是 `out/` 编译产物 —— 也就是插件里同一份代码，且不需要 Node 的类型剥离。

> 注意：插件**零运行时依赖**，`dependencies` 为空，所以不需要打包 `node_modules`。
> 装到用户机器上不会触发任何额外下载。

---

## 五、常见问题

| 报错 | 原因与处理 |
|---|---|
| `ERROR Failed to publish: Not authorized` | PAT 的 Organization 没选 `All accessible organizations`，或 scope 少了 `Marketplace → Manage` |
| `ERROR Publisher 'xxx' not found` | Publisher ID 拼错，或还没在 manage 页面创建 |
| `ERROR Extension is already published` | 版本号没递增，先改 `version` 或用 `publish patch` |
| `WARNING Missing repository field` | 只是警告，不阻塞；补上 `repository` 即可 |
| 图标不显示 | `icon.png` 必须是 PNG（不是 SVG），且 ≥128×128 |
| 中文 README 在市场显示乱码 | 确认文件为 UTF-8 无 BOM |
