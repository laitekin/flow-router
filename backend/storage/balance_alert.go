package storage

import (
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// 余额提醒对象：监控渠道（channels）或直连渠道（gateway_providers）。
const (
	BalanceSubjectChannel  = "channel"
	BalanceSubjectProvider = "provider"
)

// 余额提醒等级，按严重程度递增。
const (
	BalanceLevelOK        = "ok"
	BalanceLevelWarn      = "warn"
	BalanceLevelCritical  = "critical"
	BalanceLevelExhausted = "exhausted"
)

// BalanceLevelRank 等级排序，未知等级视为 ok。
func BalanceLevelRank(level string) int {
	switch level {
	case BalanceLevelWarn:
		return 1
	case BalanceLevelCritical:
		return 2
	case BalanceLevelExhausted:
		return 3
	}
	return 0
}

// BalanceAlertState 余额提醒状态机的持久化状态，跨重启生效，避免重复轰炸。
type BalanceAlertState struct {
	SubjectKind string    `gorm:"primaryKey;size:16" json:"subject_kind"`
	SubjectID   uint      `gorm:"primaryKey" json:"subject_id"`
	Level       string    `gorm:"size:16;not null;default:'ok'" json:"level"`
	LevelSince  time.Time `json:"level_since"`
	// LastSentLevel / LastSentAt 最近一次推送，用于同级重复间隔。
	LastSentLevel string     `gorm:"size:16;not null;default:''" json:"last_sent_level,omitempty"`
	LastSentAt    *time.Time `json:"last_sent_at,omitempty"`
	LastBalance   *float64   `json:"last_balance,omitempty"`
	// 估算结果快照，便于列表页直接展示。
	BurnPerHour *float64 `json:"burn_per_hour,omitempty"`
	RunwayHours *float64 `json:"runway_hours,omitempty"`
	Reason      string   `gorm:"size:512;not null;default:''" json:"reason,omitempty"`
	// ExhaustedAt / ExhaustedBalance 网关实时报告耗尽时的时间与当时余额，用于识别充值。
	ExhaustedAt      *time.Time `json:"exhausted_at,omitempty"`
	ExhaustedBalance *float64   `json:"exhausted_balance,omitempty"`
	// RechargeAt 最近一次识别到充值（余额明显回升）。
	RechargeAt  *time.Time `json:"recharge_at,omitempty"`
	SnoozeUntil *time.Time `json:"snooze_until,omitempty"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

func (BalanceAlertState) TableName() string { return "balance_alert_states" }

type BalanceAlerts struct{ db *gorm.DB }

func NewBalanceAlerts(db *gorm.DB) *BalanceAlerts { return &BalanceAlerts{db: db} }

// Get 返回状态；不存在时返回 ok 等级的零值状态（未落库）。
func (r *BalanceAlerts) Get(kind string, id uint) (*BalanceAlertState, error) {
	var st BalanceAlertState
	err := r.db.Where("subject_kind = ? AND subject_id = ?", kind, id).First(&st).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return &BalanceAlertState{SubjectKind: kind, SubjectID: id, Level: BalanceLevelOK}, nil
	}
	if err != nil {
		return nil, err
	}
	return &st, nil
}

func (r *BalanceAlerts) Save(st *BalanceAlertState) error {
	return r.db.Clauses(clause.OnConflict{UpdateAll: true}).Create(st).Error
}

func (r *BalanceAlerts) List() ([]BalanceAlertState, error) {
	var rows []BalanceAlertState
	err := r.db.Order("subject_kind, subject_id").Find(&rows).Error
	return rows, err
}

// UrgentChannelIDs 处于紧急 / 已耗尽的监控渠道，调度器对它们加密采样。
func (r *BalanceAlerts) UrgentChannelIDs() ([]uint, error) {
	var ids []uint
	err := r.db.Model(&BalanceAlertState{}).
		Where("subject_kind = ? AND level IN ?", BalanceSubjectChannel, []string{BalanceLevelCritical, BalanceLevelExhausted}).
		Pluck("subject_id", &ids).Error
	return ids, err
}

// SetSnooze 设置静默截止时间；until 为 nil 取消静默。
func (r *BalanceAlerts) SetSnooze(kind string, id uint, until *time.Time) (*BalanceAlertState, error) {
	st, err := r.Get(kind, id)
	if err != nil {
		return nil, err
	}
	st.SnoozeUntil = until
	if st.LevelSince.IsZero() {
		st.LevelSince = time.Now()
	}
	return st, r.Save(st)
}

func (r *BalanceAlerts) Delete(kind string, id uint) error {
	return r.db.Where("subject_kind = ? AND subject_id = ?", kind, id).Delete(&BalanceAlertState{}).Error
}

// BalanceSnapshotsSince 返回渠道自 since 起的余额采样，按时间升序。
func (r *Rates) BalanceSnapshotsSince(channelID uint, since time.Time) ([]BalanceSnapshot, error) {
	var rows []BalanceSnapshot
	err := r.db.Where("channel_id = ? AND sampled_at >= ?", channelID, since).Order("sampled_at ASC").Find(&rows).Error
	return rows, err
}

// ProviderAccountCostSince 直连渠道自 since 起网关记录的账户侧费用合计。
func (r *GatewayUsageLogs) ProviderAccountCostSince(providerID uint, since time.Time) (float64, error) {
	var total *float64
	err := r.db.Model(&GatewayUsageLog{}).
		Where("gateway_provider_id = ? AND created_at >= ?", providerID, since).
		Select("SUM(account_stats_cost)").Scan(&total).Error
	if err != nil || total == nil {
		return 0, err
	}
	return *total, nil
}

// SubjectUsageCountsSince 自 since 起各监控渠道 / 直连渠道经网关的请求数，用于判断「在用」。
func (r *GatewayUsageLogs) SubjectUsageCountsSince(since time.Time) (channels map[uint]int64, providers map[uint]int64, err error) {
	type row struct {
		ChannelID         uint
		GatewayProviderID uint
		N                 int64
	}
	var rows []row
	err = r.db.Model(&GatewayUsageLog{}).
		Select("channel_id, gateway_provider_id, COUNT(*) AS n").
		Where("created_at >= ?", since).
		Group("channel_id, gateway_provider_id").Scan(&rows).Error
	channels, providers = map[uint]int64{}, map[uint]int64{}
	for _, x := range rows {
		if x.ChannelID != 0 {
			channels[x.ChannelID] += x.N
		}
		if x.GatewayProviderID != 0 {
			providers[x.GatewayProviderID] += x.N
		}
	}
	return channels, providers, err
}

// ValidateRechargeURL 充值链接会出现在通知与页面链接中：只允许 http(s)，空串表示用默认。
func ValidateRechargeURL(u string) error {
	u = strings.TrimSpace(u)
	if u == "" {
		return nil
	}
	lower := strings.ToLower(u)
	if (!strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://")) || len(u) > 512 || strings.ContainsAny(u, " \t\r\n") {
		return errors.New("recharge_url must be an http(s) URL")
	}
	return nil
}
