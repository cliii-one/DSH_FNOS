# DSH for fnOS

> 在飞牛 fnOS（trim）上运行 **DeepSeek Harness** 的第三方应用打包项目。
> 通过 GitHub Actions 自动拉取 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 最新源码构建，组装成 fnOS 应用壳并打出 `.fpk` 安装包，发布到 Release。

## 项目定位

本仓库**不改 DSH 源码**，只做三件事：

1. **构建**：CI 上拉上游 master 源码，`pnpm install + pnpm run build` 得到 DSH 本体
2. **组装**：把 DSH 本体 + fnOS 应用壳（manifest / cmd / wizard / ui / 图标）拼成完整应用目录
3. **打包**：`fnpack build` 产出 `.fpk`，发到 GitHub Release，NAS 上下载即装

## 目录结构

```
DSH/
├── appshell/            # fnOS 应用壳（打包用）
│   ├── manifest         # 应用元数据（appname=DSH）
│   ├── cmd/main         # 启停/状态控制脚本
│   ├── config/          # privilege + resource
│   ├── wizard/install   # 安装向导（端口等）
│   ├── ui/              # 桌面入口 config + 图标
│   ├── ICON.PNG         # 64x64 图标
│   └── ICON_256.PNG     # 256x256 图标
├── runner/
│   └── runner.js        # 自研运行器：启动 dsh web + 局域网反向代理
├── scripts/
│   ├── build-local.sh   # 本机一键：构建上游 + 组装 + 打包
│   └── assemble.sh      # CI 用：组装 DSH 本体进应用壳（供 Actions 调用）
├── .github/workflows/
│   └── build.yml        # 自动构建 + 发 Release
├── docs/BUILD.md        # 构建与发布说明
└── README.md
```

## 快速开始

### NAS 上一键安装（推荐）

在 **已发布 Release** 后，NAS 的 SSH 终端执行：

```bash
# 1. 下载最新 fpk（arm64 版）
wget -O /tmp/DSH.fpk https://github.com/<你的用户名>/DSH/releases/latest/download/DSH_arm64.fpk

# 2. 安装（或直接在飞牛应用中心手动上传安装）
appcenter-cli install-fpk /tmp/DSH.fpk --env /tmp/dsh.env
```

安装时向导会要求填服务端口（默认 3082），装完桌面出现 DSH 卡片，点开即用。

### 本机开发构建

```bash
# 在 fnOS 或任意 arm64/x86_64 Linux 上
cd DSH
./scripts/build-local.sh          # 全流程：拉源码→构建→组装→fnpack
# 产物在 dist/DSH_arm64.fpk
```

### CI 自动构建

推送到 GitHub 后，Actions 每次手动触发或上游发版时自动构建并发布 Release。

## 端口约定

| 端口 | 用途 |
|------|------|
| 3082 | 对外服务（局域网反向代理） |
| 3083 | DSH 内部端口（仅 127.0.0.1） |

与官方已装的 `deepseek-harness`（3080/3081）并存不冲突。安装向导里可改。

## 与官方版的差异

| 项目 | 官方 deepseek-harness | 本项目 DSH |
|------|----------------------|-----------|
| appname | `deepseek-harness` | `DSH` |
| 端口 | 3080 / 3081 | 3082 / 3083 |
| 版本 | 跟随打包时点 | CI 自动跟上游最新 |
| 数据 | `var/` + `home/` | 独立目录，互不影响 |
