// Package balancealert 余额分级提醒：估算消耗速度与预计可用时长，按等级状态机推送，
// 识别充值后自动「解除冷却并测试」。
//
// 数据来源：
//   - 监控渠道：余额快照差分（与余额同单位，含网关之外的消费）。
//   - 直连渠道：手动登记的预算 − 网关记录的账户侧费用。
//   - 实时：网关真实请求返回「余额 / 额度不足」（gateway.CredentialExhaustedReporter）。
package balancealert

import (
	"fmt"
	"math"
	"time"

	"github.com/bejix/upstream-ops/backend/notify"
	"github.com/bejix/upstream-ops/backend/storage"
)

// 估算窗口：近 1 小时反映突发，近 24 小时反映常态；取较大者偏保守，便于提前提醒。
const (
	burnShortWindow = time.Hour
	burnLongWindow  = 24 * time.Hour
	// 窗口内采样跨度不足该值时不估算，避免两次相邻采样的噪声放大成离谱的速度。
	burnMinSpan = 20 * time.Minute
)

// burnRateFromSnapshots 由余额快照估算每小时消耗。只累计下降段，余额上升（充值）不抵扣消耗。
func burnRateFromSnapshots(snaps []storage.BalanceSnapshot, now time.Time) (perHour float64, ok bool) {
	best := -1.0
	for _, window := range []time.Duration{burnShortWindow, burnLongWindow} {
		from := now.Add(-window)
		var first, last *storage.BalanceSnapshot
		decrease := 0.0
		for i := range snaps {
			s := &snaps[i]
			if s.SampledAt.Before(from) || s.SampledAt.After(now) {
				continue
			}
			if last != nil && s.Balance < last.Balance {
				decrease += last.Balance - s.Balance
			}
			if first == nil {
				first = s
			}
			last = s
		}
		if first == nil || last == nil {
			continue
		}
		span := last.SampledAt.Sub(first.SampledAt)
		if span < burnMinSpan {
			continue
		}
		rate := decrease / span.Hours()
		if rate > best {
			best = rate
		}
	}
	if best < 0 {
		return 0, false
	}
	return best, true
}

// burnRateFromCosts 由近 1h / 24h 的费用合计估算每小时消耗（直连渠道）。
// history 为该渠道已有数据的时长，用于新渠道不足 24h 时按实际时长折算，避免低估。
func burnRateFromCosts(cost1h, cost24h float64, history time.Duration) float64 {
	hours := 24.0
	if history > 0 && history < burnLongWindow {
		hours = math.Max(history.Hours(), 1)
	}
	return math.Max(cost1h, cost24h/hours)
}

// rechargeDetected 余额明显回升视为充值：涨幅 ≥ max(0.5, 前值的 5%)，过滤采样噪声与退款零头。
func rechargeDetected(prev, cur float64) bool {
	delta := cur - prev
	return delta >= math.Max(0.5, math.Abs(prev)*0.05)
}

// assessment 一次估算的结果。
type assessment struct {
	Level   string
	Balance float64
	// HasBalance 余额已知（未登记预算的直连渠道只有网关上报的状态，没有余额）。
	HasBalance  bool
	BurnPerHour *float64
	RunwayHours *float64
	Reason      string
}

// classify 根据余额、消耗速度和阈值确定等级。autoRunway=false 时只看手填阈值。
func classify(p notify.BalanceAlertPolicy, balance, threshold float64, burn float64, burnOK, autoRunway bool) assessment {
	a := assessment{Level: storage.BalanceLevelOK, Balance: balance, HasBalance: true}
	if burnOK {
		b := burn
		a.BurnPerHour = &b
		if burn > 0 && balance > 0 {
			r := balance / burn
			a.RunwayHours = &r
		}
	}
	if balance <= 0 {
		a.Level, a.Reason = storage.BalanceLevelExhausted, "余额已用尽"
		return a
	}
	runway := math.Inf(1)
	if a.RunwayHours != nil {
		runway = *a.RunwayHours
	}
	if autoRunway && p.RunwayCriticalHours > 0 && runway < p.RunwayCriticalHours {
		a.Level = storage.BalanceLevelCritical
		a.Reason = fmt.Sprintf("预计 %s后耗尽（低于 %s）", formatHours(runway), formatHours(p.RunwayCriticalHours))
		return a
	}
	switch {
	case threshold > 0 && balance < threshold:
		a.Level = storage.BalanceLevelWarn
		a.Reason = fmt.Sprintf("余额低于阈值 %s", money(threshold))
	case autoRunway && p.RunwayWarnHours > 0 && runway < p.RunwayWarnHours:
		a.Level = storage.BalanceLevelWarn
		a.Reason = fmt.Sprintf("预计 %s后耗尽（低于 %s）", formatHours(runway), formatHours(p.RunwayWarnHours))
	}
	return a
}

// decision 状态机输出：是否推送、推送哪个事件。
type decision struct {
	Send  bool
	Event storage.NotificationEvent
	// Recovered 从提醒等级回到正常（只在此前推送过时才发恢复）。
	Recovered bool
}

func repeatFor(p notify.BalanceAlertPolicy, level string) time.Duration {
	switch level {
	case storage.BalanceLevelWarn:
		return p.WarnRepeat
	case storage.BalanceLevelCritical:
		return p.CriticalRepeat
	case storage.BalanceLevelExhausted:
		return p.ExhaustedRepeat
	}
	return 0
}

func eventFor(level string) storage.NotificationEvent {
	switch level {
	case storage.BalanceLevelCritical:
		return storage.EventBalanceCritical
	case storage.BalanceLevelExhausted:
		return storage.EventBalanceExhausted
	case storage.BalanceLevelOK:
		return storage.EventBalanceRecovered
	}
	return storage.EventBalanceLow
}

// decide 等级升高立即推送；同级按重复间隔；降级不推送；回到正常且此前推送过则推送恢复。
// 静默期内一律不推送（状态照常更新）。
func decide(p notify.BalanceAlertPolicy, prev *storage.BalanceAlertState, next string, now time.Time) decision {
	if prev.SnoozeUntil != nil && prev.SnoozeUntil.After(now) {
		return decision{}
	}
	prevRank, nextRank := storage.BalanceLevelRank(prev.Level), storage.BalanceLevelRank(next)
	switch {
	case nextRank == 0:
		if prevRank > 0 && prev.LastSentLevel != "" && prev.LastSentLevel != storage.BalanceLevelOK {
			return decision{Send: true, Event: storage.EventBalanceRecovered, Recovered: true}
		}
		return decision{}
	case nextRank > prevRank:
		return decision{Send: true, Event: eventFor(next)}
	case nextRank == prevRank:
		repeat := repeatFor(p, next)
		if repeat <= 0 {
			// 同级不重复；但此前因静默等原因从未推送过时补发一次
			if prev.LastSentLevel != next {
				return decision{Send: true, Event: eventFor(next)}
			}
			return decision{}
		}
		if prev.LastSentAt == nil || prev.LastSentLevel != next || now.Sub(*prev.LastSentAt) >= repeat {
			return decision{Send: true, Event: eventFor(next)}
		}
	}
	return decision{}
}

func money(v float64) string {
	return fmt.Sprintf("$%.2f", v)
}

func formatHours(h float64) string {
	switch {
	case math.IsInf(h, 1):
		return "—"
	case h < 1:
		return fmt.Sprintf("%d 分钟", int(math.Max(1, math.Round(h*60))))
	case h < 48:
		return fmt.Sprintf("%.1f 小时", h)
	default:
		return fmt.Sprintf("%.1f 天", h/24)
	}
}
