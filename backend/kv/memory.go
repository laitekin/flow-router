package kv

import (
	"bytes"
	"context"
	"strconv"
	"sync"
	"time"
)

type memEntry struct {
	val []byte
	exp time.Time // 零值 = 不过期
}

func (e memEntry) expired(now time.Time) bool {
	return !e.exp.IsZero() && !now.Before(e.exp)
}

// Memory 进程内实现：单实例部署或未配置 Redis 时使用，语义与 Redis 实现一致。
type Memory struct {
	mu   sync.Mutex
	data map[string]memEntry
	stop chan struct{}
	once sync.Once
}

// NewMemory 创建内存 store，并启动后台清理过期 key 的协程（Close 时停止）。
func NewMemory() *Memory {
	m := &Memory{data: map[string]memEntry{}, stop: make(chan struct{})}
	go m.janitor(time.Minute)
	return m
}

func (m *Memory) janitor(every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-m.stop:
			return
		case now := <-t.C:
			m.mu.Lock()
			for k, e := range m.data {
				if e.expired(now) {
					delete(m.data, k)
				}
			}
			m.mu.Unlock()
		}
	}
}

func (m *Memory) getLocked(key string, now time.Time) (memEntry, bool) {
	e, ok := m.data[key]
	if !ok {
		return memEntry{}, false
	}
	if e.expired(now) {
		delete(m.data, key)
		return memEntry{}, false
	}
	return e, true
}

func expiry(now time.Time, ttl time.Duration) time.Time {
	if ttl <= 0 {
		return time.Time{}
	}
	return now.Add(ttl)
}

func (m *Memory) Get(_ context.Context, key string) ([]byte, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.getLocked(key, time.Now())
	if !ok {
		return nil, false, nil
	}
	return bytes.Clone(e.val), true, nil
}

func (m *Memory) Set(_ context.Context, key string, val []byte, ttl time.Duration) error {
	now := time.Now()
	m.mu.Lock()
	m.data[key] = memEntry{val: bytes.Clone(val), exp: expiry(now, ttl)}
	m.mu.Unlock()
	return nil
}

func (m *Memory) Del(_ context.Context, keys ...string) error {
	m.mu.Lock()
	for _, k := range keys {
		delete(m.data, k)
	}
	m.mu.Unlock()
	return nil
}

func (m *Memory) SetNX(_ context.Context, key string, val []byte, ttl time.Duration) (bool, error) {
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.getLocked(key, now); ok {
		return false, nil
	}
	m.data[key] = memEntry{val: bytes.Clone(val), exp: expiry(now, ttl)}
	return true, nil
}

func (m *Memory) DelIfValue(_ context.Context, key string, val []byte) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.getLocked(key, time.Now())
	if !ok || !bytes.Equal(e.val, val) {
		return false, nil
	}
	delete(m.data, key)
	return true, nil
}

func (m *Memory) Incr(_ context.Context, key string) (int64, error) {
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	e, _ := m.getLocked(key, now)
	n, _ := strconv.ParseInt(string(e.val), 10, 64)
	n++
	e.val = []byte(strconv.FormatInt(n, 10))
	m.data[key] = e
	return n, nil
}

func (m *Memory) Backend() string { return "memory" }

func (m *Memory) Close() error {
	m.once.Do(func() { close(m.stop) })
	return nil
}
