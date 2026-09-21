# 远程访问

> **先说明**：下面两种做法都**不需要翻墙**。用国内云服务器，流量可以全程在国内。
> 文中的"异地组网"（Tailscale、ZeroTier 这类工具，英文常叫 VPN）只是把你自己的手机和电脑连进同一个私有网络，和翻墙无关。

DSH web 只绑 `127.0.0.1`，而且**没有登录功能**。能在手机上给它发指令，就等于能让你的电脑执行命令（受 DSH 自身审批策略约束）。
所以让手机访问 `/m/` 需要满足两件事：

1. **一条有认证的通道**，把手机的请求送到电脑上的 `127.0.0.1:3080`。认证可以是登录网关，也可以是只有你自己设备的异地组网。
2. **Host 能通过检查**：DSH 和插件都会拒绝不认识的 `Host`，这是防 DNS 重绑定的栅栏，不是认证。两种做法任选其一：
   - 在插件行的 `trustedHosts` 里声明手机访问时用的 `host:port`；
   - 让通道把 `Host`（以及 `Origin`）改写成回环地址。

在电脑上可以这样自检（把 Host 换成手机实际访问用的地址）：

```bash
curl -H "Host: pc.example.com:8443" http://127.0.0.1:3080/m/api/ping
# {"ok":true,...}                           → 这个地址已被信任
# {"ok":false,"error":{"code":"forbidden"}} → 还没加进 trustedHosts
```

---

## 方案 A：带登录的网关（推荐，作者自用）

适合大多数人：手机上不用装任何额外软件，打开 App 就能用。全程国内直连的前提是网关放在国内云服务器上。

```
手机 ──HTTPS──▶ 国内云服务器：反向代理 + 登录 ──隧道（如 WireGuard）──▶ 家里电脑 ──▶ 127.0.0.1:3080
```

### 登录方式：必须是"登录页 + Cookie"

可以用表单登录，也可以用 oauth2-proxy、Authelia、Authentik 这类认证代理。
**HTTP Basic 认证不行**：App 里的 WebView 不会弹出 Basic 认证对话框。

登录一次之后，Cookie 由 WebView 保存，后台提醒服务也带同一个 Cookie。Cookie 过期时：
1. App 会发一条"DSH 需要重新登录"的通知；
2. 之后每 10 分钟重试一次；
3. 打开 App 重新登录一次即可恢复。

### Host 头：二选一

**做法 1：通道把请求头改写成回环地址（作者自用）。**

家里电脑上的中转把 `Host` 改成 `127.0.0.1:3080`，同时把 `Origin` 改成 `http://127.0.0.1:3080`（或者直接去掉 `Origin`）。
这样 DSH 和插件都会把请求当作本机请求，不需要配置 `trustedHosts`。

**做法 2：保留原 Host，把它加进 trustedHosts。**

nginx 要用 `$http_host`（带端口），因为插件会核对 `Origin` 和 `Host` 是否一致；用 `$host` 会丢掉端口，结果发消息时返回 403。

```nginx
location / {
    # 在这里接入你的登录检查（例如 auth_request 到 oauth2-proxy / Authelia）
    proxy_pass http://10.8.0.2:8080;      # 电脑在隧道里的地址，由 forward.mjs 监听
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;     # 保留端口，必须和手机发出的 Origin 一致
    proxy_buffering off;                  # 事件流不能被缓冲（插件也会发 X-Accel-Buffering: no）
    proxy_read_timeout 330s;              # 要大于 /m/api/notify 的 120 秒心跳
}
```

```yaml
- insert:
    - id: mobile
      name: 'dsh-pager'
      config:
        trustedHosts: ['pc.example.com:8443']   # 手机访问的 host:port
```

> 验证情况：
> - 做法 1 在作者的部署里长期使用。
> - 做法 2 所依赖的插件逻辑，有单元测试和本机转发端到端测试覆盖。
> - 上面的 nginx 片段是示例配置，请按你自己的环境调整。

### 事件流与超时

- `/m/api/events` 是界面用的实时流，15 秒一次心跳。
- `/m/api/notify` 是后台提醒流，120 秒一次心跳。

代理的读超时要大于心跳间隔，并且不能缓冲响应，否则提醒会延迟到缓冲区满了或连接断开才送达。

---

## 方案 B：异地组网 + `tools/forward.mjs`

适合已经在用异地组网工具的人：手机和电脑处在同一个私有网络里，不需要云服务器。

- 常见工具：EasyTier、ZeroTier、Tailscale、自建 WireGuard 等。
- 这些工具技术上也叫"VPN"，但作用只是把你自己的设备连在一起，和翻墙无关。
- 部分工具的协调服务器在海外，国内可能连不稳。想全程国内，就选能自建节点的方案，比如在国内云服务器上自建中继。

步骤：

1. 在电脑和手机上都装好组网工具，记下电脑在组网里的地址，例如 `100.64.0.5`。
2. 在电脑上运行：

   ```bash
   node tools/forward.mjs 100.64.0.5:8080          # 转发到 127.0.0.1:3080
   ```

   它只做一件事：把 `100.64.0.5:8080` 上的 TCP 连接原样转给 DSH，不改任何请求头，也不需要任何依赖。
   它只肯监听这几类私有地址：
   - 回环；
   - `10/8`、`172.16/12`、`192.168/16`；
   - `100.64/10`（CGNAT，Tailscale 等常用）；
   - IPv6 ULA（`fc00::/7`）。

   `0.0.0.0`、公网地址和域名一律拒绝。

3. 在 `cordis.patch.yml` 的插件行里声明这个地址，然后重启 DSH：

   ```yaml
   - insert:
       - id: mobile
         name: 'dsh-pager'
         config:
           trustedHosts: ['100.64.0.5:8080']
   ```

4. 在手机 App 里填 `100.64.0.5:8080`。私有地址会自动走 `http://`；组网工具本身已经加密，所以这样没问题。

如果还想在同一地址上用 DSH 的**桌面界面**，启动 DSH 时加上它自带的参数：`dsh --profile web --trusted-host 100.64.0.5:8080`。

**开机自启**：
- Windows 用计划任务，Linux 用 systemd，让它开机运行 `node tools/forward.mjs …`。
- 要打开"失败后重启"：组网还没连上时监听会失败，`forward.mjs` 会以退出码 1 退出，等下一次重启再试。

**只在同一个 Wi-Fi 里用**：也可以让 `forward.mjs` 监听电脑的局域网地址，例如 `192.168.1.20:8080`。但这样**同一局域网里的任何人**都能操作你的 DSH，只建议在自己家里的网络中这样用。

---

## 不要这样做

- 不要把 DSH 绑到 `0.0.0.0` 或公网地址。
- 不要用没有认证的公网隧道或端口映射，直接暴露 DSH 或 `forward.mjs` 的端口。
- 不要用 HTTP Basic 认证（App 里用不了，见上文）。

## 排错

| 现象 | 可能原因 |
|---|---|
| 界面能打开，但列表一直空着，或提示 403 | 手机用的 `host:port` 不在 `trustedHosts` 里；用上面的 `curl` 自检 |
| 能看历史，但发消息失败（403） | 反代把 Host 的端口丢了（`$host` 换成 `$http_host`），或者改写了 Host 却没改写 Origin |
| 后台提醒要很久才到，或一阵一阵地到 | 代理在缓冲事件流，或读超时短于 120 秒；手机上看 `adb logcat -s DSHNotify` 有没有频繁的 `stream failed` |
| 提醒完全不来 | 先看 [android.md](android.md) 里的电池和自启动设置 |
