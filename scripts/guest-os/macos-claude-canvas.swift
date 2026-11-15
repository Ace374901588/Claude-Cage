// A geometry token describes only the signed Claude window actually captured.
// All coordinates used for presentation and input are measured in guest points.
import AppKit
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers

struct ClaudeCanvas {
    let id: CGWindowID
    let pid: pid_t
    let frame: CGRect
    let cropTop: CGFloat
    let scale: CGFloat
    let resizable: Bool
    var content: CGSize { CGSize(width: frame.width, height: frame.height - cropTop) }

    func matches(_ other: ClaudeCanvas) -> Bool {
        id == other.id && pid == other.pid && frame == other.frame && cropTop == other.cropTop && scale == other.scale
    }
}

private func axAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value
}

private func axRect(_ element: AXUIElement) -> CGRect? {
    guard let p = axAttribute(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
          let s = axAttribute(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var pos = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &pos), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: pos, size: size)
}

private func liveBounds(_ id: CGWindowID, _ pid: pid_t) throws -> CGRect {
    let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String:Any]]
    guard let info = windows?.first, info[kCGWindowOwnerPID as String] as? Int32 == pid,
          info[kCGWindowIsOnscreen as String] as? Bool == true,
          let box = info[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: box), !rect.isEmpty else { throw Failure(7, "window_changed") }
    return rect
}

func owningAXWindow(_ pid: pid_t, _ frame: CGRect) -> AXUIElement? {
    guard AXIsProcessTrusted(), NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
          let raw = axAttribute(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute),
          CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
    let window = raw as! AXUIElement
    guard let actual = axRect(window), abs(actual.minX-frame.minX)<1, abs(actual.minY-frame.minY)<1,
          abs(actual.width-frame.width)<1, abs(actual.height-frame.height)<1 else { return nil }
    return window
}

func macApplicationWindowBounds(_ pid: pid_t) -> [CGRect] {
    guard AXIsProcessTrusted(),
          let windows = axAttribute(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as? [AXUIElement] else { return [] }
    return windows.compactMap(axRect)
}

private func canSet(_ window: AXUIElement, _ name: String) -> Bool {
    var result = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(window, name as CFString, &result) == .success && result.boolValue
}

@MainActor
private func visibleWorkArea(_ bounds: CGRect) -> CGRect {
    let screens = NSScreen.screens.compactMap { screen -> (CGRect, CGRect)? in
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
        let display = CGDisplayBounds(CGDirectDisplayID(number.uint32Value))
        return (display, MacWindowLayout.workArea(display: display, screen: screen.frame, visible: screen.visibleFrame))
    }
    return screens.max { lhs, rhs in
        let a = lhs.0.intersection(bounds), b = rhs.0.intersection(bounds)
        return (a.isNull ? 0 : a.width * a.height) < (b.isNull ? 0 : b.width * b.height)
    }?.1 ?? CGDisplayBounds(CGMainDisplayID())
}

@MainActor
final class ClaudeCanvasSession {
    static let shared = ClaudeCanvasSession()
    static let browser = ClaudeCanvasSession(browser: true)
    private let browser: Bool
    let stream: MacWindowStream
    init(browser: Bool = false) {
        self.browser = browser
        self.stream = browser ? MacWindowStream() : .shared
    }

    private func owns(_ pid: pid_t) throws -> Bool {
        if browser { return MacChromeWindow.shared.owns(pid) }
        return try claudePIDs().contains(pid)
    }

    private var last: ClaudeCanvas?
    private var token = ""
    private var requested: (id: CGWindowID, pid: pid_t, target: CGRect, observed: CGRect, time: Date)?

    func layout(_ window: SCWindow, filter: SCContentFilter, width: Int, height: Int, scale: Double) async throws -> ClaudeCanvas {
        guard let pid = window.owningApplication?.processID,
              (320...2560).contains(width), (240...1600).contains(height),
              scale.isFinite, (1...2).contains(scale) else { throw Failure(8, "invalid_input") }
        var bounds = try liveBounds(window.windowID, pid)
        var resized = false
        if let ax = owningAXWindow(pid, bounds) {
            let adjustable = MacWindowLayout.mayAdjust(
                standard: axAttribute(ax, kAXSubroleAttribute) as? String == kAXStandardWindowSubrole,
                modal: axAttribute(ax, kAXModalAttribute) as? Bool == true,
                hasSheets: (axAttribute(ax, kAXChildrenAttribute) as? [AXUIElement])?.contains {
                    axAttribute($0, kAXRoleAttribute) as? String == kAXSheetRole
                } == true,
                fullscreen: axAttribute(ax, "AXFullScreen") as? Bool == true,
                movable: canSet(ax, kAXPositionAttribute), sizable: canSet(ax, kAXSizeAttribute),
                dragging: MacWindowInputSession.hasHeldPointer)
            if adjustable, let wanted = MacWindowLayout.target(current: bounds,
                viewport: CGSize(width: width, height: height), workArea: visibleWorkArea(bounds)) {
                let close = MacWindowLayout.agrees(bounds, wanted)
                let recent = requested.map { $0.id == window.windowID && $0.pid == pid && $0.target == wanted &&
                    $0.observed == bounds && Date().timeIntervalSince($0.time) < 3 } ?? false
                if !close && !recent {
                    // Make room at the destination first. Resizing a small
                    // window against the old right/bottom edge can be clamped.
                    // A bounded second pass handles asynchronous native layout
                    // and application minimum sizes without a per-frame loop.
                    for _ in 0..<2 {
                        guard try owns(pid), owningAXWindow(pid, bounds) != nil,
                              !MacWindowInputSession.hasHeldPointer else { throw Failure(7, "window_changed") }
                        var origin = wanted.origin, size = wanted.size
                        if bounds.origin != origin, let value = AXValueCreate(.cgPoint, &origin) {
                            _ = AXUIElementSetAttributeValue(ax, kAXPositionAttribute as CFString, value)
                        }
                        if let value = AXValueCreate(.cgSize, &size) {
                            _ = AXUIElementSetAttributeValue(ax, kAXSizeAttribute as CFString, value)
                        }
                        try await Task.sleep(nanoseconds: 70_000_000)
                        bounds = try liveBounds(window.windowID, pid)
                        if MacWindowLayout.agrees(bounds, wanted) { break }
                    }
                    guard try owns(pid), owningAXWindow(pid, bounds) != nil else { throw Failure(7, "window_changed") }
                    requested = (window.windowID, pid, wanted, bounds, Date())
                }
                resized = MacWindowLayout.agrees(bounds, wanted)
            }
        }
        // Claude's unified titlebar also contains navigation and the chat
        // title. Keep it in both capture and the input coordinate system.
        return ClaudeCanvas(id: window.windowID, pid: pid, frame: bounds, cropTop: 0,
                            scale: min(max(1,CGFloat(filter.pointPixelScale)), CGFloat(scale)), resizable: resized)
    }

    func record(_ value: ClaudeCanvas) -> String {
        if last?.matches(value) != true { token = UUID().uuidString; last = value }
        return token
    }

    func inputGeometry(_ requested: String, window: SCWindow) throws -> ClaudeCanvas {
        guard let last, token == requested, last.id == window.windowID, last.pid == window.owningApplication?.processID,
              try liveBounds(last.id, last.pid) == last.frame,
              owningAXWindow(last.pid, last.frame) != nil, last.cropTop == 0 else {
            throw Failure(7, "window_changed")
        }
        return last
    }

    func captureVideo(_ window: SCWindow, filter: SCContentFilter, layout: ClaudeCanvas,
                      after: String?, wait: Bool, videoSession: String) async throws -> [String: Any] {
        let config = SCStreamConfiguration()
        config.width = max(2, Int((layout.frame.width * layout.scale).rounded()))
        config.height = max(2, Int((layout.frame.height * layout.scale).rounded()))
        config.captureResolution = .best
        config.colorSpaceName = CGColorSpace.sRGB
        config.ignoreShadowsSingleWindow = true; config.showsCursor = false
        if #available(macOS 14.2, *) { config.includeChildWindows = browser }
        let geometry = record(layout)
        let (pixels, sequence) = try await stream.frameBuffer(filter: filter, configuration: config,
            identity: geometry, after: after, wait: wait)
        guard try liveBounds(layout.id, layout.pid) == layout.frame, try owns(layout.pid) else { throw Failure(7, "window_changed") }
        guard let pixels else { return ["unchanged": true, "sequence": sequence, "geometry": geometry] }
        let top = Int((layout.cropTop * CGFloat(CVPixelBufferGetHeight(pixels)) / layout.frame.height).rounded())
        let encoded: MacEncodedVideoFrame
        do {
            encoded = try await MacWindowVideoEncoder.shared.encode(pixels, cropTop: top, stream: videoSession,
                identity: geometry, keyFrame: after?.isEmpty != false)
        } catch {
            try Task.checkCancellation()
            // The caller can continue with JPEG when hardware is temporarily
            // unavailable. The browser then disables video for this connection.
            return try await capture(window, filter: filter, layout: layout, after: after, wait: false,
                binary: true, encoding: "jpeg")
        }
        guard token == geometry, last?.matches(layout) == true,
              try liveBounds(layout.id, layout.pid) == layout.frame, try owns(layout.pid) else { throw Failure(7, "window_changed") }
        return ["window": layout.id, "pid": layout.pid, "mime": "video/h264", "sequence": sequence,
            "contentWidth": layout.content.width, "contentHeight": layout.content.height,
            "pixelWidth": encoded.width, "pixelHeight": encoded.height, "cropTop": layout.cropTop,
            "resizable": layout.resizable, "geometry": geometry, "imageBytes": encoded.data,
            "codec": encoded.codec, "description": encoded.description.base64EncodedString(),
            "timestamp": encoded.timestamp, "keyFrame": encoded.keyFrame,
            "encodeMilliseconds": encoded.encodeMilliseconds]
    }

    func capture(_ window: SCWindow, filter: SCContentFilter, layout: ClaudeCanvas, after: String? = nil, wait: Bool = false, binary: Bool = false, phoneJPEG: Bool = false, encoding: String = "png") async throws -> [String:Any] {
        let config = SCStreamConfiguration()
        config.width = max(1, Int((layout.frame.width*layout.scale).rounded()))
        config.height = max(1, Int((layout.frame.height*layout.scale).rounded()))
        config.captureResolution = .best
        config.ignoreShadowsSingleWindow = true; config.showsCursor = false
        if #available(macOS 14.2, *) { config.includeChildWindows = browser }
        let geometry = record(layout)
        let (updated, sequence) = try await stream.frame(filter: filter, configuration: config, identity: geometry, after: after, wait: wait)
        guard try liveBounds(layout.id, layout.pid) == layout.frame,
              try owns(layout.pid) else { throw Failure(7, "window_changed") }
        guard let image = updated else { return ["unchanged": true, "sequence": sequence, "geometry": geometry] }
        let top = Int((layout.cropTop * CGFloat(image.height) / layout.frame.height).rounded())
        guard top >= 0, top < image.height,
              let content = image.cropping(to: CGRect(x:0,y:top,width:image.width,height:image.height-top)),
              try liveBounds(layout.id, layout.pid) == layout.frame,
              try owns(layout.pid) else { throw Failure(7, "window_changed") }
        let encoded: MacEncodedWindowImage
        do { encoded = try await MacWindowImageEncoder.shared.encode(content, encoding: encoding, phone: phoneJPEG) }
        catch MacWindowEncodingError.frameLimit { throw Failure(8, "frame_limit") }
        catch MacWindowEncodingError.invalidEncoding { throw Failure(8, "invalid_input") }
        catch { throw Failure(8, "capture_failed") }
        // Encoding now yields the GUI actor. Recheck the exact captured window
        // and geometry after the await, before publishing its pixels or receipt.
        guard token == geometry, last?.matches(layout) == true,
              try liveBounds(layout.id, layout.pid) == layout.frame,
              try owns(layout.pid) else { throw Failure(7, "window_changed") }
        let data = encoded.data, mime = encoded.mime
        var reply: [String:Any] = ["window":layout.id,"pid":layout.pid,"mime":mime,"sequence":sequence,
                "contentWidth":layout.content.width,"contentHeight":layout.content.height,
                "pixelWidth":content.width,"pixelHeight":content.height,"cropTop":layout.cropTop,
                "resizable":layout.resizable, "geometry":geometry]
        if binary { reply["imageBytes"] = data }
        else { reply["image"] = data.base64EncodedString() }
        return reply
    }
}
