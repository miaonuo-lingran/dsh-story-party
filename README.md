# dsh-story-party

> 作者：**B站：喵诺澪染**　·　许可：MIT　·　开源免费，禁止倒卖
>
> 如果你是**付费购买**的，请立即申请退款并举报卖家——本项目从未授权任何人售卖。

联机 Galgame：**房间 API + 房间独立 LLM 会话 + 广播 + 可直接打开的网页房间**。
阶段 1（服务端）与阶段 2（房间页）已完成；阶段 3（与 galgame 舞台结合）未开始。
v0.2.0 起支持：**剧本杀（角色本 + 私聊 + 阶段机）、海龟汤私有汤底、主代理自动点名子代理**。

```
房间服务（本插件自己的端口，默认 7302）
   ├─ 房间生命周期：建房 / 凭邀请令牌加入 / 职位 / 踢人 / 关闭
   ├─ 共享消息流：用户与 AI 的消息同一条 seq，SSE 广播 + ?since= 增量拉取
   ├─ 私聊：剧本杀里玩家 ↔ GM 的私密消息，第三方与 SSE 都收不到
   ├─ 发言调度：玩家/GM 发言防抖合并成一轮，AI 自己判断接不接话（<silent>）
   ├─ 角色本：每个角色一份 secret，只下发给扮演者与 GM
   ├─ 阶段机：阅读 → 自我介绍 → 搜证 → 讨论 → 投票 → 复盘
   ├─ 房间页：/room/<房号>?t=<邀请令牌>，浏览器直接进
   └─ 房间独立上下文：每个房间一份 system + 消息历史，sessionId = galgame-room:<房号>
```

## 截图

剧本杀角色本（玩家只能看到自己那份）：

![剧本杀角色本](https://raw.githubusercontent.com/miaonuo-lingran/dsh-story-party/main/docs/screenshots/mystery-rolebook.png)

GM 视角：能看全部角色本、指派角色：

![GM 角色本](https://raw.githubusercontent.com/miaonuo-lingran/dsh-story-party/main/docs/screenshots/gm-rolebooks.png)

私聊只发给 GM，第三方看不到：

![私聊](https://raw.githubusercontent.com/miaonuo-lingran/dsh-story-party/main/docs/screenshots/mystery-private.png)

海龟汤汤底只有 GM 能打开：

![汤底](https://raw.githubusercontent.com/miaonuo-lingran/dsh-story-party/main/docs/screenshots/soup-truth.png)

## 安装

**方式一：GitHub（推荐，不用注册 npm）**

DSH 桌面版：**设置 → 插件 → 添加插件**，填仓库地址：

```
https://github.com/miaonuo-lingran/dsh-story-party
```

或到仓库 **Releases** 下载 `dsh-story-party-*.tgz`，在「添加插件」里选本地文件安装。

**方式二：npm（可选，发布后可用）**

```bash
dsh plugin --profile desktop add dsh-story-party
```

**方式三：本地目录**（开发用）

```
path/to/dsh-story-party
```

## 署名与许可

- 作者：**B站：喵诺澪染**
- 许可：MIT —— 可以自由使用、修改、分发，但**必须保留本署名**
- 本项目**开源且免费**，从未授权任何人售卖；付费购买请申请退款并举报卖家
- 署名出现在这些地方：
  - `package.json` 的 `author`、`LICENSE`、README
  - 三个网页的 `<meta name="author">` 与页脚 / 房间水印
  - 所有 HTTP 响应头 `X-Plugin-Author`、`/api/health` 的 `author`
  - 剧情包 `pack.json` 的 `generator` / `brand` 字段

## 目录

```
src/room-server.js   房间核心（零 DSH 依赖，standalone 与插件共用同一份）
src/zip.js           零依赖 zip 读取（stored / deflate，带上限与路径校验）
src/index.js         Host 插件：接 ctx.llm + resolveDshHome + cosplay 角色库
src/standalone.js    不启动 DSH 的直跑入口（mock 模型，用于 curl 自检）
public/room.html     房间页（阶段 2）
public/room.css      房间页样式（开房页 / 房间页 / 制作页共用）
public/room.js       房间页逻辑（SSE + fetch）
public/host.html     开房页（创建 / 加入 + 人设卡 + 剧情包）
public/host.js       开房页逻辑
public/make.html     剧情包制作页
public/make.js       制作页逻辑 + 浏览器端零依赖 zip 打包
client/client.js     DSH 浏览器半侧：「联机模式」标签页（iframe 嵌房间页）
assets/icon.svg      插件图标（插件管理里显示）
scripts/acceptance.ps1   一键验收脚本
scripts/smoke-events.mjs 无浏览器的页面契约冒烟测试
scripts/card-test.mjs    cosplay 人设卡集成测试
scripts/pack-test.mjs    剧情包导入 / 建房 / zip-slip 测试
scripts/mystery-test.mjs 剧本杀：角色本 / 私聊 / 阶段机 / 真相不泄露
scripts/soup-test.mjs    海龟汤私有汤底：导入 / GM 接口 / 揭晓提示词
scripts/check-els.mjs    前端 els 引用检查
scripts/install-dsh.ps1 装进 profile 的脚本（复制式，备份 package.json）
cordis.patch.yml     插件挂载声明 + 默认配置
```

## 直接验收（不重启 DSH）

mock 模型只在「提问 / 叫旁白 / GM 推进」时接话，其余输出 `<silent>`，用来验证选择性发言。

```powershell
cd dsh-story-party
$env:GALGAME_ROOM_PORT = '7302'
node src/standalone.js
```

另开一个窗口跑完整体验：

```powershell
Invoke-Expression (Get-Content -Raw -Encoding UTF8 'dsh-story-party\scripts\acceptance.ps1')
```

> 也可以用 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\acceptance.ps1`。
> 脚本会把 `curl.exe` 的响应先写到文件、再按 UTF-8 读回来解析——Windows PowerShell 5.1
> 在中文系统上默认用 GBK 解码子进程输出，直接 `curl | ConvertFrom-Json` 会把中文 JSON
> 拆成乱码并报 `':' or '}' expected`。

脚本会依次演示：建房 → 玩家加入 → 观众加入 → 带问句的发言（AI 接话）→ 观众发言（不进上下文）
→ 闲聊（AI 沉默）→ 拉历史 → GM 推进（强制开口）→ 增量拉取 → 成员列表 → SSE 实时广播。

## 房间页（阶段 2）

房主先开房：浏览器打开 `http://<本机局域网 IP>:7302/`。首屏是三个选项：

- **创建房间**：填房间名和昵称（GM），点创建时会先弹联网方式提示（可勾「不再提示」）；页内「开放端口」一节可以改本机端口，
  点「开放」后服务切到新端口、页面自动跟过去；下面是朋友可用的局域网地址；
- **加入房间**：把房主发来的邀请链接粘进去，直接进对方的房间（跨机器也行）；
- **自我游玩**：单人房间，只有你和 AI；可选 cosplay 卡或剧情包（面板里也能直接导入 `.zip`），不展示邀请链接和参与者，别人 `join` 会被拒（403）。

建房后会自动以 **GM** 身份进入房间页；把「复制邀请链接」得到的地址发给朋友即可。

```
http://<这台电脑的局域网 IP>:7302/room/<房号>?t=<邀请令牌>
```

- 进入先填昵称、选「玩家 / 观众」；成员令牌存浏览器 `localStorage`，刷新不用重进；
- 消息流：昵称 + 职位徽章 + 时间；AI 的旁白用衬线字和左侧竖线区分；
- 观众发言带「不进剧情」标记，永远不触发模型；
- 右侧参与者列表：在线状态、职位；房主可以改职位、踢人；
- 房主控制条：「推进剧情」跳过防抖强制 AI 开口；「关闭房间」结束这一局；
- 「复制邀请链接」按当前地址拼链接——**想给朋友用，就先用自己的局域网 IP 打开页面**，
  否则复制到的是 `127.0.0.1`；开房页会列出本机全部局域网地址。

两个窗口测：同一浏览器开两个窗口，一个用邀请链接以「玩家」进，另一个开无痕窗口
以「观众」进，互相发一句，就能同时看到对方和旁白的消息。

无浏览器冒烟测试（验证页面依赖的接口与 SSE 字段）：

```powershell
node scripts/smoke-events.mjs
```

## 接 cosplay 人设卡

开房页的「人设卡」下拉会自动列出 cosplay 插件里的角色库，选中后：

- AI 在这个房间里扮演这张卡（消息署名、旁白口吻都跟着卡走）
- 卡的 `description / personality / system_prompt / rules / behavior / mes_example` 进 system prompt
- 卡的 `scenario` 作为房间的世界观与开场设定（自己填了则以自己填的为准）
- 卡的 `first_mes` 作为开场白，建房后直接出现在消息流里

数据来源：`$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里 `cosplay-core` 的
`config.roles`，用 `js-yaml` 读取（跟随 profile 的依赖），结果缓存 15 秒——
在 cosplay 里改完卡，稍等十几秒再建房就是新的。

注意：读取角色库是**宿主侧**代码，装/改完要**重载插件（开关关→开）**才生效，
只刷新页面不够。

无浏览器验证（注入一张假卡，验证建房、开场白、system prompt）：

```powershell
node scripts/card-test.mjs
```

## 剧情包（.zip）

发布者把「世界观 + 人物卡 + 背景素材」打成一个 zip，别人导入就能直接开房，类似 MC 整合包。

### 格式

```
story-pack.zip
├─ pack.json
├─ scenario.md
├─ characters/1.json
└─ assets/...（可选）
```

`pack.json`：

```json
{
  "format": "dsh-galgame-pack",
  "formatVersion": 1,
  "name": "老式公寓的夏天",
  "version": "1.0.0",
  "author": "xxx",
  "description": "一句话简介",
  "mode": "roleplay",
  "scenario": "scenario.md",
  "truth": "汤底 / 完整真相（只有 GM 与 AI 能看到）",
  "characters": ["characters/1.json"],
  "assets": ["assets/bg.png"]
}
```

人物卡兼容酒馆 v2 字段：`name / emoji / description / personality / scenario / first_mes / mes_example / system_prompt / rules / behavior`。
另外支持：

- `secret`：**角色本 / 秘密**，只发给扮演该角色的玩家与 GM；不会出现在公开消息、房间公开信息或剧情包详情里
- `playerBrief`：玩家须知，领取角色后可见
- `playedBy`：`ai` / `human` / `either`；剧本杀里人类角色由玩家领取，AI 角色进子代理名册
- `likes` / `favoritePlaces` / `relations`：喜爱、常去地点、人物关系

建房时：包里的 `scenario` 当世界观，选中人物的卡当人设，`first_mes` 当开场白。
`truth` 只存在房主主机的房间 JSON 与系统提示词里；列表 / 详情 / 房间公开接口只返回 `hasTruth`。

### 制作

浏览器打开 `http://<本机>:7302/make`：填包名、世界观、人物卡，可选几张背景图，
然后「下载 .zip」或「装进本机」。打包在浏览器端完成（stored zip、零依赖）；
装进本机后回开房页，在「角色」下拉里就能选。

### 导入

开房页「剧情包」一栏选 `.zip` → 点「导入 .zip」，之后「角色」下拉会出现
「剧情包 · xxx（n 人）」分组。

### 边界

- 只读数据，不执行任何东西；
- 上传 ≤ 8MB、解压后 ≤ 24MB、条目 ≤ 200、单条 ≤ 6MB（防 zip 炸弹）；
- 拒绝加密条目、`../` 与绝对路径（zip-slip）；
- 素材落到 `$DSH_HOME/galgame-room/packs/<id>/assets/`，阶段 3 舞台用。
- 人物头像：制作页每个角色可上传本地图片，自动缩成 128×128 JPEG 存进人物卡 `avatar`；
  导入后 AI 消息的头像用它，房主建房时就能看到。手写包也可以让 `avatar` 填 `assets/xxx.png`
- 包类型：角色扮演 / 海龟汤 / 剧本杀 / 其他；制作页选好写进 `pack.json` 的 `mode`，建房后按类型给系统提示词追加规则（海龟汤只答是/不是/无关，剧本杀按阶段推进）
- 海龟汤揭晓要**全员投票**：GM 点「发起揭晓投票」，所有人同意后才让 AI 揭底；观众也算一票
- 地图：制作页「地图」区，地点按东南西北（含四角/中心）摆放，可写描述；地点之间可加关系（如「步行 10 分钟」）。**支持层级**：双击地点进入下一级（省 → 市 → 住处），面包屑返回；**右键节点**可「添加子地点 / 把选中的地点挂到这里（设为父级）/ 上移一级 / 移到顶层 / 按方位重置 / 删除」；节点可以**拖动摆位**，位置随包保存（`pos`）；打包进 `map.locations`（带 `parent`）/ `map.routes`，房间系统提示带【地图】路径
- 人物喜好：每人可写「喜爱」，并从地图地点里多选「常去地点」；子代理提示里会带「喜爱 / 常去」
- 人物性别：制作页可选 女 / 男 / 其他，写进人物卡 `gender`；拼提示词时会写成「扮演『小柚』（女）」，模型不会把性别写反
- 草稿：制作页自动存进浏览器 localStorage（800ms 防抖），下次打开自动恢复；素材文件不保存、需要重选；顶部有「保存草稿 / 清除草稿」
- 建议人数：包级 `recommendedPlayers {min,max}`，开房页分组标题会显示（如「建议 2-4 人」）；勾「单人本」直接写成 `{1,1}`
- 扮演方式：每个人物可标 `ai` / `human` / `either`；人类扮演可填「玩家须知」（`playerBrief`），入包保存
- 开场说明：制作页可选填一段固定文案，建房后作为**第一条消息**，人物开场白和剧情排在它后面
- 人物关系图：`/make` 里的可视化编辑——拖动人物摆位置，从人物右侧「+」拉线到另一个人物，在弹出框里写关系（可勾「双向」）；打包时按出边 / 双向边写进人物卡 `relations`，房间的【人物关系】段落会喂给模型

## 房间密码（可选）

建房时可以设一个密码，进房的人必须输对才能进：

- 密码**只存 scrypt 哈希**（salt + hash），房间 JSON 里没有明文
- 公开信息只暴露 `hasPassword`，不返回任何哈希
- 密码**不进邀请链接**，单独告诉朋友即可
- GM 可以随时改或清空：`PATCH /api/rooms/:id  {"password":"新密码"}`，传空串 = 取消密码

## 头像与玩家身份

- 房间右上角「头像」→ 选本地图片；前端缩到 128×128 JPEG 再上传（PNG/JPEG/WebP）
- 头像存在房间存档的成员资料里，**所有人**在消息流和参与者列表都能看到
- 每个成员有 `uid`（`u_` + 10 位十六进制），进房时生成
- 同时带一个**机器码**（浏览器指纹哈希，存 localStorage）：同一台机器再次进同一间房，
  会沿用原来的 uid 和头像；`identities.json` 记这层绑定
- 注意：机器码只是「认回身份」的便利，不是安全边界；清站点数据 / 换浏览器就是新身份
## 记录 AI 思维链（调试，默认关）

开房页的「记录 AI 思维链」勾选框，由房主控制：

- 开启时：模型**不再强制 `reasoning=off`**，思维链留在房间 JSON 的 `debug` 字段（最近 20 条）
- 只存在房主本机：**不进 messages / 房间公开信息 / SSE**，玩家拿不到
- 会多花 token（reasoning 也计费），只在排查「为什么沉默 / 为什么接话」时开
- 通过 `GET/POST /api/settings {"saveReasoning": true}` 控制，选择存 `settings.json`

## 子代理（剧情包多角色）

剧情包里除主角外的 **AI 角色**会自动进房间名册（`room.agents`），每个角色一个子代理：

- 名册写进系统提示：【你的子代理】列出每个角色、是否在场，并明确「不要替她写台词」
- GM 控制条的「让子代理说话」→ `POST /api/rooms/:id/speak`
- 调用流程：**子代理只读自己的文档 + 摘要 + 上次之后的新消息**，输出意图要点 → **主代理**把它写成最终消息，署名该子代理
- 每个子代理还记自己的**位置 `location`** 和**接下来的打算 `plan`**：子代理输出一行 JSON（`line` / `location` / `plan`），主代理在名册里能看到「她在哪、打算去哪」，用来决定该唤起谁
- 位置和打算只存在子代理状态里（存档可查），不进公共消息流；主代理是上帝视角，名册里能看到全部代理的位置\n- 子代理的思考与思维链都不进消息流、不共享；人类扮演的角色不进名册

### 主代理自动点名子代理

剧情包里的 AI 角色除了 GM 手动「让她接话」，主代理也可以自己点名：

- 系统提示词会告诉主代理：需要子代理开口时，在回复最后单独一行写 `<speak 角色名>`
- 服务端把标记从正文里剥掉（玩家看不到），解析到角色名后自动走一轮
  「子代理出意图 → 主代理定稿」，消息署名该子代理
- 每轮最多自动点名一次，避免模型互相点名形成循环
- 角色名可以写子代理的名字或 id；写错/找不到就只剥掉标记，不会报错
- GM 手动点名的 `/speak` 仍然可用

## 剧本杀：角色本 / 私聊 / 阶段机

剧情包 `mode = "mystery"` 时，建房会自动进入剧本杀模式：

- **角色本**：人物卡的 `secret` 只下发给扮演者与 GM；玩家领取角色后点右上角「角色本」查看。
  一个成员同时只能持有一个角色；GM 可以在「角色本」弹窗里指派 / 释放，观众不能领取。
- **私聊**：输入框左边的目标下拉框，玩家只能私聊 GM，GM 可以私聊任意成员。
  私聊消息只有发送者、接收者与 GM 能看到：历史接口按身份过滤，SSE 只推给相关连接；
  私聊**不进 AI 上下文**，不会被剧情复述。
- **阶段机**：阅读 → 自我介绍 → 搜证 → 讨论 → 投票 → 复盘。房间页顶部显示当前阶段，
  GM 点「下一阶段」推进；每次切换会发一条系统消息，并让 AI 用一句话交代阶段目标。
  复盘阶段会把包里的 `truth`（完整真相）拼进系统提示词，但公开接口仍然不返回它。
- 如果建房时选中的人类角色只是玩家位，AI 不会把这个角色变成自己的化身，而是当 GM / 旁白；
  选中的是 AI 角色时，AI 仍然扮演它。

相关接口：

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/rooms/:id/roles` | 成员 | 角色名单 + 自己的角色本（GM 看全部） |
| POST | `/api/rooms/:id/roles` | 成员 / GM | `claim` 领取 / `assign` 指派 / `release` 释放 |
| POST | `/api/rooms/:id/phase` | GM | `next` 下一阶段 / `set` 指定阶段（`narrate:false` 不触发 AI） |
| GET | `/api/rooms/:id/truth` | GM | 读取汤底 / 真相正文 |
| POST | `/api/rooms/:id/messages` | 成员 | 带 `to: <成员id>` 时发私聊 |

## 海龟汤私有汤底

制作页的「汤底 / 真相」一栏会写进 `pack.json` 的 `truth`（也可以放 `truth.md`）：

- AI 在系统提示词里能看到汤底，所以「是 / 不是 / 无关」答得准；
- 但公开列表、详情、房间公开信息都只返回 `hasTruth`，玩家读不到正文；
- 房主 / GM 在房间侧栏点「查看汤底 / 真相」才看得到；
- 全员「揭晓投票」通过后，提示词会带上汤底原文，并要求 AI 按原文完整揭晓；
- 揭晓之后公开接口仍然不返回汤底，避免玩家翻接口作弊。


## 长局自动摘要

开房页的「长局自动摘要」默认开启：每攒够 `max(20, 读取条数)` 条未摘要的消息，就让模型压成一段 300 字以内的摘要，存在房间的 `summary` 字段里。之后发给模型的是「摘要 + 最近 N 条」，比每次重发全量便宜，也不会丢早期剧情。房主可以关掉它。

## 继续上次没玩完的局

房间数据一直在房主机器上（`$DSH_HOME/galgame-room/rooms/`），DSH 重启也不丢；
AI 的上下文会从最近 `contextMessages` 条消息重建。

开房页「继续上次没玩完的局」会列出本机开过的房间：

- 房间名 / 房号 / 消息数 / 人数 / 是否已关闭
- 点「继续」= 用本机保存的邀请链接回到原房间（GM 身份还在）
- 已关闭的房间可以「重新开放」（需要在本浏览器开过这间房，GM 令牌存在 localStorage）
- 每行右侧「编辑」= 改房间名 + 整机的端口 / 公网地址（端口改完页面会跳到新地址）；「删除」= **永久删除**（房间 JSON 和消息一起清掉，不能恢复）
- 删除/关闭/踢人用的是页面内确认框（`public/dialog.js`），不再弹 Electron 原生 confirm

玩家那边不用做任何事：本地副本先显示，再和房主对齐。

## 连接到房主的房间（版本一致）

「联机模式」标签页默认显示**本机**房间（自己开房）。要进别人的房间：

1. 房主在房间里点「复制邀请链接」发给你（弹窗里可以选公网 / 局域网 / 本机）
2. 你在页面里切到「加入房间」，粘贴链接 → 点「进入房间」
3. 如果这页是从 DSH 标签页打开的（地址带 `?v=本机版本`），加入前会先请求对方
   `GET /api/version`，**版本必须与本机一致**；不一致直接提示，不会跳转
4. 加入后你看到的消息、参与者、剧情包全部来自**房主的主机**，
   你这边只是显示；身份存在对方主机那一侧的浏览器存储里

标签页顶部只保留：本机插件版本 + 「回本机」（加入房间不再重复做一份）。

### 会话绑定与本地副本

- 从「联机模式」标签页建房时，地址里的 `?sid=` 会把**当前 DSH 会话 id** 记进房间
  （`room.sessionId`，宿主侧可见）
- 玩家端会在浏览器里留一份本地副本（`localStorage`，最近 200 条消息 + 会话 id + seq）
- 打开房间时先用本地副本渲染，再和房主对齐：
  - 会话 id 一致 → 直接补增量
  - 会话 id 不同 → 提示「房主换了会话」，**用房主整份覆盖本地副本**
- 房主随时可以「关闭房间」；关闭后玩家再打开会看到「房间已关闭」

版本门禁两种力度：

- **客户端校验（默认）**：标签页里连接时才比对；朋友直接用浏览器开链接不受限
- **服务端强制**：`cordis.patch.yml` 里 `strictVersion: true`，进房必须携带
  `clientVersion` 且与房主一致，浏览器直连会被拒（409）

这个比对只挡「版本不一致导致的接口差异」，不是安全边界。

### 走公网（樱花 frp）

1. 樱花控制台建隧道，本地地址填 `127.0.0.1:7302`：
   - **HTTP(S) 隧道**（推荐）：拿 `https://xxx.sakurafrp.com` 域名，自动 HTTPS
   - **TCP 隧道**：拿 `frp-boy.com:56804` 这种「域名:端口」，没有 https
2. 开房页的「公网地址」填进去，点保存（存 `$DSH_HOME/galgame-room/publicUrl.json`，
   立即生效，不用重载插件）；也可以写在插件配置 `publicUrl` 里
3. 房主正常开房，点「复制邀请链接」就会优先用公网地址
4. 朋友打开链接即可；TLS 在樱花那一层终止，本地仍是 http

**地址稳定性**：隧道「停止→启动」通常保留原端口；**删除再新建**会重新分配（TCP 的
自动端口会变）。地址变了就回到开房页改「公网地址」，旧邀请链接随之作废、重新复制一份。

## API

鉴权统一走 `Authorization: Bearer <令牌>` 或 `?t=<令牌>`：

- **邀请令牌**：建房时返回，用来加入房间、读房间与历史；
- **成员令牌**：加入时返回，用来发言、推进、管理，身份与 DSH 账号解耦。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/` | 无 | 开房页（创建 / 加入 两种模式） |
| GET | `/api/health` | 无 | 存活检查 |
| GET | `/api/version` | 无 | 插件版本 + 协议版本 + 是否强制版本校验 |
| GET / POST | `/api/settings` | 无 | 房主侧调试开关（`saveReasoning`） |
| POST | `/api/public-url` | 无 | 运行时改公网地址（存 `publicUrl.json`） |
| GET | `/api/network` | 无 | 本机局域网地址（开房页展示用） |
| GET | `/api/cards` | 无 | cosplay 角色库（开房页人设卡下拉） |
| GET | `/api/packs` | 无 | 已导入的剧情包列表 |
| POST | `/api/packs` | 无 | 上传剧情包（body = zip 原始字节） |
| GET | `/api/packs/:id` | 无 | 剧情包详情（不含 `truth` / `secret` / `playerBrief`） |
| DELETE | `/api/packs/:id` | 无 | 删除剧情包 |
| GET | `/make` | 无 | 剧情包制作页 |
| POST | `/api/port` | 无 | 开放 / 切换本机端口（`{port}`，失败保持原端口） |
| GET | `/room/:id` | 无 | 房间页（页面内再要邀请令牌） |
| GET | `/room-assets/room.css` \| `room.js` \| `host.js` | 无 | 页面样式与脚本 |
| POST | `/api/rooms` | 无 | 建房，返回房号 / 邀请令牌 / GM 令牌 |
| GET | `/api/rooms` | 无 | 房间列表（不含令牌与消息） |
| GET | `/api/rooms/:id` | 邀请或成员 | 房间公开信息 |
| PATCH | `/api/rooms/:id` | GM | 改标题 / 世界观设定 |
| DELETE | `/api/rooms/:id` | GM | 关闭房间 |
| POST | `/api/rooms/:id/join` | 邀请 | 加入（`role` = `player` / `spectator`） |
| GET | `/api/rooms/:id/members` | 邀请或成员 | 成员列表 |
| PATCH | `/api/rooms/:id/members/:mid` | GM | 改职位（`player` / `spectator`） |
| DELETE | `/api/rooms/:id/members/:mid` | GM | 踢人 |
| POST | `/api/rooms/:id/messages` | 成员 | 发言；带 `to: <成员id>` = 私聊（观众只进消息流、不进 AI 上下文） |
| GET | `/api/rooms/:id/messages?since=0` | 邀请或成员 | 增量拉取历史（私聊按身份过滤） |
| POST | `/api/rooms/:id/advance` | GM | 强制 AI 推进一轮 |
| POST | `/api/rooms/:id/speak` | GM | 点名子代理接话（`{agentId}`） |
| GET | `/api/rooms/:id/roles` | 成员 | 角色名单 + 自己的角色本（GM 看全部） |
| POST | `/api/rooms/:id/roles` | 成员/GM | `claim` / `assign` / `release` |
| POST | `/api/rooms/:id/phase` | GM | 剧本杀阶段机：`next` / `set` |
| GET | `/api/rooms/:id/truth` | GM | 汤底 / 真相正文 |
| POST | `/api/rooms/:id/avatar` | 成员 | 上传自己的头像（内联图片 data URL） |
| POST | `/api/rooms/:id/vote` | 成员/GM | 投票：`start` / `cast` / `cancel`（全员同意才通过） |
| POST | `/api/rooms/:id/purge` | GM 或本机 | 永久删除房间（关闭只是打标记） |
| POST | `/api/rooms/:id/leave` | 成员 | 主动离开 |
| GET | `/api/rooms/:id/events?since=0` | 邀请或成员 | SSE：snapshot / message / members / ai / system / vote / room / phase / roles |

### 最小 curl 流程

```powershell
$base = 'http://127.0.0.1:7302'

# 1. 建房（房主即 GM）
curl.exe -s -X POST "$base/api/rooms" -H 'content-type: application/json' -d '{"title":"天台上的黄昏","gmName":"澪"}'
# → 201 { room, inviteToken, gm:{memberId,token}, joinPath }

# 2. 玩家加入（把上一步的 inviteToken 填进来）
curl.exe -s -X POST "$base/api/rooms/<房号>/join" -H 'content-type: application/json' -d '{"name":"小满","inviteToken":"<邀请令牌>"}'
# → 200 { memberId, token, role, room }

# 3. 发言（用第 2 步拿到的 token）
curl.exe -s -X POST "$base/api/rooms/<房号>/messages" -H "authorization: Bearer <成员令牌>" -H 'content-type: application/json' -d '{"text":"门后面好像有脚步声，要不要进去看看？"}'
# → 202 { message, seq }；约 debounceMs 后 AI 会自己判断接不接话

# 4. 拉历史（新客户端进房）
curl.exe -s "$base/api/rooms/<房号>/messages?since=0&t=<邀请令牌>"

# 5. GM 推进（强制 AI 开口）
curl.exe -s -X POST "$base/api/rooms/<房号>/advance" -H "authorization: Bearer <GM令牌>"

# 6. 实时广播（另开一个窗口，边发边看）
curl.exe -N "$base/api/rooms/<房号>/events?t=<邀请令牌>"
```

## 选择性发言怎么定的

1. 玩家 / GM 的发言进队列，观众不触发模型；
2. `debounceMs`（默认 1200ms）内的发言合并成一轮，避免一句一回；
3. 一轮交给模型时，system 里写明「闲聊就只输出 `<silent>`，剧情需要推进才回应」；
4. 模型输出 `<silent>`（或空）→ 不产生消息，但这批发言标记为已读，不会反复重发；
5. GM 调用 `/advance` → 跳过防抖、强制要求「立即推进剧情」。

## DSH 标签页「联机模式」

浏览器半侧（`client/client.js`）在会话视图里注册了第四个标签：

- `conversation.view`，`id: galgame-room`，`order: 30` → 排在「对话 / 轨迹 / galgame 模式」最右边
- 内容是一个全高 iframe，地址由宿主路由 `/api/galgame-room/config` 返回的端口决定
- 标签内部就是开房页 / 房间页，身份与 SSE 都在房间服务这一侧，不碰 DSH 会话

注意：

- **client 半侧只在 DSH 启动时加载**，装完或改完要重启 DSH 才会出现；
- 换端口后标签页会读新端口（配置路由），但已经渲染的 iframe 要刷新页面才跟过去；
- 房间服务没监听时标签页是空白，先用 `curl http://127.0.0.1:7302/api/health` 确认。

## 装进 DSH

```powershell
# 会先备份 profile/package.json，再复制插件并登记到 bundles
powershell -NoProfile -ExecutionPolicy Bypass -File 'dsh-story-party\scripts\install-dsh.ps1'
```

然后**重启 DeepSeek Harness**。启动日志里应出现：

```
[galgame-room] 房间服务已监听 0.0.0.0:7302，入口 POST /api/rooms
```

首次监听如果弹出 Windows 防火墙，请勾选「专用网络」允许，朋友才能连进来。
局域网地址形如 `http://192.168.x.x:7302`。

### 打包（.tgz 本地导入包）

```powershell
cd dsh-story-party
$env:npm_config_cache = 'dsh-story-party\.npm-cache'   # 可选：避免写系统 npm 缓存
npm pack --pack-destination .
```

产物：`.\dsh-story-party-0.2.0.tgz`，共 41 个文件
（`src/`、`public/`、`assets/`、`scripts/`、`cordis.patch.yml`、`README.md`、`package.json`）。

包内已声明：

- `dsh.bundle.patch = ./cordis.patch.yml`（插件管理器据此识别为可挂载的 bundle）
- `engines.dsh = ">=0.2.1-rc.2 <0.3.0"`（版本兼容以它为准，不再比 peer 范围）
- `dsh.compatibility.dshReleases`（市场兼容表）

导入方式二选一：

1. **插件管理 → 安装插件**，在安装框里填本地包路径
   `.\dsh-story-party-0.2.0.tgz`（插件管理器支持 registry / path / git / tarball
   四类来源），装完重启 DSH；
2. **命令行**（插件管理器不可用时）：

   ```powershell
   cd $env:USERPROFILE\.dsh\profiles\desktop
   pnpm add file:F:/超分/.dshplugin/dsh-story-party-0.2.0.tgz
   ```

   然后把 `dsh-story-party` 加进 `package.json` 的 `dsh.profile.bundles`，重启 DSH。

> 也可以用不联网的复制式安装：`scripts/install-dsh.ps1`（直接复制到 profile 的
> `node_modules` 并登记 bundles）。

### 配置项（`cordis.patch.yml` 的 `config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | 7302 | 房间服务端口（7301 在本机被系统保留，故用 7302）；开房页「开放端口」改过的值会存进 `$DSH_HOME/galgame-room/port.json`，优先级高于这里 |
| `hostname` | `0.0.0.0` | 监听地址；只给本机用可改 `127.0.0.1` |
| `publicUrl` | 空 | 公网地址；开房页里保存的值（`publicUrl.json`）优先于这里，留空则用页面当前 origin |
| `maxPlayers` | 4 | GM + 玩家 的座位数（观众另算） |
| `debounceMs` | 1200 | 发言合并窗口 |
| `contextMessages` | 30 | 交给模型的历史消息条数（滑动窗口）；`0` = 全部历史（每轮重发，费 token）；建房时可单独覆盖 |
| `aiName` | 旁白 | AI 在消息流里的名字 |
| `strictVersion` | false | true = 进房必须带 `clientVersion` 且与房主插件版本一致（浏览器直连会被拒） |
| `provider` / `model` | 空 | 留空跟随当前对话模型；填了优先用 |

## 测试清单（不需要浏览器）

```powershell
cd dsh-story-party

# 纯前端 / 契约
node scripts/check-els.mjs
node scripts/client-sim.mjs

# 服务端（各自起临时端口，跑完自动清理）
$env:CARD_TEST_PORT=7341;      node scripts/card-test.mjs
$env:PACK_TEST_PORT=7342;      node scripts/pack-test.mjs
$env:VERSION_TEST_PORT=7343;   node scripts/version-test.mjs
$env:PASSWORD_TEST_PORT=7344;  node scripts/password-test.mjs
$env:AVATAR_TEST_PORT=7345;    node scripts/avatar-test.mjs
$env:VOTE_TEST_PORT=7347;      node scripts/vote-test.mjs
$env:AGENTS_TEST_PORT=7348;    node scripts/agents-test.mjs
$env:CONTEXT_TEST_PORT=7349;   node scripts/context-test.mjs
$env:SUMMARY_TEST_PORT=7350;   node scripts/summary-test.mjs
$env:REASONING_TEST_PORT=7351; node scripts/reasoning-test.mjs
$env:MYSTERY_TEST_PORT=7372;   node scripts/mystery-test.mjs
$env:SOUP_TEST_PORT=7374;      node scripts/soup-test.mjs
$env:HOSTSIM_PORT=7360;        node scripts/host-sim.mjs
```

`smoke-events.mjs` 需要先起 standalone：

```powershell
$env:GALGAME_ROOM_PORT=7340
$env:GALGAME_ROOM_DATA='.smoketest\rooms'
node src/standalone.js
# 另开一个窗口：
$env:GALGAME_ROOM_BASE='http://127.0.0.1:7340'; node scripts/smoke-events.mjs
```

真模型链路（对着已装进 DSH 的插件，默认 7302）：

```powershell
$env:GALGAME_ROOM_BASE='http://127.0.0.1:7302'; node scripts/live-check.mjs
```

## 已知限制

- standalone 的模型是 **mock**，只用于 API 自检；真实模型要装进 DSH 后走 `ctx.llm`；
- 房间在内存里，落盘是每房一个 JSON；进程重启后房间会从文件恢复，SSE 客户端需重连；
- 没有 TLS、没有限流之外的防护，当前只适合局域网；公网方案（frp / 反代）在阶段 3；
- 观众能看到全部消息，但发言不进 AI 上下文——这是「观众位永不触发 LLM」的落点；
- 消息限流按 IP：默认 10 条/秒，超出返回 429；
- 房间页一次渲染全部历史，几百条以内没问题，再长要做虚拟滚动；
- 同一局域网里谁都能打开 `/` 自己建房；公网上线前要先加访问控制（阶段 3）；
- 私聊的 UI 只在剧本杀模式出现；服务端本身支持任意房间发 `to`，但其他模式默认不显示目标下拉框；
- 角色本、汤底 / 真相在房主主机的房间 JSON 里是明文（只存在本机），不是端到端加密；
- 剧本杀阶段机目前是 GM 手动推进，没有计时器、自动搜证或玩家投票锁；
- 插件市场提交尚未完成（npm 包与 GitHub 仓库已就绪）。

## 阶段 3 预留

- 与 galgame 舞台结合：立绘 / 对话框复用，房间只做同步；
- 选项投票与舞台跟随（一方选、另一方看到同一段演出）；
- `room.scenario` 就是舞台要渲染的开场设定，将来可从 cosplay 角色卡导入。
