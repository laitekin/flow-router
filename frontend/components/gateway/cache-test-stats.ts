import type { GatewayCacheTestSample } from "../../lib/api-types"

export function cacheTestStats(samples: GatewayCacheTestSample[]) {
  const reported = samples.filter((s) => s.ok && s.cached_tokens != null && s.input_tokens != null && s.input_tokens > 0 && s.cached_tokens <= s.input_tokens)
  const input = reported.reduce((sum, s) => sum + s.input_tokens!, 0)
  const cached = reported.reduce((sum, s) => sum + s.cached_tokens!, 0)
  return {
    total: samples.length,
    reported: reported.length,
    hitRequests: reported.filter((s) => s.cached_tokens! > 0).length,
    // A missing field is unknown. Never silently turn it into a miss or report
    // a rate calculated over only the positive samples as the overall rate.
    tokenHitRate: reported.length === samples.length && input > 0 ? cached / input : null,
  }
}
