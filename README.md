# Sonic Topography

一个基于 Web Audio API 的交互式音频可视化播放器，支持本地音频播放、系统音频捕获、网易云音乐搜索与代理播放，并集成了实时频谱分析、歌词显示和频率触发的视觉特效。

源于yin-yizhen/sonic-topography

---

## ✨ 功能特点

- 🎵 **本地音频播放**：支持拖放或点击上传 MP3 / WAV / FLAC 文件
- 🎤 **系统音频捕获**：捕获系统输出音频（需浏览器支持），实时可视化
- 🔍 **网易云音乐搜索**：通过代理 API 搜索并播放海量在线歌曲，支持歌词同步
- 📋 **播放列表管理**：存储在浏览器本地（localStorage），数据本地化
- 🎚️ **实时音频分析**：显示 Bass / Mid / Treble / Energy 统计
- 📜 **歌词显示**：支持 `.lrc` 文件上传和网易云歌词同步，随播放进度高亮
- 🌈 **主题切换**：多种配色方案，视觉风格自由切换
- 🎛️ **频率触发（Frequency Trigger）**：基于频谱能量触发“脉冲”或“流星”视觉效果，可自定义阈值和频段
- 🔄 **代理源切换**：在线服务器代理 或本地模式代理，可自定义代理地址（支持severless函数作为代理）

- 🥰 **纯前端部署**：通过新加入的代理源切换功能，解耦前后端关联，只部署前端内容就可以使用全部功能

---

## 🛠️ 技术栈

- **前端**：React 19 + Tailwind CSS + Lucide Icons + Web Audio API
- **后端代理（可选）**：Go 1.21+（提供网易云 API 代理，支持 CORS 和音频流）、Node.js环境代理

---

## 📦 前置依赖

- **Node.js** 18+ 和 npm / yarn / pnpm（用于前端开发、本地代理服务器）
- **Go** 1.21+（编译本地 / 在线代理服务器）

---

## 🚀 快速开始

### 1. 启动前端开发服务器

在项目根目录下执行：

```bash
# 安装依赖
npm install

# 启动开发服务器（默认端口 7200）
npm run dev
```

前端将运行在 `http://localhost:7200`（或你配置的其他端口）。

> **注意**：前端默认使用**在线代理模式**，指向 `https://your-domain-api.workers.dev`。若该服务不可用或你想使用本地代理，请继续阅读下一节。

---

### 2. 启动本地 Go 代理服务器（可选）

如果你需要本地代理服务（例如在线 Worker 无法访问，或你想在本地调试），请按照以下步骤运行：

#### 2.1 获取代码

确保你已经拥有 `main.go` 文件、`local-server.mjs` 文件

#### 2.2 运行

```bash
# 直接运行
go run main.go
```

或

```bash
# 直接运行
npm start
```

或者编译为二进制：

```bash
go build -o sonic-proxy main.go
./sonic-proxy   # Linux/macOS
sonic-proxy.exe # Windows
```

代理服务器默认监听 `http://localhost:7200`，并提供以下 API：

- `/api/netease/search` – 搜索歌曲
- `/api/netease/lyric` – 获取歌词
- `/api/netease/url` – 获取播放地址

#### 2.3 日志

运行后，会在当前目录生成 `sonic-proxy.log` 文件，记录请求日志。

---

### 3. 切换“在线”与“本地”模式

前端界面左侧边栏底部有一个 **“源”** 按钮，点击即可在两种模式间切换：

- **在线模式**：使用远程 Worker 代理（默认 `https://your-domain-api.workers.dev`）
- **本地模式**：使用本地代理（`http://localhost:7200`）

切换后，所有网易云相关的 API 请求将自动指向对应的代理地址。

> 💡 如果你需要修改在线模式的代理 URL，可在在线模式下点击 **“编辑”** 按钮，输入自定义地址并保存，该地址会被保存在浏览器 localStorage 中。

---

## ⚙️ 配置说明

### 前端代理地址配置

- 默认在线地址：`https://your-domain-api.workers.dev`
- 本地地址：`http://localhost:7200`
- 自定义在线地址：在界面中通过“编辑”按钮修改，存储于 `localStorage` 键 `sonic-online-url`

### 播放列表存储

所有播放列表数据存储在浏览器的 `localStorage` 中（键名为 `sonic-topography-playlists-v1`），清除浏览器缓存会导致数据丢失。如需持久化，可考虑将播放列表导出为 JSON。

---

## 🧪 开发与调试

### 前端构建

```bash
npm run build
```

构建产物位于 `dist/` 目录，可用于部署到任何静态托管服务。

### 后端代理（Go）构建

```bash
go build -o sonic-proxy main.go
```

生成的二进制文件可直接运行，无需额外依赖。

---

## 📝 常见问题

**Q：为什么本地代理搜索不到歌曲？**  
A：请确保代理已正常运行，且端口 7200 未被占用。检查控制台日志是否有网络错误。

**Q：在线模式无法播放？**  
A：可能远程代理服务不可用，请切换至本地模式，或检查网络连接。

**Q：如何恢复默认的在线代理地址？**  
A：在“编辑”模态框中清空输入框并保存，或直接删除 localStorage 中的 `sonic-online-url` 键。

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。对于较大改动，请先开 Issue 讨论。

---

## 📄 许可证

按原作者 yin-yizhen/sonic-topography 仓库许可证

---

**享受音乐与视觉的融合之旅！** 🎶✨
