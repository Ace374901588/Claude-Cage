import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

enum MacVideoEncodingError: Error {
    case unavailable, invalidInput, busy, failed, timeout, frameLimit
}

struct MacEncodedVideoFrame: Sendable {
    let data: Data
    let description: Data
    let codec: String
    let timestamp: Int64
    let keyFrame: Bool
    let width: Int
    let height: Int
    let encodeMilliseconds: Double
}

// VideoToolbox owns the callback thread. A receipt completes exactly once,
// including cancellation/timeout, and contains no window or input authority.
private final class MacVideoReceipt: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<MacEncodedVideoFrame, Error>?
    private var timeout: Task<Void, Never>?
    let started = DispatchTime.now().uptimeNanoseconds
    let timestamp: Int64

    init(_ continuation: CheckedContinuation<MacEncodedVideoFrame, Error>, timestamp: Int64) {
        self.continuation = continuation
        self.timestamp = timestamp
    }

    func armTimeout() {
        lock.lock()
        defer { lock.unlock() }
        guard continuation != nil else { return }
        timeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { return }
            self?.finish(.failure(MacVideoEncodingError.timeout))
        }
    }

    func finish(_ result: Result<MacEncodedVideoFrame, Error>) {
        lock.lock()
        let pending = continuation
        continuation = nil
        let timer = timeout
        timeout = nil
        lock.unlock()
        timer?.cancel()
        pending?.resume(with: result)
    }

    func receive(status: OSStatus, flags: VTEncodeInfoFlags, sample: CMSampleBuffer?) {
        guard status == noErr, !flags.contains(.frameDropped), let sample,
              CMSampleBufferDataIsReady(sample), let block = CMSampleBufferGetDataBuffer(sample),
              let format = CMSampleBufferGetFormatDescription(sample),
              let atoms = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) as? [String: Any],
              let description = atoms["avcC"] as? Data, description.count >= 7, description.count <= 4096,
              description[0] == 1, description[4] & 3 == 3 else {
            finish(.failure(MacVideoEncodingError.failed)); return
        }
        let size = CMBlockBufferGetDataLength(block)
        guard size > 0, size < 8 << 20 else { finish(.failure(MacVideoEncodingError.frameLimit)); return }
        var data = Data(count: size)
        let copied = data.withUnsafeMutableBytes {
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: size, destination: $0.baseAddress!)
        }
        guard copied == kCMBlockBufferNoErr else { finish(.failure(MacVideoEncodingError.failed)); return }
        let dimensions = CMVideoFormatDescriptionGetDimensions(format)
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let notSync = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false
        let codec = String(format: "avc1.%02x%02x%02x", description[1], description[2], description[3])
        finish(.success(MacEncodedVideoFrame(data: data, description: description, codec: codec,
            timestamp: timestamp, keyFrame: !notSync, width: Int(dimensions.width), height: Int(dimensions.height),
            encodeMilliseconds: Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000)))
    }
}

private final class MacVideoSession {
    let compression: VTCompressionSession
    let pool: CVPixelBufferPool
    let identity: String
    let width: Int
    let height: Int
    var busy = false
    var used = Date()
    var frames: Int64 = 0

    init(identity: String, width: Int, height: Int) throws {
        self.identity = identity; self.width = width; self.height = height
        let attributes: [CFString: Any] = [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey: width, kCVPixelBufferHeightKey: height,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
        var pool: CVPixelBufferPool?
        guard CVPixelBufferPoolCreate(kCFAllocatorDefault,
            [kCVPixelBufferPoolMinimumBufferCountKey: 2] as CFDictionary,
            attributes as CFDictionary, &pool) == kCVReturnSuccess, let pool else {
            throw MacVideoEncodingError.unavailable
        }
        self.pool = pool
        func create(lowLatency: Bool) -> (OSStatus, VTCompressionSession?) {
            var specification: [CFString: Any] = [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true]
            if lowLatency { specification[kVTVideoEncoderSpecification_EnableLowLatencyRateControl] = true }
            var session: VTCompressionSession?
            let status = VTCompressionSessionCreate(allocator: kCFAllocatorDefault,
                width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
                encoderSpecification: specification as CFDictionary, imageBufferAttributes: attributes as CFDictionary,
                compressedDataAllocator: nil, outputCallback: { _, raw, status, flags, sample in
                    guard let raw else { return }
                    Unmanaged<MacVideoReceipt>.fromOpaque(raw).takeRetainedValue().receive(status: status, flags: flags, sample: sample)
                }, refcon: nil, compressionSessionOut: &session)
            return (status, session)
        }
        var candidate = create(lowLatency: true)
        if candidate.0 != noErr { candidate = create(lowLatency: false) }
        guard candidate.0 == noErr, let compression = candidate.1 else { throw MacVideoEncodingError.unavailable }
        self.compression = compression
        for (key, value) in [(kVTCompressionPropertyKey_RealTime, true as CFTypeRef),
                             (kVTCompressionPropertyKey_AllowFrameReordering, false as CFTypeRef),
                             (kVTCompressionPropertyKey_ExpectedFrameRate, 30 as CFTypeRef),
                             (kVTCompressionPropertyKey_AverageBitRate, max(8_000_000, min(32_000_000, width * height * 8)) as CFTypeRef),
                             (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel as CFTypeRef)] {
            guard VTSessionSetProperty(compression, key: key, value: value) == noErr else {
                VTCompressionSessionInvalidate(compression); throw MacVideoEncodingError.unavailable
            }
        }
        guard VTCompressionSessionPrepareToEncodeFrames(compression) == noErr else {
            VTCompressionSessionInvalidate(compression); throw MacVideoEncodingError.unavailable
        }
    }

    deinit { VTCompressionSessionInvalidate(compression) }

    func cropped(_ source: CVPixelBuffer, top: Int) throws -> CVPixelBuffer {
        var output: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &output) == kCVReturnSuccess,
              let output else { throw MacVideoEncodingError.failed }
        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(output, [])
        defer { CVPixelBufferUnlockBaseAddress(output, []); CVPixelBufferUnlockBaseAddress(source, .readOnly) }
        guard let inputBase = CVPixelBufferGetBaseAddress(source), let outputBase = CVPixelBufferGetBaseAddress(output) else {
            throw MacVideoEncodingError.failed
        }
        let inputStride = CVPixelBufferGetBytesPerRow(source), outputStride = CVPixelBufferGetBytesPerRow(output)
        for row in 0..<height {
            let sourceRow = inputBase.advanced(by: (row + top) * inputStride).assumingMemoryBound(to: UInt32.self)
            let targetRow = outputBase.advanced(by: row * outputStride).assumingMemoryBound(to: UInt32.self)
            let inward = row < height / 2 ? min(height - 1, row + 16) : max(0, row - 16)
            let interior = inputBase.advanced(by: (inward + top) * inputStride).assumingMemoryBound(to: UInt32.self)[min(32, width - 1)]
            let background = sourceRow[min(32, width - 1)] >> 24 == 255 ? sourceRow[min(32, width - 1)] : interior >> 24 == 255 ? interior : 0xffffffff
            for x in 0..<width {
                let pixel = sourceRow[x], alpha = pixel >> 24
                if alpha == 255 { targetRow[x] = pixel; continue }
                var composite: UInt32 = 0xff000000
                for shift in [0, 8, 16] {
                    let value = min(255, (pixel >> shift & 255) + (background >> shift & 255) * (255 - alpha) / 255)
                    composite |= value << shift
                }
                targetRow[x] = composite
            }
        }
        return output
    }

    func encode(_ pixel: CVPixelBuffer, keyFrame: Bool) async throws -> MacEncodedVideoFrame {
        let timestamp = Int64(DispatchTime.now().uptimeNanoseconds / 1000)
        let force = frames == 0 || keyFrame
        frames += 1
        return try await withCheckedThrowingContinuation { continuation in
            let receipt = MacVideoReceipt(continuation, timestamp: timestamp)
            let raw = Unmanaged.passRetained(receipt).toOpaque()
            let status = VTCompressionSessionEncodeFrame(compression, imageBuffer: pixel,
                presentationTimeStamp: CMTime(value: timestamp, timescale: 1_000_000),
                duration: CMTime(value: 1, timescale: 30),
                frameProperties: force ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil,
                sourceFrameRefcon: raw, infoFlagsOut: nil)
            if status != noErr {
                Unmanaged<MacVideoReceipt>.fromOpaque(raw).release()
                receipt.finish(.failure(MacVideoEncodingError.failed))
            } else { receipt.armTimeout() }
        }
    }
}

actor MacWindowVideoEncoder {
    static let shared = MacWindowVideoEncoder()
    static let hardwareAdvertised: Bool = {
        var list: CFArray?
        guard VTCopyVideoEncoderList(nil, &list) == noErr else { return false }
        return ((list as? [[String: Any]]) ?? []).contains {
            ($0[kVTVideoEncoderList_CodecType as String] as? NSNumber)?.uint32Value == kCMVideoCodecType_H264 &&
            ($0[kVTVideoEncoderList_IsHardwareAccelerated as String] as? NSNumber)?.boolValue == true
        }
    }()
    private var sessions: [String: MacVideoSession] = [:]
    private var expiry: Task<Void, Never>?

    private func expire() {
        let cutoff = Date().addingTimeInterval(-5)
        sessions = sessions.filter { $0.value.busy || $0.value.used > cutoff }
    }

    private func renewExpiry() {
        expiry?.cancel()
        expiry = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 6_000_000_000) } catch { return }
            await self?.expire()
        }
    }

    func close(_ stream: String) { sessions.removeValue(forKey: stream) }

    func encode(_ source: CVPixelBuffer, cropTop: Int = 0, stream: String,
                identity: String, keyFrame: Bool = false) async throws -> MacEncodedVideoFrame {
        guard !stream.isEmpty, stream.utf8.count <= 128, !identity.isEmpty, identity.utf8.count <= 128,
              CVPixelBufferGetPixelFormatType(source) == kCVPixelFormatType_32BGRA,
              cropTop >= 0, cropTop < CVPixelBufferGetHeight(source) else { throw MacVideoEncodingError.invalidInput }
        let width = CVPixelBufferGetWidth(source) & ~1
        let height = (CVPixelBufferGetHeight(source) - cropTop) & ~1
        guard width >= 2, height >= 2, width <= 8192, height <= 8192, width * height <= 40_000_000 else {
            throw MacVideoEncodingError.invalidInput
        }
        expire()
        if let previous = sessions[stream], previous.identity != identity || previous.width != width || previous.height != height {
            guard !previous.busy else { throw MacVideoEncodingError.busy }
            sessions.removeValue(forKey: stream)
        }
        if sessions[stream] == nil {
            guard sessions.count < 3 else { throw MacVideoEncodingError.busy }
            sessions[stream] = try MacVideoSession(identity: identity, width: width, height: height)
        }
        let session = sessions[stream]!
        guard !session.busy else { throw MacVideoEncodingError.busy }
        session.busy = true
        defer { session.busy = false; session.used = Date(); renewExpiry() }
        do {
            let pixel = try session.cropped(source, top: cropTop)
            let encoded = try await session.encode(pixel, keyFrame: keyFrame)
            try Task.checkCancellation()
            return encoded
        } catch {
            if sessions[stream] === session { sessions.removeValue(forKey: stream) }
            throw error
        }
    }
}
