import CoreGraphics
import Foundation
import ImageIO

private func decoded(_ data: Data) -> CGImage {
    let source = CGImageSourceCreateWithData(data as CFData, nil)!
    return CGImageSourceCreateImageAtIndex(source, 0, nil)!
}

private func pixels(_ image: CGImage) -> Data {
    let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
        bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)!
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    return Data(bytes: context.data!, count: image.width * image.height * 4)
}

@MainActor private final class Heartbeat { var count = 0; var done = false }

@main
struct WindowEncodingTests {
    @MainActor static func main() async throws {
        let context = CGContext(data: nil, width: 640, height: 480, bitsPerComponent: 8,
            bytesPerRow: 640 * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)!
        for row in 0..<480 {
            context.setFillColor(red: CGFloat(row % 251)/250, green: CGFloat(row % 127)/126, blue: 0.4, alpha: 1)
            context.fill(CGRect(x: 0, y: row, width: 640, height: 1))
        }
        let fixture = context.makeImage()!
        let encoder = MacWindowImageEncoder.shared
        let sharp = try await encoder.encode(fixture)
        precondition(sharp.mime == "image/png" && pixels(decoded(sharp.data)) == pixels(fixture), "sharp mode must preserve every pixel")
        let balanced = try await encoder.encode(fixture, encoding: "jpeg")
        precondition(balanced.mime == "image/jpeg" && balanced.data.starts(with: [0xff, 0xd8]))
        let phone = try await encoder.encode(fixture, phone: true)
        precondition(phone.mime == "image/jpeg" && phone.data.count <= 2 << 20)
        for image in [decoded(sharp.data), decoded(balanced.data), decoded(phone.data)] {
            precondition(image.width == fixture.width && image.height == fixture.height, "encoding must not change input geometry")
        }
        do {
            _ = try await encoder.encode(fixture, encoding: "unsupported")
            preconditionFailure("unknown encodings must be rejected")
        } catch MacWindowEncodingError.invalidEncoding { }

        let sample: CGImage
        if CommandLine.arguments.count > 1 {
            sample = decoded(try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        } else { sample = fixture }
        let beat = Heartbeat()
        let heartbeat = Task { @MainActor in
            while !beat.done {
                beat.count += 1
                await Task.yield()
            }
        }
        _ = try await encoder.encode(sample)
        beat.done = true
        heartbeat.cancel()
        precondition(beat.count > 0, "image compression blocked the main actor")

        var measurements: [[String:Any]] = []
        for encoding in ["png", "jpeg"] {
            var elapsed: [Double] = [], lengths: [Int] = []
            for _ in 0..<8 {
                let start = ContinuousClock.now
                let result = try await encoder.encode(sample, encoding: encoding)
                let duration = start.duration(to: .now).components
                elapsed.append(Double(duration.seconds)*1000 + Double(duration.attoseconds)/1e15)
                lengths.append(result.data.count)
                precondition(decoded(result.data).width == sample.width && decoded(result.data).height == sample.height)
                if encoding == "jpeg", CommandLine.arguments.count > 2 {
                    try result.data.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
                }
            }
            measurements.append(["encoding":encoding, "median_ms":elapsed.sorted()[elapsed.count/2],
                "bytes_mean":lengths.reduce(0,+)/lengths.count, "samples":elapsed.count])
        }
        let raw = pixels(sample)
        let alpha = [raw[3],raw[(sample.width-1)*4+3],raw[(sample.height-1)*sample.width*4+3],raw[raw.count-1]]
        let encoded = try await encoder.encode(sample, encoding: "jpeg")
        let lossy = pixels(decoded(encoded.data))
        var squared = 0.0
        for i in raw.indices where i % 4 != 3 { let delta = Double(Int(raw[i])-Int(lossy[i])); squared += delta*delta }
        let rmse = sqrt(squared/Double(sample.width*sample.height*3))
        let result: [String:Any] = ["checks":"lossless PNG, valid JPEG, phone bound, unchanged dimensions, encoding validation, main-actor liveness passed",
            "width":sample.width, "height":sample.height, "main_actor_heartbeats":beat.count,
            "source_corner_alpha":alpha.map(Int.init), "jpeg_rgb_rmse":rmse, "measurements":measurements]
        let data = try JSONSerialization.data(withJSONObject: result,options:[.sortedKeys])
        print(String(decoding:data,as:UTF8.self))
    }
}
