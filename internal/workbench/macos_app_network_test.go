package workbench

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sylvinus/agent-vm/internal/cage"
	"golang.org/x/crypto/ssh"
)

func TestMacOSAppLaunchRequiresLiveNetworkAuthorization(t *testing.T) {
	for _, condition := range []string{"open", "paused", "stopping", "not-ready", "starting", "checking", "closed-with-stale-ui", "config-changed", "intent-error", "unreadable-gate"} {
		t.Run(condition, func(t *testing.T) {
			s, gate := grantedToolUpdateServer(t)
			s.setJobForTest(Job{})
			switch condition {
			case "paused":
				s.networkPaused = true
			case "stopping":
				s.closing = true
			case "not-ready":
				s.ready = false
			case "starting":
				s.setJobForTest(Job{Kind: "start", Running: true})
			case "checking":
				if err := gate.BeginCheck(); err != nil {
					t.Fatal(err)
				}
			case "closed-with-stale-ui":
				gate.Close("revoked after last UI poll")
			case "config-changed":
				cfg, _ := loadConfig(s.configPath)
				cfg.Timezone = "Europe/London"
				if err := writePrivate(s.configPath, cfg); err != nil {
					t.Fatal(err)
				}
			case "intent-error":
				s.networkIntentError = "cannot persist network intent"
			case "unreadable-gate":
				if err := os.Remove(s.instanceDir() + "/cage-gate.json"); err != nil {
					t.Fatal(err)
				}
			}
			if got := s.macOSAppNetworkReady(t.Context()); got != (condition == "open") {
				t.Fatalf("launch allowed=%t for %s", got, condition)
			}
		})
	}
}

func TestMacOSAppLaunchHTTPAndWebSocketWaitForGate(t *testing.T) {
	for _, base := range []string{"/api/macos/claude", "/api/macos-browser"} {
		t.Run(base, func(t *testing.T) {
			var launches atomic.Int32
			guest := newMacWorkspaceGuest(t, func(channel ssh.Channel, command string) (uint32, bool) {
				if !strings.Contains(command, "window.sock") {
					return 0, false
				}
				reader := bufio.NewReader(channel)
				for {
					var in macOSWindowRequest
					if json.NewDecoder(reader).Decode(&in) != nil {
						return 0, true
					}
					if macOSAppLaunch(in.Action) {
						launches.Add(1)
					}
					if json.NewEncoder(channel).Encode(map[string]bool{"ok": true}) != nil || !in.KeepAlive {
						return 0, true
					}
				}
			})
			s := guest.s
			cfg, err := loadConfig(s.configPath)
			if err != nil {
				t.Fatal(err)
			}
			gate, err := cage.NewEgressGate(cfg)
			if err != nil {
				t.Fatal(err)
			}
			stop, err := cage.StartGateControl(s.configPath, s.instanceDir(), gate)
			if err != nil {
				t.Fatal(err)
			}
			defer stop()
			if err := gate.BeginCheck(); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(s.macOSWindowConnection))
			defer server.Close()
			s.origin = server.URL
			ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+base+"/connection", http.Header{"Origin": {server.URL}})
			if err != nil {
				t.Fatal(err)
			}
			defer ws.Close()
			check := func(wantAllowed bool) {
				t.Helper()
				w := httptest.NewRecorder()
				request := httptest.NewRequest("POST", base+"/window", strings.NewReader(`{"action":"launch"}`))
				request.Header.Set("Content-Type", "application/json")
				s.macOSClaudeWindow(w, request)
				var reply map[string]any
				if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &reply) != nil {
					t.Fatalf("HTTP: %d %s", w.Code, w.Body.String())
				}
				if (reply["ok"] == true) != wantAllowed || (!wantAllowed && reply["error"] != macOSAppNetworkError) {
					t.Fatalf("HTTP launch: %+v", reply)
				}
				if err := ws.WriteJSON(map[string]any{"id": 1, "request": map[string]string{"action": "launch"}}); err != nil {
					t.Fatal(err)
				}
				_ = ws.SetReadDeadline(time.Now().Add(8 * time.Second))
				var response struct {
					ID     int            `json:"id"`
					Result map[string]any `json:"result"`
				}
				if err := ws.ReadJSON(&response); err != nil {
					t.Fatal(err)
				}
				if response.ID != 1 || (response.Result["ok"] == true) != wantAllowed || (!wantAllowed && response.Result["error"] != macOSAppNetworkError) {
					t.Fatalf("WebSocket launch: %+v", response)
				}
			}
			check(false)
			if launches.Load() != 0 {
				t.Fatal("startup launched an app before safety checks")
			}
			grantTestGate(t, gate)
			check(true)
			if launches.Load() != 2 {
				t.Fatal("fresh authorization did not permit both transports")
			}
			// Keep the cached UI state open while revoking the real gate.
			gate.Close("simulated monitoring failure")
			check(false)
			if launches.Load() != 2 {
				t.Fatal("stale UI or persistent socket bypassed revocation")
			}
			if gate.Status().Mode != cage.GateClosed {
				t.Fatal("opening an app reopened the network")
			}
		})
	}
}
