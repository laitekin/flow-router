package notify

import (
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bejix/upstream-ops/backend/storage"
)

func TestEmailMIMEPreservesPlainTextAndUnicodeSubject(t *testing.T) {
	msg := Message{Event: storage.EventBalanceLow, Subject: "余额提醒 · 测试渠道", Body: "当前余额：$28.50\n请检查额度。"}
	raw, err := buildEmailBody("Flow Router <ops@example.com>", []string{"owner@example.com"}, msg, "https://flow.example.com", time.Date(2026, 11, 8, 7, 30, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	mailMsg, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	subject, err := new(mime.WordDecoder).DecodeHeader(mailMsg.Header.Get("Subject"))
	if err != nil || subject != msg.Subject {
		t.Fatalf("subject=%q err=%v", subject, err)
	}
	media, params, err := mime.ParseMediaType(mailMsg.Header.Get("Content-Type"))
	if err != nil || media != "multipart/alternative" {
		t.Fatalf("media=%s %v", media, err)
	}
	r := multipart.NewReader(mailMsg.Body, params["boundary"])
	plain, err := r.NextRawPart()
	if err != nil {
		t.Fatal(err)
	}
	text, err := io.ReadAll(quotedprintable.NewReader(plain))
	if err != nil || strings.ReplaceAll(string(text), "\r\n", "\n") != msg.Body {
		t.Fatalf("plain text lost: %q %v", text, err)
	}
	part, err := r.NextRawPart()
	if err != nil {
		t.Fatal(err)
	}
	html, err := io.ReadAll(quotedprintable.NewReader(part))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(html), msg.Subject) || !strings.Contains(string(html), "查看运营控制台") || strings.Contains(string(html), "ZgotmplZ") {
		t.Fatalf("HTML rendering failed: %s", html)
	}
	if _, err = r.NextPart(); err != io.EOF {
		t.Fatalf("unexpected extra MIME part: %v", err)
	}
}

func TestEmailEscapesUpstreamContentAndUnsafeLinks(t *testing.T) {
	msg := Message{Subject: `<img src=x onerror=alert(1)>`, Body: "# Details\n<script>alert(1)</script>\n- **Group A**：`1x` → `2x`\n[jump](javascript:alert(1))\n充值：https://pay.example.com/?a=1&b=2", Extra: map[string]any{"recharge_url": "javascript:alert(1)"}}
	html, err := renderEmailHTML(msg, "javascript:alert(2)", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(html, "<script>") || strings.Contains(html, "<img src=x") || strings.Contains(html, `href="javascript:`) || strings.Contains(html, "ZgotmplZ") {
		t.Fatal("untrusted content became active markup")
	}
	for _, want := range []string{"&lt;script&gt;", "<strong>Group A</strong>", "<code ", `href="https://pay.example.com/?a=1&amp;b=2"`} {
		if !strings.Contains(html, want) {
			t.Fatalf("missing safely formatted content %q", want)
		}
	}
}

func TestEmailHeaderCannotInjectRecipients(t *testing.T) {
	raw, err := buildEmailBody("ops@example.com", []string{"owner@example.com"}, Message{Subject: "Alert\r\nBcc: attacker@example.com", Body: "test"}, "", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	msg, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if msg.Header.Get("Bcc") != "" {
		t.Fatal("header injection")
	}
}

// Optional design fixtures: render actual production templates without SMTP.
// FLOW_MAIL_PREVIEW_DIR=/absolute/path go test ./backend/notify -run TestEmailPreviewArtifacts
func TestEmailPreviewArtifacts(t *testing.T) {
	dir := os.Getenv("FLOW_MAIL_PREVIEW_DIR")
	if dir == "" {
		t.Skip("preview output not requested")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	runway := 3.6
	samples := map[string]Message{
		"balance-alert": {Event: storage.EventBalanceCritical, Subject: "Astra 专线预计 3.6 小时后耗尽", Body: "当前余额：$28.50（阈值 $50.00）\n消耗速度：约 $7.92/小时\n在用：GPT Astra 专项（第 1 优先，路由 #36）\n⚠️ GPT Astra 专项没有其它可用路由，耗尽后将无法服务。\n\n建议：补充额度后，系统将自动检测并恢复可用路由。", Extra: map[string]any{"balance": 28.5, "runway_hours": &runway, "recharge_url": "https://example.com/recharge"}},
		"rate-change":   BuildRateNotificationBatchMessage(RateNotificationBatch{Changed: []ChannelRateChange{{ChannelID: 1, ChannelName: "Flow-Node", Change: RateChange{GroupName: "GPT 对接专属分组", OldRatio: 0.8, NewRatio: 0.65}}, {ChannelID: 1, ChannelName: "Flow-Node", Change: RateChange{GroupName: "Astra 专线", OldRatio: 1, NewRatio: 0.9}}}, Added: []ChannelRateChange{{ChannelID: 2, ChannelName: "大蛇", Change: RateChange{GroupName: "Claude Kiro 高缓存", NewRatio: 0.4}}}}),
		"recovered":     {Event: storage.EventBalanceRecovered, Subject: "Astra 专线已充值，2 条路由恢复调度", Body: "已恢复调度：\n- GPT Astra 专项 · 路由 #36\n- GPT 综合 · 路由 #22\n\n检测结果：两条路由均已通过连接测试，已重新加入候选列表。", Extra: map[string]any{"balance": 120.0}},
		"long-error":    {Event: storage.EventMonitorFailed, Subject: "渠道认证异常，需要检查登录状态", Body: "渠道：Astra / 测试渠道\n错误：upstream HTTP 503: the original upstream for this conversation is cooling down; retry later or start a new conversation\n\n" + strings.Repeat("长模型名称-", 24) + "\n请打开控制台查看最新检测结果。"},
	}
	for name, msg := range samples {
		html, err := renderEmailHTML(msg, "https://flow.example.com", time.Date(2026, 11, 8, 7, 30, 0, 0, time.UTC))
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, name+".html"), []byte(html), 0644); err != nil {
			t.Fatal(err)
		}
	}
}
