import CoreGraphics
import Foundation

@main
struct PointerWindowTests {
    static func main() {
        let bounds = CGRect(x: 100, y: 100, width: 600, height: 400)
        let point = CGPoint(x: 350, y: 250)
        func info(_ pid: Int32, _ id: CGWindowID, _ rect: CGRect = CGRect(x: 100, y: 100, width: 600, height: 400), layer: Int = 0, visible: Bool = true) -> [String: Any] {
            [kCGWindowOwnerPID as String: pid, kCGWindowNumber as String: id,
             kCGWindowBounds as String: rect.dictionaryRepresentation,
             kCGWindowLayer as String: layer, kCGWindowIsOnscreen as String: visible]
        }
        let target = info(23, 70)
        func owns(_ windows: [[String: Any]], _ sample: CGPoint = CGPoint(x: 350, y: 250)) -> Bool {
            macPointerWindowOwnsPoint(sample, pid: 23, window: 70, bounds: bounds, windows: windows)
        }
        precondition(owns([target]))
        precondition(!owns([]))
        precondition(!owns([info(24, 71), target]), "another app must cover the stale target")
        precondition(!owns([info(23, 71), target]), "a second window of the same app must also cover it")
        precondition(!owns([info(23, 70, CGRect(x: 110, y: 100, width: 600, height: 400))]), "moved windows invalidate coordinates")
        precondition(!owns([info(23, 70, visible: false)]))
        precondition(!owns([target], CGPoint(x: 701, y: 250)))
        precondition(!owns([target], CGPoint(x: CGFloat.nan, y: 250)))
        precondition(owns([info(24, 71, CGRect(x: 0, y: 0, width: 10, height: 10)), target]))
        precondition(!macPointerWindowOwnsPoint(point, pid: 23, window: 70, bounds: .zero, windows: [target]))
        print("10 pointer-window ownership cases passed")
    }
}
