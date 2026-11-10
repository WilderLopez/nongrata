import DeviceGuard
@testable import DeviceGuardUI
import Testing

struct BlockedRefTests {
    @Test(
        "El overlay solo cubre con .blocked; .unknown es fail-open",
        arguments: [
            (DeviceGuardVerdict.allowed, String?.none),
            (.unknown, nil),
            (.blocked(ref: "A1B2C3D4"), "A1B2C3D4"),
        ]
    )
    func blockedRef(verdict: DeviceGuardVerdict, expected: String?) {
        #expect(verdict.blockedRef == expected)
    }
}
