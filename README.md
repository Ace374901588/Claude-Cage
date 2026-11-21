# Cage H264 for Mac

**基于 Claude Cage 改造，专注 macOS 主机与 macOS 客机的 Cage H264。**

Cage H264 是 [Ace374901588/Claude-Cage-H264-for-Mac](https://github.com/Ace374901588/Claude-Cage-H264-for-Mac) 独立维护的 Fork，基于 [Lee-xeo/Claude-Cage](https://github.com/Lee-xeo/Claude-Cage) 开发。我们保留 macOS 虚拟机路线，在客机中运行 macOS 版 Claude Desktop、Chrome 和开发工具，持续优化画面传输、窗口适配、鼠标输入与触控板滚动。

[源码](https://github.com/Ace374901588/Claude-Cage-H264-for-Mac) · [构建与实现说明](H264_LOCAL.txt) · [使用文档](docs/README.md) · [上游项目](https://github.com/Lee-xeo/Claude-Cage) · [MIT 许可](LICENSE)

## 项目定位与上游关系

上游在 [#531](https://github.com/Lee-xeo/Claude-Cage/pull/531) 中转向统一的 Debian 13 环境，并移除了 macOS 客机。本 Fork 继续维护 **Mac 上运行 macOS 客机** 的实现，后续 Cage H264 优化在本仓库开展。

- **维护重点**：Apple Silicon Mac 主机、macOS 客机，以及客机内的 Claude Desktop 和 Chrome。应用构建目标为 macOS 14+，实际验收系统见下文。
- **运行方式**：Mac → Cage H264 → macOS 虚拟机 → Claude Desktop / Chrome。H.264 用于把客机窗口画面传到 Cage 工作台；应用实际运行的系统仍是 macOS。
- **上游同步**：按适用性审阅和选择上游修复，保留 macOS 客机所需实现；上游的新架构需要单独评估后再适配。
- **支持范围**：仓库保留部分上游跨平台代码和文档，但本 Fork 的持续维护与验收重点为 Mac。Windows、Linux 和 Intel Mac 不在当前 H264 实机验收范围内。

本项目沿用上游技术基础并保留来源与许可，由 Fork 独立维护和发布；不代表上游或 Anthropic 官方产品。

## Cage H264 的主要改进

| 方向 | 已实现的行为 |
| --- | --- |
| H.264 窗口传输 | 客机通过 VideoToolbox 硬件编码，工作台通过 WebCodecs 解码；保留 PNG / JPEG 兼容回退。 |
| 画面状态 | 显示实际完成解码与绘制提交的格式、画面像素、更新率、接收速率及处理耗时。静止画面减少更新。 |
| 自适应显示 | Claude Desktop 与 Chrome 按工作台可用空间适配，保留完整标题栏与输入框；两个应用独立保存显示大小。固定尺寸对话框保持原生尺寸。 |
| 原生点击与菜单 | 完整传递鼠标按下、抬起等事件，修复 Claude 输入框加号菜单等交互；保留窗口归属、前台与遮挡校验。 |
| 触控板滚动 | 改进双指上下滚动，累计小幅滚动距离并合并相邻事件，保留输入顺序和目标窗口边界。 |
| 窗口恢复与登录 | 改进切换应用后的焦点恢复，提供客机网页登录入口处理外部浏览器授权。 |
| 网络启动顺序 | Claude 与浏览器等待环境及网络关键检查完成后启动；外网暂停或授权失效时保持阻断。 |
| 本地构建 | 从完整源码构建主程序及客机组件，记录构建来源与摘要，使用独立的 H264 应用标识。 |

H.264 需要客机和查看端均具备相应能力。WebCodecs 的硬件解码偏好不等于已证明实际使用硬件解码；失败时使用兼容图像路径。画面统计表示已处理的更新，不等于显示器刷新率或完整输入延迟。性能仍受主机资源、窗口分辨率和实际负载影响。

## 当前版本与验证范围

当前版本标识为 **`0.1.8-local.h264.10`**。已集成的上游基线为 [`3f17a01`](https://github.com/Lee-xeo/Claude-Cage/commit/3f17a013ef765061d5210e959ac645ce829cdd95)，该版本的功能代码与实机验收对应 [`28994f5`](https://github.com/Ace374901588/Claude-Cage-H264-for-Mac/commit/28994f523de8e1b8d912c4b6c8016f411cb70828)。

2026-11-19 的本地验收环境为 macOS 26.6.1 / Apple Silicon 主机与 arm64 macOS 客机，Claude Desktop 5.11492.5、Chrome 157.0.8103.79。已完成：

- 完整源码构建、签名完整性检查及客机 39 个组件文件核对。
- 全量 Go 测试，225 项前端测试、lint 与生产构建，Swift 布局与窗口匹配回归，以及 7 项隔离浏览器布局检查。
- Chrome / Claude 实际 H.264 画面、自适应显示、加号菜单、上下滚动和连续小幅滚动。
- 正常停止与重启、已有录屏与辅助功能权限保留、外网暂停时 DNS / TCP / UDP 阻断，以及 11 项关键网络与隔离检查。

这些结果对应上述提交及测试环境。h264.10 的滚动复核使用实机自动事件；此前 h264.7.1 获得过人工触控板连续滚动反馈。真实中文 IME 候选/预编辑、长期稳定性、端到端延迟和整机功耗仍需继续验证。

## 从源码构建

当前 H264 版本按源码构建流程使用。本仓库首页不将上游的安装包作为 Cage H264 下载包；后续预编译包以本 Fork 的发布说明为准。

构建需要 Apple Silicon Mac、Xcode Command Line Tools / Swift、Node.js / npm、Python 3.11+、`uv`，以及满足两个 Go 模块要求的工具链：根模块 Go 1.26.10+，`tools/tailnet` Go 1.27.3+。其他原生构建依赖和固定摘要材料由构建脚本检查，详见 [H264 构建说明](H264_LOCAL.txt)及 [SSHFS 构建材料说明](scripts/guest-os/macos-sshfs-source-README)。

```sh
git clone https://github.com/Ace374901588/Claude-Cage-H264-for-Mac.git
cd Claude-Cage-H264-for-Mac

go version
go list -m
(cd tools/tailnet && GOFLAGS= go version && GOFLAGS= go list -m)

CAGE_BUILD_OUTPUT="$PWD/_output/Cage H264.app" bash scripts/build-app.sh --h264-local
```

使用干净且已提交的源码目录，并选择尚不存在的输出路径。此命令构建应用，不会自动安装或启动。历史上的固定上游包复用脚本仅适用于其对应基线，当前集成版本应使用上述完整源码构建入口。

本地构建采用临时签名，未经 Apple 公证。构建成功与签名完整性检查通过不代表获得 Apple 公证。

## 安装、使用与升级

1. 保存工作，正常退出 Cage 并停止环境。备份现有应用、客机组件和持久数据。
2. 将构建产物放到稳定位置，例如 `/Applications/Cage H264.app`。H264 版使用独立应用标识，但会复用现有 Cage 配置；切换版本前先退出另一个 Cage 实例。
3. 在应用内选择或启动 macOS 客机，配置自己的代理并完成正常网络检查。按需同步环境组件；更换助手签名后，macOS 可能要求重新授予原有录屏与辅助功能权限。
4. 在“设置 → 通用”启用“优先流畅”，按提示重新启动环境；在 Claude Desktop 或 Chrome 的“画面状态”确认实际使用 H.264，显示大小推荐选择“自适应”。

升级需分别核对主程序与客机组件。H264 本地版本采用手动更新通道，后续应使用本 Fork 的源码和发布说明准备升级与恢复包。

macOS 镜像及系统使用需符合相应许可；项目不提供系统授权、代理服务或 Claude 账户。通用操作可参考仓库内的[开始使用](docs/getting-started.md)、[Claude Desktop](docs/guide/desktop.md)和[维护说明](docs/guide/maintenance.md)。部分文档及其他语言 README 仍沿用上游历史内容，尚未全部适配 Cage H264，具体行为以本页说明和当前源码为准。

## 网络与数据边界

保留上游的代理、网络检查与项目共享机制：关键检查失败或证据不完整时阻断客机外网，代理失效时不直连回退；只共享明确授权的项目目录。共享目录里的修改和删除会影响本机原文件。

虚拟机隔离、网络检查和 H.264 画面传输不构成匿名性或账号安全保证。账户使用仍需遵守服务提供方的规则与支持范围。主程序、客机助手的身份校验和系统权限应通过正常流程维护。

## 后续维护与贡献

后续围绕 macOS 客机继续优化 H.264 传输、画面质量与资源开销、触控板和输入体验、窗口恢复及权限维护。每项改动记录测试环境、结果和未验证范围，涉及网络或权限时保留现有校验边界。

本 Fork 的代码贡献通过本仓库的分支与 Pull Request 开展。提交时说明问题、适用版本、macOS / 芯片架构、复现步骤与验证结果，并移除日志或附件中的账号资料、密码、令牌和订阅地址。

上游最新主线的功能与本 Fork 可能不同。向上游贡献通用修复时，另行遵循[上游贡献指南](https://github.com/Lee-xeo/Claude-Cage/blob/main/.github/CONTRIBUTING.md)。

## 来源、许可与致谢

Cage H264 基于 [Lee-xeo/Claude-Cage](https://github.com/Lee-xeo/Claude-Cage) 改造；Claude Cage 的基础来自 [sylvinus/agent-vm](https://github.com/sylvinus/agent-vm)。感谢上游作者与贡献者提供工作台、虚拟机管理、网络和项目共享等基础能力。

项目主许可为 [MIT](LICENSE)，保留原始版权声明。随附组件继续遵循各自许可：Mihomo 作为独立可执行文件按 GPL-3.0 分发；详见 [NOTICE](NOTICE)、[第三方许可清单](THIRD_PARTY_LICENSES)及 [noVNC 许可](ui/vendor/novnc/LICENSE.txt)。

同时感谢 [Lima](https://github.com/lima-vm/lima)、[gvisor-tap-vsock](https://github.com/containers/gvisor-tap-vsock)、[sshocker](https://github.com/lima-vm/sshocker)、[SFTP](https://github.com/pkg/sftp)、[noVNC](https://github.com/novnc/noVNC)、[Mihomo](https://github.com/MetaCubeX/mihomo)、[code-server](https://github.com/coder/code-server)、[AIO Sandbox](https://github.com/agent-infra/sandbox)，以及 [claude-switcher](https://github.com/YOURSJEYO/claude-switcher)、[Claude-Guardian](https://github.com/DUNHKpcc/Claude-Guardian) 和 [claude-post-ban-cleanup](https://github.com/l2461090/claude-post-ban-cleanup) 等上游参考项目。
