// Package storage 提供 GORM 仓储与领域模型持久化。
package storage

import (
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	sqliteDriver "github.com/glebarez/sqlite"
	mysqlDriver "gorm.io/driver/mysql"
	postgresDriver "gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type DBDriver string

const (
	DBDriverSQLite   DBDriver = "sqlite"
	DBDriverMySQL    DBDriver = "mysql"
	DBDriverPostgres DBDriver = "postgres"
)

// normalizeDriver 统一驱动名：postgresql / pg / pgsql 都按 postgres 处理。
func normalizeDriver(d DBDriver) DBDriver {
	switch strings.ToLower(strings.TrimSpace(string(d))) {
	case "", "sqlite", "sqlite3":
		return DBDriverSQLite
	case "postgres", "postgresql", "pg", "pgsql":
		return DBDriverPostgres
	default:
		return DBDriver(strings.ToLower(strings.TrimSpace(string(d))))
	}
}

type DBConfig struct {
	Driver       DBDriver
	Path         string
	Host         string
	Port         int
	User         string
	Password     string
	Name         string
	MaxOpenConns int
	MaxIdleConns int
	// SSLMode 仅 PostgreSQL：disable / require / verify-full 等，空为 disable
	SSLMode string
	// Schema 仅 PostgreSQL：指定 search_path，空为默认 public（测试用它隔离）
	Schema string
	// DSN 完整连接串，非空时优先于上面的分项（如 postgres://user:pass@host/db?sslmode=require）
	DSN string
}

func (c DBConfig) port(def int) int {
	if c.Port > 0 {
		return c.Port
	}
	return def
}

func (c DBConfig) SQLitePath() string {
	if strings.TrimSpace(c.Path) != "" {
		return c.Path
	}
	return "./data/upstream-ops.db"
}

func (c DBConfig) MySQLDSN() string {
	return fmt.Sprintf(
		"%s:%s@tcp(%s:%d)/%s?charset=utf8mb4&parseTime=True&loc=Local",
		c.User, c.Password, c.Host, c.port(3306), c.Name,
	)
}

// PostgresDSN 用 URL 形式拼连接串，用户名 / 密码里的特殊字符由 url 负责转义。
func (c DBConfig) PostgresDSN() string {
	if dsn := strings.TrimSpace(c.DSN); dsn != "" {
		return dsn
	}
	host := strings.TrimSpace(c.Host)
	if host == "" {
		host = "localhost"
	}
	u := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(c.User, c.Password),
		Host:   fmt.Sprintf("%s:%d", host, c.port(5432)),
		Path:   "/" + c.Name,
	}
	q := url.Values{}
	sslMode := strings.TrimSpace(c.SSLMode)
	if sslMode == "" {
		sslMode = "disable"
	}
	q.Set("sslmode", sslMode)
	if schema := strings.TrimSpace(c.Schema); schema != "" {
		q.Set("search_path", schema)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// newGormLogger 关掉 GORM 默认 logger 对 ErrRecordNotFound 的告警噪音。
//
// 业务代码（如 Rates.Upsert）显式处理了"找不到就插入"，这种情况下 GORM 默认仍会
// 把 record not found 当 Warn 打出来，造成日志看起来满是错误其实没问题。
// IgnoreRecordNotFoundError = true 可以静默这类预期内的"未找到"。
func newGormLogger() logger.Interface {
	return logger.New(
		log.New(os.Stdout, "\r\n", log.LstdFlags),
		logger.Config{
			SlowThreshold:             200 * time.Millisecond,
			LogLevel:                  logger.Warn,
			IgnoreRecordNotFoundError: true,
			Colorful:                  true,
		},
	)
}

func Open(cfg DBConfig) (*gorm.DB, error) {
	driver := normalizeDriver(cfg.Driver)

	var dialector gorm.Dialector
	switch driver {
	case DBDriverSQLite:
		path := cfg.SQLitePath()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, fmt.Errorf("create sqlite dir: %w", err)
		}
		dialector = sqliteDriver.Open(path)
	case DBDriverMySQL:
		dsn := cfg.MySQLDSN()
		if strings.TrimSpace(cfg.DSN) != "" {
			dsn = cfg.DSN
		}
		dialector = mysqlDriver.Open(dsn)
	case DBDriverPostgres:
		dialector = postgresDriver.Open(cfg.PostgresDSN())
	default:
		return nil, fmt.Errorf("unsupported database driver: %s", cfg.Driver)
	}

	db, err := gorm.Open(dialector, &gorm.Config{
		Logger: newGormLogger(),
	})
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("get sql.DB: %w", err)
	}

	switch driver {
	case DBDriverSQLite:
		if err := db.Exec("PRAGMA journal_mode=WAL").Error; err != nil {
			return nil, fmt.Errorf("set sqlite journal mode: %w", err)
		}
		if err := db.Exec("PRAGMA busy_timeout=5000").Error; err != nil {
			return nil, fmt.Errorf("set sqlite busy timeout: %w", err)
		}
		sqlDB.SetMaxOpenConns(1)
		sqlDB.SetMaxIdleConns(1)
	default:
		sqlDB.SetMaxOpenConns(cfg.MaxOpenConns)
		sqlDB.SetMaxIdleConns(cfg.MaxIdleConns)
		// 连接池里的长连接定期换新，避免被中间的 LB / pgbouncer 静默断开后报错
		sqlDB.SetConnMaxLifetime(30 * time.Minute)
		sqlDB.SetConnMaxIdleTime(5 * time.Minute)
	}

	return db, nil
}

// AutoMigrate 启动时自动同步表结构。
func AutoMigrate(db *gorm.DB) error {
	if err := dropDeletedAtColumns(db); err != nil {
		return err
	}
	if err := dropObsoleteRateSiteColumns(db); err != nil {
		return err
	}
	// 仅 AutoMigrate 当前模型（网关未发布，不做「密钥→组」等历史数据迁移）
	if err := db.AutoMigrate(
		&Channel{},
		&AuthSession{},
		&CaptchaConfig{},
		&RateSnapshot{},
		&RateChangeLog{},
		&UpstreamAnnouncement{},
		&BalanceSnapshot{},
		&CostSnapshot{},
		&NotificationChannel{},
		&NotificationLog{},
		&NotificationCooldown{},
		&MonitorLog{},
		&GatewayGroup{},
		&GatewayKey{},
		&GatewayRoute{},
		&GatewayProvider{},
		&GatewayUsageLog{},
		&ModelPriceOverride{},
	); err != nil {
		return err
	}
	return ensureGatewayUsageIndexes(db)
}

// ensureGatewayUsageIndexes 补充 AutoMigrate 表达不了的使用记录索引。
//
// SQLite 的 created_at 存的是带时区文本，按时间筛选只能写成
// CAST(strftime('%s', created_at) AS INTEGER)（见 applyFilters），普通 created_at
// 索引对它无效，每次筛选都是全表扫描 + 逐行解析时间。这里建同一表达式的索引，
// 查询里的表达式必须与之逐字一致才会被规划器命中。
func ensureGatewayUsageIndexes(db *gorm.DB) error {
	if db.Dialector.Name() != "sqlite" {
		return nil
	}
	stmts := []string{
		"CREATE INDEX IF NOT EXISTS idx_gateway_usage_logs_created_unix ON gateway_usage_logs(CAST(strftime('%s', created_at) AS INTEGER))",
	}
	for _, stmt := range stmts {
		if err := db.Exec(stmt).Error; err != nil {
			return fmt.Errorf("create gateway usage index: %w", err)
		}
	}
	analyzeGatewayUsageIfStale(db)
	return nil
}

// analyzeGatewayUsageIfStale 没有统计信息时 SQLite 规划器会挑错索引：例如拿
// requested_model / request_id 索引做 GROUP BY、或按主键倒序扫描找 LIMIT 行，
// 放弃时间索引，在大表上退化成全表扫描（实测 10 万行时同一查询 ~200ms vs ~3ms）。
//
// 采样 ANALYZE（analysis_limit）不生成范围直方图，帮不上忙，只能完整 ANALYZE。
// 为了不每次启动都扫一遍大表，只在从未分析过、或行数与上次分析相比变化超过
// 一倍时才跑。失败不影响启动。
func analyzeGatewayUsageIfStale(db *gorm.DB) {
	var stat string
	// 从未 ANALYZE 过时 sqlite_stat1 不存在，直接查会报错刷日志
	var hasStatTable int64
	_ = db.Raw("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").
		Scan(&hasStatTable).Error
	if hasStatTable > 0 {
		_ = db.Raw(
			"SELECT stat FROM sqlite_stat1 WHERE idx = ?", "idx_gateway_usage_logs_created_unix",
		).Scan(&stat).Error
	}
	var analyzed int64
	if fields := strings.Fields(stat); len(fields) > 0 {
		analyzed, _ = strconv.ParseInt(fields[0], 10, 64)
	}
	var rows int64
	if err := db.Raw("SELECT COUNT(*) FROM gateway_usage_logs").Scan(&rows).Error; err != nil || rows == 0 {
		return
	}
	if analyzed > 0 && rows <= analyzed*2 && rows*2 >= analyzed {
		return
	}
	_ = db.Exec("ANALYZE gateway_usage_logs").Error
}

func dropObsoleteRateSiteColumns(db *gorm.DB) error {
	targets := []struct {
		table string
		model any
	}{
		{table: "rate_snapshots", model: &RateSnapshot{}},
		{table: "rate_change_logs", model: &RateChangeLog{}},
	}
	for _, target := range targets {
		if !db.Migrator().HasTable(target.model) {
			continue
		}
		hasColumn, err := tableHasColumn(db, target.table, "site_id")
		if err != nil {
			return fmt.Errorf("inspect obsolete %s.site_id: %w", target.table, err)
		}
		if !hasColumn {
			continue
		}
		if err := db.Migrator().DropColumn(target.model, "site_id"); err != nil {
			return fmt.Errorf("drop obsolete %s.site_id: %w", target.table, err)
		}
		hasColumn, err = tableHasColumn(db, target.table, "site_id")
		if err != nil {
			return fmt.Errorf("inspect obsolete %s.site_id after drop: %w", target.table, err)
		}
		if hasColumn && db.Dialector.Name() == "sqlite" {
			if err := db.Exec("ALTER TABLE " + target.table + " DROP COLUMN site_id").Error; err != nil {
				return fmt.Errorf("drop sqlite obsolete %s.site_id: %w", target.table, err)
			}
		}
	}
	return nil
}

func dropDeletedAtColumns(db *gorm.DB) error {
	targets := []struct {
		table string
		model any
	}{
		{table: "channels", model: &Channel{}},
		{table: "captcha_configs", model: &CaptchaConfig{}},
		{table: "notification_channels", model: &NotificationChannel{}},
	}

	for _, target := range targets {
		if !db.Migrator().HasTable(target.model) {
			continue
		}
		hasColumn, err := tableHasColumn(db, target.table, "deleted_at")
		if err != nil {
			return fmt.Errorf("inspect %s.deleted_at: %w", target.table, err)
		}
		if !hasColumn {
			continue
		}
		if err := db.Exec("DELETE FROM " + target.table + " WHERE deleted_at IS NOT NULL").Error; err != nil {
			return fmt.Errorf("delete soft-deleted rows from %s: %w", target.table, err)
		}
		if db.Migrator().HasIndex(target.model, "idx_"+target.table+"_deleted_at") {
			if err := db.Migrator().DropIndex(target.model, "idx_"+target.table+"_deleted_at"); err != nil {
				return fmt.Errorf("drop %s deleted_at index: %w", target.table, err)
			}
		}
		if err := db.Migrator().DropColumn(target.model, "deleted_at"); err != nil {
			return fmt.Errorf("drop %s.deleted_at: %w", target.table, err)
		}
		hasColumn, err = tableHasColumn(db, target.table, "deleted_at")
		if err != nil {
			return fmt.Errorf("inspect %s.deleted_at after drop: %w", target.table, err)
		}
		if hasColumn && db.Dialector.Name() == "sqlite" {
			if err := db.Exec("ALTER TABLE " + target.table + " DROP COLUMN deleted_at").Error; err != nil {
				return fmt.Errorf("drop sqlite %s.deleted_at: %w", target.table, err)
			}
		}
	}
	return nil
}

func tableHasColumn(db *gorm.DB, table, column string) (bool, error) {
	columns, err := db.Migrator().ColumnTypes(table)
	if err != nil {
		return false, err
	}
	for _, c := range columns {
		if strings.EqualFold(c.Name(), column) {
			return true, nil
		}
	}
	return false, nil
}
