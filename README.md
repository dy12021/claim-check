# 正误分析（claim-check）

在**任意网页**上划选一段文字，右键 →「分析正误」，得到一份**公正客观**的论证分析：
这段话在论证什么、有哪些可能的逻辑问题、深度搜索到了哪些资料、结论是
**大概率成立 / 可能有误 / 证据不足无法判定**。

面向的是互联网上最常见的几类场景：评论区里的断言、提问式表述、
立场对立的观点、以及带结论的科普。

- **不预设立场**：prompt 里写死了「不站队」「只依据给出的证据」「允许无法判定」。
- **结论可追溯**：每一条判断都指回原文片段或某条检索资料的标题。
- **如实报告失败**：搜不到就写「没搜到」，模型输出不是 JSON 就写「解析失败」，
  绝不装作搜过、装作有结论。

## 隐私

- **没有后端。** 不运行任何服务器，不做遥测，不收集统计。
- **不读网页内容。** 划选文本由 `contextMenus` 的 `selectionText` 直接提供，
  扩展**没有 content script、没有 `activeTab`、没有 `scripting`**——
  它拿不到网页上的任何东西，除了你自己划选的那一段。
- **API Key 由你自己提供**，只存在本机 `chrome.storage.local`，
  只在你调用 LLM 时使用；**面板永远不回显明文**，错误信息里也会把 Key 遮掉。
- **禁用 `storage.sync`**：sync 会把数据同步到浏览器账号，与「只存在本机」的承诺冲突。
- **会离开你浏览器的数据**：只有你划选的那段文字（和出处链接），
  发给你自己配置的 LLM 服务商；深度搜索时另加检索词（只有 2–3 个短词），
  发给搜索引擎。选哪个服务商，数据就流向哪里。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 存你的 API Key 和分析历史（仅本机） |
| `contextMenus` | 右键菜单「分析正误」 |
| `https://*.bing.com/*` | 深度搜索用的搜索引擎出口 |

**就这三个。** 没有 `tabs` / `activeTab` / `scripting` / `webRequest` / `cookies`。
构建脚本 `scripts/verify-dist.ts` 里有硬红线：多出任何一个权限，构建直接失败。

> 扩展不申请 LLM 服务商的 host 权限——主流 OpenAI 兼容接口与 Anthropic 接口
> 都返回 `Access-Control-Allow-Origin: chrome-extension://…`，直接就能连上。

## 安装

```bash
npm install
npm run build
```

### Chrome

1. 打开 `chrome://extensions`
2. 开启右上角「开发者模式」
3. 点「加载已解压的扩展程序」→ 选 `dist/` 目录

### Edge

1. 打开 `edge://extensions`
2. 开启左侧「开发人员模式」
3. 点「加载解压缩的扩展」→ 选 `dist/` 目录

Edge 与 Chrome 同源（都是 Chromium），**扩展包完全相同**，两边都能跑。

## 配置

点扩展图标打开面板，填入：

- 服务商：OpenAI 兼容（DeepSeek / MiniMax / Kimi / Qwen 等）或 Anthropic
- Base URL、API Key、模型名
- 可选：最大输出 token、推理强度
- 是否开启深度搜索

填完点「测试连通性」。

### 推理强度：调低能快一个数量级

默认「低」。结构解析、逻辑问题抽取都是简单任务，深度思考纯属浪费时间和钱。
实测同一个请求：`low` 约 4.8 s，不设置（服务商默认）20–70 s。

如果你的服务商不认 `reasoning_effort`（返回 400），扩展会**自动摘掉这个字段重试一次**。

### 用推理模型？注意 token 预算

带 thinking 的推理模型（如 `MiniMax-M3.1-Flash`）**先思考再回答，思考过程和最终答案共用 token 预算**。
预算给小了最终答案就是空的，扩展会明确报「只返回了思考过程、没有最终答案——token 预算不够」，
而不是静默失败。

默认 `maxTokens = 8192`。实测 M3.1 在 2000 时会时灵时不灵，8000 才稳定。

## 工作原理

分两阶段，**分两段的原因是**：第一段只需要「这段话本身」，第二段需要「这段话 + 外部资料」，
混在一起模型会顾此失彼（要么忽略原文，要么忽略资料）。

```
① 结构解析（一次 LLM 调用）
   这段话在论证什么？有哪些可能的逻辑问题？默认前提是什么？还缺什么证据？
   → 同时产出 2–3 个**短的**检索词

② 深度搜索（Bing RSS 出口，不需要额外 API Key）
   → 最多 8 条资料（标题 + 摘要 + 链接）

③ 综合判断（一次 LLM 调用）
   → 三档结论：大概率成立 / 可能有误 / 证据不足无法判定
   → 每条判断都指明依据来自哪条资料
```

结果页新开一个标签页显示；分析还在跑的时候页面会轮询等它。

### 搜索出口为什么是 Bing RSS

- **不需要任何 API Key**（用户只要配 LLM 的 Key 就能用）；
- 返回标准 RSS，标题/摘要/链接三样都有，够做「有没有资料支持」的判断；
- 国内可访问（DuckDuckGo / Wikipedia API 在国内网络下不通）。

**已知限制：过长的中文查询会被截断。** 实测「人工智能取代人类工作」（10 字）
只匹配到「人工」，而「新能源汽车补贴政策」（9 字）正常。所以 prompt 里要求
检索词**用空格隔开、2–4 个词**，代码里再做一次长度兜底。

### 检索词要短，是被搜索接口逼出来的

这一条写在 prompt 里，不是建议是硬要求。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # vite build
npm run verify      # 构建产物闸门：manifest 引用路径 / 权限红线 / 无 eval
npm run scan:secrets  # 敏感数据与本机路径扫描
npm run e2e         # 端到端真机验证（需自行准备浏览器与 LLM 配置）
```

### 闸门

- `npm run verify` —— 单测全绿也救不了「manifest 忘了声明某个权限」这种**接线错误**。
  这个脚本是构建后的最后一道闸：manifest 引用的每个路径都要真实存在，
  权限面不能超出设计意图，产物里不许出现 `eval` / `new Function`。
- `npm run scan:secrets` —— 开源前扫本机绝对路径、API Key、邮箱、私钥块。
  规则写在代码里，每次提交都能自动跑；确认是误报的写进
  `scripts/sensitive-allow.txt`。
- `npm run e2e` —— 真机跑一遍完整链路：装扩展 → **真实鼠标划词** → 右键 →
  分析 → 读结果页的 DOM 逐项断言。脚本用 CDP 驱动浏览器，
  需要指定两样东西：

  ```bash
  # LLM 配置（toml 格式，含 base_url / api_key / model）
  export CLAIM_CHECK_LLM_CONFIG=/path/to/config.toml
  # 浏览器与端口
  BROWSER=edge CDP_PORT=9346 npx tsx scripts/e2e.ts
  ```

  脚本里**不写死任何本机路径**——路径一律从环境变量来。

### 发布到 GitHub

`scripts/github-create-repo.ts` 用 git 凭据助手里的 token 调 GitHub API 建仓
（GitHub 的用户账号不支持「push 自动建仓」）。
token 只在内存里，不打印、不写盘。

## 已知限制

- 搜索只覆盖 Bing RSS 的前几条结果，**不是全网检索**。
- 模型判断受限于 LLM 服务商的能力，**不构成专业意见**——医疗、法律、金融请找专业人士。
- 分析历史只存在本机，不跨设备同步。

## License

MIT
