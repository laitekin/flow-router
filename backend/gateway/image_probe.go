// 生图模型探测：模型测试 / 测试台 / 解除冷却并测试 对生图模型改走 /v1/images/generations。
//
// 生图模型（gpt-image-1、dall-e-3、flux、seedream …）大多不支持 /chat/completions，
// 用聊天 ping 测试必然 400/404，导致可用的生图线路被误判、冷却也无法通过测试解除。
package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/bejix/upstream-ops/backend/gateway/protocol"
	"github.com/gin-gonic/gin"
)

const (
	imageProbePath = "/v1/images/generations"
	// 生图非流式，整张图生成完才返回；gpt-image-1 高峰期常见 30~90s。
	imageProbeTimeout = 150 * time.Second
	// 快速测试用的提示词：简单、无争议，尽量让上游走最便宜的路径。
	imageProbeQuickPrompt = "A single red apple on a plain white background, minimal flat illustration."
	// 测试台单轮最多回传的图片数据（data URI 或 URL）。
	imageProbeMaxPayloadBytes = 12 << 20
)

// 常见生图模型命名。刻意不含 gemini-*-image / gpt-4o-image 这类走 chat 返回图片的模型：
// 中转站通常只在 /chat/completions 暴露它们。
var imageModelPattern = regexp.MustCompile(`(?i)(^|[/:_-])(gpt-image|chatgpt-image|dall-e|dalle|imagen|flux|stable-diffusion|sdxl|sd3|sd-?\d|midjourney|mj[-_]|seedream|seededit|cogview|kolors|wanx|wan\d[.\d]*-t2i|qwen-image|hunyuan-image|hidream|recraft|ideogram|playground-v|grok-imagine-image|grok-\d+(\.\d+)?-image|kling-image|jimeng|doubao-seedream|minimax-image|image-\d{2})`)

// isImageGenerationModel 根据模型名判断是否为走 images 端点的生图模型。
func isImageGenerationModel(model string) bool {
	m := strings.TrimSpace(model)
	if m == "" {
		return false
	}
	return imageModelPattern.MatchString(m)
}

// imageProbeBody 构造 images/generations 请求体。只带各家都接受的参数：
// size 用 1024x1024（dall-e-2 以外均支持，dall-e-2 也接受）；gpt-image 系额外用 quality=low 省钱。
// 不发 response_format：gpt-image 系会因此 400。
func imageProbeBody(model, prompt, size string) ([]byte, error) {
	if strings.TrimSpace(size) == "" {
		size = "1024x1024"
	}
	payload := map[string]any{"model": model, "prompt": prompt, "n": 1, "size": size}
	if strings.Contains(strings.ToLower(model), "gpt-image") {
		payload["quality"] = "low"
	}
	return json.Marshal(payload)
}

// imageProbeResult 解析后的生图响应。
type imageProbeResult struct {
	Images        []string // URL 或 data URI
	RevisedPrompt string
	InputTokens   *int
	OutputTokens  *int
	Truncated     bool
	Err           string
}

// parseImageProbeResponse 解析 OpenAI images 响应；2xx 但没有图片（部分中转把错误包在 200 里）视为失败。
func parseImageProbeResponse(body []byte, keepPayload bool) imageProbeResult {
	var out imageProbeResult
	var raw struct {
		Data []struct {
			URL           string `json:"url"`
			B64JSON       string `json:"b64_json"`
			RevisedPrompt string `json:"revised_prompt"`
		} `json:"data"`
		OutputFormat string          `json:"output_format"`
		Usage        json.RawMessage `json:"usage"`
		Error        json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		out.Err = "上游返回的不是有效 JSON"
		return out
	}
	mime := "image/png"
	switch strings.ToLower(raw.OutputFormat) {
	case "jpeg", "jpg":
		mime = "image/jpeg"
	case "webp":
		mime = "image/webp"
	}
	budget := imageProbeMaxPayloadBytes
	for _, d := range raw.Data {
		if d.RevisedPrompt != "" && out.RevisedPrompt == "" {
			out.RevisedPrompt = clipString(d.RevisedPrompt, 1000)
		}
		var item string
		switch {
		case strings.TrimSpace(d.URL) != "":
			item = strings.TrimSpace(d.URL)
		case strings.TrimSpace(d.B64JSON) != "":
			b64 := strings.TrimSpace(d.B64JSON)
			if strings.HasPrefix(b64, "data:") {
				item = b64
			} else {
				item = "data:" + mime + ";base64," + b64
			}
		default:
			continue
		}
		if !keepPayload {
			out.Images = append(out.Images, "")
			continue
		}
		if len(item) > budget {
			out.Truncated = true
			out.Images = append(out.Images, "")
			continue
		}
		budget -= len(item)
		out.Images = append(out.Images, item)
	}
	if len(raw.Usage) > 0 {
		var u map[string]any
		if json.Unmarshal(raw.Usage, &u) == nil {
			out.InputTokens = probeTokenField(u, "input_tokens")
			out.OutputTokens = probeTokenField(u, "output_tokens")
		}
	}
	if len(out.Images) == 0 {
		if len(raw.Error) > 0 && string(raw.Error) != "null" {
			out.Err = "上游返回错误：" + clipString(string(raw.Error), 240)
		} else {
			out.Err = "上游未返回图片"
		}
	}
	return out
}

// probeRouteImage 快速测试 / 解除冷却：对生图模型发一张最小图。
// 上游不认识 images 端点（404/405）时回退到聊天 ping，兼容只在 chat 暴露生图模型的中转。
func (a *AdminService) probeRouteImage(parent context.Context, target *upstreamTarget, res *ModelTestResult, upstreamModel string) (fallbackToChat bool) {
	body, err := imageProbeBody(upstreamModel, imageProbeQuickPrompt, "")
	if err != nil {
		res.Error = err.Error()
		return false
	}
	res.UpstreamPath = imageProbePath
	ctx, cancel := context.WithTimeout(parent, imageProbeTimeout)
	defer cancel()
	start := time.Now()
	status, _, respBody, _, fwdErr := a.forwardOnce(
		ctx, &gin.Context{}, target, imageProbePath, http.MethodPost, http.Header{}, body, false, protocol.KindOpenAIChat, 0,
	)
	res.LatencyMS = time.Since(start).Milliseconds()
	res.StatusCode = status
	if fwdErr != nil {
		if ctx.Err() == context.DeadlineExceeded {
			res.Error = fmt.Sprintf("生图超时（%ds）", int(imageProbeTimeout.Seconds()))
		} else {
			res.Error = fwdErr.Error()
		}
		return false
	}
	if status == http.StatusNotFound || status == http.StatusMethodNotAllowed {
		return true
	}
	if status < 200 || status >= 300 {
		msg := a.truncateProbeError(respBody, 240)
		if msg == "" {
			msg = fmt.Sprintf("upstream status %d", status)
		}
		res.Error = msg
		return false
	}
	parsed := parseImageProbeResponse(respBody, false)
	if parsed.Err != "" {
		res.Error = parsed.Err
		return false
	}
	res.OK = true
	return false
}

// probeImageRequest 测试台单轮生图：提示词取该轮最后一条 user 消息。
func (a *AdminService) probeImageRequest(parent context.Context, client *http.Client, target *upstreamTarget, body []byte, timeout time.Duration) (sample ModelProbeSample) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	start := time.Now()
	defer func() { sample.DurationMS = time.Since(start).Milliseconds() }()
	req, err := a.buildUpstreamHTTPRequest(ctx, target, imageProbePath, http.MethodPost, http.Header{}, body, protocol.KindOpenAIChat, false)
	if err != nil {
		sample.Error = "could not build probe request"
		return
	}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			sample.Error = fmt.Sprintf("生图超时（%ds）", int(timeout.Seconds()))
		} else {
			sample.Error = "upstream request failed"
		}
		return
	}
	defer resp.Body.Close()
	sample.StatusCode = resp.StatusCode
	data, err := io.ReadAll(io.LimitReader(resp.Body, probeMaxResponseBytes+1))
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			sample.Error = fmt.Sprintf("生图超时（%ds）", int(timeout.Seconds()))
		} else {
			sample.Error = "读取上游响应失败"
		}
		return
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := a.truncateProbeError(data, 240)
		sample.Error = redactProbeSecret(fmt.Sprintf("upstream HTTP %d", resp.StatusCode), msg, target.APIKey)
		return
	}
	if len(data) > probeMaxResponseBytes {
		sample.Error = "上游响应过大"
		return
	}
	first := time.Since(start).Milliseconds()
	sample.FirstTokenMS = &first
	parsed := parseImageProbeResponse(data, true)
	sample.Images = parsed.Images
	sample.ImagesTruncated = parsed.Truncated
	sample.Text = parsed.RevisedPrompt
	sample.InputTokens, sample.OutputTokens = parsed.InputTokens, parsed.OutputTokens
	if parsed.Err != "" {
		sample.Error = parsed.Err
		return
	}
	sample.OK = true
	return
}

// imagePromptFromMessages 把一轮消息压成单条生图提示词（system 作为前缀）。
func imagePromptFromMessages(messages []ProbeMessage) string {
	var system, user string
	for _, m := range messages {
		switch m.Role {
		case "system":
			system = strings.TrimSpace(m.Content)
		case "user":
			user = strings.TrimSpace(m.Content)
		}
	}
	if system != "" && user != "" {
		return system + "\n\n" + user
	}
	if user != "" {
		return user
	}
	return system
}
