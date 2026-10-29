package storage

import (
	"fmt"
	"reflect"
	"strings"

	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

// CopyOptions 跨库数据迁移选项。
type CopyOptions struct {
	// BatchSize 每批读写行数；gateway_usage_logs 约 60 列，500 行远低于 PG 的 65535 参数上限
	BatchSize int
	// Logf 进度输出，可为 nil
	Logf func(format string, args ...any)
}

// CopyResult 单表迁移结果。
type CopyResult struct {
	Table string
	Rows  int64
}

// CopyAll 把 src 中全部模型的数据原样复制到 dst（典型场景：SQLite / MySQL → PostgreSQL）。
//
// 约定与保证：
//   - dst 会先 AutoMigrate；任一目标表非空则整体拒绝，避免和已有数据混在一起。
//   - 按 Go 模型读写，时间 / 布尔等类型差异交给各自驱动转换（SQLite 文本时间、0/1 布尔 → PG 原生类型）。
//   - 按「列名 → 值」的 map 写入：结构体 Create 遇到 default:true 的字段会把 Go 的 false
//     当零值换成默认值（Select("*") 也拦不住），Enabled=false 的行到目标库就变成了 true。
//   - 跳过模型钩子，保留原主键；PostgreSQL 上结束后把自增序列推到 MAX(id)。
func CopyAll(src, dst *gorm.DB, opts CopyOptions) ([]CopyResult, error) {
	if opts.BatchSize <= 0 {
		opts.BatchSize = 500
	}
	logf := opts.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	if err := AutoMigrate(dst); err != nil {
		return nil, fmt.Errorf("migrate target: %w", err)
	}
	models := AllModels()
	for _, m := range models {
		var n int64
		if err := dst.Model(m).Count(&n).Error; err != nil {
			return nil, fmt.Errorf("count target %T: %w", m, err)
		}
		if n > 0 {
			return nil, fmt.Errorf("target table for %T already has %d rows; migrate into an empty database", m, n)
		}
	}

	results := make([]CopyResult, 0, len(models))
	for _, m := range models {
		res, err := copyModel(src, dst, m, opts.BatchSize, logf)
		if err != nil {
			return results, err
		}
		results = append(results, res)
	}
	if dst.Dialector.Name() == "postgres" {
		for _, m := range models {
			if err := resetPostgresSequence(dst, m); err != nil {
				return results, err
			}
		}
	}
	return results, nil
}

func parseModel(db *gorm.DB, m any) (*schema.Schema, error) {
	stmt := &gorm.Statement{DB: db}
	if err := stmt.Parse(m); err != nil {
		return nil, err
	}
	return stmt.Schema, nil
}

func copyModel(src, dst *gorm.DB, m any, batch int, logf func(string, ...any)) (CopyResult, error) {
	sch, err := parseModel(src, m)
	if err != nil {
		return CopyResult{}, fmt.Errorf("parse %T: %w", m, err)
	}
	res := CopyResult{Table: sch.Table}
	if !src.Migrator().HasTable(m) {
		logf("%-28s skipped (not in source)", sch.Table)
		return res, nil
	}
	elem := reflect.TypeOf(m).Elem()
	w := dst.Session(&gorm.Session{SkipHooks: true}).Table(sch.Table)
	ctx := src.Statement.Context

	// 单一整数主键走 keyset 分页（大表 O(n)）；复合主键的小表走 offset 分页
	pk := sch.PrioritizedPrimaryField
	keyset := pk != nil && len(sch.PrimaryFields) == 1 &&
		(pk.DataType == schema.Uint || pk.DataType == schema.Int)
	order := make([]string, 0, len(sch.PrimaryFields))
	for _, f := range sch.PrimaryFields {
		order = append(order, f.DBName)
	}

	var lastKey any
	offset := 0
	for {
		rows := reflect.New(reflect.SliceOf(elem))
		q := src.Model(m).Order(strings.Join(order, ", ")).Limit(batch)
		if keyset {
			if lastKey != nil {
				q = q.Where(pk.DBName+" > ?", lastKey)
			}
		} else {
			q = q.Offset(offset)
		}
		if err := q.Find(rows.Interface()).Error; err != nil {
			return res, fmt.Errorf("read %s: %w", sch.Table, err)
		}
		n := rows.Elem().Len()
		if n == 0 {
			break
		}
		maps := make([]map[string]any, 0, n)
		for i := 0; i < n; i++ {
			rv := rows.Elem().Index(i)
			sanitizeStrings(rv)
			row := make(map[string]any, len(sch.DBNames))
			for _, f := range sch.Fields {
				if f.DBName == "" {
					continue
				}
				v, _ := f.ValueOf(ctx, rv)
				row[f.DBName] = v
			}
			maps = append(maps, row)
		}
		if err := w.Create(&maps).Error; err != nil {
			return res, fmt.Errorf("write %s: %w", sch.Table, err)
		}
		res.Rows += int64(n)
		if keyset {
			lastKey = rows.Elem().Index(n - 1).FieldByIndex(pk.StructField.Index).Interface()
		}
		offset += n
		if res.Rows%int64(batch*20) == 0 {
			logf("%-28s %d rows...", sch.Table, res.Rows)
		}
		if n < batch {
			break
		}
	}
	logf("%-28s %d rows", sch.Table, res.Rows)
	return res, nil
}

// sanitizeStrings 清洗结构体里所有 string 字段：SQLite 能存进 \x00 / 非法 UTF-8，PG 不收。
func sanitizeStrings(v reflect.Value) {
	for i := 0; i < v.NumField(); i++ {
		f := v.Field(i)
		switch {
		case f.Kind() == reflect.String && f.CanSet():
			f.SetString(cleanDBText(f.String()))
		case f.Kind() == reflect.Struct && v.Type().Field(i).Anonymous:
			sanitizeStrings(f)
		}
	}
}

// resetPostgresSequence 显式写入主键不会推进序列，迁移后新插入会撞主键，这里推到 MAX(id)。
func resetPostgresSequence(db *gorm.DB, m any) error {
	sch, err := parseModel(db, m)
	if err != nil {
		return err
	}
	pk := sch.PrioritizedPrimaryField
	if pk == nil || !pk.AutoIncrement {
		return nil
	}
	sql := fmt.Sprintf(
		"SELECT setval(pg_get_serial_sequence('%s', '%s'), COALESCE(MAX(%s), 1), MAX(%s) IS NOT NULL) FROM %s",
		sch.Table, pk.DBName, pk.DBName, pk.DBName, sch.Table,
	)
	if err := db.Exec(sql).Error; err != nil {
		return fmt.Errorf("reset sequence %s: %w", sch.Table, err)
	}
	return nil
}
