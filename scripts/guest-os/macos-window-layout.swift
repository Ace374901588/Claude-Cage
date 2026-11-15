import CoreGraphics

// Work in Quartz guest points, including displays with negative origins. The
// destination origin must be calculated from the requested size, not the old
// size: otherwise a small window at the bottom/right edge cannot grow.
enum MacWindowLayout {
    static func target(current: CGRect, viewport: CGSize, workArea: CGRect) -> CGRect? {
        let values = [current.minX, current.minY, current.width, current.height,
                      viewport.width, viewport.height, workArea.minX, workArea.minY,
                      workArea.width, workArea.height]
        guard values.allSatisfy({ $0.isFinite }), !current.isEmpty, !workArea.isEmpty,
              viewport.width > 0, viewport.height > 0 else { return nil }
        let size = CGSize(width: min(viewport.width, workArea.width),
                          height: min(viewport.height, workArea.height))
        return CGRect(x: max(workArea.minX, min(current.minX, workArea.maxX - size.width)),
                      y: max(workArea.minY, min(current.minY, workArea.maxY - size.height)),
                      width: size.width, height: size.height)
    }

    // A sheet, fixed-size login dialog, fullscreen window or active drag keeps
    // its native geometry. Capture still fits the entire resulting window.
    static func mayAdjust(standard: Bool, modal: Bool, hasSheets: Bool,
                          fullscreen: Bool, movable: Bool, sizable: Bool, dragging: Bool) -> Bool {
        standard && !modal && !hasSheets && !fullscreen && movable && sizable && !dragging
    }

    static func agrees(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
        abs(lhs.minX - rhs.minX) < 2 && abs(lhs.minY - rhs.minY) < 2 &&
        abs(lhs.width - rhs.width) < 2 && abs(lhs.height - rhs.height) < 2
    }

    // NSScreen uses bottom-left coordinates; visibleFrame includes menu/Dock
    // insets. Convert locally within that display rather than flipping around
    // the primary screen, which breaks secondary displays above/below it.
    static func workArea(display: CGRect, screen: CGRect, visible: CGRect) -> CGRect {
        CGRect(x: display.minX + visible.minX - screen.minX,
               y: display.minY + screen.maxY - visible.maxY,
               width: visible.width, height: visible.height)
    }
}
