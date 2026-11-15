//go:build darwin && arm64 && cgo && !no_vz

package maclogin

/*
#include "bridge.h"
*/
import "C"

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"io"
	"os/exec"
	"time"

	"al.essio.dev/pkg/shellescape"
	"github.com/sylvinus/agent-vm/internal/guestos"
)

// This explicit manual view never accepts or retrieves a stored password. It
// belongs to one bound, unlocked guest user and expires on lock/session change.
// The existing cropped authorization flow retains its stricter target checks.
func (s *loginSession) manualConsoleScreen() string {
	bound, err := guestos.LoadMacOSProfile(s.profile)
	if err != nil || bound == nil || bound.SetupID != "" || bound.MachineID != s.consoleMachineID {
		return ""
	}
	administrator, err := guestos.MacOSProvisionUser(s.profile)
	if err != nil {
		return ""
	}
	args, err := guestos.MacOSSSHArgs(s.profile, administrator)
	if err != nil {
		return ""
	}
	script := `set -eu
owner=$(/usr/bin/stat -f '%u %Su' /dev/console)
uid=$(/usr/bin/id -u ` + shellescape.Quote(bound.User) + `)
/usr/bin/printf '%s %s\n' "$owner" "$uid"
/usr/sbin/ioreg -a -d1 -c IORegistryEntry -k IOConsoleUsers -l | /usr/bin/plutil -extract IOConsoleUsers xml1 -o - -`
	ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/ssh", append(args, "-T", "cage-macos", "--", "exec /bin/sh -c "+shellescape.Quote(script))...)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "LC_ALL=C"}
	pipe, err := cmd.StdoutPipe()
	if err != nil || cmd.Start() != nil {
		return ""
	}
	data, readErr := io.ReadAll(io.LimitReader(pipe, (32<<10)+1))
	if readErr != nil || len(data) > 32<<10 {
		cancel()
	}
	if err = cmd.Wait(); err != nil || readErr != nil || len(data) > 32<<10 {
		return ""
	}
	screen := permittedMaintenanceConsole(bytes.TrimSpace(data), bound.User)
	if screen == "" {
		return ""
	}
	return s.consoleMachineID + ":" + screen
}

func (s *loginSession) handleManualConsole(in request) (result reply) {
	defer func() { result.ConsoleVersion = 1 }()
	if !in.Console || in.Setup || in.Maintenance != "" || in.Password != "" {
		return reply{Closed: true, Error: "客机维护桌面只接受手动操作"}
	}
	if in.Action == "open" {
		s.close()
		bound, err := guestos.LoadMacOSProfile(s.profile)
		if err != nil || bound == nil || bound.SetupID != "" {
			return reply{Closed: true, Error: "请先完成虚拟 Mac 的首次设置"}
		}
		s.manualConsole, s.consoleMachineID = true, bound.MachineID
		s.screenID = s.manualConsoleScreen()
		if s.screenID == "" {
			s.close()
			return reply{Closed: true, Error: "请先登录并解锁虚拟 Mac 的绑定账户"}
		}
		s.token, s.expires = rand.Text(), time.Now().Add(5*time.Minute)
		C.cageLoginEnable(true)
		return reply{Session: s.token}
	}
	if !s.manualConsole || s.token == "" || subtle.ConstantTimeCompare([]byte(in.Session), []byte(s.token)) != 1 {
		return reply{Closed: true}
	}
	if in.Action == "close" || time.Now().After(s.expires) || s.manualConsoleScreen() != s.screenID {
		s.close()
		return reply{Closed: true}
	}
	if in.Action == "frame" {
		var size C.int
		data := C.cageLoginImage(&size)
		if data == nil {
			return reply{Error: "正在等待客机桌面画面"}
		}
		defer C.free(data)
		if s.manualConsoleScreen() != s.screenID {
			s.close()
			return reply{Closed: true}
		}
		return reply{Image: C.GoBytes(data, size), MIME: "image/jpeg", Geometry: s.screenID, Region: []int{0, 0, 1024, 640}}
	}
	if in.Geometry == "" || in.Geometry != s.screenID {
		return reply{Error: "请等待当前客机桌面画面后再操作"}
	}
	switch in.Action {
	case "click":
		if in.X < 0 || in.Y < 0 || in.X >= 1024 || in.Y >= 640 || !bool(C.cageLoginClick(C.int(in.X), C.int(in.Y))) {
			return reply{Error: "无效的客机桌面位置"}
		}
	case "key":
		navigation := in.Code >= 123 && in.Code <= 126 || in.Code == 116 || in.Code == 121
		if in.Code < 0 || in.Code > 53 && !navigation || !bool(C.cageLoginKey(C.int(in.Code), C.bool(in.Shift))) {
			return reply{Error: "不支持此客机桌面按键"}
		}
	case "select-all":
		if !bool(C.cageLoginSelectAll()) {
			return reply{Error: "未能选中客机文本"}
		}
	case "scroll":
		if in.X < 0 || in.Y < 0 || in.X >= 1024 || in.Y >= 640 ||
			in.DeltaX < -512 || in.DeltaX > 512 || in.DeltaY < -512 || in.DeltaY > 512 ||
			!bool(C.cageLoginScroll(C.int(in.X), C.int(in.Y), C.int(in.DeltaX), C.int(in.DeltaY))) {
			return reply{Error: "无效的客机桌面滚动操作"}
		}
	default:
		return reply{Error: "客机维护桌面只接受手动操作"}
	}
	return reply{}
}
