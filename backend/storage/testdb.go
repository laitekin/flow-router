package storage

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"gorm.io/gorm"
)

// TestDatabaseURLEnv 设置后测试改跑 PostgreSQL（如 postgres://u:p@127.0.0.1:5432/db?sslmode=disable）。
const TestDatabaseURLEnv = "TEST_DATABASE_URL"

// OpenTestDB 给测试开一个已迁移好的独立库，返回清理函数。
//
// 默认在 dir 下建 SQLite 文件；设置了 TEST_DATABASE_URL 时连 PostgreSQL，
// 每次新建一个随机 schema 并把 search_path 指过去，清理时整个 schema 删掉，
// 测试之间互不干扰，也能并行。
//
// 放在非 _test 文件里是为了让其它包的测试也能复用（_test 里的函数跨包不可见），
// 因此这里不引入 testing 包。
func OpenTestDB(dir string) (*gorm.DB, func(), error) {
	base := strings.TrimSpace(os.Getenv(TestDatabaseURLEnv))
	if base == "" {
		db, err := Open(DBConfig{
			Driver:       DBDriverSQLite,
			Path:         filepath.Join(dir, "test.db"),
			MaxOpenConns: 20,
			MaxIdleConns: 5,
		})
		if err != nil {
			return nil, nil, err
		}
		if err := AutoMigrate(db); err != nil {
			return nil, nil, err
		}
		return db, closeDB(db), nil
	}

	admin, err := Open(DBConfig{Driver: DBDriverPostgres, DSN: base, MaxOpenConns: 2, MaxIdleConns: 1})
	if err != nil {
		return nil, nil, fmt.Errorf("open admin conn: %w", err)
	}
	buf := make([]byte, 6)
	_, _ = rand.Read(buf)
	schema := "t_" + hex.EncodeToString(buf)
	if err := admin.Exec("CREATE SCHEMA " + schema).Error; err != nil {
		closeDB(admin)()
		return nil, nil, fmt.Errorf("create schema: %w", err)
	}
	dsn, err := withSearchPath(base, schema)
	if err != nil {
		closeDB(admin)()
		return nil, nil, err
	}
	db, err := Open(DBConfig{Driver: DBDriverPostgres, DSN: dsn, MaxOpenConns: 10, MaxIdleConns: 2})
	if err != nil {
		closeDB(admin)()
		return nil, nil, err
	}
	cleanup := func() {
		closeDB(db)()
		_ = admin.Exec("DROP SCHEMA IF EXISTS " + schema + " CASCADE").Error
		closeDB(admin)()
	}
	if err := AutoMigrate(db); err != nil {
		cleanup()
		return nil, nil, err
	}
	return db, cleanup, nil
}

func withSearchPath(dsn, schema string) (string, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return "", fmt.Errorf("parse %s: %w", TestDatabaseURLEnv, err)
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func closeDB(db *gorm.DB) func() {
	return func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	}
}
