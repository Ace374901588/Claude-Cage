import CoreGraphics

@main
struct WindowLayoutTests {
    static func main() {
        let work = CGRect(x: 0, y: 25, width: 1440, height: 825)
        let small = CGRect(x: 840, y: 450, width: 600, height: 400)
        let target = MacWindowLayout.target(current: small, viewport: CGSize(width: 1200, height: 800), workArea: work)!
        precondition(target == CGRect(x: 240, y: 50, width: 1200, height: 800), "bottom-right window must move before enlargement")
        // Emulate a window server that clamps growth to the current screen edge.
        let sizeFirst = CGSize(width: min(target.width, work.maxX - small.minX), height: min(target.height, work.maxY - small.minY))
        precondition(sizeFirst == small.size, "regression fixture must reproduce the old size-first clamp")
        let moved = CGRect(origin: target.origin, size: small.size)
        let sizeAfterMove = CGSize(width: min(target.width, work.maxX - moved.minX), height: min(target.height, work.maxY - moved.minY))
        precondition(sizeAfterMove == target.size)
        precondition(MacWindowLayout.target(current: target, viewport: target.size, workArea: work) == target, "stable layouts must not oscillate")
        let negative = CGRect(x: -1920, y: -1080, width: 1920, height: 1080)
        precondition(MacWindowLayout.target(current: small, viewport: CGSize(width: 2500, height: 1500), workArea: negative) == negative)
        precondition(MacWindowLayout.target(current: CGRect(x: -100, y: -100, width: 600, height: 400), viewport: CGSize(width: 800, height: 500), workArea: work)?.origin == work.origin)
        precondition(MacWindowLayout.workArea(display: negative, screen: CGRect(x: -1920, y: 900, width: 1920, height: 1080), visible: CGRect(x: -1920, y: 950, width: 1920, height: 1005)) == CGRect(x: -1920, y: -1055, width: 1920, height: 1005))
        for invalid in [CGFloat.nan, CGFloat.infinity, 0, -1] {
            precondition(MacWindowLayout.target(current: small, viewport: CGSize(width: invalid, height: 600), workArea: work) == nil)
        }
        for i in 0..<8 {
            precondition(MacWindowLayout.mayAdjust(standard: i != 1, modal: i == 2, hasSheets: i == 3,
                fullscreen: i == 4, movable: i != 5, sizable: i != 6, dragging: i == 7) == (i == 0))
        }
        precondition(!MacWindowLayout.agrees(small, target))
        precondition(MacWindowLayout.agrees(target, target.offsetBy(dx: 1, dy: 1)))
        print("Window layout regression checks passed: edge-clamped growth, stable fits, visible work areas, negative origins, invalid dimensions and protected windows. No GUI was changed.")
    }
}
