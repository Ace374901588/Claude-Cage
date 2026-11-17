import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct MacEncodedWindowImage: Sendable {
    let data: Data
    let mime: String
}

enum MacWindowEncodingError: Error {
    case invalidEncoding, captureFailed, frameLimit
}

// ImageIO compression is synchronous. Keep it on a serial worker actor so a
// multi-megapixel PNG cannot block the GUI actor's pointer and keyboard work.
actor MacWindowImageEncoder {
    static let shared = MacWindowImageEncoder()

    // JPEG has no alpha. Match the window's lower edge at rounded corners
    // instead of compositing transparent pixels against black.
    private func edgeColor(_ image: CGImage) -> CGColor? {
        switch image.alphaInfo {
        case .none, .noneSkipFirst, .noneSkipLast: return nil
        default: break
        }
        guard image.width > 40, image.height > 40,
              let pixel = image.cropping(to: CGRect(x: 16, y: image.height - 17, width: 1, height: 1)),
              let context = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.draw(pixel, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        guard let data = context.data else { return nil }
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        guard bytes[3] == 255 else { return nil }
        return CGColor(red: CGFloat(bytes[0]) / 255, green: CGFloat(bytes[1]) / 255,
                       blue: CGFloat(bytes[2]) / 255, alpha: 1)
    }

    private func imageData(_ image: CGImage, type: UTType, quality: Double? = nil) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else {
            throw MacWindowEncodingError.captureFailed
        }
        var properties: [CFString: Any] = [:]
        if let quality {
            properties[kCGImageDestinationLossyCompressionQuality] = quality
            if let edge = edgeColor(image) { properties[kCGImageDestinationBackgroundColor] = edge }
        }
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw MacWindowEncodingError.captureFailed }
        return data as Data
    }

    func encode(_ image: CGImage, encoding: String = "png", phone: Bool = false) throws -> MacEncodedWindowImage {
        guard encoding == "png" || encoding == "jpeg" else { throw MacWindowEncodingError.invalidEncoding }
        let limit = phone ? 2 << 20 : 8 << 20
        if !phone && encoding == "png" {
            let data = try imageData(image, type: .png)
            if data.count < limit { return MacEncodedWindowImage(data: data, mime: "image/png") }
        }
        let qualities = phone ? [0.9, 0.78, 0.62, 0.45] : encoding == "jpeg" ? [0.9, 0.84] : [0.93, 0.84]
        for quality in qualities {
            let data = try imageData(image, type: .jpeg, quality: quality)
            if phone ? data.count <= limit : data.count < limit {
                return MacEncodedWindowImage(data: data, mime: "image/jpeg")
            }
        }
        throw MacWindowEncodingError.frameLimit
    }
}
