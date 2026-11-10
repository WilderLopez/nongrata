@testable import NonGrata
import Foundation
import Testing

@MainActor
@Suite("NonGrata")
struct NonGrataTests {
    let device = TestDevice()

    // MARK: installId

    @Test("installId es estable entre llamadas y relanzamientos")
    func installIdIsStable() throws {
        let first = try #require(device.launch().installId)
        #expect(device.launch().installId == first)
        #expect(device.secureStore.values["installId"] == first)
    }

    @Test("Keychain no disponible: no inventa installId, no llama al Worker y no bloquea")
    func keychainUnavailable() async throws {
        device.secureStore.unavailable = true
        let guardian = device.launch()
        #expect(guardian.installId == nil)

        #expect(await guardian.check(intent: .launch) == .unknown)
        #expect(device.transport.payloads.isEmpty)

        // Tras el primer desbloqueo, la siguiente comprobación crea el installId.
        device.secureStore.unavailable = false
        #expect(await guardian.check(intent: .launch) == .allowed)
        #expect(guardian.installId != nil)
    }

    // MARK: Petición

    @Test("La petición lleva hashes con el prefijo de la app, dos tokens distintos y el ref")
    func payload() async throws {
        let guardian = device.launch()
        await guardian.check(intent: .login, userId: "user_12345")

        let payload = try #require(device.transport.payloads.first)
        let hasher = IdentifierHasher(prefix: "myapp-ban-v1")
        let installHash = hasher.hash(.install, try #require(guardian.installId))

        #expect(payload.app == "myapp")
        #expect(payload.env == "production")
        #expect(payload.intent == "login")
        #expect(payload.platform == "ios")
        #expect(payload.appVersion == "1.2.3")
        // Vectores de spec/hash-vectors.json.
        #expect(payload.ids.idfv == "b55ea8ae1f1ece0d1fd58ce1ebdf9c6573beedb75ef78b13335904980c55c408")
        #expect(payload.ids.user == "83b1273587f3f4c91e0dcab9c6952765dfb2b00f743d0979cb9679d82f493854")
        #expect(payload.ids.install == installHash)
        #expect(payload.ids.icloud == nil) // useICloud apagado
        #expect(payload.ref == IdentifierHasher.ref(installHash: installHash))
        #expect(payload.ref == guardian.supportCode)

        let query = try #require(payload.dcToken)
        let update = try #require(payload.dcTokenUpdate)
        #expect(query != update)
        #expect(Data(base64Encoded: query) != nil)
    }

    @Test("El JSON sigue el contrato del Worker, con null explícito")
    func payloadJSON() throws {
        let payload = CheckPayload(
            app: "myapp", dcToken: nil, dcTokenUpdate: nil, env: "production", ref: "ABCDEF12",
            ids: .init(idfv: nil, install: "a", icloud: nil, user: nil),
            intent: "launch", platform: "ios", appVersion: nil
        )
        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any]
        )
        #expect(Set(object.keys) == [
            "app", "dc_token", "dc_token_update", "env", "ref", "ids", "intent", "platform", "app_version",
        ])
        #expect(object["dc_token"] is NSNull)
        let ids = try #require(object["ids"] as? [String: Any])
        #expect(Set(ids.keys) == ["idfv", "install", "icloud", "user"])
    }

    @Test("Sin DeviceCheck (simulador) no manda tokens")
    func unsupportedDeviceCheck() async throws {
        device.tokens.isSupported = false
        await device.launch().check(intent: .launch)
        let payload = try #require(device.transport.payloads.first)
        #expect(payload.dcToken == nil && payload.dcTokenUpdate == nil)
    }

    @Test("Si DeviceCheck falla, la comprobación sigue sin tokens")
    func failingDeviceCheck() async throws {
        device.tokens.failing = true
        #expect(await device.launch().check(intent: .launch) == .allowed)
        #expect(try #require(device.transport.payloads.first).dcToken == nil)
    }

    // MARK: Veredicto persistente

    @Test("blocked pone la marca y bloquea al relanzar sin red")
    func blockedPersists() async throws {
        device.transport.mode = .blocked
        let guardian = device.launch()
        let ref = try #require(guardian.supportCode)
        #expect(await guardian.check(intent: .launch) == .blocked(ref: ref))

        device.transport.mode = .failing
        let relaunched = device.launch()
        #expect(relaunched.verdict == .blocked(ref: ref))
        #expect(await relaunched.check(intent: .launch) == .blocked(ref: ref))
    }

    @Test("ok quita la marca: es la única salida del bloqueo")
    func okClearsMark() async {
        device.transport.mode = .blocked
        let guardian = device.launch()
        await guardian.check(intent: .launch)

        device.transport.mode = .ok
        #expect(await guardian.check(intent: .foreground) == .allowed)
        #expect(device.secureStore.values["blockedRef"] == nil)
        #expect(device.launch().verdict == .unknown)
    }

    @Test("Un error no toca la marca ni el veredicto bloqueado")
    func errorKeepsMark() async throws {
        device.transport.mode = .blocked
        let guardian = device.launch()
        await guardian.check(intent: .launch)

        device.transport.mode = .failing
        let ref = try #require(guardian.supportCode)
        #expect(await guardian.check(intent: .foreground) == .blocked(ref: ref))
        #expect(device.secureStore.values["blockedRef"] == ref)
    }

    @Test("Fail-open: sin marca y con error, unknown deja seguir salvo el registro estricto")
    func failOpen() async {
        device.transport.mode = .failing
        let strict = device.launch()
        let verdict = await strict.check(intent: .signup)
        #expect(verdict == .unknown)
        for intent in [CheckIntent.launch, .foreground, .login] {
            #expect(strict.permits(verdict, for: intent))
        }
        #expect(!strict.permits(verdict, for: .signup))

        let lenient = device.launch(device.configuration(strictSignup: false))
        #expect(lenient.permits(.unknown, for: .signup))
        #expect(!lenient.permits(.blocked(ref: "ABCDEF12"), for: .launch))
    }

    // MARK: Primer plano

    @Test("En primer plano, no repite la comprobación antes de foregroundInterval")
    func foregroundThrottle() async {
        let guardian = device.launch()
        await guardian.check(intent: .launch)
        await guardian.check(intent: .foreground)
        #expect(device.transport.payloads.count == 1)

        device.clock.advance(by: .seconds(3601))
        await guardian.check(intent: .foreground)
        #expect(device.transport.payloads.count == 2)

        // Otros intents siempre comprueban.
        await guardian.check(intent: .login, userId: "u")
        #expect(device.transport.payloads.count == 3)
    }

    @Test("Bloqueado, comprueba en cada vuelta a primer plano para detectar el desbaneo")
    func foregroundWhileBlocked() async {
        device.transport.mode = .blocked
        let guardian = device.launch()
        await guardian.check(intent: .launch)
        await guardian.check(intent: .foreground)
        await guardian.check(intent: .foreground)
        #expect(device.transport.payloads.count == 3)
    }

    // MARK: iCloud

    @Test("Con iCloud, manda el hash del ID y pone la marca en el almacén compartido")
    func iCloudMark() async throws {
        device.transport.mode = .blocked
        let guardian = device.launch(device.configuration(useICloud: true))
        await guardian.check(intent: .launch)

        let payload = try #require(device.transport.payloads.first)
        // Vector de spec/hash-vectors.json.
        #expect(payload.ids.icloud == "5d8f38cf7e2af497533f83ae0ae6e636626cae2eff6c802f50489f68c26d1268")
        #expect(device.cloudStore.values["nongrata.myapp.blockedRef"] == guardian.supportCode)
    }

    @Test("Otro dispositivo pone la marca de iCloud: bloquea en caliente")
    func iCloudExternalChange() async {
        let guardian = device.launch(device.configuration(useICloud: true))
        #expect(guardian.verdict == .unknown)

        device.cloudStore.simulateExternalChange("ABCDEF12", forKey: "nongrata.myapp.blockedRef")
        await settle { guardian.verdict != .unknown }
        #expect(guardian.verdict == .blocked(ref: "ABCDEF12"))
    }

    @Test("La marca de iCloud de otro dispositivo bloquea al arrancar sin red")
    func iCloudMarkAtLaunch() {
        device.cloudStore.values["nongrata.myapp.blockedRef"] = "ABCDEF12"
        #expect(device.launch(device.configuration(useICloud: true)).verdict == .blocked(ref: "ABCDEF12"))
        // Sin useICloud, la marca compartida se ignora.
        #expect(device.launch().verdict == .unknown)
    }

    @Test("Si iCloud tarda, comprueba sin su ID y lo usa en la siguiente")
    func iCloudTimeout() async throws {
        let gate = Gate()
        device.identity.iCloudGate = gate
        let guardian = device.launch(device.configuration(useICloud: true, iCloudTimeout: .milliseconds(20)))

        await guardian.check(intent: .launch)
        #expect(try #require(device.transport.payloads.first).ids.icloud == nil)

        gate.open()
        await settle { guardian.iCloudIdHash != nil }
        await guardian.check(intent: .login)
        #expect(try #require(device.transport.payloads.last).ids.icloud == guardian.iCloudIdHash)
    }

    // MARK: Concurrencia

    @Test("Una comprobación antigua que termina tarde no pisa a la más reciente")
    func staleResultIsIgnored() async {
        let guardian = device.launch()
        let gate = Gate()
        device.transport.mode = .blocked
        device.transport.nextGate = gate

        let stale = Task { await guardian.check(intent: .launch) }
        await settle { device.transport.payloads.count == 1 }

        device.transport.mode = .ok
        #expect(await guardian.check(intent: .login) == .allowed)

        gate.open()
        #expect(await stale.value == .allowed)
        #expect(guardian.verdict == .allowed)
        #expect(device.secureStore.values["blockedRef"] == nil)
    }

    // MARK: Dependencias reales

    @Test("Sin useICloud no se crea el almacén de iCloud: una app sin ese entitlement no lo toca")
    func systemDependenciesRespectUseICloud() {
        var configuration = NonGrataConfiguration(
            endpoint: URL(string: "https://guard.example/v1/device/check")!,
            appId: "myapp",
            hashPrefix: "myapp-ban-v1"
        )
        #expect(Dependencies.system(configuration).cloudStore == nil)

        configuration.useICloud = true
        #expect(Dependencies.system(configuration).cloudStore is UbiquitousFlagStore)
    }
}
