# dsh-qq — QQ 桥接插件

在 QQ 上和 DSH 直接聊天：QQ 消息进来 → 插件把它投给一个独立的 DSH 会话 → 模型回答 →
插件清洗、拆条、补表情 → 通过 OneBot v11 发回 QQ。

不是「套壳客服机器人」，而是有记忆、有脾气、有关系变化的聊天对象：

| 能力 | 说明 |
| --- | --- |
| **一会话一联系人** | 私聊按人、群聊按「群 × 人」分开；DSH 重启 / 电脑重启都自动续聊 |
| **自定义人设** | 写 `~/.dsh/qq-bridge/persona.md`，或用 `qq_set_persona` 工具，下一句立即生效 |
| **好感度关系系统** | 每轮按「女高会怎么感觉」实时加减好感；关系深浅决定语气、主动性、追视频率 |
| **心情 + 说话形状** | 她有自己的心情（12 种，40 分钟一换）；每轮换一种回复形状（只回俩字 / 连发三条 / 岔开话题 / 只发表情……） |
| **QQ 原生表达** | `[face:微笑]` 发小黄脸（321 个内置表情全量）、`[[sticker:可爱]]` 发图片表情包（支持风格包随机）、颜文字照发 |
| **主动 + 追问** | 久了不联系会主动开口；你回完几分钟没动静会追问、会不耐烦；频率随好感度变化 |
| **群聊** | 默认关闭；打开后只回被 @ 的消息，按「群 × 人」独立上下文 |
| **安全默认** | 白名单为空时谁都能聊但**禁用一切工具**；填了白名单再开 `allowTools` 才给 QQ 端工具权限 |
| **零依赖配置页** | `http://127.0.0.1:5701/admin`，浏览器直接打开，改完立即生效 |

本插件**不包含 QQ 登录**。QQ 协议由 OneBot v11 实现端负责，推荐 [NapCatQQ](https://github.com/NapNeko/NapCatQQ)（或 LLOneBot）。

## 工作原理

```
手机 QQ ──► 机器人 QQ（NapCat 已登录，注入在 QQ 里）
              │  OneBot v11：WS 3001 / HTTP 3000 / HTTP 上报 → 5701
              ▼
        dsh-qq 插件（跑在 DSH 宿主进程里）
              │  每个 QQ 会话 ⇒ 一个 DSH 会话
              ▼
        模型回答 ──► 插件：剥标记 / 拆气泡 / 补表情 / 记好感
              └──► 发回 QQ
```

## 快速开始

### 1. 装 QQ 协议端（NapCat）

Windows 推荐[一键安装包](https://github.com/NapNeko/NapCatQQ/releases)：解压 → 运行安装器 → 进入生成的 `NapCat.XXXX.Shell` 目录 → 双击 `napcat.bat` → 扫码登录。

在 NapCat 的「网络配置」里开（开了哪个都行，插件默认三个都试）：

- **WebSocket 服务器**：`127.0.0.1:3001`（推荐）
- **HTTP 服务器**：`127.0.0.1:3000`
- **HTTP 上报**：`http://127.0.0.1:5701/`

### 2. 装插件

```bash
git clone https://github.com/<OWNER>/dsh-qq.git
```

然后在 DSH 里：

```
plugin_manager install_bundle  target: /path/to/dsh-qq
```

或用插件管理器界面导入这个目录。装完 `qq_status` 能看到连接状态。

> 注意：插件**不会**在 DSH 的「设置」里生成表单页（0.2.1 的 settings 服务只给顶层插件行生成表单，
> `install_bundle` 装的插件被包在 `include:` 组里取不到 schema）。所以它自带一个配置页，见下。

### 3. 配置

浏览器打开 **`http://127.0.0.1:5701/admin`**（只绑 127.0.0.1）。

- 人设、白名单、群聊、表情包、分条、好感度、主动/追问…… 全在这页
- 保存写入 `~/.dsh/qq-bridge/settings.json`，**立即生效**
- 写接口要求 `x-dsh-qq-admin: 1` 头（挡跨站表单提交）

### 4. 验证

给机器人发一条私聊，然后在 DSH 里让它调一次 `qq_status`：
能看到「WebSocket 已连接 · 机器人 QQ xxx」就通了。

## 在「个人 QQ」和「机器人 QQ」之间切换

NapCat 是**改 QQ 的启动入口**（`resources\app\package.json` 的 `main` 字段）注入的，所以同一份
QQ 安装不能同时当个人号用——启动入口只有一个。想用同一个号/同一台电脑，就得切换。

`tools/` 里带了一个通用切换脚本（**不写死版本号**，自动找 `versions\*` 下真正带 `package.json` 的那份）：

| 文件 | 作用 |
| --- | --- |
| `tools/switch-qq.ps1` | 主脚本：停止进程 → **整文件覆盖** `package.json` → 校验 → 启动 |
| `tools/switch-to-bot.bat` | 双击切到机器人（会问一次机器人 QQ 号，之后记住） |
| `tools/switch-to-personal.bat` | 双击切回个人 QQ |

> ⚠️ **为什么必须整文件覆盖**：QQ 启动时会校验 `package.json` 的完整性。任何「重写」操作
> ——哪怕只是重新序列化一遍 JSON（格式变多几个空格）——都会让新 QQ 静默退出（exit code 0，不报错、
> 不写日志），看上去就是「点了没反应」。所以脚本用首次运行时保存的 `package.personal.bak` /
> `package.bot.bak` 做**字节级拷贝**，绝不重新生成 JSON。

### 用法

把这三个文件**复制到 QQ 安装目录**（与 `QQ.exe` 同级），然后：

- 双击 `switch-to-personal.bat` → 停机器人 → 还原官方入口 → 启动 QQ（登录你自己的号）
- 双击 `switch-to-bot.bat` → 停 QQ → 改回 NapCat 入口 → 启动 NapCat（机器人上线）

也可以命令行：

```powershell
# 切机器人
.\switch-qq.ps1 -Mode bot -Account 1973631352
# 切个人
.\switch-qq.ps1 -Mode personal
# 只看会做什么，不动任何东西
.\switch-qq.ps1 -Mode bot -DryRun
```

脚本把「原始入口」和「机器人 QQ 号」记在 QQ 目录下的 `qq-switch.state.json`，
日志写在 `qq-switch.log`（每一步都有，失败会停住并说明原因，不会静默）。

第一次运行时脚本会自动生成两份快照：

```
package.personal.bak   官方入口的 package.json（当前文件原样保存）
package.bot.bak        NapCat 入口的 package.json（只把 main 换成 ./napcat/napcat.mjs）
```

之后每次切换就是把对应的那份**原样复制**回去。

### 注意

- **切换期间收到的 QQ 消息会丢**（NapCat 停了就没人接），别在等消息时切
- 脚本会**结束所有 QQ.exe 进程**，包括你正在用的个人 QQ
- 必须用 Windows 自带的 PowerShell 跑（脚本会自动带 `-ExecutionPolicy Bypass`，不用改系统策略）
- 每次切换约 10–15 秒；切完插件会自动重连，不用重启 DSH
- 如果只想「机器人一直在 + 自己也能聊天」，更省事的办法是**机器人放电脑上常驻，自己用手机 QQ**

## 关系系统（好感度 + 认识时长）

每个会话有独立的好感度（0–100，新认识 15）和认识时间。

**每轮由她给这句话打分**（按「17 岁女生会怎么感觉」），模型在回复末尾写一个隐藏标记
`[[好感+2]]` / `[[好感-3]]`，插件**摘掉标记再发出去**（你只看到正常的话），单轮封顶 ±5：

- 加分：认真听、记得细节、真诚关心、自然夸奖、主动道歉 → +1 ~ +3
- 扣分：敷衍、命令口气、不合时宜的玩笑、油腻称呼、说伤人的话、只顾自己 → -1 ~ -4

**关系分档直接写进提示词**：

| 好感 | 关系 | 行为 |
| --- | --- | --- |
| ≤20 | 刚认识，还很生分 | 话少；不提自己的猫/朋友/家里；不关心你私事；不撒娇；套近乎会烦 |
| 21–40 | 有点熟，还收着 | 会接话吐槽，但端着；不主动找你 |
| 41–60 | 有点在意 | 会问「你呢」；被冷落不高兴但不说；愿意讲自己的小事 |
| 61–80 | 明显亲近 | 主动关心、记得细节、会撒娇吃醋；损完你补一句软话 |
| 81–100 | 很黏 | 抱怨你回得慢、主动找你、分享琐碎的事 |

**主动性也按好感缩放**（下表是默认参数下的实际效果）：

| 行为 | 好感 15 | 好感 60 | 好感 90 |
| --- | --- | --- | --- |
| 多久才主动开口 | 约 11 小时 | 约 6.6 小时 | 约 2.9 小时 |
| 每天最多主动几次 | 0（不主动） | 1 | 2 |
| 你没回多久开始追问 | 约 7.5 分钟 | 5 分钟 | 3 分钟 |
| 一轮最多追问几次 | 1 | 2 | 2 |

**`/清空` = 重新认识**：好感回到 15、认识时间归零、换一个全新会话（旧记录仍留在磁盘上）。

## 心情与说话形状

- **心情**：12 种（有点烦 / 困 / 想闹 / 淡淡的 / 小得意……），40 分钟自动换，写进提示词。
  所以她不总顺着你，同一句话在不同心情下回得不一样。
- **形状**：每轮随机换一种（不和上一轮重复）：只回几个字、连发三条、先反问、岔开话题、
  只发一个表情、带点错别字、噎你一句、只说半截……
- 两个开关：`moodEnabled`、`styleEnabled`。

## QQ 表情与表情包

- **小黄脸**：`[face:微笑]`、`[face:doge]`、`[face:问号脸]`……内置 **321 个** QQ 官方表情（名字大小写不敏感，也认数字 `[face:179]`）
- **图片表情包**：`[[sticker:名字]]`
  - 具名：`~/.dsh/qq-bridge/stickers/` 根目录下「文件名就是表情名」
  - **风格包**：子目录名就是包名，`[[sticker:可爱]]` 会从该包里随机发一张
  - 也可以 `stickerMap` 写 `名字=路径或URL`
- 一条回复最多 2 张表情包 + 2 个小黄脸（防刷屏）

## 主动消息与追问

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `proactiveEnabled` | 开 | 久不联系时主动开口 |
| `proactiveIdleMinutes` | 240 | 多久算「久」（会被好感度缩放） |
| `proactiveMaxPerDay` | 1 | 每天最多主动几次 |
| `followUpEnabled` | 开 | 你回完没接话时追问 |
| `followUpMinutes` | 5 | 等多久开始追问（会被好感度缩放） |
| `followUpMax` | 2 | 一轮最多追问几次（先追问、再赌气） |
| `proactiveQuietStart` / `End` | 23:00 / 07:00 | 免打扰时段（跨零点支持） |

追问和主动消息只在**私聊**触发；群里只回应 @。

## 群聊

默认**关闭**。打开后（`groupEnabled`）：

- 默认只回**被 @** 的消息（`groupAtOnly`）
- 上下文按「群 × 人」独立，跟私聊不共享
- 可用 `groupWhitelist` 限定群号

> @ 必须是真正的 at 段（点选机器人头像），手打「@名字」只是文本，识别不到。

## 命令（在 QQ 里发）

| 发送 | 效果 |
| --- | --- |
| `/清空`、`重置`、`重新开始`、`/reset` | 清空这段对话的上下文，好感归零，重新认识 |
| `停止`、`/stop` | 打断当前这条回答 |

## 给 DSH 主 Agent 的工具

| 工具 | 作用 |
| --- | --- |
| `qq_status` | 连接状态、机器人 QQ、人设、白名单、会话数、好感度 |
| `qq_list_conversations` | 有哪些 QQ 会话、聊了几轮 |
| `qq_send_message` | 主动往 `QQ号` 或 `group:群号` 发消息 |
| `qq_set_persona` | 改 QQ 人设（写 persona.md） |
| `qq_allow` | 管理白名单（写 allow.txt，与设置页取并集） |
| `qq_reset` | 清空某段会话的上下文 |

## 数据目录

```
~/.dsh/qq-bridge/
├── persona.md     人设正文（优先于设置页里的 personaPrompt）
├── settings.json  配置页保存的叠加配置
├── allow.txt      白名单（每行一个 QQ 号）
├── state.json     会话映射 / 好感度 / 心情 / 主动与追问状态
├── workspace/     QQ 会话的工作目录
└── stickers/      表情包（根目录=具名，子目录=风格包）
```

DSH 侧会话记录在 `~/.dsh/sessions/` 下（`qq-<hash>`）。

## 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| `qq_status` 显示「未连接」 | NapCat 没开、端口不对、token 不匹配；先确认 NapCat 那个黑窗口还在 |
| QQ 启动后立刻退出 / 提示文件损坏 | NapCat 注入失败或 `package.json` 被改坏（常见于手动改过、或写入时带了 UTF-8 BOM）。用 NapCat 的启动器启动；`package.json` 必须无 BOM |
| 群里 @ 她不回 | 群聊默认关闭；或 @ 不是真 at；或机器人被禁言 / 群全员禁言 |
| 回复里出现 `[[sticker:xxx]]` 原文 | 表情包里没有这个名字（会静默丢弃，不会漏出方括号）；检查 `stickers/` 或 `stickerMap` |
| 人设不生效 | `persona.md` 优先级高于设置页；想用设置页那份就先清空它 |
| 电脑休眠 / DSH 退出后不回 | 插件跑在 DSH 宿主进程里；DSH 必须常驻（窗口 X 是收进托盘），NapCat 窗口也要开着 |

## 限制与安全

- **工具权限**：默认关闭。白名单为空时谁都能聊但工具全关；开 `allowTools` 前请先填白名单
- 插件不含 QQ 登录，也不修改 QQ 本体；NapCat 的注入行为由 NapCat 负责，杀软拦截时需要自行加白
- 收到的图片 / 语音只以「（图片）」「（语音）」占位，不会送图给模型
- 好感度是**模型自评**，会有波动；`affinityEnabled` 可关
- 图片表情包需要你自己准备并遵守来源许可；本仓库**不包含**任何表情包素材

## 许可

MIT。见 [LICENSE](LICENSE)。

## English

`dsh-qq` is a Unity-style QQ bridge plugin for DeepSeek Harness. It connects to any OneBot v11
implementation (NapCat / LLOneBot), gives every QQ contact its own DSH session, and adds persona,
affinity-based relationship dynamics, moods, varied reply shapes, native QQ faces, sticker packs,
kaomoji, message splitting, group @-mentions, proactive pings and impatient follow-ups.

Configure at `http://127.0.0.1:5701/admin` after installing with
`plugin_manager install_bundle target: /path/to/dsh-qq`.
