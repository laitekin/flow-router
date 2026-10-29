package storage

import (
	"gorm.io/gorm"
)

// gatewayAuthTables 写入后会影响网关鉴权结果（密钥状态 / IP 名单 / 额度上限 / 分组状态等）的表。
var gatewayAuthTables = map[string]bool{
	"gateway_keys":   true,
	"gateway_groups": true,
}

// gatewayKeyHotColumns 每次请求都会写的列：只改这些不影响鉴权，不应让鉴权缓存失效，
// 否则缓存永远命中不了。
var gatewayKeyHotColumns = map[string]bool{
	"last_used_at": true,
	"quota_used":   true,
	"updated_at":   true,
}

// OnGatewayAuthChange 在 gateway_keys / gateway_groups 发生影响鉴权的写入（增删改）后调用 fn。
//
// 挂在 GORM 回调上而不是散落在各个管理接口里：以后新增的写入路径也自动覆盖，
// 不会出现「改了密钥状态缓存却没失效」的遗漏。fn 应当轻量且不返回错误
// （通常是给缓存版本号 +1）。同一个 *gorm.DB 只应注册一次。
func OnGatewayAuthChange(db *gorm.DB, fn func()) error {
	hook := func(tx *gorm.DB) {
		if tx.Error != nil || tx.Statement == nil || tx.Statement.RowsAffected == 0 {
			return
		}
		table := tx.Statement.Table
		if table == "" && tx.Statement.Schema != nil {
			table = tx.Statement.Schema.Table
		}
		if !gatewayAuthTables[table] {
			return
		}
		if table == "gateway_keys" && onlyHotColumns(tx.Statement.Dest) {
			return
		}
		fn()
	}
	cb := db.Callback()
	if err := cb.Create().After("gorm:create").Register("flowrouter:gateway_auth_create", hook); err != nil {
		return err
	}
	if err := cb.Update().After("gorm:update").Register("flowrouter:gateway_auth_update", hook); err != nil {
		return err
	}
	return cb.Delete().After("gorm:delete").Register("flowrouter:gateway_auth_delete", hook)
}

func onlyHotColumns(dest any) bool {
	var cols []string
	switch m := dest.(type) {
	case map[string]any:
		for k := range m {
			cols = append(cols, k)
		}
	case *map[string]any:
		for k := range *m {
			cols = append(cols, k)
		}
	default:
		return false
	}
	if len(cols) == 0 {
		return false
	}
	for _, c := range cols {
		if !gatewayKeyHotColumns[c] {
			return false
		}
	}
	return true
}
