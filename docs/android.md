# Android App

App 本身只是一个 WebView 外壳（界面由电脑上的插件提供），外加一个常驻的通知服务。支持 Android 10 及以上（minSdk 29）。

实机验证过的系统：
- Redmi，HyperOS / Android 16；
- 华为平板，HarmonyOS 4.2（Android 12 兼容层）。

## 安装与首次配置

1. 从 Releases 下载 `dsh-pager-v<版本>.apk`，用 `SHA256SUMS` 核对：

   ```bash
   sha256sum -c SHA256SUMS
   ```

2. 安装时系统可能要求"允许安装未知来源应用"。
   小米 / HyperOS 通过 USB（`adb install`）安装时，手机上会弹出一个 8 秒倒计时的确认框，**默认是拒绝**，要手动点"继续安装"。也可以把 APK 拷到手机上，用文件管理器安装。
3. 首次打开会让你填服务器地址：
   - `https://pc.example.com:8443`：带登录的网关；
   - `100.64.0.5:8080`：异地组网（与翻墙无关）；
   - `192.168.1.20:8080`：局域网。

   规则：
   - 只保留协议、主机和端口，填了路径会被忽略。插件必须挂在这个地址的 `/m/` 下。
   - 不写协议时，私有地址（`localhost`、`127.*`、`10.*`、`172.16–31.*`、`192.168.*`、`100.*`、`*.local`）默认用 `http://`，其余默认用 `https://`。
   - 只接受 `http` 和 `https`。填 `ftp://`、带用户名（`user@host`）、带空格或主机名不合法的地址，都会原样退回并提示错误。
   - 在公网地址上用 `http://` 会给出警告：明文只适合异地组网或局域网。
4. 以后要换地址：
   - 点界面顶部的连接状态，选"切换服务器"；
   - 或者在"连不上"页面点"更换服务器地址"。

## 后台提醒

### 什么时候提醒

| 事件 | 通知 | 可以直接操作 |
|---|---|---|
| 工具需要审批 | "需要确认"（高优先级，会弹出） | **允许 / 拒绝** 按钮；点通知本身打开会话 |
| Agent 在提问 | "DSH 在问你 · 会话名" | 只有一个单选题、不超过 3 个选项时直接显示选项按钮；只有一个问题时可以直接输入回答；其他情况点开会话回答 |
| 回合正常结束 | "任务完成"：会话名、耗时、回复开头 | **回复**：直接输入下一条指令；点通知打开会话 |
| 回合出错 | 会话名 +"运行出错：…"（在"任务完成"通道） | 点开会话 |
| Claude Code / Codex 要确认、完成、在等你 | 同上，标题带工具名（见 [claude-code-codex.md](claude-code-codex.md)） | 允许 / 拒绝，完成后可回复 |

锁屏时，通知上的"允许"、选项、回复都要先解锁手机才会生效（Android 12 及以上），"拒绝"不用解锁。这样即使手机被别人拿到，也不能替你批准操作。

"任务完成"只在以下两种情况下提醒：
- 回合跑了 10 秒以上；
- 这一轮是从手机发起的。

下面这些情况不提醒：
- 你主动停止或打断的回合；
- 子代理会话。

打开 App 时，已完成的提醒会被自动清掉。

### 工作方式

- 前台服务 `NotifyService` 常驻，连接插件的 `/m/api/notify`：这条流 120 秒一次心跳，只有有事时才发帧，非常省电。它会在通知栏留一条最低优先级的"后台连接"通知，这是 Android 对前台服务的要求。
- 开机和 App 升级后，由 `BootReceiver` 自动恢复。但前提是系统允许 App"自启动"：
  - 小米 HyperOS 默认不允许，日志里能看到系统拒绝投递（`BroadcastQueueInjector: Unable to launch app … for broadcast MY_PACKAGE_REPLACED`）；
  - 华为 HarmonyOS 4.2 实测升级后服务也没有自己起来。
  
  不开自启动也能用，只是重启或升级后要**手动打开一次 App**。
- Wi-Fi 和移动网络切换时立即重连。断网或电脑关机时按 3 秒到 60 秒指数退避重试。
- 每条提醒带递增序号，断线期间漏掉的会补发（6 小时内）。DSH 重启会换一个新的 epoch，不会重复提醒。待处理的审批和提问，每次连上都会重发。
- 如果你的网关登录过期，会收到一条"需要重新登录"的通知，之后每 10 分钟重试一次。

### 必要设置

1. **允许通知**：首次进入时 App 会申请（Android 13 及以上）。
2. **电池或省电策略设为"无限制"**：App 会引导你打开系统设置页，最多提示两次。
   - 小米 / HyperOS：应用信息 → 省电策略 → **无限制**。默认的"智能限制"会在息屏后切断后台联网，提醒就收不到了。
   - 其他品牌：在电池 / 应用启动管理里，允许 dsh-pager 后台运行。
3. **允许自启动**（建议）：设置 → 应用 → 应用管理 → DSH → 打开"自启动"。华为在"应用启动管理"里改为手动管理，并允许自启动。
   不开也能用，只是手机重启或 App 升级后，要手动打开一次 App 才恢复提醒。

### 排错

```bash
adb logcat -s DSHNotify
```

日志只记录连接状态和帧类型，例如 `connect since=12 -> HTTP 200`、`frame ask n=13`、`stream failed: … (retry in 8s)`，不记录内容和凭据。

## 权限说明

| 权限 | 用途 |
|---|---|
| `INTERNET`、`ACCESS_NETWORK_STATE` | 连接你的电脑；网络切换时立即重连 |
| `POST_NOTIFICATIONS`、`VIBRATE` | 发提醒 |
| `FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_SPECIAL_USE` | 让提醒连接在后台保持 |
| `RECEIVE_BOOT_COMPLETED` | 开机后恢复提醒 |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | 引导你把电池策略设为不限制 |
| `REQUEST_INSTALL_PACKAGES` | App 内更新：安装从你电脑下载的新版本（每次都由系统弹框让你确认） |

App 没有统计，没有第三方 SDK，也不依赖 Google 服务。本地只存三样东西：
- 服务器地址；
- 网关 Cookie（如果有）；
- 提醒序号。

## 从源码编译

需要：
- Android SDK：`build-tools/34.0.0` 和 `platforms/android-34`；
- JDK 17；
- bash（Windows 上用 Git Bash）。

不需要 Gradle。

```bash
export ANDROID_SDK=/path/to/android-sdk     # 或 ANDROID_HOME
export JDK_HOME=/path/to/jdk-17             # 或 JAVA_HOME
bash android/build.sh public                # → android/out/dsh-pager-v<版本>.apk，不预置地址
```

也可以把 SDK 和 JDK 路径写进 `android/local.properties`（已被 git 忽略）：

```properties
ANDROID_SDK=/path/to/android-sdk
JDK_HOME=/path/to/jdk-17
# 可选：私有构建时预置服务器地址，bash android/build.sh 会把它写进 App
DSH_DEFAULT_SERVER=https://pc.example.com:8443
```

| 命令 | 产物 |
|---|---|
| `bash android/build.sh public` | 不预置地址，首次打开时询问；**关闭** WebView 远程调试（Release 用的就是这个） |
| `bash android/build.sh` | 预置 `DSH_DEFAULT_SERVER`，自用最方便；**开启** WebView 远程调试 |
| `bash android/build.sh install` | 同上，并执行 `adb install -r` |

**关于 WebView 远程调试**：
- 私有构建开着它，开发时可以 `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`，再用 Chrome DevTools 协议直接检查和操作页面，锁屏状态下也行。
- 但拿到手机 USB 调试授权的人也能这样读取网关 Cookie、操作 DSH，所以公开版关闭了它。
- 自用的私有构建，请只在你自己信任的电脑上授权 USB 调试。

构建流程：aapt2 → javac → d8 → zipalign → apksigner，大约 30 秒，产物约 41 KB。

**签名密钥**：
- 第一次构建时会生成 `android/keystore/dsh.jks` 和 `password.txt`，都已被 git 忽略。
- **要妥善保管**：Android 只允许用同一把密钥签名的包覆盖升级。
- 因此你自己编译的包，不能直接覆盖从 Releases 安装的版本，反过来也一样，需要先卸载。

**升级版本**：改 `android/build.sh` 里的 `VERSION_CODE`（每次 +1）和 `VERSION_NAME`。

## 界面和 App 怎么更新

界面（HTML / CSS / JS）放在电脑上的插件里，App 每次打开都从电脑加载。所以：
- 改界面不需要重装 App，手机上下拉刷新即可；
- 只有改 App 外壳（`android/` 目录）时，才需要新的安装包。

**App 内更新**（1.3.0 起）：新安装包不用再插线装到每台手机上。
1. 在电脑上编译（`bash android/build.sh` 或 `public`）。`build.sh` 会在安装包旁边写一个 `<安装包>.json`，记录版本号和 SHA-256。
2. 手机打开 App 时，会向插件查询 `/m/api/app/latest`。如果电脑上的版本号更高，顶部就会出现"有新版本"。
3. 点"更新"后，App 从电脑下载安装包，边下边算 SHA-256，对不上就放弃，然后交给系统安装器。
4. 第一次更新时，系统会让你允许 dsh-pager"安装未知应用"。之后每次安装，系统都会弹框让你确认。

插件按以下顺序找安装包：
1. 配置项 `appApk`（在 `cordis.patch.yml` 里插件那一行的 `config` 下）；
2. `android/out/DSH.apk`（私有构建）；
3. `android/out/` 里最新的 `dsh-pager-v*.apk`（公开构建）。

没有配套 `.json` 的安装包不会被提供。Android 只接受同一把密钥签名的更新，所以别人的电脑推不了安装包给你的 App。

1.3.2 之前的版本没有这个功能，要最后手动装一次 1.3.2；之后就能一直用 App 内更新了。真机验证：Redmi 从 1.3.0 直接更新到 1.3.2 成功，全程没插电脑。
