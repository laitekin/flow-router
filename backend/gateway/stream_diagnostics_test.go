package gateway

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestStreamDiagnosticPreservesCauseAndDoesNotLogPayload(t *testing.T) {
	now := time.Now()
	var last, bytes int64
	atomic.StoreInt64(&last, now.Add(-time.Second).UnixNano())
	r := &streamProgressReader{reader: strings.NewReader("private partial line"), lastReadAt: &last, bytesRead: &bytes}
	buf := make([]byte, 5)
	if _, err := r.Read(buf); err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt64(&bytes) != 5 || atomic.LoadInt64(&last) <= now.Add(-time.Second).UnixNano() {
		t.Fatal("partial read not tracked")
	}
	err := streamReadDiagnostic("upstream stream disconnected", io.ErrUnexpectedEOF, "HTTP/2.0", now, last, bytes, "response.output_text.delta")
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatal("underlying error chain lost")
	}
	for _, field := range []string{"unexpected EOF", "HTTP/2.0", "elapsed_ms=", "since_last_byte_ms=", "bytes_read=5", "last_event="} {
		if !strings.Contains(err.Error(), field) {
			t.Fatalf("missing %s: %v", field, err)
		}
	}
	if strings.Contains(err.Error(), "private partial") {
		t.Fatal("payload leaked into log")
	}
	err = streamReadDiagnostic("canceled", context.Canceled, "HTTP/1.1", now, last, bytes, "none")
	if !errors.Is(err, context.Canceled) {
		t.Fatal("client cancellation no longer recognizable")
	}
}
