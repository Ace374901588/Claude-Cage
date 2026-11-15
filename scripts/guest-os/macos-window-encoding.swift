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

    private func imageData(_ image: CGImage, type: UTType, quality: Double? = nil) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else {
            throw MacWindowEncodingError.captureFailed
        }
        let properties = quality.map { [kCGImageDestinationLossyCompressionQuality: $0] as CFDictionary }
        CGImageDestinationAddImage(destination, image, properties)
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
