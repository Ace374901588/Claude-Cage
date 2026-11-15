//go:build !windows

package workbench

import (
	"encoding/json"
	"github.com/sylvinus/agent-vm/internal/guestos"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestMacOSManualConsoleBoundaryAndRevocation(t *testing.T) {
	s := testServer(t)
	profile, err := os.MkdirTemp("/tmp", "cage-console-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(profile)
	s.profile = profile
	s.macosGuest = &guestos.MacOSProfile{Instance: "mac", User: "trial"}
	s.ready = true
	if err := os.MkdirAll(s.instanceDir(), 0700); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", filepath.Join(s.instanceDir(), "cage-login.sock"))
	if err != nil {
		t.Fatal(err)
	}
	requests := make(chan guestos.MacLoginRequest, 8)
	var legacy atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			var in guestos.MacLoginRequest
			if json.NewDecoder(conn).Decode(&in) == nil {
				requests <- in
				out := guestos.MacLoginReply{ConsoleVersion: 1, Session: "console-session"}
				if legacy.Load() {
					out = guestos.MacLoginReply{Closed: true}
				}
				_ = json.NewEncoder(conn).Encode(out)
			}
			_ = conn.Close()
		}
	}()
	defer func() { listener.Close(); <-done }()
	post := func(path, body string, trusted bool) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, s.origin+path, strings.NewReader(body))
		r.Header.Set("Origin", s.origin)
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: s.cookieName(), Value: s.session})
		if trusted {
			r.AddCookie(&http.Cookie{Name: s.cookieName() + "-desktop", Value: trustedViewProof(s.token)})
		}
		w := httptest.NewRecorder()
		s.handler().ServeHTTP(w, r)
		return w
	}
	if w := post("/api/macos/console", `{"action":"open"}`, false); w.Code != http.StatusForbidden {
		t.Fatalf("untrusted console returned %d", w.Code)
	}
	for _, action := range []string{"show-password", "fill-password", "finish", "screen", "input"} {
		if w := post("/api/macos/console", `{"action":"`+action+`"}`, true); w.Code != http.StatusBadRequest {
			t.Fatalf("console accepted %s: %d", action, w.Code)
		}
	}
	if w := post("/api/macos/console", `{"action":"frame","session":"console-session","geometry":"current-screen","manual_console":false,"initial_setup":true,"maintenance":"screen","password":"untrusted"}`, true); w.Code != http.StatusOK {
		t.Fatalf("console failed: %d %s", w.Code, w.Body)
	}
	in := <-requests
	if !in.Console || in.Setup || in.Maintenance != "" || in.Password != "" || in.Geometry != "current-screen" {
		t.Fatal("HTTP console scope or password boundary changed")
	}
	// The console flag is determined by the route, never by an HTTP body.
	if w := post("/api/macos/login", `{"action":"frame","manual_console":true}`, true); w.Code != http.StatusOK {
		t.Fatal("login fixture failed")
	}
	if in := <-requests; in.Console {
		t.Fatal("console scope escaped into login route")
	}
	legacy.Store(true)
	w := post("/api/macos/console", `{"action":"open"}`, true)
	<-requests
	var out guestos.MacLoginReply
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &out) != nil || !out.Closed || out.Recovery != "environment-restart" {
		t.Fatalf("legacy runner accepted: %s", w.Body)
	}
	legacy.Store(false)
	if w := post("/api/macos/console", `{"action":"open"}`, true); w.Code != http.StatusOK {
		t.Fatal("open failed")
	}
	<-requests
	s.account.lock()
	select {
	case close := <-requests:
		if close.Action != "close" || !close.Console || close.Session != "console-session" {
			t.Fatal("Cage lock lost the console scope")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Cage lock retained the console")
	}
	s.macosGuest.SetupID = "unfinished"
	if w := post("/api/macos/console", `{"action":"open"}`, true); w.Code != http.StatusConflict {
		t.Fatalf("console bypassed first setup: %d", w.Code)
	}
}
