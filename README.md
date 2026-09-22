# YT Downloader

> 本项目**全程使用 DeepSeek-V4.1Flash 制作**：界面、Rust 后端、安装器与卸载器、
> 构建脚本与验证工具均由其编写。

一款面向 Windows 的现代桌面视频下载工具。底层使用 **yt-dlp + FFmpeg**，
上层是 **Tauri 2 + Rust + React 19 + TypeScript + Tailwind CSS v4**。

它不是"给 yt-dlp 套一层 GUI"：下载队列、暂停/继续、取消、只重试合并、
历史、收藏、Cookie、代理、字幕、元数据全部由 Rust 后端真实驱动，
前端只负责呈现后端的状态。

```
粘贴链接 → 解析 → 查看信息 → 选择格式 → 下载/合并 → 完成
```

---

## 亮点

| 能力 | 实现方式 |
| --- | --- |
| **不二次编码** | 视频流与音频流分别下载，再用 FFmpeg `-c copy` 无损封装 |
| **真正的暂停/继续** | 终止进程树、保留 `.part` 分片，继续时 yt-dlp `--continue` 断点续传 |
| **只重试合并** | 音视频已在磁盘上时，合并失败可只重跑 FFmpeg，绝不重新下载 |
| **真实进度** | yt-dlp `--progress-template` + FFmpeg `-progress pipe:1`，按字节聚合、节流推送 |
| **运行库自带** | Release 内置完整 `runtime/FFMPEG-9.0`（含 presets / LICENSE），用户无需安装任何东西 |
| **零 C 盘写入** | 数据、缓存、临时文件、WebView2 用户目录全部位于应用目录旁 |
| **Cookie 不外泄** | Cookie 只在本机读取，永不进入日志、Toast、错误详情或命令预览 |

---

## 快速开始（开发）

```powershell
# 1. 依赖
npm install

# 2. 开发模式（Vite + Tauri）
npm run tauri dev
```

开发环境固定使用 `E:\FFMPEG-9.0`：

```
E:\FFMPEG-9.0\bin\yt-dlp.exe
E:\FFMPEG-9.0\bin\ffmpeg.exe
E:\FFMPEG-9.0\bin\ffprobe.exe
```

程序**不会**调用系统 PATH 中的 FFmpeg，也不会自动下载其它版本。

### 环境变量（开发/测试）

`scripts/dev-env.ps1` 会把所有缓存与临时目录重定向到工作区，使构建过程
完全不写 C 盘：

| 变量 | 作用 |
| --- | --- |
| `CARGO_HOME` / `CARGO_TARGET_DIR` | Cargo 注册表缓存与构建输出 |
| `TEMP` / `TMP` | 构建期临时目录 |
| `npm_config_cache` | npm 缓存 |
| `YTD_DATA_DIR` | 覆盖应用数据目录（测试用） |
| `YTD_LIVE_TESTS=1` | 启用需要联网的集成测试 |

---

## 构建 Release

```powershell
# Windows PowerShell 5.1（系统自带）
powershell -ExecutionPolicy Bypass -File scripts\build.ps1

# 或者 PowerShell 7+
pwsh -File scripts\build.ps1
```

一次构建同时产出**便携版**与**正式安装包**：

```
release\
├─ YT Downloader\                    ← 便携版（整目录复制即可运行）
│  ├─ YTDownloader.exe
│  ├─ README.txt
│  ├─ runtime\FFMPEG-9.0\            ← 完整内置运行库
│  └─ data\                          ← 数据骨架
└─ installer\
   └─ YT Downloader Setup.exe        ← 正式安装包（单文件）
```

构建日志会写入 `release\build.log`。

### 安装包如何做到"只含生产文件"

安装包是**单文件自解压**结构：

```
[安装器骨架 2.9 MB][载荷 273.3 MB][24 字节尾部标记]
```

载荷由 `scripts/make_payload.py` 从**便携版目录**（构建第 6 步刚生成的干净产物）打包，
并额外拒绝任何形如开发内容的路径：`node_modules`、`target`、`.git`、`.caches`、
`src`、测试文件、截图、日志、临时文件。因此开发目录（约 10 GB）不可能进入安装包——
安装包的解压后总大小就是便携版的 669 MB，一一对应。

安装结束后由安装器自己创建 `data\{config,history,favorites,logs,cache,temp,downloads,webview}`
骨架，所以安装出来的数据目录永远是干净的，不会带上构建机上的设置或日志。

### 安装器

| 项目 | 说明 |
| --- | --- |
| 技术方案 | 自研 Tauri 2 安装器（`src-setup`），与主程序共用同一套 Design Token、组件与动效 |
| 界面 | 单窗口三步：选项 → 进度 → 完成；无传统向导式"下一步"链 |
| 安装目录 | 默认取安装包所在盘（非 C 盘）；否则剩余空间最大的非 C 固定盘；再否则 `%LOCALAPPDATA%\Programs` |
| 快捷方式 | 开始菜单（含卸载入口）+ 桌面，均可在界面中关闭 |
| 卸载信息 | `HKCU\...\Uninstall\YT Downloader`（显示在"应用和功能"中） |
| 免管理员 | 全部为当前用户范围，不写系统目录、不需要 UAC |
| 卸载 | 删除程序文件与快捷方式；**默认保留全部用户数据** |

命令行（便于批量部署与自动化验证）：

```powershell
"YT Downloader Setup.exe" --silent --dir=E:\Apps\YTDownloader [--no-shortcuts] [--no-launch]
"<安装目录>\uninstall.exe" --uninstall --silent [--remove-app-data] [--remove-downloads]
```

退出码：`0` 成功、`2` 失败、`3` 取消。`--silent` 时会在可执行文件旁写 `setup-log.txt`
（显式传入 `--log=<路径>` 时以该路径为准，且不会被自动清理）。

### 验证安装包

```powershell
# 1) 载荷内容与体积（会断言不含任何开发目录）
python scripts\make_payload.py verify "release\installer\YT Downloader Setup.exe"

# 2) 真实安装 → 启动检查 → 卸载（含用户数据保留验证）
powershell -ExecutionPolicy Bypass -File scripts\verify-installer.ps1
```

`verify-installer.ps1` 会在 E 盘的临时目录里完整跑三个循环：干净安装 →
卸载（保留用户数据）→ 卸载（连用户数据一起删除），并断言：程序文件、快捷方式、
注册表项被正确创建与移除，**用户下载的文件不会被误删**（包括用户自定义的下载目录），
以及"全部删除"时安装目录不残留。

### 必须启用 `custom-protocol`

Tauri 自身的 `build.rs` 是这样判断 dev / 生产的：

```rust
let custom_protocol = has_feature("custom-protocol");
let dev = !custom_protocol;          // ← 没有该 feature 就是 dev 构建
```

**少了这个 feature，Release 里的 exe 会去加载 `http://localhost:1420`**，
表现为窗口只有 “localhost 拒绝了我们的连接请求”。Tauri CLI 在
`tauri build` 时会自动加上它，而直接调用 `cargo build --release` 不会。
因此 `scripts/build.ps1` 固定使用：

```powershell
cargo build --release --features custom-protocol
```

并且 `src-tauri/src/lib.rs` 里有一道编译期防线：如果 release 构建缺少该
feature，会直接编译失败而不是产出一个坏包。

### 验证 Release（不要只看截图）

```powershell
# 静态检查：内嵌资源键是否写入 exe（build.ps1 第 7 步自动执行）
# 运行时检查：直接启动该 exe，通过 CDP 读取它真正加载的 URL 与渲染内容
node scripts\verify-release.mjs
```

`verify-release.mjs` 会启动
`release\YT Downloader\YTDownloader.exe`，连接它自己创建的 WebView2，
断言加载地址是 `http://tauri.localhost/`（内嵌资源）而不是 dev 服务器，
并检查标题、React 挂载、设计令牌、界面文案，同时输出截图与启动日志。

流程（任一步失败即终止，**不会产出无法运行的 Release**）：

```
检查 Node / npm / cargo
   ↓
校验 E:\FFMPEG-9.0（yt-dlp / ffmpeg / ffprobe 必须存在且非空）
   ↓
安装前端依赖
   ↓
前端构建（tsc --noEmit + vite build）
   ↓
后端构建（cargo build --release）
   ↓
复制整个 runtime 目录 + 生成 data 骨架
   ↓
完整性检查（可执行文件体积、运行库三项、运行库可执行性、数据目录）
```

产物结构：

```
release\YT Downloader\
├── YTDownloader.exe
├── README.txt
├── runtime\FFMPEG-9.0\        ← 完整复制，不只是三个 exe
│   ├── bin\{yt-dlp,ffmpeg,ffprobe}.exe
│   ├── doc\  presets\  LICENSE  README.txt
└── data\
    ├── config\  history\  favorites\  logs\  cache\  temp\  downloads\
    └── webview\               ← WebView2 用户目录（不落 %LOCALAPPDATA%）
```

把整个 `YT Downloader` 文件夹拷到任意一台**没有安装 FFmpeg / yt-dlp / Python**
的 Windows 机器，双击即可运行。

---

## 架构

```
┌──────────────────────────────────────────────┐
│  React UI (src/)                             │
│  pages / components / hooks / stores / api   │
└───────────────────┬──────────────────────────┘
                    │ Tauri IPC（命令 + 事件）
┌───────────────────┴──────────────────────────┐
│  Rust backend (src-tauri/src/)               │
│  commands/    IPC 层，一命令一动作            │
│  downloader/  队列、任务状态机、执行计划       │
│  services/    yt-dlp / FFmpeg 参数、解析、错误 │
│  process/     唯一允许创建进程的地方           │
│  runtime/     运行库定位与版本自检             │
│  store/       设置 / 历史 / 收藏（原子写入）   │
│  core/        错误、路径、日志、文件系统        │
└───────────────────┬──────────────────────────┘
                    │
        yt-dlp.exe / ffmpeg.exe / ffprobe.exe
```

### 一次下载的完整链路

```
1. probe        yt-dlp --dump-single-json     → 媒体信息 + 格式表
2. plan         生成执行计划（文件路径、分片、是否合并）
3. stream 1     yt-dlp -f <video> → <name>.video.<ext>   ┐ 真实进度
4. stream 2     yt-dlp -f <audio> → <name>.audio.<ext>   ┘
5. merge        ffmpeg -i video -i audio -c copy …       ← 失败可只重试此步
6. verify       ffprobe 校验两条流与时长
7. finish       写历史、发事件、通知前端
```

任一步都可以暂停、取消；第 3/4 步已完成的分片在重试时会被直接复用。

### 前端模块

```
src/
├── api/          一命令一函数的 IPC 封装（组件不直接 invoke）
├── stores/       zustand：设置 / 队列 / 资料库 / UI / Toast
├── hooks/        事件桥、快捷键、剪贴板监听
├── components/
│   ├── ui/       设计系统原语（Button/Surface/Controls/Overlay/Feedback/Progress）
│   ├── shell/    TitleBar / Sidebar / AppShell
│   └── download/ 输入、预览、格式选择、任务卡、下载面板
├── pages/        Home / Queue / History / Favorites / Settings / About
├── lib/          cn、格式化、动效系统、事件总线、原生对话框
└── styles/       theme.css —— 全部设计 Token
```

---

## 设计系统

所有视觉都走 Token，组件里不出现任何字面色值。
深色不是纯黑：`background → surface → elevated → hover → active` 由明度分层；
浅色是单独调校的一套，而不是深色反转。

```
颜色    --background --surface --surface-elevated --surface-hover --surface-active
        --border --text-primary/secondary/tertiary --accent --success --warning --danger
圆角    --radius-xs/sm/md/lg/xl/2xl
动效    --ease-standard/out/in-out + 统一的 duration 与 spring
```

动效原则：只动 `transform` / `opacity`，侧边栏选中态用共享元素 `layoutId`
弹簧过渡，页面切换只有轻微上移与淡入，`prefers-reduced-motion` 与
「外观 → 动效」设置都会关闭非必要动画。

---

## 数据与安全

**数据位置**：`<应用目录>\data\`（开发环境为项目下的 `data\`）。
不写注册表，不写 `%APPDATA%`，不写 `%LOCALAPPDATA%`。

**Cookie**：仅在调用 yt-dlp 时作为参数传入（`--cookies` / `--cookies-from-browser`）。
`process::render_preview` 与日志会对 Cookie 路径、密码、带凭据的代理 URL 做脱敏。

**不做的事**：不上传任何 Cookie / 链接 / 历史 / 文件；不支持绕过 DRM、
付费墙或任何访问控制；不自动下载第三方二进制。

---

## 测试

```powershell
# Rust 单元测试（134 项）
cd src-tauri; cargo test --lib

# Rust 集成测试（真实调用 FFmpeg / yt-dlp）
cd src-tauri; cargo test --test integration

# 含联网测试
$env:YTD_LIVE_TESTS='1'; cargo test --test integration

# 前端类型检查 + 构建
npm run build
```

「定位到文件位置」需要肉眼确认：`scripts/verify-reveal.ps1` 会创建中文、空格、
括号等名称的测试文件，逐个调用定位功能，再用 Shell 自动化读回资源管理器窗口，
核对打开的是文件所在目录且目标文件处于选中状态。

集成测试覆盖：真实 VP9+Opus 合流并用 ffprobe 校验、章节元数据往返、
进程取消真正终止编码、超时终止、失败退出码与 stderr 捕获、
运行库发现不落在 C 盘、Cookie 不进入命令预览、
以及联网解析真实视频并验证格式配对。

---

## 常见问题

**解析失败，提示需要登录/人机校验？**
在「设置 → Cookies」选择浏览器 Cookie 或指定 `cookies.txt`。

**yt-dlp 无法启动（PyInstaller 临时目录被拒绝）？**
官方 yt-dlp.exe 是单文件打包，启动时要解压到临时目录。在受限令牌、
应用控制策略等环境下这一步会被拒绝。此时在「设置 → 高级 → yt-dlp 运行方式」
切换到 **Python 模块**，指定 `python.exe` 与该模块目录即可，功能完全一致。

**合并失败？**
任务卡会显示「只重试合并」，点击即可仅重跑 FFmpeg，不会重新下载。

**下载到一半失败，提示 ffmpeg 退出码异常？**
若日志里出现 `Connection to tcp://…:443 failed` 或 `Error number -138`，
说明 **FFmpeg 自身的 HTTPS 连接被拦截**（FFmpeg 在 Windows 上使用系统
schannel 栈，与 yt-dlp 使用的 Python/OpenSSL 栈不同）。这通常来自安全软件、
企业代理或网络管控策略。常规下载不受影响，因为媒体数据由 yt-dlp 自己的
下载器获取；只有需要 FFmpeg 直接访问网络的场景（如「按时间段下载」）会受影响。
此时可改用代理设置，或改用不含分段的下载方式。

---

## 许可与致谢

本项目以 [MIT 许可证](LICENSE) 开源：可自由使用、修改与再分发，需保留版权与许可声明。

第三方组件遵循各自的许可：

- [yt-dlp](https://github.com/yt-dlp/yt-dlp)（Unlicense）— 下载核心，以独立进程调用；
- FFmpeg — 媒体处理，以独立进程调用。Release 内置的构建来自
  [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)，其 `LICENSE` 随 `runtime\FFMPEG-9.0` 一并分发
  （该构建含 GPL 组件，随包分发内置运行库时需一并遵守其条款）；
- [Tauri](https://tauri.app/)、[React](https://react.dev/)、Tailwind CSS 等框架与依赖，遵循其原始许可。

本应用不绕过 DRM、付费墙或任何访问控制，只调用上述工具处理用户自己有权获取的内容。

本项目全程使用 **DeepSeek-V4.1Flash** 制作，特此致谢。

