import CoreGraphics
import Foundation

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
