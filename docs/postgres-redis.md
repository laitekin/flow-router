# PostgreSQL + Redis 存储方案

> 适用版本：本 PR 之后。默认 `docker-compose.yml` 使用 PostgreSQL + Redis；SQLite / MySQL 仍然支持。

## 1. 背景与目标

原来默认用 SQLite 单文件，代码里还给 SQLite 设了**单连接**（`MaxOpenConns=1`）。数据量上来以后有三个问题：

| 问题 | 表现 |
| --- | --- |
| 读写互相阻塞 | 看板 / 使用记录的聚合查询和网关写用量日志排在同一个连接上，查询一慢，转发请求的落库也跟着排队 |
| 只能单实例 | SQLite 文件只能被一个进程安全写入，无法水平扩容，也做不了主备 |
| 热路径重复读库 | 每个转发请求都要查 2 次库（密钥 + 分组）再写 1 次库（`last_used_at`） |

目标：

1. **持久化数据换到 PostgreSQL**：真正的并发读写、连接池、可多实例共享、成熟的备份 / 主从方案。
2. **引入 Redis 承载「可以丢、能重建」的数据**：缓存、节流标记、分布式锁，给数据库减负，并让多实例之间共享这些状态。
3. **不破坏现有部署**：SQLite / MySQL 继续可用；Redis 是可选项，不配置或宕机时自动回落到进程内内存。

## 2. 总体架构

```
              ┌──────────────── app 实例（可多个）────────────────┐
 客户端 ───▶  │  网关数据面  /v1/*            管理后台 /api/*       │
              │     │  鉴权缓存 / 节流             │ 看板结果缓存       │
              │     ▼                              ▼                   │
              │   kv.Store（Redis，或回落内存） ◀── 调度任务锁         │
              │     │ 未命中 / 故障时                                  │
              │     ▼                                                  │
              │   GORM ──────────────────────────────────────────────▶ PostgreSQL
              └────────────────────────────────────────────────────────┘
```

- **PostgreSQL 是唯一的事实来源（source of truth）**。所有业务数据、计费、额度、配置、日志都在这里。
- **Redis 只是加速层和协调层**。任何 Redis 数据丢失都只会让请求多查一次数据库，不会丢数据、不会算错钱。

## 3. 数据放哪里

### 3.1 判断原则

放 Redis 的数据必须同时满足：

1. **可重建**：丢了能从数据库重新算出来，或者丢了无所谓（节流标记、锁）。
2. **允许短暂不一致**：有明确的失效机制或很短的 TTL。
3. **读多写少或纯临时**。

不满足的一律留在 PostgreSQL。

### 3.2 归属清单

| 数据 | 存放 | 理由 |
| --- | --- | --- |
| 渠道、网关组、密钥、路由、直连渠道、价格覆盖、通知渠道、验证码配置 | **PostgreSQL** | 核心配置，必须持久 |
| 使用记录 `gateway_usage_logs`、费用、额度 `quota_used` | **PostgreSQL** | 计费与对账依据，不能丢；需要事务和聚合查询 |
| 倍率 / 余额快照、监控日志、通知日志、公告 | **PostgreSQL** | 历史数据，需要按时间查询和清理 |
| 路由临时冷却状态（`temp_unschedulable_*`） | **PostgreSQL（暂不迁）** | 管理端要展示「上次错误 / 请求 ID」，和路由配置在同一行；见 §8 后续规划 |
| 网关鉴权快照（密钥 + 分组） | **Redis** | 每个请求都读、极少变更；有版本号失效 |
| 密钥 `last_used_at` 写入节流标记 | **Redis** | 纯临时标记，丢了最多多写一次库 |
| `/v1/models` 响应 | **Redis** | 原本就是进程内缓存，换到 Redis 后多实例共享 |
| 看板聚合结果（使用统计、调度面板） | **Redis** | 只读聚合，10 秒内的旧数据可以接受 |
| 调度任务锁（余额扫描、倍率扫描、历史清理） | **Redis** | 多实例时保证同一任务只跑一份 |

## 4. PostgreSQL 支持

### 4.1 配置

| 环境变量 | 说明 | 默认 |
| --- | --- | --- |
| `DATABASE_DRIVER` | `postgres`（别名 `postgresql` / `pg`）、`sqlite`、`mysql` | `sqlite` |
| `DATABASE_URL` | 完整连接串，如 `postgres://user:pass@host:5432/db?sslmode=require`；设置后优先于下面分项 | 空 |
| `DATABASE_HOST` / `DATABASE_PORT` | 端口留空时按驱动取默认值：postgres 5432、mysql 3306 | `localhost` / 自动 |
| `DATABASE_USER` / `DATABASE_PASSWORD` / `DATABASE_NAME` | 账号与库名，密码中的特殊字符会自动转义 | — |
| `DATABASE_SSLMODE` | `disable` / `require` / `verify-full` 等 | `disable` |

连接池沿用 `database.maxOpenConns`（默认 20）/ `maxIdleConns`（默认 5），并新增 `ConnMaxLifetime=30m`、`ConnMaxIdleTime=5m`，避免长连接被中间的负载均衡或 pgbouncer 静默断开。

驱动用的是 `gorm.io/driver/postgres` + `pgx/v5`。

### 4.2 兼容性处理

代码里写死的 SQL 都在 SQLite 和 PostgreSQL 上跑过完整测试（见 §7），涉及以下改动：

| 差异 | 处理 |
| --- | --- |
| PG 的 `boolean` 不能和整数比较（`success = 1` 会报错） | 直接用布尔列：`CASE WHEN success …`、`f.success`、`NOT f.success`，三种数据库通用 |
| PG 的 `LIKE` 区分大小写，SQLite / MySQL 不区分 | 新增 `likeOp()`，在 PG 上用 `ILIKE`，各库搜索行为一致（直连渠道搜索、模型通配、Request ID） |
| PG 的 `text` 拒收 `\x00` 和非法 UTF-8 | 上游错误 body 按字节截断时可能把多字节字符切开，不处理的话整条用量记录会插入失败、计费丢失。写入前统一清洗（`sanitizeUsageText`） |
| SQLite 的时间存成文本，需要 `strftime` 表达式索引 | 只在 SQLite 上建；PG 直接用 `created_at` 上的 B-tree 索引 |
| 显式写入主键不会推进 PG 的序列 | 数据迁移完成后用 `setval` 把每张表的序列推到 `MAX(id)` |

### 4.3 索引

现有的 GORM 索引（`gateway_group_id`、`gateway_key_id`、`request_id`、`created_at`、`requested_model`，以及新加的 `upstream_model`）在 PG 上直接生效。PG 有 autovacuum 自动维护统计信息，不需要 SQLite 那套启动时 `ANALYZE`。

## 5. Redis 设计

### 5.1 抽象层 `backend/kv`

```go
type Store interface {
    Get / Set / Del
    SetNX       // 节流、加锁
    DelIfValue  // 只释放自己持有的锁（Redis 上用 Lua 保证原子性）
    Incr        // 失效版本号
}
```

- 有两个实现：`kv.Redis`（go-redis v9）和 `kv.Memory`（进程内，语义一致）。两者跑**同一套契约测试**。
- `kv.Open` 的规则：配置了 Redis 且 PING 通就用 Redis；没配置或连不上就回落 `Memory` 并打一条 Warn，**不阻止启动**。
- Redis 客户端超时设得很短（连接 2s、读写 500ms）：缓存宁可快速失败去查库，也不能拖慢请求。
- 所有 key 自动加前缀 `REDIS_KEY_PREFIX`（默认 `flowrouter:`），方便和其它业务共用一个 Redis。

### 5.2 Key 一览

| Key（不含前缀） | 值 | TTL | 写入 | 失效方式 |
| --- | --- | --- | --- | --- |
| `gw:authver` | 整数版本号 | 永久 | 密钥 / 分组写入后 `INCR` | — |
| `gw:auth:{ver}:{sha256(key)}` | gob 编码的密钥 + 分组快照 | 30s | 鉴权未命中时 | 版本号变化 + TTL |
| `gw:touch:{keyID}` | `1` | 60s | 每次请求 `SETNX` | TTL |
| `gw:models:{groupID}` | `/v1/models` 响应 JSON | `gateway.modelsCacheTTLSeconds`（默认 60s） | 未命中时 | 管理端改模型时 `DEL` + TTL |
| `api:cache:{hash(path+query)}` | 看板接口响应 JSON | 10s | 未命中时 | TTL |
| `sched:lock:{job}` | 随机 token | 10min | 任务开始时 `SETNX` | 任务结束后 `DelIfValue`；实例崩溃时等 TTL 过期 |

key 里只有密钥的 SHA-256 哈希，不含明文密钥。

### 5.3 鉴权缓存与一致性

这是唯一放在请求热路径上的缓存，所以单独说明它为什么安全。

**失效机制：版本号 + GORM 回调。**

- `storage.OnGatewayAuthChange` 在 GORM 的 create / update / delete 回调上挂钩子。`gateway_keys` 或 `gateway_groups` 有写入，就给 `gw:authver` 加 1。
- 缓存 key 里带着版本号，所以旧版本的缓存会**在所有实例上立即作废**，不需要逐个删除。
- 钩子挂在 ORM 层而不是管理接口里：以后新增的写入路径会自动覆盖，不会出现漏失效。

**热列例外。** 每个请求都会写 `last_used_at`、`quota_used`，这两列不影响鉴权。如果它们也触发失效，缓存永远不会命中，所以只改这两列（加 `updated_at`）时不加版本号。

**额度密钥不走缓存。** 设置了额度（`quota > 0`）的密钥每次都读库，拿最新的 `quota_used` 判断是否超额，行为和原来完全一致。只有不限额的密钥才缓存。

**兜底。** 如果 Redis 在版本号 `INCR` 时故障，旧缓存最多活 30 秒（TTL）。鉴权结果本身的校验（状态、IP 名单、分组状态）每次都在快照上重新执行。

**已验证。**

- 测试中先用原生 SQL 绕过回调改库：第二次鉴权读到的是旧值，证明确实走了缓存。
- 再走 GORM 禁用密钥 / 分组：下一次请求立即被拒。
- 端到端在真实 PG + Redis 上重复了一遍。

### 5.4 节流与锁

- **`last_used_at`**：原来每个请求写一次库，现在每个密钥每分钟最多写一次（多实例全局只写一次）。kv 出错时照常写库。
- **调度任务锁**：余额扫描、倍率扫描、历史清理都包了一层锁。
  - 多实例共用一个数据库时，同一任务只在一个实例上执行，避免重复扫描上游和重复发通知。
  - 单实例时也能防止上一轮还没跑完下一轮又开始。
  - 拿不到锁的实例跳过本轮；kv 故障时照常执行（宁可重复，不能漏跑）。

### 5.5 故障降级

| 场景 | 行为 |
| --- | --- |
| 未配置 Redis | 全部用进程内内存，功能与单实例完全一致 |
| 启动时 Redis 连不上 | Warn 日志，回落内存，正常启动 |
| 运行中 Redis 宕机 | 缓存读写失败按未命中处理并直接查库；节流放行；锁失败时任务照常执行；`/healthz` 返回 `kv_status: degraded`，但 HTTP 仍是 200 |
| Redis 数据被清空 / 淘汰 | 只会让下一个请求多查一次库 |

Redis 推荐不开持久化，并配置 `maxmemory-policy allkeys-lru`（compose 里已配好，默认上限 256MB）。

## 6. 部署与迁移

### 6.1 全新部署

```bash
cp .env.example .env   # 至少填 APP_SECRET、POSTGRES_PASSWORD
docker compose up -d
```

`docker-compose.yml` 现在包含 `postgres:16-alpine`、`redis:7-alpine` 和应用三个服务。应用要等前两者健康检查通过才会启动。

继续用 SQLite：`docker compose -f docker-compose.sqlite.yml up -d`
用 MySQL：`docker compose -f docker-compose.sqlite.yml -f docker-compose.mysql.yml up -d`

### 6.2 从 SQLite 迁移

旧数据在宿主机的 `data/upstream-ops.db`，新版 compose 仍然挂载 `./data`，迁移工具直接读它。

```bash
# 1. 备份旧库
cp data/upstream-ops.db data/upstream-ops.db.bak

# 2. 停掉旧服务，避免迁移期间还有写入
docker compose down

# 3. 在 .env 里设置 POSTGRES_PASSWORD，然后只启动 PostgreSQL 和 Redis
docker compose up -d postgres redis

# 4. 把 SQLite 数据整库复制到 PostgreSQL（目标库必须是空的）
docker compose run --rm app migrate-db -config /app/data/config.yaml -from-path /app/data/upstream-ops.db

# 5. 启动应用
docker compose up -d
```

`migrate-db` 的行为：

- **目标库**取自正常的配置 / 环境变量（compose 里已指向 postgres 服务）。
- **只写空库**：目标库任何一张表有数据都会整体拒绝，不会和已有数据混在一起。
- **类型转换**：
  - 按 Go 模型读写，SQLite 的文本时间、0/1 布尔会转换成 PG 的原生类型。
  - 写入用「列 → 值」的 map。GORM 的结构体写入会把 `default:true` 字段上的 `false` 当成零值替换为默认值；用 map 才能保住禁用状态。
- **其它**：清洗 PG 不接受的 `\x00` / 非法 UTF-8；大表按主键游标分页；最后重置自增序列。
- **其它来源**：从 MySQL 或另一个 PG 迁移用 `-from-driver mysql -from-url '…'`。

如果升级后忘了迁移，应用检测到「当前库为空，但旧 SQLite 文件还在」时，启动日志会打一条 Warn，并给出上面的迁移命令。

**回滚**：旧的 SQLite 文件迁移时只读不改。用 `docker-compose.sqlite.yml` 启动即可回到原状态。

### 6.3 Redis 配置

| 环境变量 | 说明 |
| --- | --- |
| `REDIS_URL` | `redis://:password@host:6379/0`，TLS 用 `rediss://`；优先于下面分项 |
| `REDIS_ADDR` / `REDIS_PASSWORD` / `REDIS_DB` | 分项配置 |
| `REDIS_KEY_PREFIX` | key 前缀，默认 `flowrouter:` |

`/healthz` 会返回 `kv`（`redis` / `memory`）和 `kv_status`。

## 7. 测试与验证

- **测试辅助**：`storage.OpenTestDB`。默认用 SQLite；设置 `TEST_DATABASE_URL` 后改连 PostgreSQL，每个测试一个独立的随机 schema，用完删除。所有包的测试都改用它，因此**整套后端测试可以原样在 PG 上跑**。
- **kv 契约测试**：设置 `TEST_REDIS_URL` 后，同一组断言同时在内存实现和 Redis 上跑。
- **新增 CI**（`.github/workflows/test.yml`）：
  - `sqlite`：SQLite + 内存 kv。
  - `postgres`：PostgreSQL 16 + Redis 7。
  - 前端构建。
  - 时区设为 `Asia/Shanghai`。部分统计按北京时间自然日分桶，在 UTC 下 `TestDashboardCostTrend` 本来就会失败，与本 PR 无关。
- **新增测试覆盖**：
  - 跨库迁移：大表分页、`Enabled=false` 保留、复合主键、序列重置、拒绝写非空库。
  - 文本清洗、大小写不敏感搜索。
  - 鉴权缓存命中与立即失效、额度密钥不缓存。
  - 失效回调忽略热列。
  - 调度锁互斥。
- **端到端验证**：用真实 PG 16 + Redis 7 跑了一遍：
  1. SQLite 演示库 → `migrate-db` → PG。
  2. 启动应用，检查使用记录、链路筛选、统计、调度面板。
  3. 新建分组（验证序列）、创建密钥、调用 `/v1/models`。
  4. 检查 Redis 里出现的 key。
  5. 禁用密钥后下一次请求立即返回 `api key disabled`。

## 8. 后续规划（本 PR 未做）

1. **用量预聚合表**：按分钟 / 小时汇总请求数、token、费用，看板直接读汇总表，「近 30 天」也能秒开。
2. **`gateway_usage_logs` 按月分区**（PG 声明式分区）：清理历史时直接 `DROP PARTITION`，不用大批量 `DELETE`。
3. **路由冷却状态放 Redis**：`SET route:cooldown:{id} EX n`。故障转移的判断不再读写数据库；最近错误仍异步写回 PG 供管理端展示。
4. **按密钥限流（RPM / TPM）**：基于 Redis 的滑动窗口计数，这是 Redis 引入后才方便做的新功能。
5. **额度扣减改为 Redis 原子计数 + 定期回写**：需要设计好崩溃时的对账，暂缓。
6. **`channelGroupsCache` 迁到 kv**：这块有后台刷新的单飞逻辑，单独改。
7. **Request ID 模糊搜索加 `pg_trgm` 索引**；读多时为看板配置只读副本。
