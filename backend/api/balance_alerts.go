// 余额分级提醒：状态列表、静默、直连渠道预算登记。
package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/bejix/upstream-ops/backend/storage"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func registerBalanceAlerts(g *gin.RouterGroup, d *Deps) {
	if d.BalanceAlerts == nil {
		return
	}
	g.GET("/balance-alerts", func(c *gin.Context) { listBalanceAlerts(c, d) })
	g.POST("/balance-alerts/:kind/:id/snooze", func(c *gin.Context) { snoozeBalanceAlert(c, d) })
	g.POST("/gateway/providers/:id/budget", func(c *gin.Context) { recordProviderBudget(c, d) })
}

func listBalanceAlerts(c *gin.Context, d *Deps) {
	items, err := d.BalanceAlerts.Statuses()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

// snoozeBalanceAlert body: {"minutes": 720}；minutes<=0 取消静默。最长 30 天。
func snoozeBalanceAlert(c *gin.Context, d *Deps) {
	id, err := parseUintParam(c, "id")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var in struct {
		Minutes int `json:"minutes"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if in.Minutes > 30*24*60 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "minutes must be at most 43200 (30 days)"})
		return
	}
	var until *time.Time
	if in.Minutes > 0 {
		t := time.Now().Add(time.Duration(in.Minutes) * time.Minute)
		until = &t
	}
	st, err := d.BalanceAlerts.Snooze(c.Param("kind"), id, until)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, st)
}

// recordProviderBudget body: {"mode":"set|add|clear","amount":100}
func recordProviderBudget(c *gin.Context, d *Deps) {
	id, err := parseUintParam(c, "id")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var in struct {
		Mode   string  `json:"mode"`
		Amount float64 `json:"amount"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	item, err := d.BalanceAlerts.RecordProviderBudget(c.Request.Context(), id, in.Mode, in.Amount)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, gorm.ErrRecordNotFound) {
			status = http.StatusNotFound
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"provider": item, "subject_kind": storage.BalanceSubjectProvider})
}
