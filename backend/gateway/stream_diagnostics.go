package gateway

import (
	"fmt"
	"io"
	"sync/atomic"
	"time"
)

// Track actual reads, not complete SSE lines: a large partial line is activity.
type streamProgressReader struct {
	reader     io.Reader
	lastReadAt *int64
	bytesRead  *int64
}

func (r *streamProgressReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	if n > 0 {
		atomic.StoreInt64(r.lastReadAt, time.Now().UnixNano())
		atomic.AddInt64(r.bytesRead, int64(n))
	}
	return n, err
}

func streamReadDiagnostic(label string, cause error, protocol string, start time.Time, lastReadAt, bytesRead int64, lastEvent string) error {
	if len(lastEvent) > 120 {
		lastEvent = lastEvent[:120]
	}
	return fmt.Errorf("%s (cause_type=%T; protocol=%s; elapsed_ms=%d; since_last_byte_ms=%d; bytes_read=%d; last_event=%q): %w",
		label, cause, protocol, time.Since(start).Milliseconds(), time.Since(time.Unix(0, lastReadAt)).Milliseconds(), bytesRead, lastEvent, cause)
}
