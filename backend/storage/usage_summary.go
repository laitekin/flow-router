package storage

import (
	"time"
)

// GatewayUsageStat 一个维度（网关组 / 密钥 / 路由 / 直连渠道）在时间窗内的用量汇总。
//
// 组和密钥按「请求」计（同一 request_id 的多次重试 / 顺延只算一次，链里任一次成功即成功），
// 反映客户端视角；路由和直连渠道按「尝试」计（每次尝试都真实打到了该上游），反映上游健康度。
type GatewayUsageStat struct {
	Requests        int64      `json:"requests"`
	Success         int64      `json:"success"`
	Cost            float64    `json:"cost"`
	Tokens          int64      `json:"tokens"`
	AvgDurationMS   float64    `json:"avg_duration_ms"`
	AvgFirstTokenMS *float64   `json:"avg_first_token_ms,omitempty"`
	LastAt          *time.Time `json:"last_at,omitempty"`

	durSum, ftSum float64
	ftCount       int64
	lastID        uint
}

func (s *GatewayUsageStat) add(o summaryRow) {
	s.Requests += o.Requests
	s.Success += o.Success
	s.Cost += o.Cost
	s.Tokens += o.Tokens
	s.durSum += o.DurSum
	s.ftSum += o.FtSum
	s.ftCount += o.FtCount
	if o.LastID > s.lastID {
		s.lastID = o.LastID
	}
}

func (s *GatewayUsageStat) finish(rows int64, lastAt map[uint]time.Time) {
	if rows > 0 {
		s.AvgDurationMS = s.durSum / float64(rows)
	}
	if s.ftCount > 0 {
		v := s.ftSum / float64(s.ftCount)
		s.AvgFirstTokenMS = &v
	}
	if t, ok := lastAt[s.lastID]; ok {
		s.LastAt = &t
	}
}

// GatewayUsageSummary 管理端各列表展示用的汇总（key 为对应实体 id）。
type GatewayUsageSummary struct {
	From      time.Time                  `json:"from"`
	To        time.Time                  `json:"to"`
	Groups    map[uint]*GatewayUsageStat `json:"groups"`
	Keys      map[uint]*GatewayUsageStat `json:"keys"`
	Routes    map[uint]*GatewayUsageStat `json:"routes"`
	Providers map[uint]*GatewayUsageStat `json:"providers"`
	rowCounts map[*GatewayUsageStat]int64
}

type summaryRow struct {
	GroupID    uint
	KeyID      uint
	RouteID    uint
	ProviderID uint
	RowCnt     int64
	Requests   int64
	Success    int64
	Cost       float64
	Tokens     int64
	DurSum     float64
	FtSum      float64
	FtCount    int64
	LastID     uint
}

const summaryAggCols = `
	COUNT(*) AS row_cnt,
	COALESCE(SUM(actual_cost), 0) AS cost,
	COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) AS tokens,
	COALESCE(SUM(duration_ms), 0) AS dur_sum,
	COALESCE(SUM(first_token_ms), 0) AS ft_sum,
	COUNT(first_token_ms) AS ft_count,
	MAX(id) AS last_id`

// Summary 时间窗内按组 / 密钥 / 路由 / 直连渠道汇总用量。两次带时间索引的 GROUP BY，
// 「最近使用时间」用 MAX(id) 再回表取 created_at（各库对 MAX(时间文本) 的扫描类型不一致）。
func (r *GatewayUsageLogs) Summary(from, to time.Time) (*GatewayUsageSummary, error) {
	out := &GatewayUsageSummary{
		From: from, To: to,
		Groups: map[uint]*GatewayUsageStat{}, Keys: map[uint]*GatewayUsageStat{},
		Routes: map[uint]*GatewayUsageStat{}, Providers: map[uint]*GatewayUsageStat{},
		rowCounts: map[*GatewayUsageStat]int64{},
	}
	q := GatewayUsageQuery{From: &from, To: &to}

	// 请求级：同一 request_id 只算一次，链里任一次成功即成功
	var byKey []summaryRow
	if err := r.applyFilters(r.db.Model(&GatewayUsageLog{}), q).
		Select(`gateway_group_id AS group_id, gateway_key_id AS key_id,
			COUNT(DISTINCT request_id) AS requests,
			COUNT(DISTINCT CASE WHEN success THEN request_id END) AS success,` + summaryAggCols).
		Group("gateway_group_id, gateway_key_id").
		Scan(&byKey).Error; err != nil {
		return nil, err
	}
	// 尝试级：每次尝试都真实打到了该路由 / 直连渠道
	var byRoute []summaryRow
	if err := r.applyFilters(r.db.Model(&GatewayUsageLog{}), q).
		Select(`route_id, gateway_provider_id AS provider_id,
			COUNT(*) AS requests,
			COALESCE(SUM(CASE WHEN success THEN 1 ELSE 0 END), 0) AS success,` + summaryAggCols).
		Group("route_id, gateway_provider_id").
		Scan(&byRoute).Error; err != nil {
		return nil, err
	}

	get := func(m map[uint]*GatewayUsageStat, id uint) *GatewayUsageStat {
		if m[id] == nil {
			m[id] = &GatewayUsageStat{}
		}
		return m[id]
	}
	lastIDs := map[uint]struct{}{}
	for _, row := range byKey {
		for _, s := range []*GatewayUsageStat{get(out.Groups, row.GroupID), get(out.Keys, row.KeyID)} {
			s.add(row)
			out.rowCounts[s] += row.RowCnt
		}
		lastIDs[row.LastID] = struct{}{}
	}
	for _, row := range byRoute {
		targets := []*GatewayUsageStat{}
		if row.RouteID > 0 {
			targets = append(targets, get(out.Routes, row.RouteID))
		}
		if row.ProviderID > 0 {
			targets = append(targets, get(out.Providers, row.ProviderID))
		}
		for _, s := range targets {
			s.add(row)
			out.rowCounts[s] += row.RowCnt
		}
		lastIDs[row.LastID] = struct{}{}
	}
	delete(out.Groups, 0)
	delete(out.Keys, 0)

	lastAt := map[uint]time.Time{}
	if len(lastIDs) > 0 {
		var rows []struct {
			ID        uint
			CreatedAt time.Time
		}
		if err := r.db.Model(&GatewayUsageLog{}).Select("id, created_at").
			Where("id IN ?", uintKeys(lastIDs)).Scan(&rows).Error; err != nil {
			return nil, err
		}
		for _, row := range rows {
			lastAt[row.ID] = row.CreatedAt
		}
	}
	for _, m := range []map[uint]*GatewayUsageStat{out.Groups, out.Keys, out.Routes, out.Providers} {
		for _, s := range m {
			s.finish(out.rowCounts[s], lastAt)
		}
	}
	return out, nil
}
