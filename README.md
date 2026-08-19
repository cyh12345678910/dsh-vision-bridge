# dsh-vision-bridge

让没有视觉能力的 DSH 模型"看见"图片 —— 多后端、跨平台、带缓存的 DeepSeek Harness 宿主级插件。

基于 [doubao-vision-dsh](https://github.com/hawkongz/doubao-vision-dsh) 重写，修复了原插件的核心问题并大幅扩展。

## 为什么重写

原插件 `doubao-vision-dsh` 解决了一个真实问题——让纯文本模型"看见"图片——但有以下严重缺陷：

| 问题 | 原插件 | 本插件 |
|------|--------|--------|
| 硬编码用户路径 | `C:\Users\20105\...`（作者自己的路径） | 动态解析 `homedir()` + `DSH_HOME` |
| 平台限制 | 仅 Windows（taskkill, cmd.exe） | Windows / macOS / Linux |
| 视觉后端 | 仅豆包（CDP） | 多后端：SiliconFlow / OpenAI Vision API + CDP 桥接 |
| 错误处理 | 大量 `catch (e) {}` 吞错误 | 有意义的错误信息 + 日志 |
| 缓存 | 仅会话内内存缓存 | 持久化缓存（内容哈希，磁盘+内存） |
| 配置 | 全部硬编码常量 | 通过 `cordis.patch.yml` 配置 |
| 标准化 | 非标准（手动复制文件） | npm 包 + `package.json` |

## 功能特性

- **多后端**：支持 SiliconFlow（DeepSeek-OCR，免费）、OpenAI-compatible Vision API 和 CDP 桥接（豆包等桌面应用）
- **跨平台**：Windows、macOS、Linux 全支持
- **动态路径**：自动解析用户目录，不硬编码任何路径
- **持久缓存**：图片识别结果按内容哈希缓存，重复识别零延迟
- **可配置**：后端类型、API key、超时、缓存大小等全部可通过 `cordis.patch.yml` 配置
- **全预设生效**：挂在用户补丁层，任何 preset、任何对话自动可用
- **图片照常显示**：聊天界面正常显示图片，界面无多余标记
- **停止可取消**：识别是标准工具调用，"停止"按钮立即中断
- **纯文本模型安全**：适配器层剥离图片块，图片内容永远不到达模型请求
- **图片归档**：每张图片复制到 `attachments/collected/`（日期_哈希.ext），按内容去重
- **LLM 运行时 patching**：patch `resolveModelInfo` + `listModels` + `stream` + `registerAdapter`，确保前端接受图片上传、模型不收到图片块、新注册适配器也被 patch

## 快速开始

### 前置条件

- DeepSeek Harness (DSH) 已安装
- 选择一种视觉后端：
  - **SiliconFlow + DeepSeek-OCR（推荐，免费）**：注册送额度，DeepSeek-OCR 模型免费，1-2 秒响应
  - **API 后端**：一个 OpenAI-compatible Vision API key（OpenAI / Groq / Together 等）
  - **CDP 后端**：桌面豆包 App（Windows/macOS 自动检测路径，Linux 需手动配置）

### 安装

将 `vision-bridge-entry.mjs`（入口 shim）和 `vision-bridge.mjs`（核心实现）复制到 `~/.dsh/plugins/` 目录：

```sh
cp vision-bridge-entry.mjs ~/.dsh/plugins/vision-bridge-entry.mjs
cp vision-bridge.mjs ~/.dsh/plugins/vision-bridge.mjs
```

### 配置

在 `$DSH_HOME/cordis.patch.yml`（不存在则新建）中添加：

**SiliconFlow + DeepSeek-OCR（推荐，免费）：**

```yaml
- insert:
  - id: vision-bridge
    name: "file:///C:/Users/你的用户名/.dsh/plugins/vision-bridge-entry.mjs?v=1"
    config:
      backend: api
      apiKey: "sk-你的SiliconFlow密钥"       # https://cloud.siliconflow.cn
      apiBase: "https://api.siliconflow.cn/v1"
      apiModel: "deepseek-ai/DeepSeek-OCR"
      timeoutMs: 30000
      cacheMaxEntries: 200
```

**OpenAI Vision API：**

```yaml
- insert:
  - id: vision-bridge
    name: "file:///C:/Users/你的用户名/.dsh/plugins/vision-bridge-entry.mjs?v=1"
    config:
      backend: api
      apiKey: "sk-..."
      apiBase: "https://api.openai.com/v1"
      apiModel: "gpt-4o"
```

保存即热加载，无需重启。

### 验证

1. 查看日志 `~/.dsh/plugins/vision-bridge.log` 出现 `apply: vision-bridge loaded` 和 `patched llm runtime`
2. 任意对话的工具列表中出现 `vision_recognize` 工具
3. 在聊天中发一张图，模型会自动调用工具识别

## 工具

| 工具 | 用途 |
|------|------|
| `vision_recognize` | 识别本地图片文件，传入文件路径和可选问题，返回文字描述 |

## 配置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `backend` | `api` | 视觉后端：`api`（Vision API）或 `cdp`（桌面应用 CDP） |
| `apiKey` | `""` | API 后端的 key（也可用环境变量 `OPENAI_API_KEY`） |
| `apiBase` | `""` | API 基础 URL（也可用环境变量 `OPENAI_BASE_URL`） |
| `apiModel` | `gpt-4o` | 视觉模型名 |
| `cdpExePath` | 自动检测 | 桌面应用路径（Windows/macOS 自动检测，Linux 需配置） |
| `cdpPort` | `9225` | CDP 调试端口 |
| `timeoutMs` | `60000` | 单次识别超时（毫秒） |
| `cacheMaxEntries` | `200` | 缓存最大条目数（LRU 淘汰） |
| `cdpTextareaSelector` | 默认 | CDP 后端的文本框 DOM 选择器 |
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

LLM 运行时 patching 同时：
1. `resolveModelInfo` — 在模型元数据中声明 `image` 输入模态（让 DSH 前端接受图片上传）
2. `listModels` — 在模型列表中也声明 `image` 支持
3. `stream` — 在发送给模型请求时剥离 `image` 块（纯文本模型不会收到图片，不会报错），并添加文字提示引导模型调用 `vision_recognize`
4. `registerAdapter` — 确保新注册的适配器也被上述 patch 覆盖

## 踩坑记录

开发过程中踩过的坑，供后来者避雷。

### 1. DSH 工具注册 API

`ctx.tool(...)` 旧写法不被支持，报错 `cannot get property "tool" without inject`。

**解决**：在插件定义中声明 `inject: ['tools']`，然后用 `ctx.tools.register()` 注册工具。

### 2. DSH LLM 适配器服务名

`ctx.get('adapters')` 返回的不是 LLM 适配器服务。

**解决**：用 `ctx.get('llm')` 获取 LLM 服务，从中取出 `runtime` 对象做 patching。

### 3. 前端阻止图片上传

DSH 前端检查模型的 `inputModalities`，纯文本模型（如 deepseek-v4-flash）不包含 `image`，前端会拦截图片上传，提示"当前模型不支持照片"。

**解决**：patch `resolveModelInfo` 和 `listModels`，在模型元数据中注入 `inputModalities: ['text', 'image']`。

### 4. 模型收到图片块报错

即使前端允许上传，发送给纯文本模型的请求如果包含 `image` 类型的 content block，模型会报错或忽略。

**解决**：patch `stream`，在发送请求前剥离所有 `image` 块，替换为文字提示 `[用户发送了图片（N张）。请使用 vision_recognize 工具识别图片内容，file_path 参数为：<路径>]`。

### 5. 新注册适配器未被 patch

初始 patch 只覆盖已注册的适配器。如果 DSH 在插件加载后注册了新适配器，新适配器不会被 patch。

**解决**：patch `registerAdapter`，拦截新注册的适配器并自动应用同样的 patch。

### 6. 模型不调用 vision_recognize 工具

模型收到图片路径提示后，可能选择用 bash 工具查找文件，而不是调用 `vision_recognize`。

**解决**：在系统提示词中明确指示"必须调用 `vision_recognize`，不要用 bash/ls/find"，在工具描述中也强调"不要用 bash 查找文件"。

### 7. SenseNova 视觉模型超时

商汤 SenseNova 的 `sensenova-6.7-flash-lite` 和 `sensenova-6.8-flash-lite` 声称支持图片输入，但所有图片 POST 请求都超时（纯文本请求正常，2 秒返回）。GET 请求正常，仅 POST `/chat/completions` 带图片时超时。

**解决**：换用 SiliconFlow + `deepseek-ai/DeepSeek-OCR`，1-2 秒稳定返回。

### 8. SiliconFlow 视觉模型被禁用

SiliconFlow 文档列出了多个视觉模型（Qwen2-VL-72B、deepseek-vl2 等），但实际调用返回 `Model disabled`。Qwen3-VL、GLM-5V-Turbo 等新模型名返回 `Model does not exist`。

**解决**：只有 `deepseek-ai/DeepSeek-OCR` 可用且免费，1-2 秒响应。

### 9. Windows symlink 大小写问题

DSH 的 `ensureSymlink` 函数用 `readlinkSync(link) === target` 比较路径，但 Windows 文件系统不区分大小写。symlink 的 target 可能是 `f:\...`（小写），而代码比较的是 `F:\...`（大写），导致 `===` 返回 false，symlinkSync 抛出 EEXIST，DSH 启动崩溃。

**解决**：在 Windows 上将路径比较改为不区分大小写（`toLowerCase()`）。已修复本地 `packages/boot/app-boot/lib/index.js`，需提交给 DSH 上游。

### 10. DSH 启动时端口被占用

之前运行的 DSH 进程被强制杀掉后，端口 3080 可能仍被占用。

**解决**：启动前用 `Get-NetTCPConnection -LocalPort 3080` 找到并杀掉占用进程。

## 更新插件

修改 `vision-bridge.mjs` 后，需要同步将 `cordis.patch.yml` 中的 `?v=N` 加一（击穿 ESM 缓存），保存补丁文件即热加载。

## 致谢

- 原插件 [doubao-vision-dsh](https://github.com/hawkongz/doubao-vision-dsh) by [hawkongz](https://github.com/hawkongz)
- DeepSeek Harness 插件生态
- [SiliconFlow](https://siliconflow.cn) 提供免费的 DeepSeek-OCR 模型

## 许可证

[MIT](LICENSE)
