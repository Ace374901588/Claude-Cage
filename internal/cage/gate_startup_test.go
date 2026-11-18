package cage

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"sync/atomic"
	"testing"
	"time"

	"github.com/miekg/dns"
)

type startupProxyDialer struct{ calls atomic.Int32 }

func (d *startupProxyDialer) DialContext(context.Context, string, string) (net.Conn, error) {
	d.calls.Add(1)
	return nil, errors.New("isolated proxy outage")
}

func TestStartupGateBlocksApplicationDNSAndConnections(t *testing.T) {
	for _, state := range []string{"new", "checking", "fault-drill", "revoked", "expired"} {
		t.Run(state, func(t *testing.T) {
			gate := fixtureGate(t)
			dialer := &startupProxyDialer{}
			gate.raw.connect = dialer
			switch state {
			case "checking", "fault-drill":
				if err := gate.BeginCheck(); err != nil {
					t.Fatal(err)
				}
				if state == "fault-drill" {
					if err := gate.SetFault(true); err != nil {
						t.Fatal(err)
					}
				}
			case "revoked", "expired":
				fixtureGrant(t, gate)
				if state == "revoked" {
					gate.Close("failure")
				} else {
					gate.mu.Lock()
					gate.state.Until = time.Now().Add(-time.Second)
					gate.mu.Unlock()
				}
			}
			if _, err := gate.ExchangeDNS(t.Context(), new(dns.Msg).SetQuestion("claude.ai.", dns.TypeA)); !errors.Is(err, ErrGateClosed) {
				t.Fatalf("DNS not blocked: %v", err)
			}
			if _, err := gate.DialContext(t.Context(), "tcp", "1.1.1.1:443"); !errors.Is(err, ErrGateClosed) {
				t.Fatalf("TCP not blocked: %v", err)
			}
			for _, target := range []struct{ network, address string }{{"tcp", "1.1.1.1:443"}, {"udp", "1.1.1.1:53"}, {"tcp", "[2606:4700:4700::1111]:443"}} {
				if gate.Allows(target.network, netip.MustParseAddrPort(target.address)) {
					t.Fatal("unverified route allowed")
				}
			}
			if dialer.calls.Load() != 0 {
				t.Fatal("ordinary startup traffic contacted the upstream before authorization")
			}
			if gate.Status().Counters.DNSDenied != 1 {
				t.Fatal("blocked DNS was not accounted for")
			}
		})
	}
}
