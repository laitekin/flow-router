// 生图模型探测：模型测试 / 测试台 / 解除冷却并测试 对生图模型改走 /v1/images/generations。
//
// 生图模型（gpt-image-1、dall-e-3、flux、seedream …）大多不支持 /chat/completions，
// 用聊天 ping 测试必然 400/404，导致可用的生图线路被误判、冷却也无法通过测试解除。
package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
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
	// 测试台单轮最多回传的图片数据（data URI 或 URL）。gpt-image-2 系可出 3840x2160、n≤10。
	imageProbeMaxPayloadBytes = 48 << 20
	// 生图响应体上限（base64 PNG 4K 单张即可达十几 MB）。
	imageProbeMaxResponseBytes = 64 << 20
)

// ImageProbeOptions 测试台生图参数，对应 OpenAI Images API（gpt-image-2 / 2.5 / 2.6）。
// 空值表示不发送，交给上游默认；仅 Quality 在 gpt-image 系空值时默认 low 省钱。
type ImageProbeOptions struct {
	Quality           string `json:"quality,omitempty"`            // auto | low | medium | high | xhigh | max
	Background        string `json:"background,omitempty"`         // auto | opaque | transparent
	OutputFormat      string `json:"output_format,omitempty"`      // png | jpeg | webp | gif | svg
	OutputCompression *int   `json:"output_compression,omitempty"` // 0-100，仅 jpeg / webp
	N                 int    `json:"n,omitempty"`                  // 1-10
	Moderation        string `json:"moderation,omitempty"`         // auto | low
	Complexity        string `json:"complexity,omitempty"`         // low | medium | high
	FrameCount        int    `json:"frame_count,omitempty"`        // GIF 2-16
	FrameDurationMS   int    `json:"frame_duration_ms,omitempty"`  // GIF ≥20
}

func oneOfImageOpt(name, v string, allowed ...string) error {
	if v == "" {
		return nil
	}
	for _, a := range allowed {
		if v == a {
			return nil
		}
	}
	return fmt.Errorf("image_options.%s must be one of %s", name, strings.Join(allowed, ", "))
}

// normalize 校验并清理参数；不兼容的组合直接报错，避免白白消耗一次生图。
func (o *ImageProbeOptions) normalize() error {
	if o == nil {
		return nil
	}
	o.Quality = strings.ToLower(strings.TrimSpace(o.Quality))
	o.Background = strings.ToLower(strings.TrimSpace(o.Background))
	o.OutputFormat = strings.ToLower(strings.TrimSpace(o.OutputFormat))
	if o.OutputFormat == "jpg" {
		o.OutputFormat = "jpeg"
	}
	o.Moderation = strings.ToLower(strings.TrimSpace(o.Moderation))
	o.Complexity = strings.ToLower(strings.TrimSpace(o.Complexity))
	for _, err := range []error{
		oneOfImageOpt("quality", o.Quality, "auto", "low", "medium", "high", "xhigh", "max", "standard", "hd"),
		oneOfImageOpt("background", o.Background, "auto", "opaque", "transparent"),
		oneOfImageOpt("output_format", o.OutputFormat, "png", "jpeg", "webp", "gif", "svg"),
		oneOfImageOpt("moderation", o.Moderation, "auto", "low"),
		oneOfImageOpt("complexity", o.Complexity, "low", "medium", "high"),
	} {
		if err != nil {
			return err
		}
	}
	if o.N < 0 || o.N > 10 {
		return errors.New("image_options.n must be 1-10")
	}
	if c := o.OutputCompression; c != nil {
		if *c < 0 || *c > 100 {
			return errors.New("image_options.output_compression must be 0-100")
		}
		if o.OutputFormat != "jpeg" && o.OutputFormat != "webp" {
			return errors.New("output_compression only applies to jpeg or webp")
		}
	}
	if o.Background == "transparent" && o.OutputFormat != "" && o.OutputFormat != "png" && o.OutputFormat != "webp" {
		return errors.New("transparent background requires png or webp")
	}
	if o.OutputFormat == "gif" {
		if o.FrameCount != 0 && (o.FrameCount < 2 || o.FrameCount > 16) {
			return errors.New("image_options.frame_count must be 2-16")
		}
		if o.FrameDurationMS != 0 && o.FrameDurationMS < 20 {
			return errors.New("image_options.frame_duration_ms must be at least 20")
		}
	} else {
		o.FrameCount, o.FrameDurationMS = 0, 0
	}
	if o.OutputFormat == "svg" && o.N > 1 {
		return errors.New("svg output requires n=1")
	}
	return nil
}

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
func imageProbeBody(model, prompt, size string, opts *ImageProbeOptions) ([]byte, error) {
	if strings.TrimSpace(size) == "" {
		size = "1024x1024"
	}
	if opts == nil {
		opts = &ImageProbeOptions{}
	}
	n := opts.N
	if n <= 0 {
		n = 1
	}
	payload := map[string]any{"model": model, "prompt": prompt, "n": n, "size": size}
	isGPTImage := strings.Contains(strings.ToLower(model), "gpt-image") || strings.Contains(strings.ToLower(model), "chatgpt-image")
	switch {
	case opts.Quality != "":
		payload["quality"] = opts.Quality
	case isGPTImage:
		payload["quality"] = "low"
	}
	for k, v := range map[string]string{"background": opts.Background, "output_format": opts.OutputFormat, "moderation": opts.Moderation, "complexity": opts.Complexity} {
		if v != "" {
			payload[k] = v
		}
	}
	if opts.OutputCompression != nil {
		payload["output_compression"] = *opts.OutputCompression
	}
	if opts.FrameCount > 0 {
		payload["frame_count"] = opts.FrameCount
	}
	if opts.FrameDurationMS > 0 {
		payload["frame_duration_ms"] = opts.FrameDurationMS
	}
	return json.Marshal(payload)
}

// ImageProbeInfo 上游回报的实际出图参数与用量（gpt-image 系才有）。
type ImageProbeInfo struct {
	Size              string `json:"size,omitempty"`
	Quality           string `json:"quality,omitempty"`
	OutputFormat      string `json:"output_format,omitempty"`
	Background        string `json:"background,omitempty"`
	InputTextTokens   *int   `json:"input_text_tokens,omitempty"`
	InputImageTokens  *int   `json:"input_image_tokens,omitempty"`
	OutputImageTokens *int   `json:"output_image_tokens,omitempty"`
	OutputTextTokens  *int   `json:"output_text_tokens,omitempty"`
	Bytes             []int  `json:"bytes,omitempty"` // 每张图解码后字节数（URL 为 0）
}

// imageMIME 先看上游声明的 output_format，没有（很多中转会丢掉）就按 base64 头部魔数判断。
func imageMIME(format, b64 string) string {
	switch strings.ToLower(format) {
	case "jpeg", "jpg":
		return "image/jpeg"
	case "webp":
		return "image/webp"
	case "gif":
		return "image/gif"
	case "svg":
		return "image/svg+xml"
	case "png":
		return "image/png"
	}
	switch {
	case strings.HasPrefix(b64, "/9j/"):
		return "image/jpeg"
	case strings.HasPrefix(b64, "R0lGOD"):
		return "image/gif"
	case strings.HasPrefix(b64, "UklGR"):
		return "image/webp"
	case strings.HasPrefix(b64, "PHN2Zy"), strings.HasPrefix(b64, "PD94bW"), strings.HasPrefix(b64, "77u/PD94"), strings.HasPrefix(b64, "77u/PHN2"):
		return "image/svg+xml"
	}
	return "image/png"
}

// imageProbeResult 解析后的生图响应。
type imageProbeResult struct {
	Images        []string // URL 或 data URI
	RevisedPrompt string
	InputTokens   *int
	OutputTokens  *int
	Truncated     bool
	Err           string
	Info          ImageProbeInfo
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
		Size         string          `json:"size"`
		Quality      string          `json:"quality"`
		Background   string          `json:"background"`
		Usage        json.RawMessage `json:"usage"`
		Error        json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		out.Err = "上游返回的不是有效 JSON"
		return out
	}
	out.Info = ImageProbeInfo{Size: raw.Size, Quality: raw.Quality, OutputFormat: raw.OutputFormat, Background: raw.Background}
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
				item = "data:" + imageMIME(raw.OutputFormat, b64) + ";base64," + b64
				out.Info.Bytes = append(out.Info.Bytes, base64.StdEncoding.DecodedLen(len(b64))-strings.Count(b64[max(0, len(b64)-2):], "="))
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
			if d, ok := u["input_tokens_details"].(map[string]any); ok {
				out.Info.InputTextTokens = probeTokenField(d, "text_tokens")
				out.Info.InputImageTokens = probeTokenField(d, "image_tokens")
			}
			if d, ok := u["output_tokens_details"].(map[string]any); ok {
				out.Info.OutputTextTokens = probeTokenField(d, "text_tokens")
				out.Info.OutputImageTokens = probeTokenField(d, "image_tokens")
			}
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
	body, err := imageProbeBody(upstreamModel, imageProbeQuickPrompt, "", nil)
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
	data, err := io.ReadAll(io.LimitReader(resp.Body, imageProbeMaxResponseBytes+1))
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
	if len(data) > imageProbeMaxResponseBytes {
		sample.Error = "上游响应过大"
		return
	}
	first := time.Since(start).Milliseconds()
	sample.FirstTokenMS = &first
	parsed := parseImageProbeResponse(data, true)
	sample.Images = parsed.Images
	sample.ImagesTruncated = parsed.Truncated
	sample.Text = parsed.RevisedPrompt
	info := parsed.Info
	sample.ImageInfo = &info
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
