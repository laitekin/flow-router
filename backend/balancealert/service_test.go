package balancealert

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bejix/upstream-ops/backend/gateway"
	"github.com/bejix/upstream-ops/backend/notify"
	"github.com/bejix/upstream-ops/backend/storage"
	"gorm.io/gorm"
)

type fakeDispatcher struct {
	mu   sync.Mutex
	msgs []notify.Message
}

func (f *fakeDispatcher) Dispatch(_ context.Context, m notify.Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.msgs = append(f.msgs, m)
	return nil
}
func (f *fakeDispatcher) Policy() notify.Policy { return notify.Policy{Balance: testPolicy} }
func (f *fakeDispatcher) take() []notify.Message {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.msgs
	f.msgs = nil
	return out
}

type fakeGateway struct {
	mu       sync.Mutex
	cooling  map[uint]bool // route id → credential cooldown active
	released []uint
	failWith string
}

func (g *fakeGateway) RouteCooldowns(uint) ([]gateway.RouteCooldownState, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	var out []gateway.RouteCooldownState
	for id, on := range g.cooling {
		if on {
			out = append(out, gateway.RouteCooldownState{RouteID: id, Credential: &gateway.RouteCredentialCooldown{Until: time.Now().Add(time.Hour)}})
		}
	}
	return out, nil
}

func (g *fakeGateway) ReleaseRouteCooldown(_ context.Context, id uint, _ gateway.ReleaseCooldownInput) (*gateway.ReleaseCooldownResult, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.failWith != "" {
		return &gateway.ReleaseCooldownResult{Tests: []gateway.ModelTestResult{{Error: g.failWith}}}, nil
	}
	g.released = append(g.released, id)
	g.cooling[id] = false
	return &gateway.ReleaseCooldownResult{Released: true}, nil
}

type fixture struct {
	db      *gorm.DB
	svc     *Service
	disp    *fakeDispatcher
	gw      *fakeGateway
	channel *storage.Channel
	prv     *storage.GatewayProvider
	group   *storage.GatewayGroup
	chRoute uint
	pvRoute uint
	now     time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	db, cleanup, err := storage.OpenTestDB(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	f := &fixture{db: db, disp: &fakeDispatcher{}, gw: &fakeGateway{cooling: map[uint]bool{}}, now: time.Now()}
	channels, providers := storage.NewChannels(db), storage.NewGatewayProviders(db)
	groups, routes := storage.NewGatewayGroups(db), storage.NewGatewayRoutes(db)
	f.channel = &storage.Channel{Name: "relay-a", Type: storage.ChannelTypeNewAPI, SiteURL: "https://relay-a.example/", Username: "u", MonitorEnabled: true}
	if err := channels.Create(f.channel); err != nil {
		t.Fatal(err)
	}
	f.prv = &storage.GatewayProvider{Name: "direct-b", BaseURL: "https://api.b.example", APIKeyCipher: "x", Enabled: true, RechargeURL: "https://b.example/billing"}
	if err := providers.Create(f.prv); err != nil {
		t.Fatal(err)
	}
	f.group = &storage.GatewayGroup{Name: "prod", Status: storage.GatewayGroupStatusActive, RateSortDirection: "asc"}
	if err := groups.Create(f.group); err != nil {
		t.Fatal(err)
	}
	if err := routes.SaveForGroup(f.group.ID, []storage.GatewayRoute{
		{SourceKind: "monitor", SourceChannelID: f.channel.ID, Enabled: true, RateConvertMode: "raw", RateConvertValue: 1},
		{SourceKind: "provider", GatewayProviderID: f.prv.ID, Enabled: true, RateConvertMode: "raw", RateConvertValue: 1},
	}); err != nil {
		t.Fatal(err)
	}
	list, _ := routes.ListByGroupID(f.group.ID)
	for _, r := range list {
		if r.GatewayProviderID != 0 {
			f.pvRoute = r.ID
		} else {
			f.chRoute = r.ID
		}
	}
	f.svc = New(Deps{
		States: storage.NewBalanceAlerts(db), Channels: channels, Providers: providers, Rates: storage.NewRates(db),
		Usage: storage.NewGatewayUsageLogs(db), Groups: groups, Routes: routes, Dispatcher: f.disp, Gateway: f.gw,
	})
	f.svc.now = func() time.Time { return f.now }
	return f
}

func (f *fixture) usage(t *testing.T, channelID, providerID, routeID uint, cost float64, at time.Time) {
	t.Helper()
	row := &storage.GatewayUsageLog{GatewayGroupID: f.group.ID, RouteID: routeID, ChannelID: channelID, GatewayProviderID: providerID, AccountStatsCost: cost, CreatedAt: at}
	if err := f.db.Create(row).Error; err != nil {
		t.Fatal(err)
	}
}

// 1/小时匀速消耗的快照，最后一点余额为 last
func (f *fixture) burn(t *testing.T, last float64) {
	t.Helper()
	rates := storage.NewRates(f.db)
	for h := 4; h >= 0; h-- {
		_ = rates.AppendBalance(&storage.BalanceSnapshot{ChannelID: f.channel.ID, Balance: last + float64(h), SampledAt: f.now.Add(-time.Duration(h) * time.Hour)})
	}
}

func (f *fixture) evalChannel(balance float64) {
	f.channel.LastBalance = &balance
	f.svc.EvaluateChannel(context.Background(), f.channel)
}

func TestChannelRunwayEscalatesWithoutSpam(t *testing.T) {
	f := newFixture(t)
	f.usage(t, f.channel.ID, 0, f.chRoute, 0.1, f.now.Add(-time.Hour))
	f.burn(t, 10)
	f.evalChannel(10)
	msgs := f.disp.take()
	if len(msgs) != 1 || msgs[0].Event != storage.EventBalanceLow || !msgs[0].Managed || msgs[0].ChannelID != f.channel.ID {
		t.Fatalf("warn: %+v", msgs)
	}
	body := msgs[0].Subject + "\n" + msgs[0].Body
	for _, want := range []string{"预计 10.0 小时后耗尽", "消耗速度：约 $1.00/小时", "在用：prod", "充值：https://relay-a.example/console/topup"} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in\n%s", want, body)
		}
	}
	// 分组里还有直连路由承接，不应提示无备用
	if strings.Contains(body, "没有其它可用路由") {
		t.Errorf("unexpected no-backup warning:\n%s", body)
	}
	f.now = f.now.Add(15 * time.Minute)
	f.evalChannel(9.75)
	if msgs := f.disp.take(); len(msgs) != 0 {
		t.Fatalf("repeat within window: %+v", msgs)
	}
	f.evalChannel(2)
	if msgs := f.disp.take(); len(msgs) != 1 || msgs[0].Event != storage.EventBalanceCritical {
		t.Fatalf("critical: %+v", msgs)
	}
	ids, _ := f.svc.States.UrgentChannelIDs()
	if len(ids) != 1 || ids[0] != f.channel.ID {
		t.Fatalf("urgent ids %v", ids)
	}
}

func TestUnusedChannelOnlyUsesManualThreshold(t *testing.T) {
	f := newFixture(t) // 没有网关流量 → 不在用
	f.burn(t, 2)
	f.evalChannel(2)
	if msgs := f.disp.take(); len(msgs) != 0 {
		t.Fatalf("unused channel alerted: %+v", msgs)
	}
	f.channel.BalanceThreshold = 5
	f.evalChannel(2)
	if msgs := f.disp.take(); len(msgs) != 1 || !strings.Contains(msgs[0].Body+msgs[0].Subject, "阈值 $5.00") {
		t.Fatalf("manual threshold: %+v", msgs)
	}
}

func TestExhaustedStaysUntilRechargeThenAutoReleases(t *testing.T) {
	f := newFixture(t)
	f.usage(t, f.channel.ID, 0, f.chRoute, 0.1, f.now.Add(-time.Hour))
	f.burn(t, 30)
	f.evalChannel(30) // 30h：正常
	f.disp.take()

	// 网关实时报告：账户还有余额（密钥额度耗尽）
	f.gw.cooling[f.chRoute] = true
	f.svc.ReportCredentialExhausted(context.Background(), gateway.CredentialExhaustedEvent{
		RouteID: f.chRoute, ChannelID: f.channel.ID, GroupID: f.group.ID, GroupName: "prod", RequestID: "req-1", Until: f.now.Add(5 * time.Minute), Failures: 1,
	})
	msgs := f.disp.take()
	if len(msgs) != 1 || msgs[0].Event != storage.EventBalanceExhausted || !strings.Contains(msgs[0].Body, "req-1") || !strings.Contains(msgs[0].Subject, "余额 / 额度不足") {
		t.Fatalf("exhausted: %+v", msgs)
	}
	// 下一次采样余额没变、密钥仍在冷却 → 保持耗尽、不重复
	f.now = f.now.Add(10 * time.Minute)
	f.evalChannel(29.8)
	if msgs := f.disp.take(); len(msgs) != 0 {
		t.Fatalf("should stay silent: %+v", msgs)
	}
	if st, _ := f.svc.States.Get(storage.BalanceSubjectChannel, f.channel.ID); st.Level != storage.BalanceLevelExhausted {
		t.Fatalf("level %s", st.Level)
	}
	// 充值 → 恢复 + 自动解除冷却
	f.evalChannel(130)
	f.svc.Wait()
	msgs = f.disp.take()
	if len(msgs) != 2 || msgs[0].Event != storage.EventBalanceRecovered || !strings.Contains(msgs[0].Body, "已识别到充值") ||
		!strings.Contains(msgs[1].Subject, "已自动恢复 1 条路由") {
		t.Fatalf("recovery: %+v", msgs)
	}
	if len(f.gw.released) != 1 || f.gw.released[0] != f.chRoute {
		t.Fatalf("released %v", f.gw.released)
	}
}

func TestExhaustedRecoversWhenCooldownClearsWithoutRecharge(t *testing.T) {
	f := newFixture(t)
	f.usage(t, f.channel.ID, 0, f.chRoute, 0.1, f.now.Add(-time.Hour))
	f.burn(t, 50)
	f.gw.cooling[f.chRoute] = true
	f.svc.ReportCredentialExhausted(context.Background(), gateway.CredentialExhaustedEvent{RouteID: f.chRoute, ChannelID: f.channel.ID, GroupName: "prod"})
	f.disp.take()
	f.gw.cooling[f.chRoute] = false // 真实流量成功 / 冷却到期
	f.evalChannel(50)
	if msgs := f.disp.take(); len(msgs) != 1 || msgs[0].Event != storage.EventBalanceRecovered {
		t.Fatalf("recovery: %+v", msgs)
	}
}

func TestProviderBudgetTrackingAndRecharge(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	if _, err := f.svc.RecordProviderBudget(ctx, f.prv.ID, BudgetSet, 10); err != nil {
		t.Fatal(err)
	}
	// 登记之后网关记了 8.5 的费用，其中近 1 小时 1.0
	f.usage(t, 0, f.prv.ID, f.pvRoute, 7.5, f.now.Add(-3*time.Hour).Add(time.Minute))
	f.usage(t, 0, f.prv.ID, f.pvRoute, 1.0, f.now.Add(-30*time.Minute))
	// 登记时间点之前的费用不计入
	f.db.Model(&storage.GatewayProvider{}).Where("id = ?", f.prv.ID).Update("budget_set_at", f.now.Add(-3*time.Hour))
	f.usage(t, 0, f.prv.ID, f.pvRoute, 100, f.now.Add(-5*time.Hour))
	f.disp.take()
	f.svc.chCounts = nil // 用量计数缓存 1 分钟；测试里刚写入用量，强制重读

	f.svc.EvaluateProviders(ctx)
	msgs := f.disp.take()
	if len(msgs) != 1 || msgs[0].Event != storage.EventBalanceCritical || msgs[0].ChannelID != 0 ||
		!strings.Contains(msgs[0].Body, "预算剩余：$1.50（已登记 $10.00）") || !strings.Contains(msgs[0].Body, "充值：https://b.example/billing") {
		t.Fatalf("provider critical: %+v", msgs)
	}
	statuses, err := f.svc.Statuses()
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, s := range statuses {
		if s.SubjectKind == storage.BalanceSubjectProvider && s.SubjectID == f.prv.ID {
			found = s.BudgetRemaining != nil && *s.BudgetRemaining > 1.49 && *s.BudgetRemaining < 1.51 && s.InUse
		}
	}
	if !found {
		t.Fatalf("status missing: %+v", statuses)
	}

	// 充一点（约 22h，仍处预警）：降级不推送，但会自动解除冷却
	f.gw.cooling[f.pvRoute] = true
	prv, err := f.svc.RecordProviderBudget(ctx, f.prv.ID, BudgetAdd, 100)
	if err != nil || prv.BudgetAmount == nil || *prv.BudgetAmount < 101.49 || *prv.BudgetAmount > 101.51 {
		t.Fatalf("add: %+v err=%v", prv, err)
	}
	f.svc.Wait()
	msgs = f.disp.take()
	if len(msgs) != 1 || !strings.Contains(msgs[0].Subject, "已自动恢复 1 条路由") || len(f.gw.released) != 1 || f.gw.released[0] != f.pvRoute {
		t.Fatalf("partial recharge: %+v released=%v", msgs, f.gw.released)
	}
	if st, _ := f.svc.States.Get(storage.BalanceSubjectProvider, f.prv.ID); st.Level != storage.BalanceLevelWarn {
		t.Fatalf("level %s", st.Level)
	}
	// 充足：回到正常并推送恢复
	if _, err := f.svc.RecordProviderBudget(ctx, f.prv.ID, BudgetAdd, 1000); err != nil {
		t.Fatal(err)
	}
	f.svc.Wait()
	if msgs = f.disp.take(); len(msgs) != 1 || msgs[0].Event != storage.EventBalanceRecovered || !strings.Contains(msgs[0].Body, "已识别到充值") {
		t.Fatalf("full recharge: %+v", msgs)
	}
	// 取消预算
	if prv, err = f.svc.RecordProviderBudget(ctx, f.prv.ID, BudgetClear, 0); err != nil || prv.BudgetAmount != nil {
		t.Fatalf("clear: %+v err=%v", prv, err)
	}
	if _, err := f.svc.RecordProviderBudget(ctx, f.prv.ID, "weird", 1); err == nil {
		t.Fatal("bad mode accepted")
	}
}

func TestAutoReleaseFailureIsReported(t *testing.T) {
	f := newFixture(t)
	f.usage(t, f.channel.ID, 0, f.chRoute, 0.1, f.now.Add(-time.Hour))
	f.burn(t, 2)
	f.evalChannel(2)
	f.disp.take()
	f.gw.cooling[f.chRoute] = true
	f.gw.failWith = "insufficient balance"
	f.evalChannel(5) // 只充了一点：识别为充值，但测试仍失败
	f.svc.Wait()
	var got bool
	for _, m := range f.disp.take() {
		if strings.Contains(m.Subject, "充值后测试未通过") && strings.Contains(m.Body, "insufficient balance") {
			got = true
		}
	}
	if !got {
		t.Fatal("failed release not reported")
	}
}

func TestSnoozeSuppressesButKeepsState(t *testing.T) {
	f := newFixture(t)
	f.usage(t, f.channel.ID, 0, f.chRoute, 0.1, f.now.Add(-time.Hour))
	until := f.now.Add(time.Hour)
	if _, err := f.svc.Snooze(storage.BalanceSubjectChannel, f.channel.ID, &until); err != nil {
		t.Fatal(err)
	}
	f.burn(t, 2)
	f.evalChannel(2)
	if msgs := f.disp.take(); len(msgs) != 0 {
		t.Fatalf("snoozed: %+v", msgs)
	}
	st, _ := f.svc.States.Get(storage.BalanceSubjectChannel, f.channel.ID)
	if st.Level != storage.BalanceLevelCritical {
		t.Fatalf("state not updated: %s", st.Level)
	}
	f.now = f.now.Add(2 * time.Hour)
	f.evalChannel(1.9)
	if msgs := f.disp.take(); len(msgs) != 1 || msgs[0].Event != storage.EventBalanceCritical {
		t.Fatalf("after snooze: %+v", msgs)
	}
	if _, err := f.svc.Snooze("bogus", 1, nil); err == nil {
		t.Fatal("bad kind accepted")
	}
}
