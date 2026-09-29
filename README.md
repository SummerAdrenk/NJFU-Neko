# NJFU智慧猫娘

一个能像玩家一样进入 Minecraft 的 AI 猫娘伙伴：会陪你冒险、听你在聊天栏的吩咐干活、和你聊天互动，大脑由 Claude 驱动。

- 支持新版本服务器（包括 26.2 这样 mineflayer 还没支持的版本）：自动经 ViaProxy 转换协议。
- 支持装了 Fabric API 的服务器和局域网世界：自动完成 Fabric 注册表同步握手。
- 两种大脑：直接调用 Claude API 独立运行；或者由 Claude Code 会话来“附身”操作。

## 她能做什么

- **聊天**：聊天里带上「猫娘」就能叫她；私聊也行。中文口语，偶尔带「喵」。
- **干活**：采集、合成（会自己规划合成树）、熔炼、存取箱子、运送物资、跟随、护卫、打怪、建造。
- **自己动**：没事时陪在主人身边走动；捡掉落物；缺装备和食物时去箱子里拿；饿了吃东西；被怪打会还手，遇到苦力怕会躲开；离太远自动传送回来。
- **懂规矩**：不打挂了命名牌的生物、坐在载具里的生物（多半在刷怪机器里）和禁战区里的生物；/ 命令分级管理；只替主人执行管理员命令。
- **红石与建造**：读出一片区域里每个红石元件的状态来排查故障；按方块状态精确建造；照投影（Litematica）原理图建造。
- **查资料**：本地游戏数据（配方、来源、方块和生物资料）、Minecraft 中文 Wiki；API 模式还能联网查 MC百科。用 /locate 找结构，并附 Chunkbase 地图链接。
- **互动与娱乐**：好感度系统、摸头、抱抱、跳舞、坐下、捡木棍游戏、猜拳、猜数字、钓鱼、PVP 决斗；有人上床时问要不要一起睡；玩家上线问候、死亡关心、进度祝贺。
- **识别模组**：进服时从频道、命令、标签里识别服务器装了哪些模组（例如 Carpet），并使用它们的命令。
- **在游戏里查看她**：`#状态` `#背包` `#好感` 等快捷命令；准心对着她蹲下，会私聊你她的背包。

## 工作原理

```
你的 Minecraft（例如 26.2 局域网世界）
        ▲
        │  26.2 协议
   ViaProxy（协议转换，自动启动）
        ▲
        │  26.1 协议
   猫娘本体（Node.js + mineflayer）── 控制接口 127.0.0.1:3777 ── 命令行 / Claude Code
        │
   大脑：Claude API（独立模式）或 Claude Code 会话
```

## 准备

- Node.js 20 或更高版本
- Java 17 或更高版本（ViaProxy 需要；服务器版本 mineflayer 直接支持时用不到）
- 一个服务器或开了局域网的单人世界

```bash
npm install
npm run setup
```

`npm run setup` 会检查 Node 和 Java、从 GitHub 下载最新的 ViaProxy，并生成 `config.toml`。用记事本打开 `config.toml`，按注释修改：服务器地址和端口、大脑模式、主人名单等。

Windows 上也可以直接双击 `start.bat`：第一次运行会自动安装依赖、下载 ViaProxy、生成配置。

## 启动

```bash
npm start
```

或双击 `start.bat`。

### 连局域网单人世界

1. 在游戏里“对局域网开放”：记下端口（装了 mcwifipnp 可以固定端口），**正版验证选“禁用”**（猫娘是离线账号），**允许命令**打开。
2. 把端口填进 `config.toml` 的 `[server] port`。
3. 启动猫娘，她进来后在聊天栏输入 `/op NJFU_Neko` 给她管理员权限（说话变好看、能用命令、能显示前缀）。

### 连服务器

- 正版服务器：`[account] auth = "microsoft"`，第一次启动按提示在浏览器登录微软账号（不用写密码）。服务器版本需要 ViaProxy 转换时，还要把 `[viaproxy] auth_method` 设为 `"ACCOUNT"`，并先运行一次 ViaProxy 图形界面（`java -jar runtime/viaproxy/ViaProxy.jar`）登录账号。
- 上服务器前一定要填 `[chat] owners` 主人名单，并确认服务器规则允许机器人。
- 离线模式（关闭正版验证）下名字可以被冒用：把世界开放到外网时，请给隧道/服务器设置访问密码或白名单。

## 两种大脑

### Claude API（`[brain] mode = "api"`）

猫娘独立运行，每次有人叫她时调用 Claude API 思考。认证方式三选一：

1. 在 `config.toml` 的 `[brain.api] api_key` 填控制台的 API Key；
2. 设置环境变量 `ANTHROPIC_API_KEY`（更安全）；
3. 用官方命令行 `ant auth login` 在浏览器登录 Claude 平台账号。

说明：

- **按用量计费**。简单对话每次只需很少的费用，干复杂的活会多一些；可以用 `effort = "low"` 降低成本，`max_episodes_per_hour` 限制每小时的思考次数。
- 默认开启了**拒绝时自动换备用模型**（服务端 `fallbacks: "default"`）：请求被安全策略拒绝时，Anthropic 会自动用推荐的备用模型重试，按备用模型的价格计费。不需要时设 `fallbacks = false`。
- 默认允许大脑联网查 Minecraft Wiki 和 MC百科（`web_search`），会产生额外的搜索费用，不需要可以关闭。
- 用中转/代理地址（`base_url`）时，你的 API Key 会发给那个地址，请确认它可信。

### Claude Code（`[brain] mode = "claude-code"`）

在本项目目录打开 Claude Code，它会按 [CLAUDE.md](CLAUDE.md) 启动猫娘、监听聊天，并通过命令行替她说话和行动。适合想用 Claude 订阅账号、或者一边开发一边玩的情况。

### 只挂机（`mode = "none"`）

不思考不聊天，但快捷命令、陪伴、自卫、睡觉邀请等自动行为照常工作。

## 在游戏里怎么用

发 `#帮助` 查看完整说明（可以点击命令），常用：

| 命令 | 作用 |
|---|---|
| `#状态` `#背包` `#好感` `#任务` | 查看她的状态、背包、好感度、正在做的事 |
| `#过来` `#跟着` `#停` `#回家` | 叫她过来、一直跟着、停下、回床边 |
| `#摸头` `#抱抱` `#跳舞` `#坐下` `#喵` | 互动动作 |
| `#猜拳 石头` `#猜数字` `#抛硬币` | 小游戏 |
| `#决斗` `#决斗 困难` `#认输` `#战绩` | PVP 决斗（默认切磋，不会打死） |

其他事情直接用中文说就行：「猫娘去挖 32 个圆石」「猫娘做一把铁镐」「猫娘把钻石运给我」「猫娘最近的村庄在哪」「猫娘看看这台刷铁机哪里坏了」。

## 给她换皮肤

离线玩家没有正版皮肤，游戏会按 UUID 给她分配一张默认皮肤。用资源包替换那张默认皮肤即可，不需要任何模组：

```bash
npm run skin -- 你的皮肤.png --out "游戏目录/resourcepacks"
```

然后在游戏里：选项 → 资源包 → 把「NJFU猫娘皮肤」移到右边 → 完成。不给图片时使用自带的猫娘女仆皮肤 `assets/skins/neko-maid.png`。细手臂和粗手臂皮肤会自动转换。只有启用了资源包的玩家能看到。

## 命令行

```bash
npm run ctl -- help        # 所有命令
npm run ctl -- status      # 状态
npm run ctl -- say 你好     # 让她说话
npm run ctl -- act goto x=100 y=64 z=-20
npm run ctl -- logs -f     # 实时查看日志
npm run ctl -- report      # 生成问题报告（密钥已打码）
```

## 日志与排查问题

- 运行日志：`runtime/logs/neko-日期.log`（按天分文件，保留 14 天）。
- 事件记录：`runtime/logs/events.jsonl`；ViaProxy 日志：`runtime/logs/viaproxy.log`。
- 出问题时运行 `npm run ctl -- report`，把生成的报告发给帮你排查的人，里面的 API Key 和令牌都已打码。

## 安全

- API Key 读取后会从内存里的配置和环境变量中清除，不会传给 ViaProxy；所有日志、事件、聊天输出都会自动打码；`config.toml` 被 git 跟踪时启动会警告。
- 控制接口只监听 127.0.0.1，要求随机令牌，并拒绝浏览器发来的请求；执行任意代码的 eval 默认关闭。
- 玩家在聊天里说的话只会被当作游戏里的请求；/ 命令分级管理，`stop`、`op`、`ban` 等永远不执行。

## 常见问题

- **被踢出，提示需要 Fabric API**：确认 `[compat] fabric_handshake = true`。
- **连不上**：局域网端口每次开放可能不同（装 mcwifipnp 可以固定），核对 `config.toml` 的端口；看 `runtime/logs/` 里的日志。
- **管理员聊天栏里出现很多灰色的 [NJFU_Neko: …]**：那是原版的“管理员命令广播”。把 `[ui] quiet_admin_commands` 设为 `true`，她上线时会关掉这个游戏规则（`log_admin_commands`），准心对准时的动作栏显示、爱心特效等也会随之启用。
- **皮肤没变**：确认资源包已经在游戏里启用（移到右边“已选”一栏）。
- **ViaProxy 启动失败**：检查 Java 版本（17+），或在 `[viaproxy] java` 填 java.exe 的完整路径；看 `runtime/logs/viaproxy.log`。

## 致谢与许可

- 基于 [mineflayer](https://github.com/PrismarineJS/mineflayer) 与 PrismarineJS 系列库、[ViaProxy](https://github.com/ViaVersion/ViaProxy)、[Claude](https://www.anthropic.com/)。
- 游戏知识模块参考了 [mindcraft](https://github.com/mindcraft-bots/mindcraft)（MIT），详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 本项目以 MIT 许可发布。
