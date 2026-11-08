package notify

import (
	"bytes"
	_ "embed"
	"fmt"
	"html"
	"html/template"
	"math"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/textproto"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/bejix/upstream-ops/backend/storage"
)

//go:embed email_template.html
var emailHTMLSource string

var emailHTMLTemplate = template.Must(template.New("notification-email").Parse(emailHTMLSource))
var emailInlinePattern = regexp.MustCompile("`[^`\\n]+`|\\*\\*[^*\\n]+\\*\\*|\\[[^]\\n]+\\]\\(https?://[^\\s)]+\\)|https?://[^\\s<>]+")

type emailTheme struct{ Label, Color, Background, Description string }
type emailMetric struct{ Label, Value, Unit string }
type emailView struct {
	Title, Preheader, Date, Description, ActionURL, ActionLabel, Footer string
	Theme                                                               emailTheme
	Metrics                                                             []emailMetric
	Body                                                                template.HTML
}

func notificationEmailTheme(event storage.NotificationEvent) emailTheme {
	theme := emailTheme{"系统通知", "#0f766e", "#e7f4ef", "有一条新的运营通知，请查看以下内容。"}
	switch event {
	case storage.EventBalanceCritical, storage.EventBalanceExhausted:
		theme = emailTheme{"需要优先处理", "#b42318", "#fff0ed", "可用额度接近耗尽或已耗尽，请优先检查受影响的渠道与路由。"}
	case storage.EventBalanceLow, storage.EventSubscriptionDailyLow, storage.EventSubscriptionWeeklyLow, storage.EventSubscriptionMonthlyLow, storage.EventSubscriptionExpiring:
		theme = emailTheme{"额度与订阅提醒", "#925e0b", "#fff5df", "请留意可用额度与订阅状态，及时安排充值或续期。"}
	case storage.EventBalanceRecovered:
		theme = emailTheme{"恢复状态更新", "#0f766e", "#e7f4ef", "额度或路由恢复状态已更新，具体结果请查看下方详情。"}
	case storage.EventRateChanged, storage.EventRateStructureChanged, storage.EventRateAdded, storage.EventRateRemoved:
		theme = emailTheme{"渠道分组变动", "#315a91", "#edf3fc", "本轮扫描发现以下渠道分组或倍率变动。"}
	case storage.EventMonitorFailed, storage.EventLoginFailed, storage.EventCaptchaFailed:
		theme = emailTheme{"监测异常", "#b42318", "#fff0ed", "本轮监测或渠道认证未能完成，请检查下方异常信息。"}
	case storage.EventAnnouncement:
		theme = emailTheme{"渠道公告", "#315a91", "#edf3fc", "渠道发布了一条新公告，请查看以下内容。"}
	}
	return theme
}

func safeEmailURL(value string) string {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil {
		return ""
	}
	return u.String()
}

func emailNumber(value any) (float64, bool) {
	var n float64
	switch v := value.(type) {
	case float64:
		n = v
	case float32:
		n = float64(v)
	case *float64:
		if v == nil {
			return 0, false
		}
		n = *v
	case int:
		n = float64(v)
	case int64:
		n = float64(v)
	case string:
		var err error
		n, err = strconv.ParseFloat(v, 64)
		if err != nil {
			return 0, false
		}
	default:
		return 0, false
	}
	return n, !math.IsNaN(n) && !math.IsInf(n, 0)
}

func renderEmailHTML(msg Message, consoleURL string, at time.Time) (string, error) {
	theme := notificationEmailTheme(msg.Event)
	zone := time.FixedZone("CST", 8*60*60)
	view := emailView{Title: strings.TrimSpace(msg.Subject), Theme: theme, Description: theme.Description, Date: at.In(zone).Format("01月02日 · 15:04"), Footer: "你收到此邮件，是因为已订阅相应的渠道运营通知。"}
	if view.Title == "" {
		view.Title = theme.Label
	}
	view.Preheader = theme.Label + " · " + theme.Description
	view.Body = template.HTML(renderEmailContent(msg.Body, view.Title)) // Content renderer escapes all upstream text.
	if n, ok := emailNumber(msg.Extra["balance"]); ok {
		label := "当前余额"
		if msg.Extra["subject_kind"] == storage.BalanceSubjectProvider || msg.Extra["subject_kind"] == string(storage.BalanceSubjectProvider) {
			label = "预算剩余"
		}
		view.Metrics = append(view.Metrics, emailMetric{Label: label, Value: fmt.Sprintf("$%.2f", n)})
	}
	if n, ok := emailNumber(msg.Extra["runway_hours"]); ok && n >= 0 && msg.Event != storage.EventBalanceRecovered {
		metric := emailMetric{Label: "预计可用", Value: fmt.Sprintf("%.1f", n), Unit: " 小时"}
		if n < 1 {
			metric.Value = fmt.Sprintf("%.0f", math.Max(1, math.Round(n*60)))
			metric.Unit = " 分钟"
		} else if n >= 48 {
			metric.Value = fmt.Sprintf("%.1f", n/24)
			metric.Unit = " 天"
		}
		view.Metrics = append(view.Metrics, metric)
	}
	if recharge, ok := msg.Extra["recharge_url"].(string); ok && msg.Event != storage.EventBalanceRecovered {
		view.ActionURL = safeEmailURL(recharge)
		view.ActionLabel = "前往充值"
	}
	if view.ActionURL == "" {
		view.ActionURL = safeEmailURL(consoleURL)
		view.ActionLabel = "查看运营控制台"
	}
	var b bytes.Buffer
	if err := emailHTMLTemplate.Execute(&b, view); err != nil {
		return "", err
	}
	return b.String(), nil
}

// Render the CommonMark subset used by our notifications. Raw upstream HTML is
// always text; only explicitly validated http(s) URLs can become links.
func renderEmailInline(text string) string {
	var b strings.Builder
	last := 0
	for _, match := range emailInlinePattern.FindAllStringIndex(text, -1) {
		b.WriteString(html.EscapeString(text[last:match[0]]))
		token := text[match[0]:match[1]]
		switch {
		case strings.HasPrefix(token, "`"):
			b.WriteString(`<code style="font-family:Consolas,'SFMono-Regular',monospace;font-size:13px;background-color:#edf3f0;color:#25473e;padding:2px 5px;border-radius:4px;">` + html.EscapeString(strings.Trim(token, "`")) + `</code>`)
		case strings.HasPrefix(token, "**"):
			b.WriteString(`<strong>` + html.EscapeString(strings.TrimPrefix(strings.TrimSuffix(token, "**"), "**")) + `</strong>`)
		default:
			label, target := token, token
			if strings.HasPrefix(token, "[") {
				cut := strings.Index(token, "](")
				label = token[1:cut]
				target = token[cut+2 : len(token)-1]
			}
			if safeEmailURL(target) != "" {
				b.WriteString(`<a href="` + html.EscapeString(target) + `" style="color:#0f766e;text-decoration:underline;word-break:break-all;">` + html.EscapeString(label) + `</a>`)
			} else {
				b.WriteString(html.EscapeString(token))
			}
		}
		last = match[1]
	}
	b.WriteString(html.EscapeString(text[last:]))
	return b.String()
}

func renderEmailContent(body, title string) string {
	var b strings.Builder
	list := false
	closeList := func() {
		if list {
			b.WriteString("</ul>")
			list = false
		}
	}
	for _, raw := range strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			closeList()
			continue
		}
		if strings.HasPrefix(line, "- ") || strings.HasPrefix(line, "· ") {
			if !list {
				b.WriteString(`<ul style="padding-left:20px;margin:8px 0 18px;">`)
				list = true
			}
			b.WriteString(`<li style="margin:0 0 9px;padding-left:3px;color:#334c43;">` + renderEmailInline(strings.TrimSpace(line[2:])) + `</li>`)
			continue
		}
		closeList()
		switch {
		case strings.HasPrefix(line, "# "):
			heading := strings.TrimSpace(line[2:])
			if !strings.Contains(title, heading) {
				b.WriteString(`<h2 style="font-size:18px;line-height:1.5;margin:20px 0 12px;color:#172b27;">` + renderEmailInline(heading) + `</h2>`)
			}
		case strings.HasPrefix(line, "## "):
			b.WriteString(`<h2 style="font-size:17px;line-height:1.5;margin:22px 0 12px;color:#172b27;">` + renderEmailInline(line[3:]) + `</h2>`)
		case strings.HasPrefix(line, "### "):
			b.WriteString(`<h3 style="font-size:14px;line-height:1.6;margin:18px 0 8px;color:#172b27;">` + renderEmailInline(line[4:]) + `</h3>`)
		case strings.HasPrefix(line, "> "):
			b.WriteString(`<p style="border-left:3px solid #d8e6df;padding-left:12px;margin:0 0 16px;color:#62766f;font-size:13px;">` + renderEmailInline(line[2:]) + `</p>`)
		case strings.HasPrefix(line, "⚠"):
			line = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(line, "⚠"), "️"))
			b.WriteString(`<p style="padding:13px 15px;margin:14px 0;background-color:#fff5df;border-radius:8px;color:#77510d;">` + renderEmailInline(line) + `</p>`)
		default:
			label, value, ok := strings.Cut(line, "：")
			if ok && utf8.RuneCountInString(label) <= 10 && !strings.ContainsAny(label, "<>/") {
				b.WriteString(`<table role="presentation" width="100%" style="margin:0 0 13px;table-layout:fixed;"><tr><td valign="top" class="detail-label muted" style="width:98px;color:#62766f;font-size:13px;line-height:1.8;">` + html.EscapeString(label) + `</td><td valign="top" style="color:#334c43;font-size:14px;line-height:1.8;overflow-wrap:anywhere;word-break:break-word;">` + renderEmailInline(value) + `</td></tr></table>`)
			} else {
				b.WriteString(`<p style="margin:0 0 14px;color:#334c43;">` + renderEmailInline(line) + `</p>`)
			}
		}
	}
	closeList()
	return b.String()
}

func buildEmailBody(from string, to []string, msg Message, consoleURL string, at time.Time) (string, error) {
	htmlBody, err := renderEmailHTML(msg, consoleURL, at)
	if err != nil {
		return "", err
	}
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for _, part := range []struct{ kind, body string }{{"text/plain", msg.Body}, {"text/html", htmlBody}} {
		h := make(textproto.MIMEHeader)
		h.Set("Content-Type", part.kind+"; charset=UTF-8")
		h.Set("Content-Transfer-Encoding", "quoted-printable")
		out, err := w.CreatePart(h)
		if err != nil {
			return "", err
		}
		q := quotedprintable.NewWriter(out)
		if _, err = q.Write([]byte(part.body)); err != nil {
			return "", err
		}
		if err = q.Close(); err != nil {
			return "", err
		}
	}
	if err = w.Close(); err != nil {
		return "", err
	}
	clean := func(s string) string { return strings.NewReplacer("\r", " ", "\n", " ").Replace(s) }
	address := func(s string) string {
		if a, e := mail.ParseAddress(clean(s)); e == nil {
			return a.String()
		}
		return clean(s)
	}
	addresses := make([]string, len(to))
	for i, s := range to {
		addresses[i] = address(s)
	}
	headers := []string{"From: " + address(from), "To: " + strings.Join(addresses, ", "), "Subject: " + mime.QEncoding.Encode("UTF-8", clean(msg.Subject)), "Date: " + at.Format(time.RFC1123Z), "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="` + w.Boundary() + `"`}
	return strings.Join(headers, "\r\n") + "\r\n\r\n" + body.String(), nil
}
