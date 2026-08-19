# dsh-vision-bridge

让没有视觉能力的 DSH 模型"看见"图片 —— 多后端、跨平台、带缓存的 DeepSeek Harness 宿主级插件。

基于 [doubao-vision-dsh](https://github.com/hawkongz/doubao-vision-dsh) 重写，修复了原插件的核心问题并大幅扩展。

## 为什么重写

原插件 `doubao-vision-dsh` 解决了一个真实问题——让纯文本模型"看见"图片——但有以下严重缺陷：

| 问题 | 原插件 | 本插件 |
|------|--------|--------|
| 硬编码用户路径 | `C:\Users\20105\...`（作者自己的路径） | 动态解析 `homedir()` + `DSH_HOME` |
| 平台限制 | 仅 Windows（taskkill, cmd.exe） | Windows / macOS / Linux |
| 视觉后端 | 仅豆包（CDP） | 多后端：OpenAI Vision API + CDP 桥接 |
| 错误处理 | 大量 `catch (e) {}` 吞错误 | 有意义的错误信息 + 日志 |
| 缓存 | 仅会话内内存缓存 | 持久化缓存（内容哈希，磁盘+内存） |
| 配置 | 全部硬编码常量 | 通过 `cordis.patch.yml` 配置 |
| 标准化 | 非标准（手动复制文件） | npm 包 + `package.json` |

## 功能特性

- **多后端**：支持 OpenAI-compatible Vision API（OpenAI、Groq、Together 等）和 CDP 桥接（豆包等桌面应用）
- **跨平台**：Windows、macOS、Linux 全支持
- **动态路径**：自动解析用户目录，不硬编码任何路径
- **持久缓存**：图片识别结果按内容哈希缓存，重复识别零延迟
- **可配置**：后端类型、API key、超时、缓存大小等全部可通过 `cordis.patch.yml` 配置
- **全预设生效**：挂在用户补丁层，任何 preset、任何对话自动可用
- **图片照常显示**：聊天界面正常显示图片，界面无多余标记
- **停止可取消**：识别是标准工具调用，"停止"按钮立即中断
- **纯文本模型安全**：适配器层剥离图片块，图片内容永远不到达模型请求
- **图片归档**：每张图片复制到 `attachments/collected/`（日期_哈希.ext），按内容去重

## 快速开始

### 前置条件

- DeepSeek Harness (DSH) 已安装
- 选择一种视觉后端：
  - **API 后端**：一个 OpenAI-compatible Vision API key（OpenAI / Groq / Together 等）
  - **CDP 后端**：桌面豆包 App（Windows/macOS 自动检测路径，Linux 需手动配置）

### 安装

**方式一：npm 安装（推荐）**

```sh
npm install dsh-vision-bridge
# 将 index.mjs 复制到插件目录
cp node_modules/dsh-vision-bridge/index.mjs ~/.dsh/plugins/vision-bridge.mjs
cp node_modules/dsh-vision-bridge/vision-bridge.mjs ~/.dsh/plugins/vision-bridge-impl.mjs
```

**方式二：手动安装**

将 `index.mjs` 和 `vision-bridge.mjs` 复制到 `~/.dsh/plugins/` 目录。

### 配置

在 `$DSH_HOME/cordis.patch.yml`（不存在则新建）中添加：

**API 后端（最简）：**

```yaml
- insert:
  - id: vision-bridge
    name: "file:///C:/Users/你的用户名/.dsh/plugins/index.mjs?v=1"
    config:
      backend: api
      apiKey: "sk-..."          # 或设置环境变量 OPENAI_API_KEY
      apiBase: ""               # 或设置环境变量 OPENAI_BASE_URL
      apiModel: "gpt-4o"        # 或 gpt-4o-mini 等支持视觉的模型
```

**CDP 后端（豆包桥接）：**

```yaml
- insert:
  - id: vision-bridge
    name: "file:///C:/Users/你的用户名/.dsh/plugins/index.mjs?v=1"
    config:
      backend: cdp
      cdpPort: 9225
```

保存即热加载，无需重启。

### 验证

1. 查看日志 `~/.dsh/plugins/vision-bridge.log` 出现 `apply: vision-bridge loaded`
2. 任意对话的工具列表中出现 `vision_recognize` 工具
3. 在聊天中发一张图，模型会自动调用工具识别

## 工具

| 工具 | 用途 |
|------|------|
| `vision_recognize` | 识别本地图片文件，传入文件路径和可选问题，返回文字描述 |

## 配置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `backend` | `api` | 视觉后端：`api`（OpenAI Vision API）或 `cdp`（桌面应用 CDP） |
| `apiKey` | `""` | API 后端的 key（也可用环境变量 `OPENAI_API_KEY`） |
| `apiBase` | `""` | API 基础 URL（也可用环境变量 `OPENAI_BASE_URL`） |
| `apiModel` | `gpt-4o` | 视觉模型名 |
| `cdpExePath` | 自动检测 | 桌面应用路径（Windows/macOS 自动检测，Linux 需配置） |
| `cdpPort` | `9225` | CDP 调试端口 |
| `timeoutMs` | `60000` | 单次识别超时（毫秒） |
| `cacheMaxEntries` | `200` | 缓存最大条目数（LRU 淘汰） |
| `cdpTextareaSelector` | 默认 | CDP 后端的文本框 DOM 选择器（自定义应用时配置） |
| `cdpUploadSelector` | 默认 | CDP 后端的上传按钮 DOM 选择器 |
| `cdpMsgSelector` | 默认 | CDP 后端的消息容器 DOM 选择器 |

## 环境变量

| 变量 | 说明 |
|------|------|
| `DSH_HOME` | DSH 主目录（默认 `~/.dsh`） |
| `OPENAI_API_KEY` | API 后端的 key |
| `OPENAI_BASE_URL` | API 后端的基础 URL |

## 工作原理

```
用户发图
  └─ vision_recognize 工具被调用（file_path + question）
     ├─ 检查缓存（内容哈希 + 问题哈希）
     │  └─ 命中 → 直接返回缓存结果
     └─ 未命中 → 分发到后端
        ├─ API 后端：base64 编码图片 → 调用 Vision API → 返回文字
        └─ CDP 后端：CDP 驱动桌面应用 → 上传图片 → 注入问题 → 轮询回复
  └─ 结果写入缓存（磁盘 + 内存）
  └─ 图片归档到 attachments/collected/
```

适配器层同时：
1. 在模型元数据中声明 `image` 输入模态（让 DSH 接受图片上传）
2. 在发送给模型请求时剥离 `image` 块（纯文本模型不会收到图片，不会报错）

## 更新插件

修改 `vision-bridge.mjs` 后，需要同步将 `index.mjs` 和 `cordis.patch.yml` 中的 `?v=N` 加一（击穿 ESM 缓存），保存补丁文件即热加载。

## 致谢

- 原插件 [doubao-vision-dsh](https://github.com/hawkongz/doubao-vision-dsh) by [hawkongz](https://github.com/hawkongz)
- DeepSeek Harness 插件生态

## 许可证

[MIT](LICENSE)
