# 剧场灯光 Cue 表编排器（gbcuesheet）

面向剧场灯光师与舞台监督的纯前端单页应用：把一台演出的**场次**、**灯位通道**与 **Cue 提示点**串成可执行的灯光编排，记录亮度、色温与过渡时间，并在排演后导出排演表。数据全部保存在浏览器本地，不依赖任何后端服务、数据库或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：**http://localhost:21803**

常用命令：

```bash
docker compose logs -f          # 查看日志
docker compose down             # 停止并移除容器
docker compose up -d --build    # 改动代码后重新构建
```

> 端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 `21803` → 容器 `80`）；项目名由 `COMPOSE_PROJECT_NAME` 控制（默认 `gbcuesheet`，同时作为容器名前缀 `${COMPOSE_PROJECT_NAME}-frontend`）。

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3（Composition API + `<script setup>`） | 全部页面为 SFC 单文件组件 |
| 语言 | TypeScript（`strict`，无 `any`） | `npm run build` 内含 `vue-tsc --noEmit` 类型检查 |
| UI 组件库 | Naive UI（暗色剧场主题） | 按需引入组件，无全局注册 |
| 构建工具 | Vite 6 | 路由级代码分割 + 依赖单独 vendor 分块 |
| 状态管理 | Pinia | 6 个 store，页面只读 store |
| 路由 | Vue Router 4（history 模式） | nginx `try_files` 做 SPA 回退 |
| 本地存储 | IndexedDB（Dexie 4 封装） | 含数据结构版本号与升级迁移逻辑 |
| 部署 | 多阶段 Dockerfile（node:20-alpine + nginx:alpine） | 构建期类型检查零错误 |

## 三、核心功能与路由

| 路由 | 页面 | 主要能力 | 消费模型 |
| --- | --- | --- | --- |
| `/sessions` | 场次编排 | 新建场次、上下调序、查看每场 Cue 数与过渡总时长、硬切衔接预警 | Session、Cue |
| `/sessions/:id/fixtures` | 灯位通道配置台 | 通道号排布、按灯位分组折叠、重复通道号高亮、灯位负载校验 | Fixture、Session |
| `/sessions/:id/cues` | Cue 编排时间轴 | 插入 / 复制 / 删除 Cue、拖拽调整先后、沿袭上一条参数、批量偏移过渡时间 | Cue、CueLevel |
| `/cues/:id/levels` | 通道电平编辑 | 逐通道设定亮度与色温、色温漂移检查、一键对齐基准色温 | CueLevel、Fixture |
| `/sheets` | 排演表生成与导出 | 勾选 Cue 组表、本地留存历史、预览 / 复制 / 下载纯文本 | RehearsalSheet、Cue |
| `/reconciliation` | 控台日志对账 | 分批导入日志（断点续传）、按编号/提示语/触发顺序配对、候选人工确认、偏差与缺段汇总 | LogImport、ConsoleLogEntry、ReconReport、Cue |

核心动作闭环：**建场次 → 配灯位通道 → 插入 Cue → 设定过渡与通道电平 → 导出排演表 → 演出后导入控台日志对账**。

## 四、本地开发

```bash
cd frontend
npm install
npm run dev        # 开发服务 http://localhost:21803
npm run build      # 类型检查 + 生产构建（产物在 frontend/dist）
npm run preview    # 预览构建产物 http://localhost:21803
```

要求 Node.js ≥ 20。

## 五、目录结构

```
sologsb-1103/
├── docker-compose.yml          # 顶层 name: gbcuesheet，无 version 字段
├── Dockerfile                  # 多阶段：node:20-alpine 构建 + nginx:alpine 托管
├── nginx.conf                  # SPA fallback（try_files）+ gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    └── src/
        ├── main.ts                 # 启动时先把本地数据载入 Pinia，再挂载视图
        ├── App.vue                 # 暗色主题外壳 + 侧边导航 + Message/Dialog Provider
        ├── types/                  # 6 个数据模型，一模型一文件
        │   ├── session.ts  fixture.ts  cue.ts  level.ts  sheet.ts  recon.ts
        ├── stores/                 # Pinia：跨页状态唯一来源
        │   ├── sessionStore.ts  cueStore.ts  fixtureStore.ts
        │   ├── levelStore.ts    sheetStore.ts  reconStore.ts
        ├── components/common/      # 共享组件
        │   ├── FadeBar.vue      # 渐变条：渐亮/保持/渐暗按比例绘制
        │   ├── ChannelChip.vue  # 通道标签：通道号 + 灯位色块 + 亮度百分比
        │   ├── BlankHint.vue    # 空态引导与新建入口
        │   ├── CueNoInput.vue   # Cue 编号输入与重号校验（支持 Q12.5）
        │   └── VirtualList.vue  # 异步定高虚拟列表：长日志按窗口读 IndexedDB，不卡页面
        ├── components/recon/       # 对账报告：配对行 / 未对上 Cue 行 / 报告视图
        ├── hooks/
        │   ├── useCueOrder.ts        # 按 cueNo 排序、重排落库、相邻过渡汇总
        │   └── useChannelConflict.ts # 重复通道号与灯位过载检测
        ├── pages/
        │   ├── SessionList.vue  FixtureBoard.vue  CueTimeline.vue
        │   ├── LevelEditor.vue  SheetList.vue  Reconciliation.vue
        ├── router/index.ts
        └── utils/
            ├── fade.ts        # 过渡时间格式化、色温一致性判定、排演表纯文本拼装
            ├── db.ts          # IndexedDB（Dexie）封装：版本号与升级迁移
            ├── export.ts      # 文本下载、文件名生成、剪贴板复制、偏差格式化
            ├── cueOrder.ts    # Cue 编号解析、比较、排序与位次计算
            ├── logParse.ts    # 控台日志行/块解析：多格式时间戳、Cue 编号、半行 carry
            ├── reconcile.ts   # 对账纯函数：编号锚定 + 触发顺序对齐 + 候选/偏差/缺段
            ├── reconExport.ts # 对账报告纯文本拼装
            ├── batch.ts       # 分批让出主线程调度
            ├── patch.ts       # 通道冲突 / 灯位负载纯函数
            └── id.ts          # 本地主键生成
```

## 六、数据存储说明

- 所有数据存放在**浏览器本地 IndexedDB**，数据库名 `gbcuesheet`，由 `src/utils/db.ts` 用 Dexie 统一封装；页面不直接读写数据库，只调用 store 的 action。
- 共 9 张表：`sessions`、`fixtures`、`cues`、`levels`、`sheets`、`appMeta`（元数据）、`logImports`（导入任务/断点）、`logEntries`（解析后的日志条目）、`reconReports`（对账报告）。
- **数据结构版本号**：`DB_VERSION = 3`。`version(1)` 定义初始结构；`version(2)` 新增 `updatedAt` / `sheetNo` 索引、`appMeta` 表并迁移既有数据；`version(3)` 仅新增日志对账三表，旧表无需迁移。
- 删除场次会级联清理其灯位通道、Cue、通道电平、排演表、日志导入任务（含条目）与对账报告；删除导入任务会清理其条目与报告；删除通道会清理对应的电平记录。
- **断点续传**：日志导入按 256KB 文件块读取、约每 300 行同事务落库条目与字节断点（断点始终在换行 / UTF-8 字符边界）；暂停、异常中断或刷新页面后，重新选择同一文件即从断点继续，已解析行不重不漏。重复时间戳会在行上标记。
- **配对策略**（`utils/reconcile.ts`）：① Cue 编号直接锚定（同号取时刻最接近计划者）；② 剩余条目做带带宽限制、单调不交叉的触发顺序对齐（DP），收益由提示语 bigram 相似度与时刻邻近决定；③ 配不准的保留候选（附分数与依据）而非强行配对，可在报告里人工确认 / 改配 / 取消。计划时刻由场次计划开演加前序过渡时长推算，偏差跨午夜自动折回；相邻有效触发间隔超过阈值记为日志缺段。
- **不卡页面**：导入分批读文件、分批落库；报告汇总分批遍历 IndexedDB（批次间让出主线程）；报告列表用定高虚拟列表按窗口取数，上万行日志也只渲染可视区。
- **容器无状态**：不使用数据库服务、不挂载命名卷；换浏览器或清理站点数据即等于清空。排演表与对账报告均以生成时刻的快照留档，之后修改 Cue 不影响历史记录。

## 七、容器化实现要点

- `Dockerfile` 多阶段构建：构建阶段 `node:20-alpine` 执行 `npm ci` + `npm run build`（含 `vue-tsc` 类型检查，任何类型错误都会中断镜像构建）；运行阶段 `nginx:alpine` 托管 `dist`。
- `nginx.conf` 开启 gzip（含 `text/css`、`application/javascript`、`image/svg+xml` 等），`location /` 使用 `try_files $uri $uri/ /index.html;` 支持前端路由直接访问与刷新，带 hash 的静态资源长缓存。
- `docker-compose.yml`：不写 `version:` 字段；顶层 `name: gbcuesheet` 兜底（避免中文目录名导致项目名为空）；`container_name: ${COMPOSE_PROJECT_NAME:-gbcuesheet}-frontend`；端口映射 `"${FRONTEND_PORT:-21803}:80"`。
- 首次启动前需 `cp .env.example .env`，之后 `docker compose up -d --build` 一条命令即可起服务。
