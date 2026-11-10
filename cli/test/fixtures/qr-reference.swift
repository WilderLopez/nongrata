// Regenerates qr-reference.json: the QR matrices that Apple's CoreImage (CIQRCodeGenerator, error
// correction level M) draws for each text, as reference outputs for ../qr.test.ts. macOS only:
//
//   swift cli/test/fixtures/qr-reference.swift > cli/test/fixtures/qr-reference.json
//
// CoreImage chooses its own mask; the test reads it from each matrix's format information.

import CoreImage
import Foundation

/// A pairing link like the Worker's, cut or padded to `length` bytes.
func link(_ length: Int) -> String {
  var s = "nongrata://pair?v=1&url=https%3A%2F%2Fnongrata-myapp.example.workers.dev&id=AAECAwQFBgcICQoLDA0ODw"
    + "&secret=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8&role=admin&label=Ana-s-iPhone-with-a-long-name"
  while s.utf8.count < length { s += "x" }
  return String(decoding: Array(s.utf8.prefix(length)), as: UTF8.self)
}

let texts = [
  "hello",
  "Hello, World!",
  "ñandú ✓ 🙂",
  link(14), link(15), link(26), link(27), link(42), link(43), link(62), link(63),
  link(84), link(85), link(106), link(107), link(122), link(123), link(152), link(153),
  link(180), link(181), link(213),
]

let context = CIContext()
var vectors: [[String: Any]] = []
for text in texts {
  let filter = CIFilter(name: "CIQRCodeGenerator")!
  filter.setValue(Data(text.utf8), forKey: "inputMessage")
  filter.setValue("M", forKey: "inputCorrectionLevel")
  let image = filter.outputImage!
  let width = Int(image.extent.width)
  var pixels = [UInt8](repeating: 0, count: width * width * 4)
  context.render(image, toBitmap: &pixels, rowBytes: width * 4, bounds: image.extent, format: .RGBA8,
                 colorSpace: CGColorSpaceCreateDeviceRGB())
  // CoreImage adds a one-module light border; it is left out.
  let rows = (1..<(width - 1)).map { y in
    String((1..<(width - 1)).map { x in pixels[(y * width + x) * 4] < 128 ? "1" : "0" })
  }
  vectors.append(["text": text, "version": (rows.count - 17) / 4, "modules": rows])
}

let root: [String: Any] = [
  "description": "QR matrices drawn by Apple's CoreImage (CIQRCodeGenerator, level M) for each text, without the quiet zone. 1 is dark. Regenerate with qr-reference.swift.",
  "vectors": vectors,
]
let json = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
print(String(decoding: json, as: UTF8.self))
