package gateway

import "errors"

func validateBalanceCooldown(base, maximum int) error {
	if base < 0 || base > 86400 || maximum < 0 || maximum > 86400 {
		return errors.New("余额不足冷却时间必须为 0–86400 秒的整数")
	}
	if maximum < base {
		return errors.New("余额不足最长冷却不能小于初始冷却")
	}
	return nil
}
