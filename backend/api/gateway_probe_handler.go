package api

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/bejix/upstream-ops/backend/gateway"
	"github.com/gin-gonic/gin"
)

// probeGatewayModel runs one configurable multi-round experiment (cache,
// pelican SVG, speed, needle, custom prompts …) against a pinned route and
// streams progress as SSE so the admin UI can fill results round by round.
func probeGatewayModel(c *gin.Context, d *Deps) {
	id, err := parseUintParam(c, "id")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var in gateway.ModelProbeInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid probe input"})
		return
	}
	started := false
	err = d.Gateway.ProbeModel(c.Request.Context(), id, in, func(ev gateway.ModelProbeEvent) error {
		if !started {
			c.Header("Content-Type", "text/event-stream")
			c.Header("Cache-Control", "no-cache, no-transform")
			c.Header("X-Accel-Buffering", "no")
			started = true
		}
		data, err := json.Marshal(ev)
		if err != nil {
			return err
		}
		if _, err = fmt.Fprintf(c.Writer, "data: %s\n\n", data); err != nil {
			return err
		}
		c.Writer.Flush()
		return nil
	})
	if err != nil && c.Request.Context().Err() == nil {
		if !started {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		} else {
			data, _ := json.Marshal(gateway.ModelProbeEvent{Stage: "error", Error: err.Error()})
			_, _ = fmt.Fprintf(c.Writer, "data: %s\n\n", data)
			c.Writer.Flush()
		}
	}
}
