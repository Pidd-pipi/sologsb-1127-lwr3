# sologsb-1127 城市无障碍设施核验地图（gbaccessmap）

面向无障碍督导员与轮椅使用者代表，把坡道、盲道、无障碍电梯的点位、核验数据与通行路线集中到一张图上。

## 一键启动（Docker）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：<http://localhost:21827>

停止服务（镜像保留）：

```bash
docker compose down
```

## 技术栈

| 分层 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | Ant Design 5 + @ant-design/icons |
| 构建 | Vite 6（`tsc -b && vite build`，构建含类型检查） |
| 状态管理 | Zustand 5（业务数据 store + UI 偏好 persist 到 localStorage） |
| 路由 | React Router 6（BrowserRouter，nginx `try_files` 兜底） |
| 地图 | 高德地图 JS API（key 走 `VITE_AMAP_KEY`，留空时自动降级为本地 SVG 网格视图） |
| 本地存储 | IndexedDB（Dexie 4，库名 `gbaccessmap-db`）+ localStorage（表单草稿、UI 偏好） |
| 托管 | nginx:alpine（多阶段构建） |

## 核心功能

| 路由 | 说明 | 消费模型 |
| --- | --- | --- |
| `/` | 核验总览：按行政区与设施类型汇总点位数、合格率、待整改数，点击统计块下钻清单 | AccessPoint / Inspection / RectifyPlan |
| `/points/new` | 点位登记：地图打点或手填经纬度，可同时录入首次核验实测值 | AccessPoint / Inspection |
| `/points/:id` | 点位详情：地图定位与属性、核验历史、就地新增核验、整改跟踪 | 四个模型 |
| `/routes` | 通行路线编制：选点自动串联路段，逐段填障碍数/台阶数/路缘高差，输出全线判定 | RouteSegment / AccessPoint |
| `/map` | 设施地图：按设施类型着色渲染点位，点选弹出核验摘要 | AccessPoint / Inspection |
| `/rectify` | 整改清单：按状态与期限分组、逾期置顶，登记复检结果 | RectifyPlan / AccessPoint |
| `/batches` | 离线批次合并：核验员离线登记的批次回内网后整体贴入，待核对取舍与批次记录 | 四个模型 + BatchRecord / PendingConflict |

## 数据模型（`src/types/` 独立文件）

| 模型 | 文件 | 关键字段 |
| --- | --- | --- |
| AccessPoint | `src/types/point.ts` | 点位编号、名称、设施类型、经纬度、行政区、所在道路或建筑、建成年代、养护单位 |
| Inspection | `src/types/inspection.ts` | 核验日期、核验人、坡度 %、净宽 cm、扶手、盲道连续性、占用情况、结论、问题描述 |
| RouteSegment | `src/types/route.ts` | 路线名称、起点/终点点位、长度、障碍数、台阶数、路缘高差、是否可轮椅通行 |
| RectifyPlan | `src/types/rectify.ts` | 点位 id、整改要求、责任单位、整改期限、复检日期、状态 |

## 数据存储

- **IndexedDB（Dexie，库名 `gbaccessmap-db`）**：业务数据。含版本号与升级迁移：
  - `v1` 建 `points` / `inspections` 表；
  - `v2` 增加 `routes` 表与 `pointId` 相关索引；
  - `v3` 增加 `rectifies` 表，并为历史「不合格」核验补建整改条目；
  - `v4` 增加 `batches`（批次处理记录）/ `conflicts`（待核对）表，并给点位、核验、整改补 `batchId` 索引。
- **localStorage**：点位登记表单草稿（`gbaccessmap-draft:point-new`）与 UI 偏好（`gbaccessmap-ui`）。
- 首次打开时自动写入一批示例数据，便于直接体验。
- 容器无状态：不使用数据库服务、不挂载命名卷，清空浏览器存储即可重置数据。

## 高德地图 key

`VITE_AMAP_KEY` 留空（默认）时：`useAmapLoader()` 检测到 key 为空会**立即**返回降级标记，**不会**请求 `webapi.amap.com`；页面渲染可点选、可查看详情的本地 SVG 网格视图（`MapPanel`）。配置了 key 时脚本加载失败或超时同样自动降级，因此构建与运行都不依赖该 key。

## 目录结构

```
sologsb-1127/
├── docker-compose.yml          # 顶层 name: gbaccessmap，无 version: 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY
├── README.md
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files + gzip
    ├── index.html
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig*.json
    ├── public/favicon.svg
    └── src/
        ├── types/{point,inspection,route,rectify,batch}.ts
        ├── db/index.ts                     # Dexie 封装 + 版本迁移 + 示例数据
        ├── stores/{pointStore,routeStore,uiStore}.ts
        ├── components/common/{MapPanel,StatusBadge,FacilityIcon,MeasureInput,EmptyState}.tsx
        ├── hooks/{useAmapLoader,useInspectionFilter,useLocalDraft}.ts
        ├── pages/{Overview,PointNew,PointDetail,Routes,MapView,Rectify,BatchMerge}.tsx
        ├── layouts/AppLayout.tsx
        ├── router/index.tsx
        └── utils/{routeCheck,geo,format,batchMerge,sampleBatch}.ts
```

## 判定阈值（`src/utils/routeCheck.ts`）

- 坡度：≤ 5% 合格，> 5% 限期整改，> 8% 不合格；
- 净宽：≥ 120cm 合格，< 120cm 限期整改，< 90cm 不合格；
- 路缘高差：≤ 3cm 可轮椅通行，> 6cm 判定不可通行；存在台阶需绕行或增设坡道。

## 离线批次合并（`/batches`，`src/utils/batchMerge.ts`）

核验员在外网离线登记，回到内网后把批次 JSON 一次贴入，点位、核验、整改在**单个 IndexedDB 事务**内合并：

- **点位属性以台账为准**：台账没有该编号才作为新点位登记；台账已有则不覆盖。台账自上次同步后没动过才回填现场值；现场与台账**双方都改过**的字段写入 `conflicts` 表列「待核对」（可保留台账或人工采用现场），绝不用现场值静默覆盖；
- **核验去重**：同一核验人 + 同一日期 + 同一点位视为重复，库内已存在则丢弃现场记录，并给旧记录补上 `batchId` 批次身份继续参与统计；批次内重复直接校验失败；
- **整改取更晚有效值**：比较现场与台账条目的复检日期 / 更新时间 / 期限，取更晚一方的非空字段，旧值不会被空值清空；
- **级联重算**：点位（含坐标）或核验一变化，相关整改条目自动重算（最新核验不合格补建待整改、合格则关闭），相关路段按最新端点坐标重算长度与轮椅通行判定；
- **校验失败整批撤回**：结构 / 枚举 / 日期 / 引用完整性等校验在事务内外双层进行，任一失败事务回滚不留半截数据，失败批次登记到 `batches`（状态「失败」+ 原因），输入内容保留可直接修正重试；同一批次号成功合并后拒绝重复导入。

批次 JSON 形如 `{ "batchId", "inspector", "exportedAt", "syncedAt", "points": [...], "inspections": [...], "rectifies": [...] }`，页面提供「填入演示批次 / 错误批次」按钮。

端到端规则验证（fake-indexeddb，无浏览器）：

```bash
cd frontend
npm run verify:batch
```
