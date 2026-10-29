package main

import (
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/bejix/upstream-ops/backend/config"
	"github.com/bejix/upstream-ops/backend/storage"
	"gorm.io/gorm"
)

// runMigrateDB 子命令：把旧库（默认 SQLite）的数据整库复制到当前配置的数据库（通常是 PostgreSQL）。
//
//	upstream-ops migrate-db -from-path /app/data/upstream-ops.db
//	upstream-ops migrate-db -from-driver mysql -from-url 'user:pass@tcp(host:3306)/db?parseTime=true'
//
// 目标库取自正常的配置 / 环境变量（DATABASE_DRIVER=postgres、DATABASE_HOST …），
// 必须为空库；迁移前请先停掉正在写旧库的服务。
func runMigrateDB(args []string) int {
	fs := flag.NewFlagSet("migrate-db", flag.ContinueOnError)
	configPath := fs.String("config", "", "path to config.yaml (target database comes from config/env)")
	fromDriver := fs.String("from-driver", "sqlite", "source driver: sqlite | mysql | postgres")
	fromPath := fs.String("from-path", "./data/upstream-ops.db", "source SQLite file (when -from-driver=sqlite)")
	fromURL := fs.String("from-url", "", "source DSN (when -from-driver is mysql / postgres)")
	batch := fs.Int("batch", 500, "rows per batch")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	cfg, _, err := config.LoadWithPath(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config failed: %v\n", err)
		return 1
	}
	dstCfg := cfg.Database.ToStorageConfig()

	srcCfg := storage.DBConfig{Driver: storage.DBDriver(*fromDriver), Path: *fromPath, DSN: *fromURL, MaxOpenConns: 4, MaxIdleConns: 2}
	if srcCfg.Driver == storage.DBDriverSQLite || srcCfg.Driver == "" {
		if _, err := os.Stat(*fromPath); err != nil {
			fmt.Fprintf(os.Stderr, "source sqlite file: %v\n", err)
			return 1
		}
	}
	if string(srcCfg.Driver) == string(dstCfg.Driver) && srcCfg.Path == dstCfg.Path && srcCfg.DSN == dstCfg.DSN {
		fmt.Fprintln(os.Stderr, "source and target are the same database; set DATABASE_DRIVER / DATABASE_* to the new database")
		return 1
	}

	src, err := storage.Open(srcCfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open source: %v\n", err)
		return 1
	}
	dst, err := storage.Open(dstCfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open target: %v\n", err)
		return 1
	}
	// 源库按当前模型补齐列，旧版本数据库也能读
	if err := storage.AutoMigrate(src); err != nil {
		fmt.Fprintf(os.Stderr, "migrate source schema: %v\n", err)
		return 1
	}

	fmt.Printf("copying %s -> %s\n", srcCfg.Driver, dstCfg.Driver)
	start := time.Now()
	results, err := storage.CopyAll(src, dst, storage.CopyOptions{
		BatchSize: *batch,
		Logf: func(format string, a ...any) {
			fmt.Printf("  "+format+"\n", a...)
		},
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "copy failed: %v\n", err)
		return 1
	}
	var total int64
	for _, r := range results {
		total += r.Rows
	}
	fmt.Printf("done: %d rows in %d tables, %s\n", total, len(results), time.Since(start).Round(time.Millisecond))
	return 0
}

// warnIfLegacySQLiteLeftBehind 换到 PostgreSQL / MySQL 后库是空的、但旧的 SQLite 文件还在：
// 多半是升级后忘了迁移数据，启动时大声提示怎么迁，避免用户以为数据丢了。
func warnIfLegacySQLiteLeftBehind(log *slog.Logger, dbCfg config.DatabaseConfig, db *gorm.DB) {
	driver := strings.ToLower(strings.TrimSpace(dbCfg.Driver))
	if driver == "" || driver == "sqlite" || driver == "sqlite3" {
		return
	}
	legacy := strings.TrimSpace(dbCfg.Path)
	if legacy == "" {
		legacy = "./data/upstream-ops.db"
	}
	info, err := os.Stat(legacy)
	if err != nil || info.Size() == 0 {
		return
	}
	var channels, groups int64
	db.Model(&storage.Channel{}).Count(&channels)
	db.Model(&storage.GatewayGroup{}).Count(&groups)
	if channels > 0 || groups > 0 {
		return
	}
	log.Warn("database is empty but a legacy SQLite file exists; migrate your data with: upstream-ops migrate-db -from-path "+legacy,
		"driver", driver, "sqlite", legacy)
}
