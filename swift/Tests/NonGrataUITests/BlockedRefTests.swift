import NonGrata
@testable import NonGrataUI
import Testing

struct BlockedRefTests {
    @Test(
        "El overlay solo cubre con .blocked; .unknown es fail-open",
        arguments: [
            (NonGrataVerdict.allowed, String?.none),
            (.unknown, nil),
            (.blocked(ref: "A1B2C3D4"), "A1B2C3D4"),
        ]
    )
    func blockedRef(verdict: NonGrataVerdict, expected: String?) {
        #expect(verdict.blockedRef == expected)
    }
}
