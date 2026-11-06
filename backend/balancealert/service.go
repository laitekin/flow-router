package balancealert

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/bejix/upstream-ops/backend/gateway"
	"github.com/bejix/upstream-ops/backend/notify"
	"github.com/bejix/upstream-ops/backend/storage"
)

// Dispatcher 通知出口（*notify.Dispatcher）。
type Dispatcher interface {
	Dispatch(ctx context.Context, msg notify.Message) error
	Policy() notify.Policy
}

// Gateway 冷却查询与「解除冷却并测试」（*gateway.Service）。
type Gateway interface {
	RouteCooldowns(groupID uint) ([]gateway.RouteCooldownState, error)
	ReleaseRouteCooldown(ctx context.Context, routeID uint, in gateway.ReleaseCooldownInput) (*gateway.ReleaseCooldownResult, error)
}

type Deps struct {
	States     *storage.BalanceAlerts
	Channels   *storage.Channels
	Providers  *storage.GatewayProviders
	Rates      *storage.Rates
	Usage      *storage.GatewayUsageLogs
	Groups     *storage.GatewayGroups
	Routes     *storage.GatewayRoutes
	Dispatcher Dispatcher
	Gateway    Gateway
	Log        *slog.Logger
}

// providerEvalInterval 直连渠道预算估算间隔（只读本地库，开销很小）。
const providerEvalInterval = 5 * time.Minute

// releaseTimeout 充值后自动解除冷却的总时长上限（每条路由的探测另有自身超时）。
const releaseTimeout = 5 * time.Minute

type Service struct {
	Deps
	now func() time.Time

	// mu 串行化状态读改写；推送在锁外进行，避免慢通知阻塞其它渠道。
	mu sync.Mutex

	countsMu  sync.Mutex
	countsAt  time.Time
	chCounts  map[uint]int64
	prvCounts map[uint]int64

	tickMu        sync.Mutex
	lastUrgent    time.Time
	lastProviders time.Time

	relMu     sync.Mutex
	releasing map[string]bool
	wg        sync.WaitGroup
}

func New(d Deps) *Service {
	return &Service{Deps: d, now: time.Now, releasing: map[string]bool{}}
}

func (s *Service) policy() notify.BalanceAlertPolicy {
	if s.Dispatcher == nil {
		return notify.BalanceAlertPolicy{}
	}
	return s.Dispatcher.Policy().Balance
}

// Wait 等待后台的自动解除任务结束（测试与优雅退出用）。
func (s *Service) Wait() { s.wg.Wait() }

// ---------- 对象与在用路由 ----------

type subject struct {
	Kind        string
	ID          uint
	Name        string
	RechargeURL string
	Threshold   float64
	// 直连渠道预算
	Budget *float64
}

func (sj subject) key() string { return fmt.Sprintf("%s:%d", sj.Kind, sj.ID) }

func (sj subject) label() string {
	if sj.Kind == storage.BalanceSubjectProvider {
		return "直连渠道「" + sj.Name + "」"
	}
	return "渠道「" + sj.Name + "」"
}

func channelSubject(c *storage.Channel) subject {
	return subject{Kind: storage.BalanceSubjectChannel, ID: c.ID, Name: c.Name, RechargeURL: channelRechargeURL(c), Threshold: c.BalanceThreshold}
}

func providerSubject(p *storage.GatewayProvider) subject {
	return subject{Kind: storage.BalanceSubjectProvider, ID: p.ID, Name: p.Name, RechargeURL: strings.TrimSpace(p.RechargeURL), Threshold: p.BudgetThreshold, Budget: p.BudgetAmount}
}

// channelRechargeURL 优先用渠道上填写的充值链接；NewAPI 默认 /console/topup，其它站点回退到站点首页。
func channelRechargeURL(c *storage.Channel) string {
	if u := strings.TrimSpace(c.RechargeURL); u != "" {
		return u
	}
	site := strings.TrimRight(strings.TrimSpace(c.SiteURL), "/")
	if site == "" {
		return ""
	}
	if c.Type == storage.ChannelTypeNewAPI {
		return site + "/console/topup"
	}
	return site
}

type routeUse struct {
	RouteID   uint
	GroupID   uint
	GroupName string
	Position  int
	HasBackup bool
}

func routeSubject(r *storage.GatewayRoute) (string, uint) {
	if r.NormalizeSourceKind() == storage.GatewayRouteSourceProvider {
		return storage.BalanceSubjectProvider, r.GatewayProviderID
	}
	return storage.BalanceSubjectChannel, r.SourceChannelID
}

// routesUsing 引用该对象的启用路由，及所在分组是否还有其它对象的启用路由可承接。
func (s *Service) routesUsing(kind string, id uint) ([]routeUse, error) {
	if s.Groups == nil || s.Routes == nil {
		return nil, nil
	}
	groups, err := s.Groups.List()
	if err != nil {
		return nil, err
	}
	var out []routeUse
	for _, g := range groups {
		if strings.EqualFold(g.Status, "disabled") {
			continue
		}
		routes, err := s.Routes.ListByGroupID(g.ID)
		if err != nil {
			return nil, err
		}
		var mine []storage.GatewayRoute
		backup := false
		for i := range routes {
			r := routes[i]
			if !r.Enabled {
				continue
			}
			if k, rid := routeSubject(&r); k == kind && rid == id {
				mine = append(mine, r)
			} else {
				backup = true
			}
		}
		for _, r := range mine {
			out = append(out, routeUse{RouteID: r.ID, GroupID: g.ID, GroupName: g.Name, Position: r.Position, HasBackup: backup})
		}
	}
	return out, nil
}

// usageCounts 近 24h 经网关的请求数（缓存 1 分钟，整轮扫描共用一次查询）。
func (s *Service) usageCounts(kind string, id uint) int64 {
	if s.Usage == nil {
		return 0
	}
	s.countsMu.Lock()
	defer s.countsMu.Unlock()
	now := s.now()
	if s.chCounts == nil || now.Sub(s.countsAt) > time.Minute {
		ch, prv, err := s.Usage.SubjectUsageCountsSince(now.Add(-burnLongWindow))
		if err != nil {
			if s.Log != nil {
				s.Log.Warn("balance alert: usage counts failed", "err", err)
			}
			return 0
		}
		s.chCounts, s.prvCounts, s.countsAt = ch, prv, now
	}
	if kind == storage.BalanceSubjectProvider {
		return s.prvCounts[id]
	}
	return s.chCounts[id]
}

// stillCooling 对象的路由上是否仍有密钥冷却（判断「已耗尽」是否已经自然恢复）。
func (s *Service) stillCooling(uses []routeUse) bool {
	if s.Gateway == nil {
		return true
	}
	mine := map[uint]bool{}
	groups := map[uint]bool{}
	for _, u := range uses {
		mine[u.RouteID], groups[u.GroupID] = true, true
	}
	for gid := range groups {
		states, err := s.Gateway.RouteCooldowns(gid)
		if err != nil {
			return true
		}
		for _, st := range states {
			if mine[st.RouteID] && st.Credential != nil {
				return true
			}
		}
	}
	return false
}

// ---------- 评估入口 ----------

// EvaluateChannel 监控渠道刷新余额后调用。
func (s *Service) EvaluateChannel(ctx context.Context, c *storage.Channel) {
	if c == nil || c.LastBalance == nil || s.States == nil {
		return
	}
	now := s.now()
	p := s.policy()
	uses, err := s.routesUsing(storage.BalanceSubjectChannel, c.ID)
	if err != nil {
		s.warn("routes lookup failed", err)
	}
	inUse := len(uses) > 0 && s.usageCounts(storage.BalanceSubjectChannel, c.ID) > 0
	var burn float64
	var ok bool
	if s.Rates != nil {
		snaps, err := s.Rates.BalanceSnapshotsSince(c.ID, now.Add(-burnLongWindow))
		if err != nil {
			s.warn("balance snapshots failed", err)
		}
		burn, ok = burnRateFromSnapshots(snaps, now)
	}
	a := classify(p, *c.LastBalance, c.BalanceThreshold, burn, ok, p.AllChannels || inUse)
	s.apply(ctx, channelSubject(c), &a, uses, false)
}

// EvaluateProviders 估算所有启用直连渠道的预算。
func (s *Service) EvaluateProviders(ctx context.Context) {
	if s.Providers == nil {
		return
	}
	list, err := s.Providers.ListOptions("")
	if err != nil {
		s.warn("list providers failed", err)
		return
	}
	for i := range list {
		s.evaluateProvider(ctx, &list[i], false)
	}
}

func (s *Service) providerRemaining(p *storage.GatewayProvider) (float64, bool) {
	if p.BudgetAmount == nil || s.Usage == nil {
		return 0, false
	}
	since := p.CreatedAt
	if p.BudgetSetAt != nil {
		since = *p.BudgetSetAt
	}
	spent, err := s.Usage.ProviderAccountCostSince(p.ID, since)
	if err != nil {
		s.warn("provider cost failed", err)
		return 0, false
	}
	return *p.BudgetAmount - spent, true
}

func (s *Service) evaluateProvider(ctx context.Context, prv *storage.GatewayProvider, recharged bool) {
	if s.States == nil {
		return
	}
	now := s.now()
	p := s.policy()
	uses, err := s.routesUsing(storage.BalanceSubjectProvider, prv.ID)
	if err != nil {
		s.warn("routes lookup failed", err)
	}
	remaining, ok := s.providerRemaining(prv)
	if !ok {
		// 未登记预算：只能依赖网关实时上报的「已耗尽」，冷却消失即视为恢复
		st, err := s.States.Get(storage.BalanceSubjectProvider, prv.ID)
		if err != nil || st.Level != storage.BalanceLevelExhausted {
			return
		}
		s.apply(ctx, providerSubject(prv), &assessment{Level: storage.BalanceLevelOK}, uses, recharged)
		return
	}
	cost1h, _ := s.Usage.ProviderAccountCostSince(prv.ID, now.Add(-burnShortWindow))
	cost24h, _ := s.Usage.ProviderAccountCostSince(prv.ID, now.Add(-burnLongWindow))
	burn := burnRateFromCosts(cost1h, cost24h, now.Sub(prv.CreatedAt))
	inUse := len(uses) > 0 && s.usageCounts(storage.BalanceSubjectProvider, prv.ID) > 0
	a := classify(p, remaining, prv.BudgetThreshold, burn, true, p.AllChannels || inUse)
	s.apply(ctx, providerSubject(prv), &a, uses, recharged)
}

// ReportCredentialExhausted 网关真实请求返回「余额 / 额度不足」（实现 gateway.CredentialExhaustedReporter）。
func (s *Service) ReportCredentialExhausted(ctx context.Context, ev gateway.CredentialExhaustedEvent) {
	if s.States == nil {
		return
	}
	var sj subject
	var balance *float64
	switch {
	case ev.ProviderID != 0 && s.Providers != nil:
		prv, err := s.Providers.FindByID(ev.ProviderID)
		if err != nil {
			s.warn("provider lookup failed", err)
			return
		}
		sj = providerSubject(prv)
		if r, ok := s.providerRemaining(prv); ok {
			balance = &r
		}
	case ev.ChannelID != 0 && s.Channels != nil:
		c, err := s.Channels.FindByID(ev.ChannelID)
		if err != nil {
			s.warn("channel lookup failed", err)
			return
		}
		sj, balance = channelSubject(c), c.LastBalance
	default:
		return
	}
	uses, err := s.routesUsing(sj.Kind, sj.ID)
	if err != nil {
		s.warn("routes lookup failed", err)
	}
	now := s.now()
	p := s.policy()

	var reason strings.Builder
	reason.WriteString("网关请求返回余额 / 额度不足")
	if ev.GroupName != "" {
		fmt.Fprintf(&reason, "（分组 %s", ev.GroupName)
		if ev.RouteID != 0 {
			fmt.Fprintf(&reason, "，路由 #%d", ev.RouteID)
		}
		reason.WriteString("）")
	}
	a := assessment{Level: storage.BalanceLevelExhausted, Reason: reason.String()}
	if balance != nil {
		a.Balance, a.HasBalance = *balance, true
	}
	var extra []string
	if !ev.Until.IsZero() {
		extra = append(extra, fmt.Sprintf("该密钥已暂停调度至 %s（连续 %d 次）", ev.Until.Local().Format("01-02 15:04"), ev.Failures))
	}
	if ev.RequestID != "" {
		extra = append(extra, "request_id："+ev.RequestID)
	}

	s.mu.Lock()
	st, err := s.States.Get(sj.Kind, sj.ID)
	if err != nil {
		s.mu.Unlock()
		s.warn("load state failed", err)
		return
	}
	d := decide(p, st, storage.BalanceLevelExhausted, now)
	if st.Level != storage.BalanceLevelExhausted {
		st.LevelSince = now
		st.ExhaustedAt = &now
		st.ExhaustedBalance = balance
	}
	st.Level = storage.BalanceLevelExhausted
	st.Reason = clip(a.Reason, 500)
	if balance != nil {
		st.LastBalance = balance
	}
	var msg *notify.Message
	if d.Send {
		m := buildMessage(sj, d, &a, a.HasBalance, uses, extra, now)
		msg = &m
		st.LastSentAt, st.LastSentLevel = &now, storage.BalanceLevelExhausted
	}
	if err := s.States.Save(st); err != nil {
		s.warn("save state failed", err)
	}
	s.mu.Unlock()
	s.dispatch(ctx, msg)
}

// apply 状态机：识别充值 → 维持实时耗尽 → 判定推送 → 落库 → 推送 → 按需自动解除冷却。
func (s *Service) apply(ctx context.Context, sj subject, a *assessment, uses []routeUse, recharged bool) {
	now := s.now()
	p := s.policy()
	hasBalance := a.HasBalance

	s.mu.Lock()
	st, err := s.States.Get(sj.Kind, sj.ID)
	if err != nil {
		s.mu.Unlock()
		s.warn("load state failed", err)
		return
	}
	if hasBalance && st.LastBalance != nil && rechargeDetected(*st.LastBalance, a.Balance) {
		recharged = true
	}
	if recharged {
		st.RechargeAt = &now
	}
	// 网关报告的耗尽可能早于余额采样反映（或是密钥额度耗尽而账户仍有余额）：
	// 没有识别到充值且密钥仍在冷却时，保持「已耗尽」。
	if st.Level == storage.BalanceLevelExhausted && a.Level != storage.BalanceLevelExhausted && st.ExhaustedAt != nil {
		rechargedSince := st.RechargeAt != nil && !st.RechargeAt.Before(*st.ExhaustedAt)
		if !rechargedSince && s.stillCooling(uses) {
			a.Level, a.Reason = storage.BalanceLevelExhausted, st.Reason
		}
	}
	d := decide(p, st, a.Level, now)
	prevLevel := st.Level
	if a.Level != st.Level || st.LevelSince.IsZero() {
		st.LevelSince = now
	}
	st.Level = a.Level
	if hasBalance {
		b := a.Balance
		st.LastBalance = &b
	}
	st.BurnPerHour, st.RunwayHours = a.BurnPerHour, a.RunwayHours
	st.Reason = clip(a.Reason, 500)
	if a.Level != storage.BalanceLevelExhausted {
		st.ExhaustedAt, st.ExhaustedBalance = nil, nil
	}
	var msg *notify.Message
	if d.Send {
		var extra []string
		if d.Recovered && recharged {
			extra = append(extra, "已识别到充值")
		}
		m := buildMessage(sj, d, a, hasBalance, uses, extra, now)
		msg = &m
		st.LastSentAt, st.LastSentLevel = &now, a.Level
	}
	if err := s.States.Save(st); err != nil {
		s.warn("save state failed", err)
	}
	s.mu.Unlock()
	s.dispatch(ctx, msg)

	if recharged && p.AutoReleaseOnRecharge && (storage.BalanceLevelRank(prevLevel) > 0 || len(uses) > 0) {
		s.autoRelease(sj, uses)
	}
}

// autoRelease 充值后对该对象仍在冷却的路由执行「解除冷却并测试」，并推送结果。
func (s *Service) autoRelease(sj subject, uses []routeUse) {
	if s.Gateway == nil || len(uses) == 0 {
		return
	}
	key := sj.key()
	s.relMu.Lock()
	if s.releasing[key] {
		s.relMu.Unlock()
		return
	}
	s.releasing[key] = true
	s.relMu.Unlock()
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer func() {
			s.relMu.Lock()
			delete(s.releasing, key)
			s.relMu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), releaseTimeout)
		defer cancel()
		mine := map[uint]routeUse{}
		groups := map[uint]bool{}
		for _, u := range uses {
			mine[u.RouteID], groups[u.GroupID] = u, true
		}
		var released, failed []string
		for gid := range groups {
			states, err := s.Gateway.RouteCooldowns(gid)
			if err != nil {
				s.warn("route cooldowns failed", err)
				continue
			}
			for i := range states {
				u, ok := mine[states[i].RouteID]
				if !ok || !states[i].Active() {
					continue
				}
				label := fmt.Sprintf("分组 %s 路由 #%d", u.GroupName, u.RouteID)
				res, err := s.Gateway.ReleaseRouteCooldown(ctx, u.RouteID, gateway.ReleaseCooldownInput{})
				switch {
				case err != nil:
					failed = append(failed, label+"："+err.Error())
				case res.Released:
					released = append(released, label)
				default:
					why := "测试未通过"
					for _, t := range res.Tests {
						if !t.OK && t.Error != "" {
							why = clip(t.Error, 160)
							break
						}
					}
					failed = append(failed, label+"："+why)
				}
			}
		}
		if len(released)+len(failed) == 0 {
			return
		}
		sort.Strings(released)
		sort.Strings(failed)
		var b strings.Builder
		subjectLine := fmt.Sprintf("【已充值】%s 已自动恢复 %d 条路由", sj.label(), len(released))
		if len(released) == 0 {
			subjectLine = fmt.Sprintf("【充值后测试未通过】%s", sj.label())
		}
		if len(released) > 0 {
			b.WriteString("已恢复调度：\n- " + strings.Join(released, "\n- ") + "\n")
		}
		if len(failed) > 0 {
			b.WriteString("仍未恢复（冷却保留）：\n- " + strings.Join(failed, "\n- ") + "\n")
		}
		msg := notify.Message{
			Event: storage.EventBalanceRecovered, Subject: subjectLine, Body: strings.TrimSpace(b.String()), Managed: true,
			Extra: map[string]any{"subject_kind": sj.Kind, "subject_id": sj.ID, "name": sj.Name, "released": released, "failed": failed},
		}
		if sj.Kind == storage.BalanceSubjectChannel {
			msg.ChannelID = sj.ID
		}
		s.dispatch(ctx, &msg)
	}()
}

// ---------- 调度 / 管理 ----------

// Tick 由调度器每分钟调用：紧急渠道加密采样（refresh 刷新余额并回调 EvaluateChannel）+ 直连渠道估算。
func (s *Service) Tick(ctx context.Context, refresh func(ctx context.Context, channelIDs []uint)) {
	if s.States == nil {
		return
	}
	now := s.now()
	p := s.policy()
	s.tickMu.Lock()
	urgentDue := p.UrgentScanInterval > 0 && now.Sub(s.lastUrgent) >= p.UrgentScanInterval
	providersDue := now.Sub(s.lastProviders) >= providerEvalInterval
	if urgentDue {
		s.lastUrgent = now
	}
	if providersDue {
		s.lastProviders = now
	}
	s.tickMu.Unlock()
	if urgentDue && refresh != nil {
		ids, err := s.States.UrgentChannelIDs()
		if err != nil {
			s.warn("urgent channels failed", err)
		} else if len(ids) > 0 {
			refresh(ctx, ids)
		}
	}
	if providersDue {
		s.EvaluateProviders(ctx)
	}
}

// Snooze 静默某对象的提醒至 until（nil 取消）。
func (s *Service) Snooze(kind string, id uint, until *time.Time) (*storage.BalanceAlertState, error) {
	if kind != storage.BalanceSubjectChannel && kind != storage.BalanceSubjectProvider {
		return nil, errors.New("kind must be channel or provider")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.States.SetSnooze(kind, id, until)
}

// Budget 模式：set 覆盖为新预算（从现在起重新扣减）；add 在当前剩余上追加（记一笔充值）；clear 取消预算。
const (
	BudgetSet   = "set"
	BudgetAdd   = "add"
	BudgetClear = "clear"
)

// RecordProviderBudget 登记直连渠道预算 / 充值，随后立即重新估算；充值会触发自动解除冷却。
func (s *Service) RecordProviderBudget(ctx context.Context, id uint, mode string, amount float64) (*storage.GatewayProvider, error) {
	if s.Providers == nil {
		return nil, errors.New("providers not configured")
	}
	prv, err := s.Providers.FindByID(id)
	if err != nil {
		return nil, err
	}
	now := s.now()
	recharged := false
	switch mode {
	case BudgetClear:
		prv.BudgetAmount, prv.BudgetSetAt = nil, nil
	case BudgetSet, BudgetAdd:
		if amount < 0 || amount > 1e9 {
			return nil, errors.New("amount must be between 0 and 1e9")
		}
		next := amount
		if mode == BudgetAdd {
			if amount == 0 {
				return nil, errors.New("amount must be positive")
			}
			if r, ok := s.providerRemaining(prv); ok {
				next = r + amount
			}
			recharged = true
		}
		prv.BudgetAmount, prv.BudgetSetAt = &next, &now
	default:
		return nil, errors.New("mode must be set, add or clear")
	}
	if err := s.Providers.Update(prv); err != nil {
		return nil, err
	}
	if prv.BudgetAmount == nil {
		// 取消预算：清掉估算展示，但保留网关上报的耗尽状态
		s.mu.Lock()
		if st, err := s.States.Get(storage.BalanceSubjectProvider, id); err == nil && st.Level != storage.BalanceLevelExhausted {
			_ = s.States.Delete(storage.BalanceSubjectProvider, id)
		}
		s.mu.Unlock()
		return prv, nil
	}
	s.evaluateProvider(ctx, prv, recharged)
	return prv, nil
}

// Status 列表展示用。
type Status struct {
	storage.BalanceAlertState
	Name        string `json:"name"`
	RechargeURL string `json:"recharge_url,omitempty"`
	InUse       bool   `json:"in_use"`
	// 直连渠道预算
	BudgetAmount    *float64   `json:"budget_amount,omitempty"`
	BudgetSetAt     *time.Time `json:"budget_set_at,omitempty"`
	BudgetRemaining *float64   `json:"budget_remaining,omitempty"`
	BudgetThreshold float64    `json:"budget_threshold,omitempty"`
}

// Statuses 所有已评估过的对象，以及登记了预算的直连渠道。
func (s *Service) Statuses() ([]Status, error) {
	rows, err := s.States.List()
	if err != nil {
		return nil, err
	}
	byKey := map[string]*storage.BalanceAlertState{}
	for i := range rows {
		byKey[fmt.Sprintf("%s:%d", rows[i].SubjectKind, rows[i].SubjectID)] = &rows[i]
	}
	out := []Status{}
	if s.Channels != nil {
		list, err := s.Channels.List()
		if err != nil {
			return nil, err
		}
		for i := range list {
			c := &list[i]
			st := byKey[fmt.Sprintf("%s:%d", storage.BalanceSubjectChannel, c.ID)]
			if st == nil {
				continue
			}
			out = append(out, Status{BalanceAlertState: *st, Name: c.Name, RechargeURL: channelRechargeURL(c),
				InUse: s.usageCounts(storage.BalanceSubjectChannel, c.ID) > 0})
		}
	}
	if s.Providers != nil {
		list, err := s.Providers.ListOptions("")
		if err != nil {
			return nil, err
		}
		for i := range list {
			prv := &list[i]
			st := byKey[fmt.Sprintf("%s:%d", storage.BalanceSubjectProvider, prv.ID)]
			if st == nil && prv.BudgetAmount == nil {
				continue
			}
			row := Status{Name: prv.Name, RechargeURL: strings.TrimSpace(prv.RechargeURL),
				InUse:        s.usageCounts(storage.BalanceSubjectProvider, prv.ID) > 0,
				BudgetAmount: prv.BudgetAmount, BudgetSetAt: prv.BudgetSetAt, BudgetThreshold: prv.BudgetThreshold}
			if st != nil {
				row.BalanceAlertState = *st
			} else {
				row.BalanceAlertState = storage.BalanceAlertState{SubjectKind: storage.BalanceSubjectProvider, SubjectID: prv.ID, Level: storage.BalanceLevelOK}
			}
			if r, ok := s.providerRemaining(prv); ok {
				row.BudgetRemaining = &r
			}
			out = append(out, row)
		}
	}
	return out, nil
}

// ---------- 消息 ----------

func buildMessage(sj subject, d decision, a *assessment, hasBalance bool, uses []routeUse, extra []string, now time.Time) notify.Message {
	prefix := map[storage.NotificationEvent]string{
		storage.EventBalanceLow:       "【余额预警】",
		storage.EventBalanceCritical:  "【余额紧急】",
		storage.EventBalanceExhausted: "【余额耗尽】",
		storage.EventBalanceRecovered: "【余额已恢复】",
	}[d.Event]
	headline := a.Reason
	if a.RunwayHours != nil && (d.Event == storage.EventBalanceLow || d.Event == storage.EventBalanceCritical) {
		headline = "预计 " + formatHours(*a.RunwayHours) + "后耗尽"
	}
	if d.Recovered {
		headline = "已回到正常水位"
	}
	subj := strings.TrimSpace(prefix + sj.label() + " " + headline)

	var lines []string
	if hasBalance {
		if sj.Kind == storage.BalanceSubjectProvider && sj.Budget != nil {
			lines = append(lines, fmt.Sprintf("预算剩余：%s（已登记 %s）", money(a.Balance), money(*sj.Budget)))
		} else {
			line := "当前余额：" + money(a.Balance)
			if sj.Threshold > 0 {
				line += "（阈值 " + money(sj.Threshold) + "）"
			}
			lines = append(lines, line)
		}
	}
	if a.BurnPerHour != nil && *a.BurnPerHour > 0 {
		lines = append(lines, fmt.Sprintf("消耗速度：约 %s/小时（%s/天）", money(*a.BurnPerHour), money(*a.BurnPerHour*24)))
	}
	if a.RunwayHours != nil && !d.Recovered {
		eta := now.Add(time.Duration(*a.RunwayHours * float64(time.Hour)))
		lines = append(lines, fmt.Sprintf("预计可用：%s（约 %s 耗尽）", formatHours(*a.RunwayHours), eta.Local().Format("01-02 15:04")))
	}
	if a.Reason != "" && !d.Recovered && a.Reason != headline {
		lines = append(lines, "原因："+a.Reason)
	}
	lines = append(lines, extra...)

	var groups []map[string]any
	if len(uses) > 0 {
		var used, noBackup []string
		seenNB := map[string]bool{}
		for _, u := range uses {
			used = append(used, fmt.Sprintf("%s（第 %d 优先，路由 #%d）", u.GroupName, u.Position+1, u.RouteID))
			if !u.HasBackup && !seenNB[u.GroupName] {
				seenNB[u.GroupName] = true
				noBackup = append(noBackup, u.GroupName)
			}
			groups = append(groups, map[string]any{"group_id": u.GroupID, "group": u.GroupName, "route_id": u.RouteID, "position": u.Position, "has_backup": u.HasBackup})
		}
		lines = append(lines, "在用："+strings.Join(used, "、"))
		if len(noBackup) > 0 && !d.Recovered {
			lines = append(lines, "⚠️ 以下分组没有其它可用路由，耗尽后将无法服务："+strings.Join(noBackup, "、"))
		}
	}
	if sj.RechargeURL != "" && !d.Recovered {
		lines = append(lines, "充值："+sj.RechargeURL)
	}

	msg := notify.Message{
		Event:   d.Event,
		Subject: subj,
		Body:    strings.Join(lines, "\n"),
		Managed: true,
		Extra: map[string]any{
			"subject_kind": sj.Kind, "subject_id": sj.ID, "name": sj.Name, "level": a.Level,
			"burn_per_hour": a.BurnPerHour, "runway_hours": a.RunwayHours, "recharge_url": sj.RechargeURL,
			"reason": a.Reason, "groups": groups,
		},
	}
	if hasBalance {
		msg.Extra["balance"] = a.Balance
	}
	if sj.Kind == storage.BalanceSubjectChannel {
		msg.ChannelID = sj.ID
	}
	return msg
}

func (s *Service) dispatch(ctx context.Context, msg *notify.Message) {
	if msg == nil || s.Dispatcher == nil {
		return
	}
	if err := s.Dispatcher.Dispatch(ctx, *msg); err != nil {
		s.warn("dispatch balance alert failed", err)
	}
}

func (s *Service) warn(msg string, err error) {
	if s.Log != nil && err != nil {
		s.Log.Warn("balance alert: "+msg, "err", err)
	}
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
