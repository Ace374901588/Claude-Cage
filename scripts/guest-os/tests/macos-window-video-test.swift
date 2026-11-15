import CoreVideo
import Foundation

private func fixture(width: Int = 320, height: Int = 240) -> CVPixelBuffer {
    var value: CVPixelBuffer?
    precondition(CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
        [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary] as CFDictionary, &value) == kCVReturnSuccess)
    let pixel = value!
    CVPixelBufferLockBaseAddress(pixel, [])
    let base = CVPixelBufferGetBaseAddress(pixel)!.assumingMemoryBound(to: UInt32.self)
    let stride = CVPixelBufferGetBytesPerRow(pixel) / 4
    for row in 0..<height {
        for x in 0..<width { base[row * stride + x] = (x / 16 + row / 16) % 2 == 0 ? 0xfff0f5fa : 0xff286ab0 }
    }
    CVPixelBufferUnlockBaseAddress(pixel, [])
    return pixel
}

private func packet(_ frame: MacEncodedVideoFrame, sequence: String) throws -> Data {
    let header: [String: Any] = ["imageLength": frame.data.count, "mime": "video/h264", "sequence": sequence,
        "geometry": "synthetic-fixture", "window": 42, "pid": 23, "contentWidth": frame.width,
        "contentHeight": frame.height, "pixelWidth": frame.width, "pixelHeight": frame.height,
        "codec": frame.codec, "description": frame.description.base64EncodedString(), "timestamp": frame.timestamp,
        "keyFrame": frame.keyFrame, "encodeMilliseconds": frame.encodeMilliseconds]
    let metadata = try JSONSerialization.data(withJSONObject: header, options: .sortedKeys)
    var size = UInt32(metadata.count).bigEndian
    var output = withUnsafeBytes(of: &size) { Data($0) }
    output.append(metadata); output.append(frame.data)
    return output
}

@main
struct MacWindowVideoTests {
    static func main() async throws {
        let encoder = MacWindowVideoEncoder.shared
        let pixel = fixture()
        let first = try await encoder.encode(pixel, stream: "first", identity: "window-one")
        let second = try await encoder.encode(pixel, stream: "first", identity: "window-one")
        precondition(first.keyFrame && first.timestamp < second.timestamp)
        precondition(first.width == 320 && first.height == 240 && first.codec.hasPrefix("avc1."))
        precondition(first.description == second.description && !first.data.isEmpty && !second.data.isEmpty)
        let independent = try await encoder.encode(pixel, stream: "second", identity: "window-one")
        precondition(independent.keyFrame, "each connection needs its own decodable first frame")
        let reset = try await encoder.encode(pixel, stream: "first", identity: "window-two")
        precondition(reset.keyFrame, "a new geometry must reset prediction")
        let forced = try await encoder.encode(pixel, stream: "first", identity: "window-two", keyFrame: true)
        precondition(forced.keyFrame, "a subscription reset must force a keyframe")
        await encoder.close("first"); await encoder.close("second")
        let crop = try await encoder.encode(fixture(width: 321, height: 243), cropTop: 21, stream: "crop", identity: "cropped")
        precondition(crop.width == 320 && crop.height == 222)
        await encoder.close("crop")
        do {
            _ = try await encoder.encode(pixel, cropTop: 240, stream: "bad", identity: "bad")
            preconditionFailure("a crop outside the captured buffer was accepted")
        } catch MacVideoEncodingError.invalidInput { }
        do {
            _ = try await encoder.encode(pixel, stream: String(repeating: "x", count: 129), identity: "bad")
            preconditionFailure("unbounded stream identity was accepted")
        } catch MacVideoEncodingError.invalidInput { }
        for stream in ["limit-a", "limit-b", "limit-c"] {
            _ = try await encoder.encode(pixel, stream: stream, identity: stream)
        }
        do {
            _ = try await encoder.encode(pixel, stream: "fourth", identity: "fourth")
            preconditionFailure("unbounded encoder sessions were accepted")
        } catch MacVideoEncodingError.busy { }
        await encoder.close("limit-a")
        _ = try await encoder.encode(pixel, stream: "fourth", identity: "fourth")
        for stream in ["limit-b", "limit-c", "fourth"] { await encoder.close(stream) }
        if CommandLine.arguments.count > 1 {
            let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try packet(first, sequence: "key-1").write(to: folder.appendingPathComponent("macos-window-h264-key.bin"))
            try packet(second, sequence: "delta-2").write(to: folder.appendingPathComponent("macos-window-h264-delta.bin"))
        }
        print("Hardware AVC: independent streams, geometry reset, forced keyframes, crop, input bounds and session limit passed.")
    }
}
