import CoreGraphics
import Foundation

@main
struct WindowPointerTests {
    static func main() throws {
        let pid: pid_t = 71, window: CGWindowID = 91
        let rect = CGRect(x: 120, y: 80, width: 800, height: 600)
        let point = CGPoint(x: 260, y: 580)
        func info(_ id: CGWindowID = 91, owner: pid_t = 71, layer: Int = 0,
                  bounds: CGRect = CGRect(x: 120, y: 80, width: 800, height: 600)) -> [String: Any] {
            [kCGWindowOwnerPID as String: owner, kCGWindowNumber as String: id,
             kCGWindowLayer as String: layer, kCGWindowBounds as String: bounds.dictionaryRepresentation]
        }
        func owns(_ location: CGPoint = CGPoint(x: 260, y: 580), front: pid_t? = 71,
                  hit: pid_t? = 71, stack: [[String: Any]] = []) -> Bool {
            macPointerWindowOwnsPoint(location, pid: pid, window: window,
                frontmostPID: front, hitPID: hit, windows: stack)
        }
        precondition(owns(stack: [info()]), "visible captured window must accept its input")
        precondition(!owns(front: 72, stack: [info()]), "app switch must reject stale input")
        precondition(!owns(front: nil, stack: [info()]), "missing foreground app must fail closed")
        precondition(!owns(hit: 72, stack: [info()]), "an overlapping app must not receive the click")
        precondition(!owns(hit: nil, stack: [info()]), "failed AX hit test must fail closed")
        precondition(!owns(stack: [info(92), info()]), "another front window of the same process must block input")
        precondition(owns(stack: [info(), info(92)]), "a window behind the captured window must not block it")
        precondition(!owns(stack: [info(layer: 1)]), "a floating panel cannot substitute for the captured window")
        precondition(!owns(stack: []), "a disappeared window must fail closed")
        precondition(!owns(CGPoint(x: rect.minX - 1, y: rect.minY), stack: [info()]), "outside-window coordinates must be rejected")
        precondition(!owns(CGPoint(x: CGFloat.nan, y: 100), stack: [info()]), "NaN must be rejected")
        precondition(!owns(CGPoint(x: 100, y: CGFloat.infinity), stack: [info()]), "infinity must be rejected")
        precondition(owns(CGPoint(x: -100, y: -20), stack: [info(bounds: CGRect(x: -300, y: -100, width: 400, height: 300))]),
                     "valid negative display coordinates must remain usable")

        let source = CGEventSource(stateID: .privateState)
        let cases: [(String, Int?, CGEventType)] = [
            ("down", 0, .leftMouseDown), ("up", 0, .leftMouseUp), ("move", 0, .leftMouseDragged),
            ("down", 1, .otherMouseDown), ("up", 1, .otherMouseUp), ("move", 1, .otherMouseDragged),
            ("down", 2, .rightMouseDown), ("up", 2, .rightMouseUp), ("move", 2, .rightMouseDragged),
            ("move", nil, .mouseMoved),
        ]
        for (phase, button, type) in cases {
            let event = macWindowPointerEvent(source: source, phase: phase, button: button,
                point: point, clicks: phase == "move" ? 0 : 2, flags: [.maskShift, .maskCommand], window: window)!
            precondition(event.type == type, "button phase must reach Chromium as the matching mouse event")
            precondition(event.location == point, "Quartz coordinates must not be flipped or made AppKit-local")
            precondition(event.flags.contains(.maskShift) && event.flags.contains(.maskCommand), "modifiers must survive")
            precondition(event.getIntegerValueField(.mouseEventClickState) == (phase == "move" ? 0 : 2), "double-click state must survive")
            precondition(event.getIntegerValueField(.mouseEventWindowUnderMousePointer) == Int64(window))
            precondition(event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent) == Int64(window))
            if let button {
                let expected: CGMouseButton = button == 1 ? .center : button == 2 ? .right : .left
                precondition(event.getIntegerValueField(.mouseEventButtonNumber) == Int64(expected.rawValue))
            }
        }
        for (phase, button, clicks) in [("down", nil, 1), ("down", 3, 1), ("invalid", 0, 1), ("up", 0, 0), ("down", 0, 4)] as [(String, Int?, Int)] {
            precondition(macWindowPointerEvent(source: source, phase: phase, button: button,
                point: point, clicks: clicks, flags: [], window: window) == nil, "invalid input must not create an event")
        }
        precondition(macWindowPointerEvent(source: source, phase: "down", button: 0,
            point: CGPoint(x: CGFloat.nan, y: 0), clicks: 1, flags: [], window: window) == nil)
        print("Pointer regression checks passed: captured-window ownership, occlusion and app-switch rejection, screen coordinates, down/up/drag, click counts and modifiers. No events were posted.")
    }
}
