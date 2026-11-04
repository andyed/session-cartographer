// Print every line of text Vision recognizes in each PNG given, as
// "<file>\t<line>". Accurate mode, no language correction (names are not words).
import Foundation
import Vision
import AppKit

for path in CommandLine.arguments.dropFirst() {
    guard let image = NSImage(contentsOfFile: path),
          let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        FileHandle.standardError.write("cannot read \(path)\n".data(using: .utf8)!)
        continue
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
    for observation in request.results ?? [] {
        if let line = observation.topCandidates(1).first?.string {
            print("\((path as NSString).lastPathComponent)\t\(line)")
        }
    }
}
