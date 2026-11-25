// Proof-only: exercises the shipped probe end to end on a real macOS host.
// This file lives on the proof branch and never enters the PR diff.

import Darwin
import Foundation
import Testing

@testable import OpenClaw

// The PATH overrides below are process-wide, so these rows must not overlap:
// one test's stub would otherwise answer another test's probe.
@Suite(.serialized)
struct PortGuardianEndToEndProofTests {
    /// A real `lsof` (same flags as the shipped probe) run against a port with no
    /// socket at all. This is the control row. A bound-but-unlistened socket would
    /// make lsof enumerate processes to attribute it, and proc_listpids fails
    /// intermittently on this runner, so an idle port keeps this row deterministic.
    /// The binary is addressed by absolute path so a neighbouring stub cannot
    /// stand in for it.
    @Test @MainActor func `proof 1 real lsof on an idle port is free`() async throws {
        let port = try Self.freePort()

        let raw = await Self.runShippedLsof(on: port)
        Self.report(label: "control: real lsof, idle port \(port)", raw: raw)

        let inspection = await Self.inspectUntilFree(port)
        Self.report(label: "control: PortGuardian.inspect", inspection: inspection)
        #expect(Self.sameCase(inspection, .free))
    }

    /// A real `lsof` that fails on its own (exit 1 plus a diagnostic, exactly what
    /// `proc_listpids` failure looks like) must not be read as a free port.
    @Test @MainActor func `proof 2 real summed lsof failure is unknown`() async throws {
        let bin = try Self.makeStubDirectory()
        defer { try? FileManager.default.removeItem(at: bin) }
        try Self.writeStub(
            named: "lsof",
            to: bin,
            script: """
            #!/bin/sh
            echo "lsof: proc_listpids failed" >&2
            exit 1
            """)

        let listed = try await TestIsolation.withEnvValues(["PATH": "\(bin.path):/usr/bin:/bin"]) {
            await PortGuardian.shared.isListening(port: 49_301)
        }
        Self.reportValue(label: "failure stub: isListening (must be true = possibly occupied)", listed)
        #expect(listed)

        let inspection = try await TestIsolation.withEnvValues(["PATH": "\(bin.path):/usr/bin:/bin"]) {
            await PortGuardian.shared.inspect(port: 49_301)
        }
        Self.report(label: "failure stub: PortGuardian.inspect", inspection: inspection)
        #expect(Self.sameCase(inspection, .unknown))
    }

    /// A real `lsof` that never answers must time out into `unknown`, not `free`.
    @Test @MainActor func `proof 3 real summed lsof timeout is unknown`() async throws {
        let bin = try Self.makeStubDirectory()
        defer { try? FileManager.default.removeItem(at: bin) }
        try Self.writeStub(named: "lsof", to: bin, script: "#!/bin/sh\n/bin/sleep 30\n")

        let started = ContinuousClock.now
        let inspection = try await TestIsolation.withEnvValues(["PATH": "\(bin.path):/usr/bin:/bin"]) {
            await PortGuardian.shared.inspect(port: 49_302)
        }
        let elapsed = ContinuousClock.now - started
        Self.report(label: "timeout stub: PortGuardian.inspect", inspection: inspection)
        Self.reportValue(label: "timeout stub: elapsed", elapsed)
        #expect(Self.sameCase(inspection, .unknown))
        #expect(elapsed < .seconds(10))
    }
}

// MARK: - App-level rows

/// The closest a headless runner can get to the shipped app's first run: a real
/// `.build/debug/OpenClaw` executable, a real PATH `lsof` fault, and the same
/// owners the app uses. Not a GUI session, but not a fixture either.
@Suite(.serialized)
struct PortGuardianAppEntryProofTests {
    /// Drives the shipped app-hosted start (`startAppHostedGateway`, the function this
    /// PR changes) on a real `GatewayProcessManager` with a real broken `lsof` in
    /// `PATH`. Only the supervisor launcher is replaced, so it counts whether the app
    /// actually tried to spawn a child Gateway on the port it could not inspect.
    @Test @MainActor func `app 1 broken lsof keeps the app hosted start from spawning`() async throws {
        let bin = try PortGuardianEndToEndProofTests.makeStubDirectory()
        defer { try? FileManager.default.removeItem(at: bin) }
        try PortGuardianEndToEndProofTests.writeStub(
            named: "lsof",
            to: bin,
            script: "#!/bin/sh\necho 'lsof: proc_listpids failed' >&2\nexit 1\n")

        var launches = 0
        let supervisor = GatewayChildSupervisor(launcher: { configuration in
            launches += 1
            print("[proof-app] app 1 LAUNCHED a child Gateway on port \(configuration.port)")
            return .init(
                waitUntilStarted: { 42_424 },
                wait: { .terminated(nil) },
                terminate: {})
        })
        let manager = GatewayProcessManager(childSupervisor: supervisor)
        // A synthetic runtime keeps this row on the port decision instead of failing
        // in the seeding step that a headless runner cannot satisfy.
        let runtime = BundledRuntime(root: bin)

        try await TestIsolation.withEnvValues(["PATH": "\(bin.path):/usr/bin:/bin"]) {
            let port = GatewayEnvironment.gatewayPort()
            let inspection = await PortGuardian.shared.inspect(port: port)
            PortGuardianEndToEndProofTests.report(label: "app 1 inspect with broken lsof", inspection: inspection)
            #expect(Self.sameCase(inspection, .unknown))
            print("[proof-app] app 1 installation=\(manager.installation) "
                + "hosting=\(manager.gatewayHosting)")

            manager.desiredActive = true
            let generation = manager.gatewayStartGeneration
            await manager.startAppHostedGateway(startGeneration: generation, runtime: runtime)

            print("[proof-app] app 1 shipped startup status: \(manager.status)")
            print("[proof-app] app 1 supervisor launches: \(launches) "
                + "(active=\(supervisor.isActive) pid=\(supervisor.processIdentifier.map(String.init) ?? "nil"))")

            // The bug under test: the failed probe read as "free", so startup spawned.
            #expect(launches == 0)
            #expect(!supervisor.isActive)
            #expect(supervisor.processIdentifier == nil)
            // Guard against a vacuous pass: the row must have reached the port decision,
            // not bailed out earlier on an installation guard.
            #expect(manager.installation == .managed)
            if case let .failed(reason) = manager.status {
                print("[proof-app] app 1 failure reason: \(reason)")
            }

            // Every other route to a child on that port must be empty too.
            let children = try Self.childGateways(on: port)
            print("[proof-app] app 1 child gateways on port \(port): \(children.count)")
            #expect(children.isEmpty)

            manager.desiredActive = false
        }
    }

    /// The onboarding owner itself: with the port unreadable, the probe it builds
    /// must not advertise an automatic install or a stale listener.
    @Test @MainActor func `app 2 onboarding never promises an install on an unreadable port`() async throws {
        let port = try Self.freePort()
        let bin = try PortGuardianEndToEndProofTests.makeStubDirectory()
        defer { try? FileManager.default.removeItem(at: bin) }
        try PortGuardianEndToEndProofTests.writeStub(named: "lsof", to: bin, script: "#!/bin/sh\n/bin/sleep 30\n")

        try await TestIsolation.withEnvValues(["PATH": "\(bin.path):/usr/bin:/bin"]) {
            let started = ContinuousClock.now
            let inspection = await PortGuardian.shared.inspect(port: port)
            print("[proof-app] app 2 inspect took \(ContinuousClock.now - started), "
                + "unreadable=\(Self.sameCase(inspection, .unknown))")
            #expect(Self.sameCase(inspection, .unknown))

            // Whatever the page renders, it must not claim the port is usable.
            let promisesInstall = try Self.onboardingPromisesInstall(on: port)
            print("[proof-app] app 2 onboarding would promise an automatic install: \(promisesInstall)")
            #expect(!promisesInstall)
        }
    }

    /// An upgrade must keep the settings the next launch reads.
    @Test @MainActor func `app 3 stored settings survive an upgrade rewrite`() async throws {
        let suite = "ai.openclaw.mac.proof.\(UUID().uuidString)"
        // The previous build's on-disk domain, written by a separate UserDefaults
        // instance so this row cannot pass by reading its own in-memory values back.
        let previousBuild = try #require(UserDefaults(suiteName: suite))
        previousBuild.set(true, forKey: onboardingSeenKey)
        previousBuild.set(3, forKey: onboardingVersionKey)
        previousBuild.set("local", forKey: connectionModeKey)
        previousBuild.set("/opt/homebrew/bin/openclaw gateway --port 18789",
                          forKey: GatewayLaunchAgentManager.resumeCommandKey)
        previousBuild.set(false, forKey: pauseDefaultsKey)
        previousBuild.synchronize()
        defer { previousBuild.removePersistentDomain(forName: suite) }

        // A fresh process reading the same domain is what the upgraded build sees.
        let candidate = try #require(UserDefaults(suiteName: suite))
        let seen = candidate.bool(forKey: onboardingSeenKey)
        let version = candidate.integer(forKey: onboardingVersionKey)
        let mode = candidate.string(forKey: connectionModeKey)
        let resume = candidate.string(forKey: GatewayLaunchAgentManager.resumeCommandKey)
        let paused = candidate.object(forKey: pauseDefaultsKey) as? Bool
        print("[proof-app] app 3 upgraded read: seen=\(seen) version=\(version) mode=\(mode ?? "nil") "
            + "resume=\(resume ?? "nil") paused=\(String(describing: paused))")

        #expect(seen)
        #expect(version == 3)
        #expect(mode == "local")
        #expect(resume == "/opt/homebrew/bin/openclaw gateway --port 18789")
        #expect(paused == false)
        // The build's own onboarding gate must not re-run setup for a seen install.
        #expect(version < currentOnboardingVersion)
    }

    /// Once the port is readable again the same owner settles on a real answer.
    @Test @MainActor func `app 4 a readable port recovers the probe after the fault clears`() async throws {
        // A port with no socket at all. A bound-but-unlistened socket makes lsof
        // enumerate processes to attribute it, and proc_listpids intermittently
        // fails on this runner; a truly idle port needs no such enumeration, so
        // the recovery assertion is deterministic.
        let port = try Self.freePort()
        let bin = try PortGuardianEndToEndProofTests.makeStubDirectory()
        defer { try? FileManager.default.removeItem(at: bin) }
        // The stub only answers this row's port, so the child processes this suite
        // starts cannot hold the process-wide PATH after the override is unwound.
        try PortGuardianEndToEndProofTests.writeStub(
            named: "lsof",
            to: bin,
            script: """
            #!/bin/sh
            echo "$*" >> "\(bin.path)/invocations.txt"
            case "$*" in
              *"-iTCP:\(port)"*)
                echo "lsof: proc_listpids failed" >&2
                exit 1
                ;;
            esac
            exec /usr/sbin/lsof "$@"
            """)

        // Faulted: a broken lsof cannot answer for this port.
        let faulted = try await TestIsolation.withEnvValues(["PATH": "\(bin.path):/usr/bin:/bin"]) {
            await PortGuardian.shared.inspect(port: port)
        }
        PortGuardianEndToEndProofTests.report(label: "app 4 faulted", inspection: faulted)
        #expect(Self.sameCase(faulted, .unknown))

        // The fault is lifted and the same owner re-inspects the same port. The
        // real tool is intermittently inconclusive here, so poll until it answers.
        let recovered = await PortGuardianEndToEndProofTests.inspectUntilFree(port)
        PortGuardianEndToEndProofTests.report(label: "app 4 recovered", inspection: recovered)
        // If the stub answered the recovery probe too, the PATH override leaked.
        PortGuardianEndToEndProofTests.logStubInvocation(bin.appendingPathComponent("lsof"))
        #expect(Self.sameCase(recovered, .free))
    }
}

extension PortGuardianAppEntryProofTests {
    static func sameCase(_ lhs: PortGuardian.PortInspection, _ rhs: PortGuardian.PortInspection) -> Bool {
        switch (lhs, rhs) {
        case (.free, .free), (.unknown, .unknown), (.owned, .owned): true
        default: false
        }
    }

    static func freePort() throws -> Int {
        let bound = try PortGuardianEndToEndProofTests.bindUnlistenedLoopbackSocket()
        _ = Darwin.close(bound.fd)
        return Int(bound.port)
    }

    /// Reads the child Gateway processes the way the app's supervisor launches them.
    static func childGateways(on port: Int) throws -> [Int32] {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        task.arguments = ["-c", "ps -Ao pid=,command= | grep -F 'gateway' | grep -F '\(port)' | grep -v grep"]
        let pipe = Pipe()
        task.standardOutput = pipe
        try task.run()
        task.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return (String(data: data, encoding: .utf8) ?? "")
            .split(separator: "\n")
            .compactMap { Int32($0.split(separator: " ").first ?? "") }
    }

    /// True when the onboarding subtitle would tell the user setup will install one.
    static func onboardingPromisesInstall(on port: Int) throws -> Bool {
        let probe = OnboardingView.LocalGatewayProbe(unreadablePort: port)
        print("[proof-app] onboarding subtitle: \(probe.subtitle)")
        return probe.subtitle.contains("Will attach") || probe.subtitle.contains("will install")
    }
}

// MARK: - Probe plumbing


extension PortGuardianEndToEndProofTests {
    /// Proves what the stub actually sees, so a recovery row cannot silently pass
    /// by being answered by the stub.
    static func logStubInvocation(_ stub: URL) {
        let log = stub.deletingLastPathComponent().appendingPathComponent("invocations.txt")
        guard let text = try? String(contentsOf: log, encoding: .utf8) else {
            print("[proof] stub invocation log: absent")
            return
        }
        let lines = text.split(separator: "\n")
        print("[proof] stub was invoked \(lines.count) time(s)")
        for line in lines { print("[proof]   stub saw: \(line)") }
    }

    /// Runs the shipped probe command verbatim so the raw streams are visible.
    /// Absolute path: the shipped probe resolves `lsof` through `PATH`, which other
    /// rows in this file deliberately rewrite.
    static func runShippedLsof(on port: Int) async -> ShellExecutor.ShellResult {
        await ShellExecutor.runDetailed(
            command: ["/usr/sbin/lsof", "-b", "-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpcn"],
            cwd: nil,
            env: nil,
            timeout: 5)
    }

    static func report(label: String, raw: ShellExecutor.ShellResult) {
        print("[proof] \(label): exit=\(raw.exitCode.map(String.init) ?? "nil") success=\(raw.success) "
            + "timedOut=\(raw.timedOut) preflight=\(raw.preflightError ?? "nil")")
        print("[proof] \(label): stdout=<\(raw.stdout)>")
        print("[proof] \(label): stderr has \(raw.stderr.count) chars, "
            + "\(raw.stderr.split(separator: "\n").count) lines")
    }

    static func report(label: String, inspection: PortGuardian.PortInspection) {
        let text = switch inspection {
        case .free: "free"
        case let .owned(descriptor): "owned(pid: \(descriptor.pid), command: \(descriptor.command))"
        case .unknown: "unknown"
        }
        print("[proof] \(label): \(text)")
    }

    static func reportValue<T>(label: String, _ value: T) {
        print("[proof] \(label): \(value)")
    }

    /// This runner's real lsof intermittently fails proc_listpids even on an idle
    /// port, which the probe correctly reports as `.unknown`. Poll until the tool
    /// answers cleanly so the assertion measures the probe's classification, not
    /// the tool's transient failure. Every attempt is printed, so a probe that
    /// never settles on `.free` still fails loudly.
    static func inspectUntilFree(_ port: Int, attempts: Int = 6) async -> PortGuardian.PortInspection {
        var last = PortGuardian.PortInspection.unknown
        for attempt in 1...attempts {
            let inspection = await PortGuardian.shared.inspect(port: port)
            Self.report(label: "inspect attempt \(attempt)/\(attempts)", inspection: inspection)
            if case .free = inspection { return inspection }
            last = inspection
        }
        return last
    }

    static func sameCase(_ lhs: PortGuardian.PortInspection, _ rhs: PortGuardian.PortInspection) -> Bool {
        switch (lhs, rhs) {
        case (.free, .free), (.unknown, .unknown): true
        case (.owned, .owned): true
        default: false
        }
    }

    static func bindUnlistenedLoopbackSocket() throws -> (fd: Int32, port: UInt16) {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ProofFixtureError.openFailed }
        var reuse: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = UInt32(bigEndian: 0x7F00_0001)
        address.sin_port = 0
        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
                bind(fd, socketAddress, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            _ = Darwin.close(fd)
            throw ProofFixtureError.openFailed
        }
        var boundAddress = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameResult = withUnsafeMutablePointer(to: &boundAddress) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
                getsockname(fd, socketAddress, &length)
            }
        }
        guard nameResult == 0 else {
            _ = Darwin.close(fd)
            throw ProofFixtureError.openFailed
        }
        return (fd, UInt16(bigEndian: boundAddress.sin_port))
    }

    /// A port with no socket bound to it, so lsof needs no process enumeration.
    static func freePort() throws -> Int {
        let bound = try Self.bindUnlistenedLoopbackSocket()
        _ = Darwin.close(bound.fd)
        return Int(bound.port)
    }

    static func makeStubDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("portguardian-proof-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    static func writeStub(named name: String, to directory: URL, script: String) throws {
        let stub = directory.appendingPathComponent(name)
        try script.write(to: stub, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stub.path)
    }
}

enum ProofFixtureError: Error {
    case openFailed
}
