package workbench

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"os"
	"testing"
)

// Fixtures are real hardware-encoded, generated checkerboards. They contain no
// screen capture or user data; regenerate with macos-window-video-test.swift.
func TestMacOSH264NativePacketsAndValidation(t *testing.T) {
	for _, name := range []string{"key", "delta"} {
		record, err := os.ReadFile("testdata/macos-window-h264-" + name + ".bin")
		if err != nil {
			t.Fatal(err)
		}
		header, pixels, err := readMacOSFrame(bytes.NewReader(record))
		if err != nil || header.MIME != "video/h264" || header.PixelWidth != 320 || header.PixelHeight != 240 || header.KeyFrame != (name == "key") {
			t.Fatalf("native %s packet rejected: %+v %v", name, header, err)
		}
		if !bytes.Equal(record[4+int(binary.BigEndian.Uint32(record)):], pixels) {
			t.Fatal("video bytes changed during relay")
		}
		cases := map[string]func(*macOSFrameHeader, *[]byte){
			"coded width mismatch":  func(h *macOSFrameHeader, _ *[]byte) { h.PixelWidth += 2 },
			"coded height mismatch": func(h *macOSFrameHeader, _ *[]byte) { h.PixelHeight += 2 },
			"wrong codec":           func(h *macOSFrameHeader, _ *[]byte) { h.Codec = "avc1.42001e" },
			"wrong keyframe flag":   func(h *macOSFrameHeader, _ *[]byte) { h.KeyFrame = !h.KeyFrame },
			"zero timestamp":        func(h *macOSFrameHeader, _ *[]byte) { h.Timestamp = 0 },
			"unsafe timestamp":      func(h *macOSFrameHeader, _ *[]byte) { h.Timestamp = 1 << 53 },
			"invalid configuration": func(h *macOSFrameHeader, _ *[]byte) { h.Description = "invalid" },
			"oversize configuration": func(h *macOSFrameHeader, _ *[]byte) {
				h.Description = base64.StdEncoding.EncodeToString(make([]byte, 4097))
			},
			"truncated NAL": func(_ *macOSFrameHeader, p *[]byte) { *p = (*p)[:len(*p)-1] },
			"NAL overflow":  func(_ *macOSFrameHeader, p *[]byte) { binary.BigEndian.PutUint32(*p, 0xffffffff) },
			"garbage tail":  func(_ *macOSFrameHeader, p *[]byte) { *p = append(*p, 1) },
		}
		for label, mutate := range cases {
			t.Run(name+"/"+label, func(t *testing.T) {
				h, p := header, append([]byte(nil), pixels...)
				mutate(&h, &p)
				h.ImageLength = len(p)
				if _, _, err := readMacOSFrame(bytes.NewReader(macFrameRecord(t, h, p))); err == nil {
					t.Fatal("invalid video packet accepted")
				}
			})
		}
	}
}

func FuzzMacOSH264SPSDimensions(f *testing.F) {
	packet, err := os.ReadFile("testdata/macos-window-h264-key.bin")
	if err != nil {
		f.Fatal(err)
	}
	header, _, err := readMacOSFrame(bytes.NewReader(packet))
	if err != nil {
		f.Fatal(err)
	}
	config, _ := base64.StdEncoding.DecodeString(header.Description)
	size := int(binary.BigEndian.Uint16(config[6:]))
	f.Add(config[8 : 8+size])
	f.Add([]byte{0x67, 0, 0, 0, 0})
	f.Fuzz(func(t *testing.T, data []byte) {
		width, height, ok := macOSH264SPSDimensions(data)
		if ok && (width < 2 || height < 2 || width > 8192 || height > 8192 || width*height > 40_000_000) {
			t.Fatal("accepted out-of-range decoder dimensions")
		}
	})
}
