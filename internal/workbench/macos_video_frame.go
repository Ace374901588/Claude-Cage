package workbench

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

var errMacOSVideoFrame = errors.New("窗口视频画面无效")

// Validate the AVC configuration and coded display dimensions before asking
// WebKit to allocate a decoder. Packets use four-byte AVCC NAL lengths.
func validateMacOSVideoFrame(header macOSFrameHeader, data []byte) error {
	if header.Timestamp <= 0 || header.Timestamp > 1<<53-1 || len(header.Description) > 5500 ||
		header.EncodeMilliseconds < 0 || header.EncodeMilliseconds > 5000 || math.IsNaN(header.EncodeMilliseconds) || math.IsInf(header.EncodeMilliseconds, 0) {
		return errMacOSVideoFrame
	}
	config, err := base64.StdEncoding.Strict().DecodeString(header.Description)
	if err != nil || len(config) < 11 || len(config) > 4096 || config[0] != 1 || config[4]&3 != 3 ||
		header.Codec != fmt.Sprintf("avc1.%02x%02x%02x", config[1], config[2], config[3]) {
		return errMacOSVideoFrame
	}
	position := 6
	readNAL := func() []byte {
		if position+2 > len(config) {
			return nil
		}
		size := int(binary.BigEndian.Uint16(config[position:]))
		position += 2
		if size == 0 || size > len(config)-position {
			return nil
		}
		nal := config[position : position+size]
		position += size
		return nal
	}
	count := int(config[5] & 31)
	if count == 0 {
		return errMacOSVideoFrame
	}
	for range count {
		width, height, ok := macOSH264SPSDimensions(readNAL())
		if !ok || width != header.PixelWidth || height != header.PixelHeight {
			return errMacOSVideoFrame
		}
	}
	if position >= len(config) || config[position] == 0 {
		return errMacOSVideoFrame
	}
	count = int(config[position])
	position++
	for range count {
		nal := readNAL()
		if len(nal) < 2 || nal[0]&0x9f != 8 {
			return errMacOSVideoFrame
		}
	}
	key, slice := false, false
	for count = 0; len(data) != 0; count++ {
		if count >= 512 || len(data) < 5 {
			return errMacOSVideoFrame
		}
		size := uint64(binary.BigEndian.Uint32(data))
		if size == 0 || size > uint64(len(data)-4) {
			return errMacOSVideoFrame
		}
		nal := data[4 : 4+int(size)]
		kind := nal[0] & 31
		if nal[0]&128 != 0 || kind == 0 || kind > 23 {
			return errMacOSVideoFrame
		}
		key = key || kind == 5
		slice = slice || kind == 1 || kind == 5
		data = data[4+int(size):]
	}
	if !slice || key != header.KeyFrame {
		return errMacOSVideoFrame
	}
	return nil
}

type macOSVideoBits struct {
	data []byte
	bit  int
	ok   bool
}

func (b *macOSVideoBits) read(n int) uint32 {
	if !b.ok || n < 0 || n > 32 || len(b.data)*8-b.bit < n {
		b.ok = false
		return 0
	}
	var value uint32
	for range n {
		value = value<<1 | uint32(b.data[b.bit/8]>>(7-b.bit%8)&1)
		b.bit++
	}
	return value
}

func (b *macOSVideoBits) ue(max uint32) uint32 {
	zeros := 0
	for b.ok && b.read(1) == 0 {
		zeros++
		if zeros > 24 {
			b.ok = false
		}
	}
	value := uint32(1<<zeros) - 1 + b.read(zeros)
	if value > max {
		b.ok = false
	}
	return value
}

func (b *macOSVideoBits) se() int {
	value := b.ue(65535)
	if value&1 == 1 {
		return int((value + 1) / 2)
	}
	return -int(value / 2)
}

func macOSH264SPSDimensions(nal []byte) (int, int, bool) {
	if len(nal) < 5 || len(nal) > 4096 || nal[0]&0x9f != 7 {
		return 0, 0, false
	}
	data, zeros := make([]byte, 0, len(nal)), 0
	for i, value := range nal[1:] {
		if zeros >= 2 && value == 3 {
			if i+2 >= len(nal) || nal[i+2] > 3 {
				return 0, 0, false
			}
			zeros = 0
			continue
		}
		data = append(data, value)
		if value == 0 {
			zeros++
		} else {
			zeros = 0
		}
	}
	b := macOSVideoBits{data: data, ok: true}
	profile := b.read(8)
	b.read(16) // constraint flags and level
	b.ue(31)
	chroma, separate := uint32(1), uint32(0)
	switch profile {
	case 100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135:
		chroma = b.ue(3)
		if chroma == 3 {
			separate = b.read(1)
		}
		b.ue(6)
		b.ue(6)
		b.read(1)
		if b.read(1) != 0 {
			lists := 8
			if chroma == 3 {
				lists = 12
			}
			for index := range lists {
				if b.read(1) == 0 {
					continue
				}
				size, last, next := 16, 8, 8
				if index >= 6 {
					size = 64
				}
				for range size {
					if next != 0 {
						next = (last + b.se() + 256) & 255
					}
					if next != 0 {
						last = next
					}
				}
			}
		}
	}
	b.ue(12)
	switch b.ue(2) {
	case 0:
		b.ue(12)
	case 1:
		b.read(1)
		b.se()
		b.se()
		for range b.ue(255) {
			b.se()
		}
	}
	b.ue(16)
	b.read(1)
	width, height := int(b.ue(511)+1)*16, int(b.ue(511)+1)*16
	frame := int(b.read(1))
	height *= 2 - frame
	if frame == 0 {
		b.read(1)
	}
	b.read(1)
	if b.read(1) != 0 {
		x, y := 1, 2-frame
		if chroma != 0 && separate == 0 {
			if chroma != 3 {
				x = 2
			}
			if chroma == 1 {
				y *= 2
			}
		}
		left, right, top, bottom := int(b.ue(8192)), int(b.ue(8192)), int(b.ue(8192)), int(b.ue(8192))
		width -= (left + right) * x
		height -= (top + bottom) * y
	}
	return width, height, b.ok && width >= 2 && height >= 2 && width <= 8192 && height <= 8192 && width*height <= 40_000_000
}
