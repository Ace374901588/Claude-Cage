package workbench

import (
	"context"
	"time"

	"github.com/sylvinus/agent-vm/internal/cage"
)

const macOSAppNetworkError = "network_not_ready"

// This is an application-start precondition, not the network boundary. The
// hostagent's gate still checks every DNS exchange and connection (including
// revocation during LaunchServices). Never grant or renew it to open an app.
func (s *Server) macOSAppNetworkReady(ctx context.Context) bool {
	s.mu.Lock()
	allowed := s.ready && !s.closing && !s.networkPaused && s.networkIntentError == "" && !s.jobs.snapshot().Running
	s.mu.Unlock()
	if !allowed {
		return false
	}
	cfg, err := loadConfig(s.configPath)
	if err != nil || cfg.RequireManagedProxy(s.profile) != nil {
		return false
	}
	client, err := s.gateClient()
	if err != nil {
		return false
	}
	state, err := client.Status(ctx)
	if err != nil {
		return false
	}
	s.publishGate(state)
	now := time.Now()
	if state.Mode != cage.GateOpen || !state.PolicyVerified || state.Fault || !now.Before(state.Until) ||
		state.Configuration != cfg.Fingerprint() || state.Report == nil ||
		state.Report.Authorizes(state.RunID, cfg.Fingerprint(), now) != nil {
		return false
	}
	// A pause/stop can arrive while the live gate is being read. Its data-plane
	// revocation remains authoritative even after this final UI-intent check.
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ready && !s.closing && !s.networkPaused && s.networkIntentError == "" && !s.jobs.snapshot().Running
}

func macOSAppLaunch(action string) bool {
	return action == "launch" || action == "browser-launch"
}
