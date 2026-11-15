import CoreGraphics
import Foundation

// AppKit consumes integral pixel deltas even when a Quartz event also contains
// fixed-point values. Keep a connection's subpixel distance until a whole
// pixel is available, and never carry it into another target or gesture.
struct MacWindowScrollAccumulator {
    private var target = ""
    private var point = CGPoint.zero
    private var time: TimeInterval?
    private var x = 0.0
    private var y = 0.0

    mutating func take(deltaX: Double, deltaY: Double, target: String,
                       point: CGPoint, time: TimeInterval) -> (x: Int32, y: Int32)? {
        guard deltaX.isFinite, deltaY.isFinite, abs(deltaX) <= 32000, abs(deltaY) <= 32000,
              point.x.isFinite, point.y.isFinite, time.isFinite, !target.isEmpty else { return nil }
        if self.target != target || self.point != point || self.time == nil ||
            time < self.time! || time - self.time! >= 0.25 {
            self = Self()
            self.target = target
            self.point = point
        }
        self.time = time
        x += deltaX
        y += deltaY
        let whole = (x: Int32(x.rounded(.towardZero)), y: Int32(y.rounded(.towardZero)))
        x -= Double(whole.x)
        y -= Double(whole.y)
        return whole
    }
}

// Construct only. The caller must verify the live window/point ownership
// immediately before sending this event through the normal Quartz input path.
func macWindowScrollEvent(source: CGEventSource?, deltaX: Int32, deltaY: Int32,
                          point: CGPoint, flags: CGEventFlags, window: CGWindowID) -> CGEvent? {
    guard point.x.isFinite, point.y.isFinite, window != 0,
          (-32000...32000).contains(deltaX), (-32000...32000).contains(deltaY),
          deltaX != 0 || deltaY != 0,
          let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel,
                              wheelCount: deltaX == 0 ? 1 : 2,
                              wheel1: -deltaY, wheel2: -deltaX, wheel3: 0) else { return nil }
    event.location = point
    event.flags = flags
    event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    // Mouse-event window hints are not retained on scroll events. Quartz
    // routes this event using its checked screen point, not a process ID.
    return event
}

// The caller has already verified the application signature and frame token.
// A physical event additionally needs the captured window to own this point:
// an overlapping app or a second window must never receive stale input.
func macPointerWindowOwnsPoint(_ point: CGPoint, pid: pid_t, window: CGWindowID,
                              frontmostPID: pid_t?, hitPID: pid_t?,
                              windows: [[String: Any]]) -> Bool {
    guard point.x.isFinite, point.y.isFinite, pid > 0, window != 0,
          frontmostPID == pid, hitPID == pid else { return false }
    let foremost = windows.first { info in
        guard info[kCGWindowOwnerPID as String] as? pid_t == pid,
              info[kCGWindowLayer as String] as? Int == 0,
              let box = info[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: box) else { return false }
        return rect.contains(point)
    }
    return foremost?[kCGWindowNumber as String] as? CGWindowID == window
}

// Chromium menus need the real down/up sequence. AXPress is not equivalent to
// pointerdown, and an AppKit-local NSEvent is not a Quartz screen-space event.
// Construct only; the session verifies ownership before posting the event.
func macWindowPointerEvent(source: CGEventSource?, phase: String, button: Int?,
                           point: CGPoint, clicks: Int, flags: CGEventFlags,
                           window: CGWindowID) -> CGEvent? {
    guard point.x.isFinite, point.y.isFinite, window != 0, (0...3).contains(clicks),
          button == nil || (0...2).contains(button!) else { return nil }
    let type: CGEventType
    switch (phase, button) {
    case ("move", nil): type = .mouseMoved
    case ("move", 0): type = .leftMouseDragged
    case ("move", 1): type = .otherMouseDragged
    case ("move", 2): type = .rightMouseDragged
    case ("down", 0): type = .leftMouseDown
    case ("down", 1): type = .otherMouseDown
    case ("down", 2): type = .rightMouseDown
    case ("up", 0): type = .leftMouseUp
    case ("up", 1): type = .otherMouseUp
    case ("up", 2): type = .rightMouseUp
    default: return nil
    }
    guard phase == "move" || clicks > 0,
          let event = CGEvent(mouseEventSource: source, mouseType: type,
                              mouseCursorPosition: point,
                              mouseButton: button == 1 ? .center : button == 2 ? .right : .left) else { return nil }
    event.flags = flags
    event.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
    return event
}
