import CoreGraphics
import Foundation

// WindowServer lists windows from front to back. A frame receipt cannot
// authorize a physical mouse event through a covering window, even when the
// covering window belongs to the same signed application.
func macPointerWindowOwnsPoint(_ point: CGPoint, pid: Int32, window: CGWindowID,
                              bounds: CGRect, windows: [[String: Any]]) -> Bool {
    guard point.x.isFinite, point.y.isFinite, !bounds.isEmpty, bounds.contains(point) else { return false }
    for info in windows {
        guard info[kCGWindowLayer as String] as? Int == 0,
              info[kCGWindowIsOnscreen as String] as? Bool != false,
              let box = info[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: box), rect.contains(point) else { continue }
        return info[kCGWindowOwnerPID as String] as? Int32 == pid &&
            info[kCGWindowNumber as String] as? CGWindowID == window && rect == bounds
    }
    return false
}
