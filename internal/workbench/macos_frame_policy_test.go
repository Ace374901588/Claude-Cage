package workbench

import (
	"math"
	"testing"
)

func TestMacOSFramePolicyPreservesPointGeometryAndInput(t *testing.T) {
	for _, action := range []string{"frame", "browser-frame"} {
		for _, scale := range []float64{1, 1.25, 1.5, 2} {
			input := macOSWindowRequest{Action: action, Width: 1280, Height: 900, Scale: scale, Geometry: "live", Window: 42, PID: 23}
			got := makeMacOSFramePolicy(1.5).apply(input)
			wantScale := min(scale, 1.5)
			if got.Scale != wantScale || got.Encoding != "jpeg" || got.Width != input.Width || got.Height != input.Height || got.Geometry != input.Geometry || got.Window != input.Window || got.PID != input.PID {
				t.Fatalf("frame policy changed point geometry: %+v", got)
			}
			sharp := makeMacOSFramePolicy(2).apply(input)
			if sharp.Scale != scale || sharp.Encoding != "png" {
				t.Fatalf("sharp mode lost the requested density: %+v", sharp)
			}
		}
	}
	for _, action := range []string{"pointer", "key", "text", "ime", "phone-frame"} {
		input := macOSWindowRequest{Action: action, Scale: 2, Geometry: "live", Encoding: "untrusted"}
		got := makeMacOSFramePolicy(1.5).apply(input)
		input.Encoding = ""
		if got.Action != input.Action || got.Scale != input.Scale || got.Geometry != input.Geometry || got.Encoding != "" {
			t.Fatalf("capture policy changed input or phone density: %+v", got)
		}
	}
	for _, invalid := range []float64{0, -1, 3, math.NaN(), math.Inf(1)} {
		if got := makeMacOSFramePolicy(invalid); got.Scale != 2 || got.Encoding != "png" {
			t.Fatalf("invalid active density did not preserve the legacy policy: %+v", got)
		}
	}
}

func TestMacOSFramePolicyChangesAtNextAttach(t *testing.T) {
	s := testServer(t)
	s.preferences.BalancedDisplay = true
	s.initMacOSFramePolicyLocked()
	if s.macOSFramePolicy().Scale != 1.5 {
		t.Fatal("balanced mode was not applied")
	}
	s.preferences.BalancedDisplay = false
	s.initMacOSFramePolicyLocked()
	if s.macOSFramePolicy().Scale != 1.5 {
		t.Fatal("saving a preference resized the running display")
	}
	s.credentials.DisplayScale = 0
	s.initMacOSFramePolicyLocked()
	if s.macOSFramePolicy().Scale != 2 {
		t.Fatal("the next attach did not apply sharp mode")
	}
}
