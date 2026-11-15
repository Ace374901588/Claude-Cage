package workbench

// Snapshot the display choice when the Mac environment attaches. Changing the
// saved preference must not resize a running capture until the next launch.
// Caller holds s.mu; stopMacOSGuest clears the snapshot.
func (s *Server) initMacOSFramePolicyLocked() {
	if s.credentials.DisplayScale == 0 {
		s.credentials.DisplayScale = 2
		if s.preferences.BalancedDisplay {
			s.credentials.DisplayScale = 1.5
		}
	}
}

type macOSFramePolicy struct {
	Scale    float64
	Encoding string
}

func makeMacOSFramePolicy(scale float64) macOSFramePolicy {
	if !(scale >= 1 && scale <= 2) {
		scale = 2
	}
	encoding := "png"
	if scale < 2 {
		encoding = "jpeg"
	}
	return macOSFramePolicy{Scale: scale, Encoding: encoding}
}

func (s *Server) macOSFramePolicy() macOSFramePolicy {
	s.mu.Lock()
	defer s.mu.Unlock()
	return makeMacOSFramePolicy(s.credentials.DisplayScale)
}

func (p macOSFramePolicy) apply(input macOSWindowRequest) macOSWindowRequest {
	input.Encoding = ""
	input.VideoSession = ""
	if input.Action == "frame" || input.Action == "browser-frame" {
		if input.Scale > p.Scale {
			input.Scale = p.Scale
		}
		// Older signed helpers ignore this optional field and keep PNG output.
		input.Encoding = p.Encoding
	}
	return input
}
