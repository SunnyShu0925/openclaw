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
    /// A real `lsof` (same flags as the shipped probe) run against a port that is
    /// bound but not listening. This is the control row. The binary is addressed by
    /// absolute path so a neighbouring test's stub cannot stand in for it.
    @Test @MainActor func `proof 1 real lsof on an unlistened port is free`() async throws {
        let bound = try Self.bindUnlistenedLoopbackSocket()
        defer { _ = Darwin.close(bound.fd) }

        let raw = await Self.runShippedLsof(on: Int(bound.port))
        Self.report(label: "control: real lsof, unlistened port \(bound.port)", raw: raw)

        let inspection = await PortGuardian.shared.inspect(port: Int(bound.port))
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

// MARK: - Probe plumbing

extension PortGuardianEndToEndProofTests {
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
