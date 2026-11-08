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

type emailTheme struct{ Label, Icon, Color, Background, Description string }
type emailMetric struct{ Label, Value, Unit, Note string }
type emailView struct {
	Title, Preheader, Date, Description, ActionURL, ActionLabel, SecondaryURL, SecondaryLabel string
	Theme                                                                                     emailTheme
	Metrics                                                                                   []emailMetric
	MetricWidth                                                                               string
	Body                                                                                      template.HTML
}

func notificationEmailTheme(event storage.NotificationEvent) emailTheme {
	theme := emailTheme{"系统通知", "i", "#0f766e", "#e6f3ef", "有一条新的运营通知。"}
	switch event {
	case storage.EventBalanceExhausted:
		theme = emailTheme{"余额耗尽", "!", "#c0352b", "#fdeeec", "额度已耗尽，相关路由可能已停止服务，请尽快处理。"}
	case storage.EventBalanceCritical:
		theme = emailTheme{"余额紧急", "!", "#c0352b", "#fdeeec", "额度即将耗尽，请优先检查受影响的分组与路由。"}
	case storage.EventBalanceLow, storage.EventSubscriptionDailyLow, storage.EventSubscriptionWeeklyLow, storage.EventSubscriptionMonthlyLow:
		theme = emailTheme{"额度预警", "!", "#b26a00", "#fdf3e1", "可用额度偏低，建议提前安排充值。"}
	case storage.EventSubscriptionExpiring:
		theme = emailTheme{"订阅到期", "!", "#b26a00", "#fdf3e1", "订阅即将到期，请及时续期。"}
	case storage.EventBalanceRecovered:
		theme = emailTheme{"已恢复", "✓", "#12805c", "#e5f4ec", "额度已补充，以下为路由恢复结果。"}
	case storage.EventRateChanged, storage.EventRateStructureChanged, storage.EventRateAdded, storage.EventRateRemoved:
		theme = emailTheme{"分组变动", "⇅", "#2f5ea8", "#eaf0fa", "本轮扫描发现以下分组或倍率变动。"}
	case storage.EventMonitorFailed, storage.EventLoginFailed, storage.EventCaptchaFailed:
		theme = emailTheme{"监测异常", "×", "#c0352b", "#fdeeec", "本轮监测或渠道认证未能完成。"}
	case storage.EventAnnouncement:
		theme = emailTheme{"渠道公告", "i", "#2f5ea8", "#eaf0fa", "渠道发布了一条新公告。"}
	}
	return theme
}

// emailTitle drops the "【余额紧急】" style prefix: the status pill already says it.
func emailTitle(subject string) string {
	s := strings.TrimSpace(subject)
	if strings.HasPrefix(s, "【") {
		if i := strings.Index(s, "】"); i > 0 {
			if rest := strings.TrimSpace(s[i+len("】"):]); rest != "" {
				return rest
			}
		}
	}
	return s
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

func isFailureEvent(e storage.NotificationEvent) bool {
	return e == storage.EventMonitorFailed || e == storage.EventLoginFailed || e == storage.EventCaptchaFailed
}

func renderEmailHTML(msg Message, consoleURL string, at time.Time) (string, error) {
	theme := notificationEmailTheme(msg.Event)
	zone := time.FixedZone("CST", 8*60*60)
	view := emailView{Title: emailTitle(msg.Subject), Theme: theme, Description: theme.Description, Date: at.In(zone).Format("01-02 15:04")}
	if view.Title == "" {
		view.Title = theme.Label
	}
	view.Preheader = theme.Label + " · " + theme.Description

	if n, ok := emailNumber(msg.Extra["balance"]); ok {
		label := "当前余额"
		if msg.Extra["subject_kind"] == storage.BalanceSubjectProvider || msg.Extra["subject_kind"] == string(storage.BalanceSubjectProvider) {
			label = "预算剩余"
		}
		view.Metrics = append(view.Metrics, emailMetric{Label: label, Value: fmt.Sprintf("$%.2f", n)})
	}
	if n, ok := emailNumber(msg.Extra["runway_hours"]); ok && n >= 0 && msg.Event != storage.EventBalanceRecovered {
		metric := emailMetric{Label: "预计可用", Value: fmt.Sprintf("%.1f", n), Unit: "小时"}
		if n < 1 {
			metric.Value = fmt.Sprintf("%.0f", math.Max(1, math.Round(n*60)))
			metric.Unit = "分钟"
		} else if n >= 48 {
			metric.Value = fmt.Sprintf("%.1f", n/24)
			metric.Unit = "天"
		}
		view.Metrics = append(view.Metrics, metric)
	}
	if n, ok := emailNumber(msg.Extra["burn_per_hour"]); ok && n > 0 && msg.Event != storage.EventBalanceRecovered {
		view.Metrics = append(view.Metrics, emailMetric{Label: "消耗速度", Value: fmt.Sprintf("$%.2f", n), Unit: "/小时"})
	}
	// Body lines whose facts are promoted to metric tiles are consumed so the
	// same number is not printed twice; their parenthetical becomes the note.
	consumed := map[string]*emailMetric{}
	for i := range view.Metrics {
		consumed[view.Metrics[i].Label] = &view.Metrics[i]
	}
	if len(view.Metrics) > 0 {
		view.MetricWidth = fmt.Sprintf("%d%%", 100/len(view.Metrics))
	}

	if recharge, ok := msg.Extra["recharge_url"].(string); ok && msg.Event != storage.EventBalanceRecovered {
		view.ActionURL = safeEmailURL(recharge)
		view.ActionLabel = "立即充值"
	}
	console := safeEmailURL(consoleURL)
	if view.ActionURL == "" {
		view.ActionURL = console
		view.ActionLabel = "打开运营控制台"
	} else if console != "" {
		view.SecondaryURL = console
		view.SecondaryLabel = "打开运营控制台"
	}

	lines := strings.Split(strings.ReplaceAll(msg.Body, "\r\n", "\n"), "\n")
	kept := lines[:0:0]
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if label, value, ok := strings.Cut(line, "："); ok {
			if m := consumed[label]; m != nil {
				if i := strings.Index(value, "（"); i >= 0 && strings.HasSuffix(value, "）") {
					m.Note = strings.TrimSuffix(value[i+len("（"):], "）")
				}
				continue
			}
			if (label == "充值" || label == "充值链接") && view.ActionURL != "" && safeEmailURL(value) == view.ActionURL {
				continue
			}
		}
		kept = append(kept, raw)
	}
	body := strings.Join(kept, "\n")
	if isFailureEvent(msg.Event) && !strings.Contains(body, "：") {
		view.Body = template.HTML(renderEmailError(body))
	} else {
		view.Body = template.HTML(renderEmailContent(body, msg.Subject, theme)) // Content renderer escapes all upstream text.
	}
	var b bytes.Buffer
	if err := emailHTMLTemplate.Execute(&b, view); err != nil {
		return "", err
	}
	return b.String(), nil
}

const (
	emailInk    = "#14231f"
	emailText   = "#33463f"
	emailMuted  = "#6b7d77"
	emailLine   = "#e7ecea"
	emailMono   = "'SFMono-Regular',Menlo,Consolas,monospace"
	emailUp     = "#c0352b"
	emailDown   = "#12805c"
	emailCodeBg = "#f0f4f2"
)

func renderEmailError(body string) string {
	return `<p class="muted" style="margin:0 0 8px;font-size:12px;line-height:18px;color:` + emailMuted + `;">错误信息</p>` +
		`<div class="soft" style="background-color:#f6f8f7;border:1px solid ` + emailLine + `;border-radius:10px;padding:14px 16px;font-family:` + emailMono + `;font-size:13px;line-height:1.7;color:` + emailText + `;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;margin:0 0 18px;">` + html.EscapeString(strings.TrimSpace(body)) + `</div>`
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
			b.WriteString(`<code class="soft" style="font-family:` + emailMono + `;font-size:12px;background-color:` + emailCodeBg + `;color:#25473e;padding:2px 6px;border-radius:5px;">` + html.EscapeString(strings.Trim(token, "`")) + `</code>`)
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

var (
	emailRatioChange = regexp.MustCompile("^倍率：`([0-9.]+)x` (上涨|下调|调整) `([0-9.]+)x`$")
	emailRatioOnly   = regexp.MustCompile("^(原?倍率)：`([0-9.]+)x`$")
	emailNamedItem   = regexp.MustCompile(`^\*\*([^*\n]+)\*\*：(.+)$`)
)

func emailPill(text, color, bg string) string {
	return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background-color:` + bg + `;color:` + color + `;font-size:12px;line-height:18px;font-weight:600;white-space:nowrap;">` + html.EscapeString(text) + `</span>`
}

// renderEmailRatio turns "倍率：`0.8x` 下调 `0.65x`" into "0.8x → 0.65x  -18.8%".
func renderEmailRatio(detail string) (string, bool) {
	if m := emailRatioChange.FindStringSubmatch(detail); m != nil {
		oldV, _ := strconv.ParseFloat(m[1], 64)
		newV, _ := strconv.ParseFloat(m[3], 64)
		out := `<span class="muted" style="color:` + emailMuted + `;text-decoration:line-through;font-family:` + emailMono + `;font-size:13px;">` + m[1] + `x</span>` +
			`<span class="muted" style="color:` + emailMuted + `;">&nbsp;→&nbsp;</span>` +
			`<strong class="ink" style="color:` + emailInk + `;font-family:` + emailMono + `;font-size:14px;">` + m[3] + `x</strong>`
		if oldV > 0 && newV != oldV {
			pct := (newV - oldV) / oldV * 100
			if pct > 0 {
				out += "&nbsp; " + emailPill(fmt.Sprintf("↑ %.1f%%", pct), emailUp, "#fdeeec")
			} else {
				out += "&nbsp; " + emailPill(fmt.Sprintf("↓ %.1f%%", -pct), emailDown, "#e5f4ec")
			}
		}
		return out, true
	}
	if m := emailRatioOnly.FindStringSubmatch(detail); m != nil {
		style := `color:` + emailInk + `;`
		cls := "ink"
		if m[1] == "原倍率" {
			style = `color:` + emailMuted + `;text-decoration:line-through;`
			cls = "muted"
		}
		return `<strong class="` + cls + `" style="` + style + `font-family:` + emailMono + `;font-size:14px;">` + m[2] + `x</strong>`, true
	}
	return "", false
}

func renderEmailContent(body, title string, theme emailTheme) string {
	var b strings.Builder
	open := "" // "list" or "kv"
	closeBlock := func() {
		switch open {
		case "list", "kv":
			b.WriteString(`</table>`)
		}
		open = ""
	}
	openBlock := func(kind string) {
		if open == kind {
			return
		}
		closeBlock()
		open = kind
		b.WriteString(`<table role="presentation" width="100%" class="rule" style="width:100%;margin:0 0 18px;border-top:1px solid ` + emailLine + `;table-layout:fixed;">`)
	}
	row := func(left, right string) {
		b.WriteString(`<tr><td valign="top" class="rule kv-label muted" style="width:96px;padding:11px 12px 11px 0;border-bottom:1px solid ` + emailLine + `;color:` + emailMuted + `;font-size:13px;line-height:1.7;">` + left + `</td>` +
			`<td valign="top" class="rule" style="padding:11px 0;border-bottom:1px solid ` + emailLine + `;color:` + emailText + `;font-size:14px;line-height:1.7;overflow-wrap:anywhere;word-break:break-word;">` + right + `</td></tr>`)
	}
	sectionLabel := func(text string) {
		b.WriteString(`<p class="muted" style="margin:22px 0 8px;font-size:12px;line-height:18px;font-weight:600;letter-spacing:.4px;color:` + emailMuted + `;">` + text + `</p>`)
	}
	for _, raw := range strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			closeBlock()
			continue
		}
		if strings.HasPrefix(line, "- ") || strings.HasPrefix(line, "· ") {
			openBlock("list")
			item := strings.TrimSpace(line[len(strings.SplitN(line, " ", 2)[0])+1:])
			if m := emailNamedItem.FindStringSubmatch(item); m != nil {
				right, ok := renderEmailRatio(m[2])
				if !ok {
					right = renderEmailInline(m[2])
				}
				b.WriteString(`<tr><td valign="top" class="rule ink" style="padding:11px 12px 11px 0;border-bottom:1px solid ` + emailLine + `;color:` + emailInk + `;font-size:14px;line-height:1.7;font-weight:600;overflow-wrap:anywhere;word-break:break-word;">` + html.EscapeString(m[1]) + `</td>` +
					`<td valign="top" align="right" class="rule" style="padding:11px 0;border-bottom:1px solid ` + emailLine + `;color:` + emailText + `;font-size:14px;line-height:1.7;">` + right + `</td></tr>`)
				continue
			}
			name, detail, ok := strings.Cut(item, "：")
			cell := renderEmailInline(item)
			if ok && utf8.RuneCountInString(name) <= 40 {
				cell = `<span class="ink" style="color:` + emailInk + `;font-weight:600;">` + renderEmailInline(name) + `</span><br><span class="muted" style="color:` + emailMuted + `;font-size:13px;">` + renderEmailInline(detail) + `</span>`
			}
			b.WriteString(`<tr><td valign="top" class="rule" style="width:18px;padding:11px 0;border-bottom:1px solid ` + emailLine + `;"><span style="display:inline-block;width:6px;height:6px;border-radius:3px;background-color:` + theme.Color + `;vertical-align:middle;"></span></td>` +
				`<td valign="top" colspan="1" class="rule" style="padding:11px 0;border-bottom:1px solid ` + emailLine + `;color:` + emailText + `;font-size:14px;line-height:1.7;overflow-wrap:anywhere;word-break:break-word;">` + cell + `</td></tr>`)
			continue
		}
		switch {
		case strings.HasPrefix(line, "# "):
			closeBlock()
			heading := strings.TrimSpace(line[2:])
			if !strings.Contains(title, heading) {
				b.WriteString(`<h2 class="ink" style="font-size:17px;line-height:1.5;margin:22px 0 10px;color:` + emailInk + `;">` + renderEmailInline(heading) + `</h2>`)
			}
		case strings.HasPrefix(line, "## "):
			closeBlock()
			b.WriteString(`<h2 class="ink" style="font-size:16px;line-height:1.5;margin:26px 0 4px;color:` + emailInk + `;">` + renderEmailInline(line[3:]) + `</h2>`)
		case strings.HasPrefix(line, "### "):
			closeBlock()
			sectionLabel(renderEmailInline(line[4:]))
		case strings.HasPrefix(line, "> "):
			closeBlock()
			b.WriteString(`<p class="muted" style="margin:0 0 16px;color:` + emailMuted + `;font-size:13px;line-height:1.7;">` + renderEmailInline(line[2:]) + `</p>`)
		case strings.HasPrefix(line, "⚠"):
			closeBlock()
			line = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(line, "⚠"), "️"))
			b.WriteString(`<table role="presentation" width="100%" style="width:100%;margin:4px 0 18px;"><tr><td class="warn" style="padding:13px 16px;background-color:#fdf3e1;border-left:3px solid #d58a12;border-radius:0 8px 8px 0;color:#6e4a0b;font-size:14px;line-height:1.7;"><strong>注意&nbsp;</strong>` + renderEmailInline(line) + `</td></tr></table>`)
		default:
			label, value, ok := strings.Cut(line, "：")
			label = strings.TrimSpace(label)
			if ok && strings.TrimSpace(value) == "" && utf8.RuneCountInString(label) <= 16 {
				closeBlock()
				sectionLabel(html.EscapeString(label))
			} else if ok && utf8.RuneCountInString(label) <= 10 && !strings.ContainsAny(label, "<>/`*") {
				openBlock("kv")
				if label == "错误" {
					row(html.EscapeString(label), `<span style="font-family:`+emailMono+`;font-size:13px;color:`+emailUp+`;">`+html.EscapeString(strings.TrimSpace(value))+`</span>`)
				} else {
					row(html.EscapeString(label), renderEmailInline(strings.TrimSpace(value)))
				}
			} else {
				closeBlock()
				b.WriteString(`<p style="margin:0 0 14px;color:` + emailText + `;font-size:14px;line-height:1.8;">` + renderEmailInline(line) + `</p>`)
			}
		}
	}
	closeBlock()
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
