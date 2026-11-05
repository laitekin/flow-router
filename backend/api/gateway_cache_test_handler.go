package api

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/bejix/upstream-ops/backend/gateway"
	"github.com/gin-gonic/gin"
)

func testGatewayModelCache(c *gin.Context, d *Deps) {
	id, err := parseUintParam(c, "id")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var in gateway.CacheTestInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid cache test input"})
		return
	}
	started := false
	err = d.Gateway.TestModelCache(c.Request.Context(), id, in, func(ev gateway.CacheTestEvent) error {
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
			data, _ := json.Marshal(gateway.CacheTestEvent{Stage: "error", Error: err.Error()})
			_, _ = fmt.Fprintf(c.Writer, "data: %s\n\n", data)
			c.Writer.Flush()
		}
	}
}
