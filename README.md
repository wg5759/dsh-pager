# dsh-pager

**DeepSeek Harness 的"寻呼机"**：一个 33 KB 的安卓 App，加一个 DSH 插件。
人不在电脑前，也能看进度、发指令，并在通知栏里直接批准或拒绝。

> 非官方社区项目，与 DeepSeek 没有关联。· [English](#english)

`MIT` · `Android 10+` · `DeepSeek Harness 0.1.x` · `Node.js 22+` · `dsh-plugin`

---

## 为什么做它

DSH 的 Web 界面是为桌面设计的，直接拿手机打开会遇到三个问题：

1. **界面挤**：侧栏、工具面板占满屏幕，输入框被挤走。
2. **流量大**：打开一个长会话，要先下载几 MB 的原始事件，其中 **89%** 是逐字流式碎片，另外每轮还带着整段系统提示词。
3. **锁屏就失联**：任务跑完、出错、停下来等你批准，都要你自己打开页面才知道。

dsh-pager 分别对应三件事：一套为手机重写的界面，在电脑上先折叠再下发的接口，以及常驻后台的提醒。

## 它是什么

```
手机 · dsh-pager App（33 KB：WebView 外壳 + 常驻通知服务）
   │   你已有的远程通道：VPN（Tailscale / WireGuard …）或带登录的反向代理
   ▼
DSH web（仍只绑 127.0.0.1，不改 DSH 源码）
   └─ 插件 dsh-pager，挂在 /m
        ├─ /m/                 手机界面（约 25 KB，放在电脑上：改完手机下拉刷新即生效）
        ├─ /m/api/boot         工作区 + 会话列表（约 2 KB）
        ├─ /m/api/history      在电脑上折叠后的历史（4 MB 级 → 20–30 KB）
        ├─ /m/api/events       实时帧（流式文字每 90 ms 合并一次）
        ├─ /m/api/notify       后台提醒流（120 秒心跳，断线补发）
        └─ /m/api/rpc|respond  发消息 / 停止 / 换模型 / 审批 / 回答提问（白名单）
```

## 真机实测

实测环境：Redmi（HyperOS / Android 16），经公网链路连回家里电脑（2026-09-21）。

| 项目 | 结果 |
|---|---|
| 安装包 | **33 KB**（3 个 Java 文件，零第三方库） |
| 打开 4 MB 级长会话 | 下发 **28 KB**，1.45 秒 |
| 首页（工作区 + 会话列表） | 2.4 KB |
| 冷启动 | 首帧 195 ms，0.39 秒出列表（本地缓存），0.87 秒刷新到最新 |
| 发消息到出第一段文字 | 1.8 秒，之后逐字流式 |
| 后台提醒 | 息屏状态下 2–30 秒送达；连续 15 分钟心跳，零重连 |

同一套 App 还在华为平板（HarmonyOS 4.2）上跑通了首次配置、地址校验和后台服务。

## 亮点

- **真正的后台提醒**：通知走一条独立的低频流（120 秒一次心跳，比界面用的实时流省电得多），由前台服务托着，开机、App 升级后自动恢复，Wi-Fi 和流量互切时立即重连。
  - 任务完成、出错、Agent 提问、工具审批都会提醒；**审批可以直接在通知栏点"允许"或"拒绝"**，点通知会打开对应会话。
  - 断线期间漏掉的提醒按序号补发（6 小时内）；待处理的审批和提问，每次连上都会重发。
  - 不依赖 Google 推送（FCM），国产系统（HyperOS、HarmonyOS）照样能用。
- **省流量**：插件在电脑上把原始事件折叠成"用户消息 / 回复 / 每个工具一行 / 回合结束"，再压缩下发。
- **界面热更新**：界面跑在电脑上，App 只是外壳。改完界面，手机下拉刷新就生效，不用重装。
- **不增加暴露面**：挂在 DSH 自己的 web 服务上，不开新端口，DSH 仍只绑 127.0.0.1。
  - 接口沿用 DSH 同款信任栅栏（Host / Origin / 跨站检查）。
  - RPC 只放行 9 个方法（新建会话、发消息、停止、查/选模型、改名、搜索、排队、归档），设置、密钥这类接口一个不开。
- **不绑定通道**：走你已经在用的 VPN 或带登录的反代，不内置第三方隧道或中继。流量不经过别人的服务器，国内网络也友好。
- **只用 DSH 公开的线协议**（`POST /api/<方法>`、`/api/events.*`），不依赖 DSH 内部模块，DSH 升级时不容易坏。
- **小而可审计**：
  - 服务端约 1,000 行原生 JS，零 npm 依赖；界面是原生 JS/CSS，无框架。
  - App 820 行 Java、无 Gradle，一条命令即可复现构建。

## 与同类项目对比

数据取自各项目的 README 和最新 Release（截至 2026-09-21）。"未提及"只表示 README 里没找到相关说明，不代表一定没有这个功能。

| 项目 | 形态 | 手机端界面 | 远程通道 | 认证 | 后台提醒 | 安装包 |
|---|---|---|---|---|---|---|
| [dsh-pocket](https://github.com/shaobeichen/dsh-pocket) | 插件 + 改头反代 | 桌面界面原样 | 局域网 + cloudflared 隧道 | 访问密码 | 未提及 | 无 App（浏览器） |
| [dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk) | 在手机本机运行 DSH（内嵌 Termux 运行时） | 响应式 Web 界面 | 不涉及（本机运行） | — | 前台服务保活引擎 | 160 MB |
| [DshMobile](https://github.com/Clarklevis1995/dsh-mobile) | 原生 Android + iOS（KMP）+ 网关插件 | 原生 | 自备 wss 域名 | 扫码配对 | 仅 Agent 回合执行期间前台服务保持连接 | 34.4 MB |
| [DSH Mobile (saya-ch)](https://github.com/saya-ch/dsh-mobile) | 插件 + WebView 薄壳 | 触屏重排的 DSH 界面 | 局域网 / Tailscale Funnel / cpolar / cloudflared / FRP / 自有反代 | 配对 + 证书固定 | 需在 App 菜单中手动开启，依赖 WebView 页面存活（其 README 注明"不是通用的后台推送"） | 1.8 MB |
| [ds-harness-remote](https://github.com/liguobao/ds-harness-remote) | 插件 + 桌面端 / 安卓 / 网页多端 | 复用 Harness 原生界面 | LAN → P2P → TURN → 托管中继（端到端加密） | 账号 + 设备授权 | 未提及 | 72.4 MB |
| [dsh-remote-web-gateway](https://github.com/summer1238/dsh-remote-web-gateway) | 网关插件 | 网页 | Cloudflare Quick Tunnel | GitHub 登录 + 一次性配对 + 设备撤销 | 未提及 | 无 App |
| [DSH Mobile (sorsama)](https://github.com/sorsama/deepseek-harness-mobile) | 原生 Compose App + dsh-relay 插件 | 原生，功能对齐 GUI | 局域网 / relay / 自有反代 | relay 配对 + 固定公钥 | 前台服务：回合完成、目标完成或受阻、审阅或提问等待 | 14.5 MB |
| [dsh-remote-mobile](https://github.com/IceApriler/dsh-remote-mobile) | 安全网关插件 + 移动端样式 | 桌面界面 + 移动端 CSS | 局域网 / Tailscale | 扫码 + RSA + 防爆破 | 未提及 | 无 App |
| **dsh-pager（本项目）** | 插件（挂 /m）+ WebView 外壳 | 为手机重写的界面，服务端先折叠 | 任意现有通道，不内置隧道 | 交给你的 VPN 或网关 | 常驻前台服务 + 专用低频流；通知栏直接允许/拒绝；断线补发 | **33 KB** |

**我们的定位**：不是把桌面界面搬到手机上，而是做一个"寻呼机"。你锁屏时它替你盯着，需要你时叫你，点开就能处理。所以我们优先保证三件事：体积最小、流量最省、后台提醒最可靠。认证和隧道交给你已有的、更专业的工具。

**目前的不足**：
- 不内置认证和隧道。远程访问要你自己准备 VPN，或者带登录页的网关，见 [docs/remote-access.md](docs/remote-access.md)。
- 只有 Android 版。
- 只覆盖 DSH 的常用功能：看会话、发消息（可带图）、停止、切模型、审批、回答提问、待办、排队消息。目标、计划模式、文件浏览、终端还没有。
- 暂时只能连一台电脑（可以在 App 里切换地址）。

## 快速开始

### 1. 在电脑上装插件

要求：DeepSeek Harness 0.1.x（在 0.1.1-rc.2 上验证），Node.js 22 及以上。

```bash
git clone https://github.com/wg5759/dsh-pager.git
```

把 `plugin/` 目录链接进 DSH profile 的 `node_modules`，名字用 `dsh-pager`：

```bat
:: Windows（目录联接，不需要管理员权限）
mklink /J "%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-pager" "C:\path\to\dsh-pager\plugin"
```

```bash
# macOS / Linux
ln -s /path/to/dsh-pager/plugin ~/.dsh/profiles/web/node_modules/dsh-pager
```

在 `~/.dsh/profiles/web/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: mobile
      name: 'dsh-pager'
```

重启 DSH web，然后在电脑浏览器打开 `http://127.0.0.1:3080/m/`，能看到会话列表就说明插件装好了。

想卸载，删掉这几行 patch 再重启即可，DSH 会完全恢复原样；桌面界面 `/` 始终不受影响。

### 2. 让手机能访问到

DSH 本身**没有登录功能**，所以千万别把它直接暴露到公网。常见做法有两种，详见 [docs/remote-access.md](docs/remote-access.md)：

- **VPN**（Tailscale、WireGuard、ZeroTier 等）：手机和电脑连进同一个私有网络，再用自带的 [`tools/forward.mjs`](tools/forward.mjs) 把 DSH 转发到电脑的 VPN 地址上。它会拒绝监听公网地址和通配地址。
- **带登录的网关**：在自己的服务器上放一个带登录页的反向代理（登录页 + Cookie 方式），再通过隧道连回家里电脑。作者自用的就是这种。

如果手机访问时用的地址不是回环地址，要在插件这一行加上 `trustedHosts`：

```yaml
- insert:
    - id: mobile
      name: 'dsh-pager'
      config:
        trustedHosts: ['100.64.0.5:8080']   # 手机访问时用的 host:port
```

### 3. 在手机上装 App

从 [Releases](https://github.com/wg5759/dsh-pager/releases/latest) 下载最新的 `dsh-pager-v<版本>.apk`，下载后请核对 `SHA256SUMS`，也可以按 [docs/android.md](docs/android.md) 自己编译。

首次打开会让你填服务器地址，例如 `https://pc.example.com:8443` 或 `100.64.0.5:8080`，填完即可使用。

要收到后台提醒，还需要两个设置：
- 允许通知；
- 把电池 / 省电策略设为"无限制"。HyperOS 默认的"智能限制"会在息屏后切断后台联网。

以后想换地址，点界面顶部的连接状态，选"切换服务器"。

## 安全须知

- **能在手机上发指令，就等于能让电脑执行命令**（受 DSH 自身审批策略约束）。所以远程通道必须有你信得过的认证：VPN，或带登录的网关。
- dsh-pager 不开新端口，也不改变 DSH 的绑定地址，`/m/api/*` 沿用和 DSH 相同的 Host / Origin / 跨站检查。`trustedHosts` 里写错的条目会让插件在加载时直接报错，而不是悄悄放行。
- App 本地只存服务器地址、网关 Cookie（如果有）和提醒序号；日志只记连接状态和帧类型，不记内容和凭据（`adb logcat -s DSHNotify`）。
- 没有统计、没有第三方 SDK、不依赖 Google 服务；公开版 APK 关闭了 WebView 远程调试（1.2.1 起）。

## 开发

```bash
cd plugin && npm test                 # 插件单测（27 项）
node --test tools/*.test.mjs          # 转发器单测
node plugin/dev.mjs                   # 独立开发服务器 http://127.0.0.1:3090/m/，直连本机 DSH，改服务端代码不用重启 DSH
bash android/build.sh public          # 编译 App（无 Gradle，需 Android SDK build-tools 34 + JDK 17）
```

界面文件（`plugin/www/`）保存后即时生效；`index.js` / `server.js` / `fold.js` / `notify.js` 改动后需要重启 DSH。DSH 的线协议笔记见 [docs/dsh-protocol-notes.md](docs/dsh-protocol-notes.md)。

```
plugin/     DSH 插件：index.js 挂载 · server.js 接口与实时桥 · fold.js 事件折叠 · notify.js 提醒中枢 · www/ 手机界面
android/    App 外壳：MainActivity（WebView + 首次配置）· NotifyService（后台提醒）· BootReceiver · build.sh
tools/      forward.mjs：把 DSH 转发到一个私有地址（VPN 用）
docs/       远程访问 · Android · DSH 协议笔记
```

## 许可与声明

[MIT](LICENSE)。"DeepSeek"及"DeepSeek Harness"是其各自所有者的商标。本项目是独立的社区插件，没有获得 DeepSeek 的认可或背书，也与其没有关联。

---

<a id="english"></a>

## English

**dsh-pager** is a pager for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It has two parts:
- a 33 KB Android app;
- a DSH plugin that serves a phone-first UI and API at `/m` on DSH's own web server.

Together they let you follow sessions, send prompts, and approve or reject tool calls from the notification shade while you are away from your PC. This is an unofficial community project, not affiliated with DeepSeek.

- **Real background alerts.** A dedicated low-traffic notify stream (120 s heartbeat) is held by a foreground service.
  - Alerts cover turn completion, errors, agent questions and tool approvals, with Allow/Deny buttons on the notification.
  - Missed notices are replayed after a reconnect, and pending approvals are re-sent on every reconnect.
  - There is no FCM or Google services dependency.
- **Low traffic.** Raw session history is 89% streaming fragments. The plugin folds it on the PC, so a 4 MB session opens as 28 KB (1.45 s over a public network on a real phone).
- **No new exposure.**
  - DSH keeps binding 127.0.0.1, and no port is opened.
  - `/m/api/*` applies DSH's own Host/Origin fence, plus a 9-method RPC allow-list.
  - Remote access is left to your VPN or authenticating gateway; see [docs/remote-access.md](docs/remote-access.md). DSH has no login, so never expose it publicly without one.
- **Small and auditable.**
  - Zero npm dependencies.
  - About 1,000 lines of server JS and a vanilla JS UI that hot-reloads on the phone.
  - An 820-line Java shell built without Gradle.

Quick start:
1. Link `plugin/` into `~/.dsh/profiles/web/node_modules/dsh-pager`.
2. Add `- insert: [{ id: mobile, name: 'dsh-pager' }]` to `cordis.patch.yml` and restart DSH.
3. Make `/m/` reachable from the phone through a VPN or an authenticating gateway.
4. Install the APK from Releases and enter your server address.

MIT licensed.
