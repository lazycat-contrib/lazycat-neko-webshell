# Interface Material and Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有十套界面主题补齐共享材质层级、必要的弹层动效、按压反馈和完整的 reduced-motion 行为。

**Architecture:** 使用纯 CSS token 管理圆角、阴影、材质和时序。现有 hidden 属性继续作为组件开关，通过 `transition-behavior: allow-discrete` 与 `@starting-style` 渐进增强进出场，不引入 JavaScript 动画状态，也不扩张 `main.ts`。

**Tech Stack:** TypeScript、Vite、CSS Custom Properties、CSS Transitions、`@starting-style`

## Global Constraints

- 保留全部现有主题，不新增主题。
- 不向 `src/frontend/src/main.ts` 增加视觉或动效逻辑。
- 只动画 `transform` 和 `opacity`。
- 不给终端内容、Tab 切换、键盘快捷操作和移动端虚拟键盘增加等待动画。
- 不增加前端依赖。
- 提交、tag 和推送不属于实现步骤，按单独发布指令执行。

---

### Task 1: 共享材质、圆角和动效 token

**Files:**
- Modify: `src/frontend/src/styles.css`
- Modify: `src/frontend/src/webshell-themes.css`

**Interfaces:**
- Produces: `--radius-*`、`--motion-*`、`--ease-*`、`--shadow-popover`、`--app-material`、`--topbar-material`、`--dialog-material`、`--menu-material`

- [ ] **Step 1: 补齐默认 Steel token**

在 `:root` 中定义命名圆角、进入和退出时长、快速减速曲线、三级阴影和 Steel 的低透明度 wash 色。

- [ ] **Step 2: 接入应用外壳和顶栏**

将 `.webshell` 背景改为 `var(--app-material), var(--bg)`，将 `.topbar` 背景改为 `var(--topbar-material), var(--chrome)`，保持终端画布本身不变。

- [ ] **Step 3: 修正亮色 elevation**

在 `.webshell[data-interface-tone="light"]` 覆盖三级阴影和内高光，保证 Porcelain 等亮色主题的相邻表面可区分。

- [ ] **Step 4: 静态检查**

Run: `git diff --check`

Expected: exit 0，无空白错误。

### Task 2: 菜单和弹窗空间动效

**Files:**
- Modify: `src/frontend/src/styles.css`

**Interfaces:**
- Consumes: Task 1 的 `--motion-*`、`--ease-*`、`--menu-material`、`--dialog-material`
- Produces: `.ui-popover` 等价选择器组和 `.ui-modal` 等价选择器组的统一行为

- [ ] **Step 1: 统一菜单材质和 transform origin**

覆盖 `.switcher-menu`、`.new-tab-menu`、`.herdr-workspace-menu`、`.notifications-menu`、`.settings-menu`、`.pane-menu`，使用共享 menu material、`--shadow-popover` 和触发器方向 origin。

- [ ] **Step 2: 添加菜单进出场**

可见状态使用 `opacity: 1; transform: translateY(0) scale(1)`。hidden 状态使用 `opacity: 0; transform: translateY(-4px) scale(.98)`，并通过 `transition-behavior: allow-discrete` 与 `@starting-style` 支持进入和退出。

- [ ] **Step 3: 添加中心弹窗动效**

设置页、快捷键帮助、About 和通知确认框使用共享 scrim 透明度变化，内部 dialog 使用中心缩放和轻微向下位移。

- [ ] **Step 4: 收敛 About 特例**

移除 About 外壳和卡片的独立进入 keyframes，保留品牌标识和内容的低频细节动效，统一整体进出场节奏。

- [ ] **Step 5: 静态检查**

Run: `rg -n 'transition:\s*all|scale\(0\)' src/frontend/src/styles.css`

Expected: 新增代码中不存在 `transition: all` 或从 `scale(0)` 进入。

### Task 3: 插件侧栏和按压反馈

**Files:**
- Modify: `src/frontend/src/plugin-tools.css`
- Modify: `src/frontend/src/styles.css`

**Interfaces:**
- Consumes: Task 1 的 drawer 和 press token
- Produces: 右侧工具栏进入动效与常规控件的即时按压反馈

- [ ] **Step 1: 插件侧栏材质与进出场**

`.plugin-sidebar` 使用 dialog material，从右侧 `translateX(12px) scale(.995)` 进入，退出时更快。

- [ ] **Step 2: 常规控件按压反馈**

为 `.command-button`、`.icon-button`、`.tab-add`、`.switcher-button`、设置 Tab、菜单项、插件工具 Tab 添加 `:active:not(:disabled)` 缩放。排除 Tab 主按钮、终端画布控制和已有 transform 定位的按钮。

- [ ] **Step 3: 工具提示过渡**

插件工具提示只过渡 `opacity` 和 `transform`，并从工具按钮方向出现。

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`

Expected: exit 0。

### Task 4: 移动端和 reduced motion

**Files:**
- Modify: `src/frontend/src/mobile/styles.css`
- Modify: `src/frontend/src/styles.css`
- Modify: `src/frontend/src/plugin-tools.css`

**Interfaces:**
- Consumes: Task 1 至 Task 3 的共享动效规则
- Produces: 375px 视口下更短的反馈和无位移 reduced-motion 模式

- [ ] **Step 1: 移动端压缩时序**

在移动控件启用时，将普通触控按压反馈缩短到 80ms，不给 `.mobile-keyboard-page-tabs button` 和 `.mobile-keyboard-panel button` 增加 transform 过渡。

- [ ] **Step 2: 移动端弹层位移**

移动端菜单和侧栏的进入位移减半，保持安全区与软键盘 inset 现有布局。

- [ ] **Step 3: 完整 reduced-motion 覆盖**

在三个样式文件的 `prefers-reduced-motion` 中移除 transform 动效和 About keyframes，仅保留最多 120ms 的 opacity 变化。

- [ ] **Step 4: 样式检查**

Run: `git diff --check`

Expected: exit 0。

### Task 5: 自动化与浏览器验证

**Files:**
- Verify: `src/frontend/src/styles.css`
- Verify: `src/frontend/src/webshell-themes.css`
- Verify: `src/frontend/src/plugin-tools.css`
- Verify: `src/frontend/src/mobile/styles.css`

- [ ] **Step 1: 运行前端测试**

Run: `npm test`

Expected: 全部 Node test 通过，0 failures。

- [ ] **Step 2: 运行类型检查**

Run: `npm run typecheck`

Expected: exit 0。

- [ ] **Step 3: 运行生产构建**

Run: `npm run build`

Expected: Vite build exit 0。

- [ ] **Step 4: 桌面视觉验证**

在 1280px 或 1440px 宽度检查 Steel、Glass、Porcelain。逐一打开设置、右上菜单、通知确认框和插件侧栏，确认层级、transform origin、时长与关闭行为。

- [ ] **Step 5: 移动端视觉验证**

在 375px 宽度检查相同代表主题，确认无横向溢出、安全区布局不变、移动端键盘无延迟动画。

- [ ] **Step 6: reduced-motion 验证**

模拟 `prefers-reduced-motion: reduce`，确认弹层与侧栏没有位移和缩放动画。

- [ ] **Step 7: 最终差异检查**

Run: `git diff --check && git status --short`

Expected: 仅出现计划内四个样式文件和两份文档。
