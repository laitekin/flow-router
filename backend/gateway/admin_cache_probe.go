package gateway

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/bejix/upstream-ops/backend/gateway/protocol"
	"github.com/bejix/upstream-ops/backend/storage"
)

type CacheTestInput struct {
	Model       string `json:"model"`
	RouteID     uint   `json:"route_id"`
	Protocol    string `json:"protocol"` // auto follows the route/provider; chat or responses selects the inbound protocol
	IntervalSec *int   `json:"interval_sec"`
}

type CacheTestSample struct {
	Round        int      `json:"round"`
	Case         string   `json:"case"`
	OK           bool     `json:"ok"`
	StatusCode   int      `json:"status_code"`
	InputTokens  *int     `json:"input_tokens"`  // total input, including cached tokens
	CachedTokens *int     `json:"cached_tokens"` // nil means not reported, NOT a cache miss
	TokenHitRate *float64 `json:"token_hit_rate"`
	FirstTextMS  *int64   `json:"first_text_ms"` // text delta, not response.created or first byte
	DurationMS   int64    `json:"duration_ms"`
	Error        string   `json:"error,omitempty"`
}

type CacheTestEvent struct {
	Stage         string           `json:"stage"`
	RouteID       uint             `json:"route_id,omitempty"`
	Label         string           `json:"label,omitempty"`
	UpstreamModel string           `json:"upstream_model,omitempty"`
	UpstreamPath  string           `json:"upstream_path,omitempty"`
	Total         int              `json:"total,omitempty"`
	Round         int              `json:"round,omitempty"`
	Sample        *CacheTestSample `json:"sample,omitempty"`
	Error         string           `json:"error,omitempty"`
}

// TestModelCache deliberately bypasses scheduling/failover and pins one resolved
// target for the whole experiment. It neither changes routes nor writes runtime
// health/cooldowns. Each HTTP request is bounded, and disconnect cancels the run.
func (s *Service) TestModelCache(ctx context.Context, groupID uint, in CacheTestInput, emit func(CacheTestEvent) error) error {
	return s.admin().testModelCache(ctx, groupID, in, emit)
}

func (a *AdminService) testModelCache(parent context.Context, groupID uint, in CacheTestInput, emit func(CacheTestEvent) error) error {
	model := strings.TrimSpace(in.Model)
	if model == "" || len(model) > 256 || in.RouteID == 0 {
		return errors.New("model and route_id are required")
	}
	if in.Protocol != "" && in.Protocol != "auto" && in.Protocol != "chat" && in.Protocol != "responses" {
		return errors.New("protocol must be auto, chat or responses")
	}
	interval := 5
	if in.IntervalSec != nil {
		interval = *in.IntervalSec
	}
	if interval < 1 || interval > 15 {
		return errors.New("interval_sec must be between 1 and 15")
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
	for _, route := range filterRoutesForModel(routes, a.ParseModelsJSON(group.ModelsJSON), model) {
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
	upstreamModel, _ := ResolveModel(model, ParseModelMapping(selected.ModelMappingJSON), ParseModelMapping(group.ModelMappingJSON))
	if upstreamModel == "" {
		upstreamModel = model
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
	marker := make([]byte, 12)
	if _, err := rand.Read(marker); err != nil {
		return err
	}
	prefix := "Synthetic cache experiment " + hex.EncodeToString(marker) + ". Read the records and reply only OK.\n"
	for i := 0; i < 128; i++ {
		prefix += fmt.Sprintf("Record %03d: warehouse inventory item copper steel timber glass; received 48 units, dispatched 17 units, remaining 31 units; verified stable.\n", i)
	}
	ctx, cancel := context.WithTimeout(parent, 4*time.Minute)
	defer cancel()
	client := a.httpClientForTarget(target.Channel, target.Provider)
	defer client.CloseIdleConnections()
	const total = 5
	if err := emit(CacheTestEvent{Stage: "started", RouteID: selected.ID, Label: label, UpstreamModel: upstreamModel, Total: total}); err != nil {
		return err
	}
	for round := 1; round <= total; round++ {
		if round > 1 {
			if err := emit(CacheTestEvent{Stage: "waiting", Round: round, Total: total}); err != nil {
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
		if err := emit(CacheTestEvent{Stage: "requesting", Round: round, Total: total}); err != nil {
			return err
		}
		text := prefix + "End of document. Reply only OK."
		caseName := "cold"
		if round > 1 {
			caseName = "repeat"
		}
		if round > 3 {
			caseName = "changed_tail"
			text = prefix + fmt.Sprintf("End of document. Verification variant %d. Reply only OK.", round)
		}
		body, path, err := a.cacheTestBody(text, upstreamModel, kind)
		if err != nil {
			return err
		}
		sample := a.cacheTestRequest(ctx, client, target, body, path, kind)
		sample.Round, sample.Case = round, caseName
		if err := emit(CacheTestEvent{Stage: "sample", Sample: &sample, UpstreamPath: path, Total: total}); err != nil {
			return err
		}
		if !sample.OK { // do not repeatedly charge or hammer an unavailable upstream
			break
		}
	}
	return emit(CacheTestEvent{Stage: "done", Total: total})
}

func (a *AdminService) cacheTestBody(text, model string, kind protocolKind) ([]byte, string, error) {
	// Native Responses avoids a lossy Chat conversion for Responses-first sources.
	if kind == protocol.KindOpenAIResponses {
		payload := map[string]any{"model": model, "input": []any{map[string]any{"role": "user", "content": text}}, "stream": true, "max_output_tokens": 64}
		if strings.HasPrefix(strings.ToLower(model), "deepseek") {
			payload["reasoning"] = map[string]any{"effort": "none"}
			payload["thinking"] = map[string]any{"type": "disabled"}
		}
		body, err := json.Marshal(payload)
		return body, "/v1/responses", err
	}
	payload := map[string]any{"model": model, "messages": []any{map[string]any{"role": "user", "content": text}}, "stream": true, "max_tokens": 64}
	if strings.HasPrefix(strings.ToLower(model), "deepseek") {
		payload["thinking"] = map[string]any{"type": "disabled"}
	}
	chat, err := json.Marshal(payload)
	if err != nil {
		return nil, "", err
	}
	body, path, _, err := a.prepareUpstreamRequest(chat, protocol.KindOpenAIChat, kind, model, true, "/v1/chat/completions")
	return body, path, err
}

func (a *AdminService) cacheTestRequest(parent context.Context, client *http.Client, target *upstreamTarget, body []byte, path string, kind protocolKind) (sample CacheTestSample) {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	start := time.Now()
	defer func() { sample.DurationMS = time.Since(start).Milliseconds() }()
	req, err := a.buildUpstreamHTTPRequest(ctx, target, path, http.MethodPost, http.Header{}, body, kind, true)
	if err != nil {
		sample.Error = "could not build probe request"
		return
	}
	resp, err := client.Do(req)
	if err != nil {
		sample.Error = "upstream request failed or timed out"
		return
	}
	defer resp.Body.Close()
	sample.StatusCode = resp.StatusCode
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Do not echo upstream bodies: providers sometimes echo Authorization/keys.
		sample.Error = fmt.Sprintf("upstream HTTP %d", resp.StatusCode)
		return
	}
	scanner := bufio.NewScanner(io.LimitReader(resp.Body, 2*1024*1024))
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	var lines []string
	terminal, terminalOK := false, false
	consume := func() {
		event, data := a.runtime().parseSSEEventLines(lines)
		lines = nil
		if data == "" {
			return
		}
		var raw map[string]any
		if json.Unmarshal([]byte(data), &raw) == nil {
			mergeCacheTestUsage(&sample, raw, kind)
			if sample.FirstTextMS == nil && cacheTestHasText(raw) {
				ms := time.Since(start).Milliseconds()
				sample.FirstTextMS = &ms
			}
		}
		if end, ok, _ := a.runtime().upstreamSSETerminal(event, data, kind); end {
			terminal, terminalOK = true, ok
		}
	}
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			consume()
			if terminal {
				break
			}
		} else {
			lines = append(lines, line)
		}
	}
	if len(lines) > 0 {
		consume()
	}
	sample.OK = scanner.Err() == nil && terminal && terminalOK && sample.FirstTextMS != nil
	if !sample.OK {
		sample.Error = "upstream did not complete a text stream"
	}
	if sample.InputTokens != nil && sample.CachedTokens != nil && *sample.InputTokens > 0 && *sample.CachedTokens <= *sample.InputTokens {
		rate := float64(*sample.CachedTokens) / float64(*sample.InputTokens)
		sample.TokenHitRate = &rate
	}
	return
}

func cacheTestHasText(raw map[string]any) bool {
	if raw["type"] == "response.output_text.delta" {
		return stringValue(raw["delta"]) != ""
	}
	if delta, _ := raw["delta"].(map[string]any); delta != nil && delta["type"] == "text_delta" {
		return stringValue(delta["text"]) != ""
	}
	choices, _ := raw["choices"].([]any)
	for _, choice := range choices {
		c, _ := choice.(map[string]any)
		delta, _ := c["delta"].(map[string]any)
		if stringValue(delta["content"]) != "" {
			return true
		}
	}
	return false
}

func mergeCacheTestUsage(sample *CacheTestSample, raw map[string]any, kind protocolKind) {
	u, _ := openAIUsageObjects(raw)
	if kind == protocol.KindAnthropic {
		if msg, _ := raw["message"].(map[string]any); msg != nil {
			u, _ = msg["usage"].(map[string]any)
		}
	}
	if u == nil {
		return
	}
	if input := cacheTokenField(u, "input_tokens"); input != nil {
		v := *input
		if kind == protocol.KindAnthropic {
			v += max0(mapInt(u, "cache_read_input_tokens")) + max0(mapInt(u, "cache_creation_input_tokens"))
		}
		sample.InputTokens = &v
	} else if input := cacheTokenField(u, "prompt_tokens"); input != nil {
		sample.InputTokens = input
	}
	for _, key := range []string{"input_tokens_details", "prompt_tokens_details"} {
		if details, _ := u[key].(map[string]any); details != nil {
			if value := cacheTokenField(details, "cached_tokens"); value != nil {
				sample.CachedTokens = value
				return
			}
		}
	}
	for _, key := range []string{"prompt_cache_hit_tokens", "cache_read_input_tokens", "cache_read_tokens", "cached_tokens", "cache_hit_tokens"} {
		if value := cacheTokenField(u, key); value != nil {
			sample.CachedTokens = value
			return
		}
	}
}

func cacheTokenField(m map[string]any, key string) *int {
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
