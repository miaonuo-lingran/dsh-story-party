# 插件市场提交材料

> 目标市场：<https://dsh-plugin.org/zh/submit>
> 仓库：<https://github.com/miaonuo-lingran/dsh-story-party>
> 当前版本：`dsh-story-party@0.2.0`

## 状态（2026-10-22）

- GitHub topic `dsh-plugin` 已存在（当前 topics：`ai-story, deepseek-harness, dsh-plugin, dsh-plugins, galgame, multiplayer`）
- **尚未正式提交**：2026-10-22 曾误创建 issue #381，已按作者要求关闭；等作者确认后再重新提交
- npm 上最新仍是 `0.1.48`；`0.2.0` 的 `.npmrc` token 校验返回 401，更新 token 后执行 `npm publish` 即可

## 提交前检查

- [x] 仓库公开
- [x] 仓库 Topics 添加 `dsh-plugin`（需要仓库管理员在 GitHub 网页操作）
- [x] README 包含安装命令
- [x] 插件导出 `apply(ctx)`
- [x] 仓库根目录有 `package.json`
- [x] 已发布 npm 包（`dsh-story-party@0.1.48`，0.2.0 待发布）
- [x] 截图在 `docs/screenshots/`

## 提交 Issue 正文（复制到 GitHub）

标题：

```text
[插件提交] miaonuo-lingran/dsh-story-party — DSH 里的多人联机 Galgame / 海龟汤 / 剧本杀房间
```

正文：

```markdown
### 仓库地址
<https://github.com/miaonuo-lingran/dsh-story-party>

### 一句话价值
在 DeepSeek Harness 里开一个多人共享的 AI 故事房间：所有人看到同一段剧情，玩家/GM/观众各司其职，支持剧情包、海龟汤、剧本杀角色本与私聊。

### 能力分类
娱乐

### 安装命令
dsh plugin --profile desktop add dsh-story-party

（profile 名以本机为准；桌面版默认是 desktop。也可以从 GitHub Releases 下载 .tgz，在「插件管理 → 安装插件」里选本地文件。）

### 兼容与运行要求
- DSH：>= 0.2.1-rc.2 < 0.3.0（`engines.dsh`）
- Node.js：>= 22
- 平台：Windows / macOS / Linux（房间页是普通浏览器页面）
- 默认房间端口：7302（可在插件配置或开房页修改）
- 无外部服务依赖；公网联机需要自己准备 frp / 反代

### 许可证
MIT（代码）；内置鲸鱼娘立绘为 CC BY-NC-SA 4.0（非商业，署名链见 NOTICE / LICENSE-ARTWORK）

### 截图 / 演示
- 剧本杀角色本（玩家只能看自己那份）：
  https://raw.githubusercontent.com/miaonuo-lingran/dsh-story-party/main/docs/screenshots/mystery-rolebook.png
- GM 视角：全部角色本 + 指派：
  https://raw.githubusercontent.com/miaonuo-lingran/dsh-story-party/main/docs/screenshots/gm-rolebooks.png
- 私聊只发给 GM：
  https://raw.githubusercontent.com/miaonuo-lingran/dsh-story-party/main/docs/screenshots/mystery-private.png
- 海龟汤私有汤底：
  https://raw.githubusercontent.com/miaonuo-lingran/dsh-story-party/main/docs/screenshots/soup-truth.png

### 补充说明
- 房间身份与 DSH 账号解耦：进房用「昵称 + 邀请令牌」，成员令牌存浏览器 localStorage。
- 数据全部落在房主本机 `$DSH_HOME/galgame-room/`；AI 使用房间独立会话 `galgame-room:<房号>`，不碰主会话。
- 权限：无文件系统 / shell / 网络外联权限；只监听配置的端口，提供房间页与房间 API。
- 已知限制：没有 TLS；公网前需要 frp/反代；同一局域网能打开 `/` 的人可以自己建房。
- 作者：B站：喵诺澪染；开源免费，禁止倒卖。

### 提交前自查
- [x] 仓库已公开
- [ ] 已添加 GitHub topic：dsh-plugin
- [x] README 包含安装命令
- [x] 插件导出 apply(ctx) 模块
- [x] 仓库根目录包含 package.json
```

## 还需要手动做的两件事

1. 在 GitHub 仓库页面 → About 右侧齿轮 → Topics 添加 `dsh-plugin`。
2. 打开 <https://github.com/dshplugin/dsh-plugin-hub/issues/new>，把上面的标题和正文粘进去提交。

市场扫描只看公开仓库 + topic + README + `package.json`；npm 包已存在，条目会自动生成，之后定期刷新。
