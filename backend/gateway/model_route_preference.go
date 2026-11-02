package gateway

import "strings"

// preferModelRoute applies an explicit preference after eligibility, context,
// cooldown and exclusion filters. Missing preferences preserve existing sorting.
// On failover the preferred route is already excluded, so backups stay eligible.
func preferModelRoute(candidates []ScoredRoute, items []ModelListItem, model string) []ScoredRoute {
	var preferred uint
	for _, item := range items {
		if strings.TrimSpace(item.ID) == strings.TrimSpace(model) {
			preferred = item.PreferredRouteID
			break
		}
	}
	if preferred == 0 {
		return candidates
	}
	for i := range candidates {
		if candidates[i].Route.ID == preferred {
			if i > 0 {
				chosen := candidates[i]
				copy(candidates[1:i+1], candidates[:i])
				candidates[0] = chosen
			}
			break
		}
	}
	return candidates
}
