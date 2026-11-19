// Proof-only: the red half of the before/after pair.
//
// `baseEvidence` reproduces the pre-change probe verbatim: the same `lsof`
// invocation without `-b`, driven through `ShellExecutor.run`, where a failed
// probe collapses to an empty listener list. The assertions show that shape
// reporting the port as free / not listening. This file never enters the PR diff.

import Darwin
import Foundation
import Testing

@testable import OpenClaw

@Suite(.serialized)
struct PortGuardianBaseBehaviorProofTests {
    @Test @MainActor func `base 1 a failing probe reads as free and not listening`() async throws {
        let bin = try PortGuardianEndToEndProofTests.makeStubDirectory()
        defer { try? FileManager.default.removeItem(at: bin) }
        try PortGuardianEndToEndProofTests.writeStub(
            named: "lsof",
            to: bin,
            script: """
            #!/bin/sh
            echo "lsof: proc_listpids failed" >&2
            exit 1
            """)

        let outcome = try await TestIsolation.withEnvValues(["PATH": "\(bin.path):/usr/bin:/bin"]) {
            let listeners = await Self.baseListeners(on: 49_311)
            return (listeners: listeners, listening: !listeners.isEmpty)
        }
        print("[proof-base] failing probe -> \(outcome.listeners.count) listeners, "
            + "isListening=\(outcome.listening)")
        #expect(outcome.listeners.isEmpty)
        #expect(!outcome.listening)
    }

    @Test @MainActor func `base 2 a timed out probe reads as free`() async throws {
        let bin = try PortGuardianEndToEndProofTests.makeStubDirectory()
        defer { try? FileManager.default.removeItem(at: bin) }
        try PortGuardianEndToEndProofTests.writeStub(named: "lsof", to: bin, script: "#!/bin/sh\n/bin/sleep 30\n")

        let listeners = try await TestIsolation.withEnvValues(["PATH": "\(bin.path):/usr/bin:/bin"]) {
            await Self.baseListeners(on: 49_312)
        }
        print("[proof-base] timed out probe -> \(listeners.count) listeners")
        #expect(listeners.isEmpty)
    }

    @Test @MainActor func `base 3 a real unlistened port and a broken probe are indistinguishable`() async throws {
        let bound = try PortGuardianEndToEndProofTests.bindUnlistenedLoopbackSocket()
        defer { _ = Darwin.close(bound.fd) }
        let bin = try PortGuardianEndToEndProofTests.makeStubDirectory()
        defer { try? FileManager.default.removeItem(at: bin) }
        try PortGuardianEndToEndProofTests.writeStub(
            named: "lsof",
            to: bin,
            script: "#!/bin/sh\necho 'lsof: proc_listpids failed' >&2\nexit 1\n")

        let freePort = try await TestIsolation.withEnvValues(["PATH": "/usr/sbin:/usr/bin:/bin"]) {
            await Self.baseListeners(on: Int(bound.port))
        }
        let broken = try await TestIsolation.withEnvValues(["PATH": "\(bin.path):/usr/bin:/bin"]) {
            await Self.baseListeners(on: Int(bound.port))
        }
        print("[proof-base] real free port -> \(freePort.count), broken probe -> \(broken.count)")
        #expect(freePort.isEmpty == broken.isEmpty)
    }
}

extension PortGuardianBaseBehaviorProofTests {
    /// The pre-change probe: no `-b`, `ShellExecutor.run`, and every non-ok result
    /// collapsed into an empty list.
    static func baseListeners(on port: Int) async -> [(pid: Int32, command: String)] {
        let res = await ShellExecutor.run(
            command: ["lsof", "-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpcn"],
            cwd: nil,
            env: nil,
            timeout: 5)
        print("[proof-base] raw: ok=\(res.ok) bytes=\(res.payload?.count ?? -1)")
        guard res.ok, let data = res.payload, !data.isEmpty else { return [] }
        let text = String(data: data, encoding: .utf8) ?? ""
        return Self.baseParse(text)
    }

    static func baseParse(_ text: String) -> [(pid: Int32, command: String)] {
        var pid: Int32?
        var command = ""
        var rows: [(pid: Int32, command: String)] = []
        for line in text.split(separator: "\n") {
            guard let tag = line.first else { continue }
            let value = String(line.dropFirst())
            switch tag {
            case "p": pid = Int32(value)
            case "c": command = value
            default: break
            }
            if tag == "c", let pid { rows.append((pid, command)) }
        }
        return rows
    }
}
