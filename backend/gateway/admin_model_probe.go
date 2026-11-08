package gateway

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/bejix/upstream-ops/backend/gateway/protocol"
	"github.com/bejix/upstream-ops/backend/storage"
)

// Model probes are admin-only experiments pinned to a single saved route. The
// engine is deliberately scenario-agnostic: the UI composes rounds (cache
// warm-up, pelican SVG, needle in a haystack, user templates …) and the engine
// executes them, measuring usage, caching, latency, throughput and output text.

const (
	probeMaxRounds        = 12
	probeMaxMessages      = 64
	probeMaxPromptBytes   = 2 << 20   // all rounds together
	probeMaxTextBytes     = 256 << 10 // captured answer per round
	probeMaxResponseBytes = 16 << 20
	probeDefaultMaxTokens = 1024
	probeMaxMaxTokens     = 64000
	probeDefaultTimeout   = 90
	probeMaxTimeout       = 600
	probeMaxIntervalSec   = 120
)

var probeImageSizePattern = regexp.MustCompile(`^(auto|\d{3,4}x\d{3,4})$`)

type ProbeMessage struct {
	Role    string `json:"role"` // system | user | assistant
	Content string `json:"content"`
}

type ProbeRound struct {
	Label    string         `json:"label"`
	Messages []ProbeMessage `json:"messages"`
}

type ModelProbeInput struct {
	Model    string `json:"model"`
	RouteID  uint   `json:"route_id"`
	Protocol string `json:"protocol"` // auto | chat | responses | image（auto 下生图模型自动走 image）
	// ImageSize 生图尺寸，如 1024x1024；为空用默认。仅 image 协议使用。
	ImageSize string `json:"image_size"`
	// ImageOptions gpt-image 系生图参数（质量 / 背景 / 格式 / 张数 / GIF 帧…）；仅 image 协议使用。
	ImageOptions *ImageProbeOptions `json:"image_options,omitempty"`
	Rounds       []ProbeRound       `json:"rounds"`
	IntervalSec  *int               `json:"interval_sec"` // pause before every round after the first
	MaxTokens    int                `json:"max_tokens"`
	Temperature  *float64           `json:"temperature"`
	Reasoning    string             `json:"reasoning"` // "" (provider default) | off | low | medium | high
	TimeoutSec   int                `json:"timeout_sec"`
	// ContinueOnError keeps running later rounds after a failure. Off by default
	// so an unavailable upstream is not charged/hammered repeatedly.
	ContinueOnError bool `json:"continue_on_error"`
}

type ModelProbeSample struct {
	Round           int      `json:"round"`
	Label           string   `json:"label"`
	OK              bool     `json:"ok"`
	StatusCode      int      `json:"status_code"`
	InputTokens     *int     `json:"input_tokens"`  // total input, including cached tokens
	CachedTokens    *int     `json:"cached_tokens"` // nil means not reported, NOT a cache miss
	TokenHitRate    *float64 `json:"token_hit_rate"`
	OutputTokens    *int     `json:"output_tokens"`
	ReasoningTokens *int     `json:"reasoning_tokens"`
	FirstTokenMS    *int64   `json:"first_token_ms"` // first text or reasoning delta
	FirstTextMS     *int64   `json:"first_text_ms"`  // first answer text delta
	DurationMS      int64    `json:"duration_ms"`
	OutputTPS       *float64 `json:"output_tps"` // output tokens / generation time after first token
	Text            string   `json:"text"`
	TextTruncated   bool     `json:"text_truncated,omitempty"`
	ReasoningChars  int      `json:"reasoning_chars"`
	FinishReason    string   `json:"finish_reason,omitempty"`
	Error           string   `json:"error,omitempty"`
	// Images 生图轮次返回的图片（URL 或 data URI）；超出回传上限的项为空字符串。
	Images          []string        `json:"images,omitempty"`
	ImagesTruncated bool            `json:"images_truncated,omitempty"`
	ImageInfo       *ImageProbeInfo `json:"image_info,omitempty"`
}

type ModelProbeEvent struct {
	Stage         string            `json:"stage"` // started | waiting | requesting | sample | done | error
	RouteID       uint              `json:"route_id,omitempty"`
	Label         string            `json:"label,omitempty"`
	UpstreamModel string            `json:"upstream_model,omitempty"`
	UpstreamPath  string            `json:"upstream_path,omitempty"`
	Protocol      string            `json:"protocol,omitempty"`
	Total         int               `json:"total,omitempty"`
	Round         int               `json:"round,omitempty"`
	WaitMS        int64             `json:"wait_ms,omitempty"`
	Sample        *ModelProbeSample `json:"sample,omitempty"`
	Error         string            `json:"error,omitempty"`
}

// ProbeModel bypasses scheduling/failover and pins one resolved target for the
// whole experiment. It neither changes routes nor writes runtime health or
// cooldowns. Each HTTP request is bounded, and disconnect cancels the run.
func (s *Service) ProbeModel(ctx context.Context, groupID uint, in ModelProbeInput, emit func(ModelProbeEvent) error) error {
	return s.admin().probeModel(ctx, groupID, in, emit)
}

func normalizeProbeInput(in *ModelProbeInput) error {
	in.Model = strings.TrimSpace(in.Model)
	if in.Model == "" || len(in.Model) > 256 || in.RouteID == 0 {
		return errors.New("model and route_id are required")
	}
	switch in.Protocol {
	case "", "auto", "chat", "responses", "image":
	default:
		return errors.New("protocol must be auto, chat, responses or image")
	}
	in.ImageSize = strings.TrimSpace(in.ImageSize)
	if in.ImageSize != "" && !probeImageSizePattern.MatchString(in.ImageSize) {
		return errors.New("image_size must look like 1024x1024 or auto")
	}
	if err := in.ImageOptions.normalize(); err != nil {
		return err
	}
	switch in.Reasoning {
	case "", "default", "off", "low", "medium", "high":
	default:
		return errors.New("reasoning must be default, off, low, medium or high")
	}
	if len(in.Rounds) == 0 || len(in.Rounds) > probeMaxRounds {
		return fmt.Errorf("rounds must contain 1-%d items", probeMaxRounds)
	}
	size := 0
	for i := range in.Rounds {
		r := &in.Rounds[i]
		if len(r.Messages) == 0 || len(r.Messages) > probeMaxMessages {
			return fmt.Errorf("round %d must contain 1-%d messages", i+1, probeMaxMessages)
		}
		hasUser := false
		for _, m := range r.Messages {
			switch m.Role {
			case "system", "assistant":
			case "user":
				hasUser = true
			default:
				return fmt.Errorf("round %d: role must be system, user or assistant", i+1)
			}
			size += len(m.Content)
		}
		if !hasUser {
			return fmt.Errorf("round %d needs a user message", i+1)
		}
		r.Label = clipString(strings.TrimSpace(r.Label), 64)
		if r.Label == "" {
			r.Label = fmt.Sprintf("第 %d 轮", i+1)
		}
	}
	if size > probeMaxPromptBytes {
		return errors.New("prompt is too large (max 2 MiB across all rounds)")
	}
	if in.MaxTokens == 0 {
		in.MaxTokens = probeDefaultMaxTokens
	}
	if in.MaxTokens < 1 || in.MaxTokens > probeMaxMaxTokens {
		return fmt.Errorf("max_tokens must be between 1 and %d", probeMaxMaxTokens)
	}
	if t := in.Temperature; t != nil && (math.IsNaN(*t) || *t < 0 || *t > 2) {
		return errors.New("temperature must be between 0 and 2")
	}
	if in.TimeoutSec == 0 {
		in.TimeoutSec = probeDefaultTimeout
	}
	if in.TimeoutSec < 5 || in.TimeoutSec > probeMaxTimeout {
		return fmt.Errorf("timeout_sec must be between 5 and %d", probeMaxTimeout)
	}
	if in.IntervalSec != nil && (*in.IntervalSec < 0 || *in.IntervalSec > probeMaxIntervalSec) {
		return fmt.Errorf("interval_sec must be between 0 and %d", probeMaxIntervalSec)
	}
	return nil
}

func (a *AdminService) probeModel(parent context.Context, groupID uint, in ModelProbeInput, emit func(ModelProbeEvent) error) error {
	if err := normalizeProbeInput(&in); err != nil {
		return err
	}
	interval := 0
	if in.IntervalSec != nil {
		interval = *in.IntervalSec
	}
	group, err := a.Groups.FindByID(groupID)
	if err != nil {
		return err
	}
	routes, err := a.Routes.ListByGroupID(groupID)
	if err != nil {
		return err
	}
	var selected *storage.GatewayRoute
	for _, route := range filterRoutesForModel(routes, a.ParseModelsJSON(group.ModelsJSON), in.Model) {
		if route.ID == in.RouteID {
			cp := route
			selected = &cp
			break
		}
	}
	if selected == nil || !selected.Enabled {
		return errors.New("enabled route not found for this model in group")
	}
	target, err := a.resolveUpstreamTarget(selected)
	if err != nil {
		return err
	}
	a.runtime().applyRouteUserAgentForAdmin(target, group, selected)
	upstreamModel, _ := ResolveModel(in.Model, ParseModelMapping(selected.ModelMappingJSON), ParseModelMapping(group.ModelMappingJSON))
	if upstreamModel == "" {
		upstreamModel = in.Model
	}
	label := fmt.Sprintf("route#%d", selected.ID)
	if target.Provider != nil {
		label = target.Provider.Name
	} else if target.Channel != nil {
		label = a.formatChannelGroupLabel(target.Channel.Name, selected.SourceGroupName, selected.SourceChannelID)
	}
	inbound := protocol.KindOpenAIChat
	if in.Protocol == "responses" {
		inbound = protocol.KindOpenAIResponses
	}
	routeProto := a.normalizeUpstreamProtocol(selected.UpstreamProtocol)
	if target.Provider != nil && routeProto == storage.GatewayUpstreamProtocolAuto {
		routeProto = a.normalizeProviderProtocol(target.Provider.UpstreamProtocol)
	}
	kind := protocol.ResolveUpstream(routeProto, inbound, upstreamModel)
	imageMode := in.Protocol == "image" || ((in.Protocol == "" || in.Protocol == "auto") && isImageGenerationModel(upstreamModel))
	protoLabel := string(kind)
	if imageMode {
		protoLabel = "image"
	}

	total := len(in.Rounds)
	budget := time.Duration(total)*time.Duration(in.TimeoutSec+interval)*time.Second + 30*time.Second
	ctx, cancel := context.WithTimeout(parent, budget)
	defer cancel()
	client := a.httpClientForTarget(target.Channel, target.Provider)
	defer client.CloseIdleConnections()
	if err := emit(ModelProbeEvent{Stage: "started", RouteID: selected.ID, Label: label, UpstreamModel: upstreamModel, Protocol: protoLabel, Total: total}); err != nil {
		return err
	}
	for i, round := range in.Rounds {
		n := i + 1
		if n > 1 && interval > 0 {
			if err := emit(ModelProbeEvent{Stage: "waiting", Round: n, Total: total, WaitMS: int64(interval) * 1000}); err != nil {
				return err
			}
			timer := time.NewTimer(time.Duration(interval) * time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := emit(ModelProbeEvent{Stage: "requesting", Round: n, Total: total}); err != nil {
			return err
		}
		var sample ModelProbeSample
		var path string
		if imageMode {
			body, err := imageProbeBody(upstreamModel, imagePromptFromMessages(round.Messages), in.ImageSize, in.ImageOptions)
			if err != nil {
				return err
			}
			path = imageProbePath
			sample = a.probeImageRequest(ctx, client, target, body, time.Duration(in.TimeoutSec)*time.Second)
		} else {
			body, p, err := a.probeBody(in, round.Messages, upstreamModel, kind)
			if err != nil {
				return err
			}
			path = p
			sample = a.probeRequest(ctx, client, target, body, path, kind, time.Duration(in.TimeoutSec)*time.Second)
		}
		sample.Round, sample.Label = n, round.Label
		if ctx.Err() != nil && parent.Err() != nil {
			return parent.Err()
		}
		if err := emit(ModelProbeEvent{Stage: "sample", Sample: &sample, UpstreamPath: path, Total: total, Round: n}); err != nil {
			return err
		}
		if !sample.OK && !in.ContinueOnError {
			break
		}
	}
	return emit(ModelProbeEvent{Stage: "done", Total: total})
}

func applyProbeReasoning(payload map[string]any, model, reasoning string, responses bool) {
	deepseek := strings.HasPrefix(strings.ToLower(model), "deepseek")
	switch reasoning {
	case "", "default":
		return
	case "off":
		if deepseek {
			payload["thinking"] = map[string]any{"type": "disabled"}
		}
		if responses {
			payload["reasoning"] = map[string]any{"effort": "none"}
		} else if !deepseek {
			payload["reasoning_effort"] = "none"
		}
	default:
		if deepseek {
			payload["thinking"] = map[string]any{"type": "enabled"}
		}
		if responses {
			payload["reasoning"] = map[string]any{"effort": reasoning}
		} else {
			payload["reasoning_effort"] = reasoning
		}
	}
}

func (a *AdminService) probeBody(in ModelProbeInput, messages []ProbeMessage, model string, kind protocolKind) ([]byte, string, error) {
	msgs := make([]any, 0, len(messages))
	for _, m := range messages {
		msgs = append(msgs, map[string]any{"role": m.Role, "content": m.Content})
	}
	// Native Responses avoids a lossy Chat conversion for Responses-first sources.
	if kind == protocol.KindOpenAIResponses {
		payload := map[string]any{"model": model, "input": msgs, "stream": true, "max_output_tokens": in.MaxTokens}
		if in.Temperature != nil {
			payload["temperature"] = *in.Temperature
		}
		applyProbeReasoning(payload, model, in.Reasoning, true)
		body, err := json.Marshal(payload)
		return body, "/v1/responses", err
	}
	payload := map[string]any{"model": model, "messages": msgs, "stream": true, "max_tokens": in.MaxTokens}
	if in.Temperature != nil {
		payload["temperature"] = *in.Temperature
	}
	applyProbeReasoning(payload, model, in.Reasoning, false)
	chat, err := json.Marshal(payload)
	if err != nil {
		return nil, "", err
	}
	body, path, _, err := a.prepareUpstreamRequest(chat, protocol.KindOpenAIChat, kind, model, true, "/v1/chat/completions")
	return body, path, err
}

type probeCollector struct {
	sample    *ModelProbeSample
	start     time.Time
	text      strings.Builder
	reasoning int
}

func (c *probeCollector) addText(s string) {
	if s == "" {
		return
	}
	now := time.Since(c.start).Milliseconds()
	if c.sample.FirstTokenMS == nil {
		c.sample.FirstTokenMS = &now
	}
	if c.sample.FirstTextMS == nil {
		v := now
		c.sample.FirstTextMS = &v
	}
	if room := probeMaxTextBytes - c.text.Len(); room > 0 {
		if len(s) > room {
			s = s[:room]
			c.sample.TextTruncated = true
		}
		c.text.WriteString(s)
	} else {
		c.sample.TextTruncated = true
	}
}

func (c *probeCollector) addReasoning(s string) {
	if s == "" {
		return
	}
	if c.sample.FirstTokenMS == nil {
		now := time.Since(c.start).Milliseconds()
		c.sample.FirstTokenMS = &now
	}
	c.reasoning += len([]rune(s))
}

// consume extracts deltas, finish reasons and usage from one decoded event.
// It understands Chat Completions, Responses and Anthropic Messages streams.
func (c *probeCollector) consume(raw map[string]any, kind protocolKind) {
	mergeProbeUsage(c.sample, raw, kind)
	switch t := stringValue(raw["type"]); t {
	case "response.output_text.delta":
		c.addText(stringValue(raw["delta"]))
		return
	case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
		c.addReasoning(stringValue(raw["delta"]))
		return
	case "response.completed", "response.incomplete", "response.failed":
		if resp, _ := raw["response"].(map[string]any); resp != nil {
			c.sample.FinishReason = stringValue(resp["status"])
			if d, _ := resp["incomplete_details"].(map[string]any); d != nil && stringValue(d["reason"]) != "" {
				c.sample.FinishReason = stringValue(d["reason"])
			}
		}
		return
	case "content_block_delta":
		if d, _ := raw["delta"].(map[string]any); d != nil {
			switch d["type"] {
			case "text_delta":
				c.addText(stringValue(d["text"]))
			case "thinking_delta":
				c.addReasoning(stringValue(d["thinking"]))
			}
		}
		return
	case "message_delta":
		if d, _ := raw["delta"].(map[string]any); d != nil && stringValue(d["stop_reason"]) != "" {
			c.sample.FinishReason = stringValue(d["stop_reason"])
		}
		return
	}
	choices, _ := raw["choices"].([]any)
	for _, choice := range choices {
		ch, _ := choice.(map[string]any)
		if ch == nil {
			continue
		}
		if fr := stringValue(ch["finish_reason"]); fr != "" {
			c.sample.FinishReason = fr
		}
		delta, _ := ch["delta"].(map[string]any)
		if delta == nil { // non-streaming fallback
			delta, _ = ch["message"].(map[string]any)
		}
		if delta == nil {
			continue
		}
		c.addReasoning(stringValue(delta["reasoning_content"]))
		c.addReasoning(stringValue(delta["reasoning"]))
		c.addText(stringValue(delta["content"]))
	}
}

// consumeJSONBody handles upstreams that ignore stream=true and reply with a
// single JSON document.
func (c *probeCollector) consumeJSONBody(raw map[string]any, kind protocolKind) {
	if _, ok := raw["choices"]; ok {
		c.consume(raw, kind)
		return
	}
	mergeProbeUsage(c.sample, raw, kind)
	if output, ok := raw["output"].([]any); ok { // Responses
		c.sample.FinishReason = stringValue(raw["status"])
		for _, item := range output {
			it, _ := item.(map[string]any)
			parts, _ := it["content"].([]any)
			for _, p := range parts {
				pm, _ := p.(map[string]any)
				switch pm["type"] {
				case "output_text":
					c.addText(stringValue(pm["text"]))
				case "reasoning_text":
					c.addReasoning(stringValue(pm["text"]))
				}
			}
		}
		return
	}
	if parts, ok := raw["content"].([]any); ok { // Anthropic
		c.sample.FinishReason = stringValue(raw["stop_reason"])
		for _, p := range parts {
			pm, _ := p.(map[string]any)
			switch pm["type"] {
			case "text":
				c.addText(stringValue(pm["text"]))
			case "thinking":
				c.addReasoning(stringValue(pm["thinking"]))
			}
		}
	}
}

func (a *AdminService) probeRequest(parent context.Context, client *http.Client, target *upstreamTarget, body []byte, path string, kind protocolKind, timeout time.Duration) (sample ModelProbeSample) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	col := &probeCollector{sample: &sample, start: time.Now()}
	defer func() {
		sample.DurationMS = time.Since(col.start).Milliseconds()
		sample.Text = col.text.String()
		sample.ReasoningChars = col.reasoning
		if sample.InputTokens != nil && sample.CachedTokens != nil && *sample.InputTokens > 0 && *sample.CachedTokens <= *sample.InputTokens {
			rate := float64(*sample.CachedTokens) / float64(*sample.InputTokens)
			sample.TokenHitRate = &rate
		}
		if sample.OutputTokens != nil && *sample.OutputTokens > 0 && sample.FirstTokenMS != nil {
			if gen := sample.DurationMS - *sample.FirstTokenMS; gen >= 50 {
				tps := math.Round(float64(*sample.OutputTokens)/(float64(gen)/1000)*10) / 10
				sample.OutputTPS = &tps
			}
		}
	}()
	req, err := a.buildUpstreamHTTPRequest(ctx, target, path, http.MethodPost, http.Header{}, body, kind, true)
	if err != nil {
		sample.Error = "could not build probe request"
		return
	}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			sample.Error = fmt.Sprintf("请求超时（%ds）", int(timeout.Seconds()))
		} else {
			sample.Error = "upstream request failed"
		}
		return
	}
	defer resp.Body.Close()
	sample.StatusCode = resp.StatusCode
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		msg := a.truncateProbeError(snippet, 240)
		sample.Error = redactProbeSecret(fmt.Sprintf("upstream HTTP %d", resp.StatusCode), msg, target.APIKey)
		return
	}
	reader := io.LimitReader(resp.Body, probeMaxResponseBytes)
	if ct := strings.ToLower(resp.Header.Get("Content-Type")); strings.Contains(ct, "application/json") {
		var raw map[string]any
		data, err := io.ReadAll(reader)
		if err != nil || json.Unmarshal(data, &raw) != nil {
			sample.Error = "upstream returned invalid JSON"
			return
		}
		col.consumeJSONBody(raw, kind)
		sample.OK = col.text.Len() > 0
		if !sample.OK {
			sample.Error = "上游未返回正文"
		}
		return
	}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), 4<<20)
	var lines []string
	terminal, terminalOK := false, false
	terminalErr := ""
	flush := func() {
		event, data := a.runtime().parseSSEEventLines(lines)
		lines = nil
		if data == "" {
			return
		}
		var raw map[string]any
		if json.Unmarshal([]byte(data), &raw) == nil {
			col.consume(raw, kind)
		}
		if end, ok, _ := a.runtime().upstreamSSETerminal(event, data, kind); end {
			terminal, terminalOK = true, ok
			if !ok {
				terminalErr = a.truncateProbeError([]byte(data), 240)
			}
		}
	}
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			flush()
			if terminal {
				break
			}
		} else {
			lines = append(lines, line)
		}
	}
	if len(lines) > 0 {
		flush()
	}
	switch {
	case scanner.Err() != nil && ctx.Err() == context.DeadlineExceeded:
		sample.Error = fmt.Sprintf("请求超时（%ds），已收到部分输出", int(timeout.Seconds()))
	case scanner.Err() != nil:
		sample.Error = "读取上游流失败"
	case terminal && !terminalOK:
		sample.Error = redactProbeSecret("上游流返回错误", terminalErr, target.APIKey)
	case !terminal:
		sample.Error = "上游流未正常结束"
	case col.text.Len() == 0 && col.reasoning > 0:
		sample.Error = "只有推理没有正文，可能 max_tokens 被推理耗尽"
	case col.text.Len() == 0:
		sample.Error = "上游未返回正文"
	default:
		sample.OK = true
	}
	return
}

func redactProbeSecret(prefix, msg, secret string) string {
	if secret != "" && len(secret) >= 6 {
		msg = strings.ReplaceAll(msg, secret, "***")
	}
	if msg == "" {
		return prefix
	}
	return prefix + ": " + msg
}

func mergeProbeUsage(sample *ModelProbeSample, raw map[string]any, kind protocolKind) {
	u, _ := openAIUsageObjects(raw)
	if msg, _ := raw["message"].(map[string]any); msg != nil && u == nil {
		u, _ = msg["usage"].(map[string]any) // Anthropic message_start
	}
	if u == nil {
		return
	}
	anthropicStyle := kind == protocol.KindAnthropic || u["cache_read_input_tokens"] != nil || u["cache_creation_input_tokens"] != nil
	if input := probeTokenField(u, "input_tokens"); input != nil {
		v := *input
		if anthropicStyle && u["input_tokens_details"] == nil {
			v += max0(mapInt(u, "cache_read_input_tokens")) + max0(mapInt(u, "cache_creation_input_tokens"))
		}
		// Anthropic message_delta may repeat a smaller input count; keep the largest.
		if sample.InputTokens == nil || v >= *sample.InputTokens {
			sample.InputTokens = &v
		}
	} else if input := probeTokenField(u, "prompt_tokens"); input != nil {
		sample.InputTokens = input
	}
	if out := probeTokenField(u, "output_tokens"); out != nil {
		sample.OutputTokens = out
	} else if out := probeTokenField(u, "completion_tokens"); out != nil {
		sample.OutputTokens = out
	}
	for _, key := range []string{"output_tokens_details", "completion_tokens_details"} {
		if details, _ := u[key].(map[string]any); details != nil {
			if v := probeTokenField(details, "reasoning_tokens"); v != nil {
				sample.ReasoningTokens = v
			}
		}
	}
	for _, key := range []string{"input_tokens_details", "prompt_tokens_details"} {
		if details, _ := u[key].(map[string]any); details != nil {
			if value := probeTokenField(details, "cached_tokens"); value != nil {
				sample.CachedTokens = value
				return
			}
		}
	}
	for _, key := range []string{"prompt_cache_hit_tokens", "cache_read_input_tokens", "cache_read_tokens", "cached_tokens", "cache_hit_tokens"} {
		if value := probeTokenField(u, key); value != nil {
			sample.CachedTokens = value
			return
		}
	}
}

func probeTokenField(m map[string]any, key string) *int {
	var value float64
	switch v := m[key].(type) {
	case float64:
		value = v
	case string:
		n, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return nil
		}
		value = n
	default:
		return nil
	}
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 1e9 {
		return nil
	}
	n := int(value)
	return &n
}
