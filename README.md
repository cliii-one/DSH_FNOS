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
│   ├── manifest         # 应用元数据（appname=dsh）
│   ├── cmd/main         # 启停/状态控制脚本
│   ├── config/          # privilege + resource
│   ├── wizard/install   # 安装向导（端口等）
│   ├── ui/              # 桌面入口 config + 图标
│   ├── ICON.PNG         # 64x64 图标
│   └── ICON_256.PNG     # 256x256 图标
├── runner/
│   └── runner.js        # 自研运行器：启动 dsh web + 局域网反向代理
├── scripts/
│   └── assemble.sh      # 组装 DSH 本体进应用壳（供 Actions 调用）
├── .github/workflows/
│   └── build.yml        # 自动构建 + 发 Release
├── docs/BUILD.md        # 构建与发布说明
└── README.md
```

## 快速开始

### 构建全部交给 GitHub（NAS 零负担）

推送到 GitHub 后，Actions 每次手动触发或上游发版时自动构建并发布 Release。
本机 Arm 性能不足完全不影响——构建、打包全在 GitHub 服务器上完成。

### NAS 上一键安装

在 **已发布 Release** 后，NAS 的 SSH 终端执行：

```bash
# 1. 下载最新 fpk（跨架构版，x86/arm 通用）
wget -O /tmp/DSH.fpk https://github.com/<你的用户名>/DSH/releases/latest/download/DSH_all.fpk

# 2. 安装（或直接在飞牛应用中心手动上传安装）
appcenter-cli install-fpk /tmp/DSH.fpk
```

安装时向导保持默认（启用统一网关）即可，装完桌面出现 DSH 卡片，点开即用。
依赖：应用中心需已安装 `nodejs_v24` 运行时（manifest 已声明，缺失时应用中心会自动安装）。

## 端口约定

**默认不占用任何端口** —— 采用飞牛官方推荐的"统一网关"接入：

- 应用在安装目录创建 Unix Socket（`dsh.sock`）
- 飞牛网关把 `/app/dsh` 转发过来，转发前先校验 NAS 登录态
- 局域网任何设备打开 `http://NAS地址/app/dsh`，用飞牛账号登录即可使用

相比传统端口方案的三大好处：**零端口冲突**、**必须登录 NAS 才能访问**（不向局域网裸暴露）、WebSocket 原生支持。

向导里也保留了传统端口模式作为回退（关闭"启用统一网关"开关即可），默认端口 3082。

## 与官方版的差异

| 项目 | 官方 deepseek-harness | 本项目 DSH |
|------|----------------------|-----------|
| appname | `deepseek-harness` | `dsh` |
| 接入方式 | 端口 3080（局域网裸暴露） | 统一网关 `/app/dsh`（NAS 登录鉴权） |
| Node 运行时 | 自带 125MB 二进制 | 复用应用中心 `nodejs_v24`（包体小 90%+） |
| 版本 | 跟随打包时点 | CI 自动跟上游最新 |
| 数据 | `var/` + `home/` | 独立目录，互不影响 |
